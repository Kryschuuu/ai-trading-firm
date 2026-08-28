/**
 * Bitunix-Adapter: Paper-E2E (Modus B, 0 Private-Calls), Live-Gate,
 * Disabled-Flag, Secret-Scan der Quellen.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BitunixFixtureServer } from "./fixtures/bitunixFixtureServer";
import { BitunixBrokerAdapter } from "../src/brokers/bitunix/adapter";
import { loadBitunixConfig } from "../src/brokers/bitunix/config";
import { BitunixDisabledError } from "../src/brokers/bitunix/errors";
import { EnvSecretStore } from "../src/brokers/bitunix/secrets";
import { BitunixPrivateClient } from "../src/brokers/bitunix/privateClient";
import { InstrumentRegistry } from "../src/universe/registry";
import { LiveTradingGateError, NotSupportedCapabilityError } from "../src/contracts/broker";
import { killSwitch, resetRuntimeLimits } from "../src/lib/riskGuard";

const dirs: string[] = [];
const servers: BitunixFixtureServer[] = [];
after(async () => {
  resetRuntimeLimits();
  killSwitch.disarm();
  await Promise.all(servers.map((s) => s.stop()));
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(path.join(tmpdir(), "bitunix-reg-"));
  dirs.push(d);
  return d;
}

async function paperAdapter(fx: BitunixFixtureServer, extraEnv: Record<string, string> = {}) {
  const env = {
    BITUNIX_ENABLED: "true",
    BITUNIX_ALLOW_INSECURE_HTTP: "true",
    BITUNIX_BASE_URL: fx ? "" : "",
    BITUNIX_RETRY_MAX: "1",
    STARTING_EQUITY: "10000",
    BITUNIX_API_KEY: fx.apiKey,
    BITUNIX_API_SECRET: fx.apiSecret,
    ...extraEnv,
  };
  const config = loadBitunixConfig(env);
  const registry = new InstrumentRegistry({ dir: tmp(), autoSave: false });
  registry.load();
  return new BitunixBrokerAdapter("paper", {
    env,
    config,
    registry,
    secretStore: new EnvSecretStore(env),
  });
}

test("Paper-E2E Modus B: Discovery → Registry → Ticker → Order, 0 Private-Calls", async () => {
  const fx = new BitunixFixtureServer();
  const base = await fx.start();
  servers.push(fx);
  const adapter = await paperAdapter(fx, { BITUNIX_BASE_URL: base });

  const health = await adapter.healthCheck();
  assert.equal(health.status, "online");
  assert.equal(health.details.liveEnabled, false);
  assert.equal(health.details.stopAtVenue, true);

  const items = await adapter.discoverInstruments();
  assert.ok(items.some((i) => i.id === "BITUNIX:BTCUSDT" && i.marketType === "perpetual"));
  const ticker = await adapter.getTicker("BTCUSDT");
  assert.equal(ticker.price, 65000.5);
  const candles = await adapter.getCandles("BTCUSDT", "1m");
  assert.ok(candles.length >= 2);
  const book = await adapter.getOrderBook("BTCUSDT");
  assert.ok(book.bids.length >= 1);

  const fill = await adapter.placeOrder({
    symbol: "BTCUSDT",
    side: "LONG",
    qty: 0.01,
    riskNotional: 650,
    stopLoss: 60000,
    takeProfit: 70000,
  });
  assert.equal(fill.status, "FILLED");
  assert.ok(fill.fillPrice > 0);
  assert.equal(fill.stopLoss, 60000);
  assert.equal(fill.takeProfit, 70000);

  const acct = await adapter.getAccount();
  assert.equal(acct.openPositions, 1);
  assert.ok(acct.equity > 0);
  const pos = await adapter.getPositions();
  assert.equal(pos.length, 1);
  assert.equal(pos[0].symbol, "BTCUSDT");

  assert.equal(fx.privateCalls, 0, "Paper darf die Private-API nie anfassen");
  assert.ok(fx.requests.every((r) => !r.signed), "kein signierter Request im Paper-Pfad");
});

test("BITUNIX_ENABLED=false: Market-Data/Trading/Discovery werfen BitunixDisabledError", async () => {
  const adapter = new BitunixBrokerAdapter("paper", {
    env: { BITUNIX_ENABLED: "false" },
    config: loadBitunixConfig({ BITUNIX_ENABLED: "false" }),
  });
  await assert.rejects(() => adapter.discoverInstruments(), BitunixDisabledError);
  await assert.rejects(() => adapter.getTicker("BTCUSDT"), BitunixDisabledError);
  await assert.rejects(() => adapter.getCandles("BTCUSDT", "1m"), BitunixDisabledError);
  await assert.rejects(() => adapter.getOrderBook("BTCUSDT"), BitunixDisabledError);
  await assert.rejects(() => adapter.getAccount(), BitunixDisabledError);
  await assert.rejects(() => adapter.getPositions(), BitunixDisabledError);
  await assert.rejects(
    () =>
      adapter.placeOrder({
        symbol: "BTCUSDT",
        side: "LONG",
        qty: 0.01,
        riskNotional: 650,
        stopLoss: 60000,
      }),
    BitunixDisabledError
  );
  const h = await adapter.healthCheck();
  assert.equal(h.status, "offline");
  assert.equal(h.details.reason, "BITUNIX_DISABLED");
  const creds = await adapter.credentialStatus();
  assert.equal(creds.liveEnabled, false);
  assert.equal(creds.connected, false);
  assert.deepEqual(JSON.stringify(creds).includes("secret"), false);
});

test("Live-placeOrder: LiveTradingGateError bis der Live-Gate-Enforcer erlaubt (Task 11)", async () => {
  let hits = 0;
  const fake = {
    placeSerializedOrder: async () => {
      hits += 1;
      return { orderId: "NOPE" };
    },
  } as unknown as BitunixPrivateClient;
  const env = {
    BITUNIX_ENABLED: "true",
    BITUNIX_LIVE_ENABLED: "true",
    LIVE_TRADING_ENABLED: "true",
    REQUIRE_HUMAN_APPROVAL: "false",
    // Hermetischer Live-Gate-State-Speicher: State DISCONNECTED (kein
    // State-File) => Enforcer denied mit STATE_NOT_LIVE_ENABLED.
    LIVE_GATE_DATA_DIR: tmp(),
  };
  const adapter = new BitunixBrokerAdapter("live", {
    env,
    config: loadBitunixConfig(env),
    privateClient: fake,
  });
  await assert.rejects(
    () =>
      adapter.placeOrder({
        symbol: "BTCUSDT",
        side: "LONG",
        qty: 0.01,
        riskNotional: 650,
        stopLoss: 60000,
      }),
    (e: unknown) =>
      e instanceof LiveTradingGateError && /STATE_NOT_LIVE_ENABLED/.test((e as Error).message)
  );
  await assert.rejects(() => adapter.getAccount(), LiveTradingGateError);
  await assert.rejects(() => adapter.getPositions(), LiveTradingGateError);
  assert.equal(hits, 0);
});

test("testnet: NotSupportedCapabilityError, kein stiller Fallback", async () => {
  const adapter = new BitunixBrokerAdapter("testnet", {
    env: { BITUNIX_ENABLED: "true" },
    config: loadBitunixConfig({ BITUNIX_ENABLED: "true" }),
  });
  await assert.rejects(
    () =>
      adapter.placeOrder({
        symbol: "BTCUSDT",
        side: "LONG",
        qty: 0.01,
        riskNotional: 650,
        stopLoss: 60000,
      }),
    (e: unknown) => e instanceof NotSupportedCapabilityError && (e as NotSupportedCapabilityError).capability === "testnet"
  );
});

test("Adapter: privateClient ohne Creds, marketWs, Health remote, testnet Account", async () => {
  const fx = new BitunixFixtureServer();
  const base = await fx.start();
  servers.push(fx);
  const env = {
    BITUNIX_ENABLED: "true",
    BITUNIX_ALLOW_INSECURE_HTTP: "true",
    BITUNIX_BASE_URL: base,
    BITUNIX_RETRY_MAX: "1",
  };
  const adapter = new BitunixBrokerAdapter("paper", {
    env,
    config: loadBitunixConfig(env),
    secretStore: new EnvSecretStore(env),
  });
  await assert.rejects(() => adapter.privateClient(), NotSupportedCapabilityError);
  const ws = adapter.marketWs();
  assert.ok(ws);
  ws.stop();
  const remoteOk = await adapter.healthCheck({ remote: true });
  assert.equal(remoteOk.status, "online");
  const dead = new BitunixBrokerAdapter("paper", {
    env: { ...env, BITUNIX_BASE_URL: "http://127.0.0.1:1" },
    config: loadBitunixConfig({ ...env, BITUNIX_BASE_URL: "http://127.0.0.1:1", BITUNIX_TIMEOUT_MS: "200" }),
  });
  const remoteFail = await dead.healthCheck({ remote: true });
  assert.equal(remoteFail.status, "degraded");

  const tn = new BitunixBrokerAdapter("testnet", {
    env: { BITUNIX_ENABLED: "true" },
    config: loadBitunixConfig({ BITUNIX_ENABLED: "true" }),
  });
  await assert.rejects(() => tn.getAccount(), NotSupportedCapabilityError);
  await assert.rejects(() => tn.getPositions(), NotSupportedCapabilityError);
});

test("Capabilities: paper/discovery/marketData/trading/live/stopAtVenue, kein Testnet", () => {
  const a = new BitunixBrokerAdapter("paper");
  assert.equal(a.id, "BITUNIX");
  assert.equal(a.capabilities.discovery, true);
  assert.equal(a.capabilities.marketData, true);
  assert.equal(a.capabilities.trading, true);
  assert.equal(a.capabilities.paper, true);
  assert.equal(a.capabilities.testnet, false);
  assert.equal(a.capabilities.live, true);
  assert.equal(a.capabilities.stopAtVenue, true);
  assert.equal(a.capabilities.instrumentTypes.perpetual, true);
  assert.equal(a.capabilities.instrumentTypes.spot, false);
});

test("Secret-Scan: Bitunix-Quellen loggen keine Keys/Signaturen", () => {
  const root = path.join(process.cwd(), "src/brokers/bitunix");
  const files = readdirSync(root).filter((f) => f.endsWith(".ts"));
  const forbidden = /console\.(log|info|warn|error)\([^)]*(apiSecret|api-key|secretKey|\.sign\b)/i;
  for (const f of files) {
    const src = readFileSync(path.join(root, f), "utf8");
    assert.equal(forbidden.test(src), false, `${f} loggt potenziell Secrets`);
    assert.ok(!src.includes("console.log(input.secret"));
  }
});
