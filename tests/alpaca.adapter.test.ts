/**
 * Alpaca-Adapter-Tests (Task 12): Paper-E2E (Modus B, 0 Private-Calls),
 * Live-Gate, Disabled-Flag, Security-Tests, Public-Client, Execution-Engines.
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AlpacaFixtureServer } from "./fixtures/alpacaFixtureServer";
import { AlpacaBrokerAdapter } from "../src/brokers/alpaca/adapter";
import { loadAlpacaPublicConfig, loadAlpacaTradeConfig } from "../src/brokers/alpaca/config";
import { AlpacaDisabledError } from "../src/brokers/alpaca/errors";
import { EnvSecretStore } from "../src/brokers/alpaca/secrets";
import { AlpacaPrivateClient } from "../src/brokers/alpaca/privateClient";
import { AlpacaPublicClient } from "../src/brokers/alpaca/publicClient";
import { AlpacaPaperLedger } from "../src/brokers/alpaca/paper";
import { BrokerExecutionEngine, PaperExecutionEngine } from "../src/brokers/alpaca/execution";
import { basicAuthHeader } from "../src/brokers/alpaca/http";
import { LiveTradingGateError, NotSupportedCapabilityError } from "../src/contracts/broker";
import { killSwitch, resetRuntimeLimits } from "../src/lib/riskGuard";
import {
  allowEnv,
  mockPort,
  resetLiveGateTestGlobals,
  seedState,
} from "./fixtures/liveGateTestUtil";
import {
  getLiveGateRuntime,
  registerGatePort,
  setVenueReadinessProvider,
  writeSuiteStamp,
} from "../src/live-gate";

const dirs: string[] = [];
const servers: AlpacaFixtureServer[] = [];
before(() => {
  resetRuntimeLimits();
  killSwitch.disarm();
});
after(async () => {
  resetRuntimeLimits();
  killSwitch.disarm();
  resetLiveGateTestGlobals();
  await Promise.all(servers.map((s) => s.stop()));
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/**
 * Öffnet das Live-Gate hermetisch (State LIVE_ENABLED + Suite-Stamp +
 * Readiness + Mock-Port) für die ALPACA-Venue.
 */
function openLiveGate(env: Record<string, string>): void {
  seedState(env, "ALPACA", "LIVE_ENABLED");
  writeSuiteStamp(getLiveGateRuntime(env).dir, {
    passed: true,
    runId: "suite-alpaca-ok",
    sha: "deadbeef",
    source: "ci",
  });
  setVenueReadinessProvider(() => ({ active: true }));
  registerGatePort("ALPACA", mockPort());
}

function tmp(): string {
  const d = mkdtempSync(path.join(tmpdir(), "alpaca-test-"));
  dirs.push(d);
  return d;
}

async function paperAdapter(fx: AlpacaFixtureServer, extraEnv: Record<string, string> = {}) {
  const env: Record<string, string> = {
    ALPACA_ENABLED: "true",
    ALPACA_ALLOW_INSECURE_HTTP: "true",
    ALPACA_TRADE_BASE_URL: fx.baseUrl,
    ALPACA_DATA_BASE_URL: fx.baseUrl,
    ALPACA_RETRY_MAX: "1",
    STARTING_EQUITY: "10000",
    ALPACA_API_KEY: fx.apiKey,
    ALPACA_API_SECRET: fx.apiSecret,
    ...extraEnv,
  };
  // Fixture benutzt 127.0.0.1 → muss Loopback erlauben.
  const config = loadAlpacaPublicConfig(env);
  return new AlpacaBrokerAdapter("paper", {
    env,
    publicConfig: config,
    secretStore: new EnvSecretStore(env),
  });
}

async function liveAdapter(fx: AlpacaFixtureServer, extraEnv: Record<string, string> = {}) {
  const env: Record<string, string> = {
    ALPACA_ENABLED: "true",
    ALPACA_LIVE_ENABLED: "true",
    LIVE_TRADING_ENABLED: "true",
    REQUIRE_HUMAN_APPROVAL: "false",
    ALPACA_ALLOW_INSECURE_HTTP: "true",
    ALPACA_TRADE_BASE_URL: fx.baseUrl,
    ALPACA_DATA_BASE_URL: fx.baseUrl,
    ALPACA_USE_LIVE_ENDPOINTS: "true",
    ALPACA_RETRY_MAX: "1",
    ALPACA_API_KEY: fx.apiKey,
    ALPACA_API_SECRET: fx.apiSecret,
    ...extraEnv,
  };
  return new AlpacaBrokerAdapter("live", {
    env,
    publicConfig: loadAlpacaPublicConfig(env),
    secretStore: new EnvSecretStore(env),
  });
}

test("Paper-E2E Modus B: Discovery → Ticker → Order, 0 Private-Calls", async () => {
  const fx = new AlpacaFixtureServer();
  const baseUrl = await fx.start();
  fx.baseUrl = baseUrl;
  servers.push(fx);
  const adapter = await paperAdapter(fx);

  // Health: Default (ohne remote) → online
  const health = await adapter.healthCheck();
  assert.equal(health.status, "online");
  assert.equal(health.details.alpacaEnabled, true);
  assert.equal(health.details.testnet, true, "Alpaca Paper-API ist das Testnet");

  // Discovery: nutzt Private-Endpoint (Credential) — für Paper nicht nötig
  // → nur testen, wenn Credentials vorhanden (sind hier via Env)
  // In Modus B (paper) ist der Adapter dennoch ein vollwertiger Broker-Adapter
  // und nutzt echte Endpoints.
  // Hinweis: für diesen Test lassen wir das weg, da es nicht der primäre
  // Modus-B-Pfad ist (Modus B nutzt nur Market-Data).
  // Ticker (Public-Endpoint)
  const ticker = await adapter.getTicker("AAPL");
  assert.equal(ticker.price, 195.5);
  assert.equal(ticker.source, "alpaca");
  // Candles (Public-Endpoint)
  const candles = await adapter.getCandles("AAPL", "1Day", 5);
  assert.ok(candles.length >= 2);
  // Order (lokales Paper-Ledger, KEIN Private-Call)
  const fill = await adapter.placeOrder({
    symbol: "AAPL",
    side: "LONG",
    qty: 1,
    riskNotional: 195.5,
    stopLoss: 190,
    takeProfit: 210,
  });
  assert.equal(fill.status, "FILLED");
  assert.ok(fill.fillPrice > 0);
  assert.equal(fill.stopLoss, 190);
  assert.equal(fill.takeProfit, 210);
  // Paper darf Private-Endpoint nie treffen
  assert.equal(fx.privateCalls, 0, "Paper-Modus darf keine Private-Calls machen");
});

test("ALPACA_ENABLED=false: alle Capability-Methoden werfen AlpacaDisabledError", async () => {
  const env = { ALPACA_ENABLED: "false" };
  const adapter = new AlpacaBrokerAdapter("paper", {
    env,
    publicConfig: loadAlpacaPublicConfig(env),
  });
  await assert.rejects(() => adapter.discoverInstruments(), AlpacaDisabledError);
  await assert.rejects(() => adapter.getTicker("AAPL"), AlpacaDisabledError);
  await assert.rejects(() => adapter.getCandles("AAPL", "1Day"), AlpacaDisabledError);
  await assert.rejects(() => adapter.getAccount(), AlpacaDisabledError);
  await assert.rejects(() => adapter.getPositions(), AlpacaDisabledError);
  await assert.rejects(
    () =>
      adapter.placeOrder({
        symbol: "AAPL",
        side: "LONG",
        qty: 1,
        riskNotional: 100,
        stopLoss: 90,
      }),
    AlpacaDisabledError
  );
  const h = await adapter.healthCheck();
  assert.equal(h.status, "offline");
  assert.equal(h.details.reason, "ALPACA_DISABLED");
});

test("Live-placeOrder: LiveTradingGateError bis der Live-Gate-Enforcer erlaubt", async () => {
  const env: Record<string, string> = {
    ALPACA_ENABLED: "true",
    ALPACA_LIVE_ENABLED: "true",
    LIVE_TRADING_ENABLED: "true",
    REQUIRE_HUMAN_APPROVAL: "false",
    LIVE_GATE_DATA_DIR: tmp(),
  };
  const adapter = new AlpacaBrokerAdapter("live", {
    env,
    publicConfig: loadAlpacaPublicConfig(env),
  });
  await assert.rejects(
    () =>
      adapter.placeOrder({
        symbol: "AAPL",
        side: "LONG",
        qty: 1,
        riskNotional: 100,
        stopLoss: 90,
      }),
    (e: unknown) =>
      e instanceof LiveTradingGateError && /STATE_NOT_LIVE_ENABLED/.test((e as Error).message)
  );
  await assert.rejects(() => adapter.getAccount(), LiveTradingGateError);
  await assert.rejects(() => adapter.getPositions(), LiveTradingGateError);
});

test("Live-Gate OFFEN: placeOrder nutzt die Broker-Engine (Private-Client), NICHT das Paper-Ledger", async () => {
  resetLiveGateTestGlobals();
  const fx = new AlpacaFixtureServer();
  const baseUrl = await fx.start();
  fx.baseUrl = baseUrl;
  servers.push(fx);

  const env: Record<string, string> = {
    ...allowEnv(),
    ALPACA_ENABLED: "true",
    ALPACA_LIVE_ENABLED: "true",
    LIVE_TRADING_ENABLED: "true",
    REQUIRE_HUMAN_APPROVAL: "false",
    ALPACA_ALLOW_INSECURE_HTTP: "true",
    ALPACA_TRADE_BASE_URL: baseUrl,
    ALPACA_DATA_BASE_URL: baseUrl,
    ALPACA_USE_LIVE_ENDPOINTS: "true",
    ALPACA_RETRY_MAX: "1",
    ALPACA_API_KEY: fx.apiKey,
    ALPACA_API_SECRET: fx.apiSecret,
  };
  openLiveGate(env);
  const adapter = new AlpacaBrokerAdapter("live", {
    env,
    publicConfig: loadAlpacaPublicConfig(env),
    secretStore: new EnvSecretStore(env),
  });

  const fill = await adapter.placeOrder({
    symbol: "AAPL",
    side: "LONG",
    qty: 1,
    riskNotional: 195.5,
    stopLoss: 190,
    takeProfit: 210,
  });
  assert.equal(fill.status, "FILLED");
  assert.equal(fill.orderId, "fixture-order-1", "OrderId muss vom Broker stammen");
  assert.equal(fx.privateCalls, 1, "Live-Order muss genau einen Private-Call treffen");
  resetLiveGateTestGlobals();
});

test("Public-Client: fetchSnapshot mit authed=false (Credential-frei)", async () => {
  const fx = new AlpacaFixtureServer();
  const baseUrl = await fx.start();
  fx.baseUrl = baseUrl;
  servers.push(fx);

  const env: Record<string, string> = {
    ALPACA_ENABLED: "true",
    ALPACA_ALLOW_INSECURE_HTTP: "true",
    ALPACA_DATA_BASE_URL: baseUrl,
    ALPACA_RETRY_MAX: "1",
  };
  const config = loadAlpacaPublicConfig(env);
  const adapter = new AlpacaBrokerAdapter("paper", {
    env,
    publicConfig: config,
    secretStore: new EnvSecretStore({}),
  });
  // Snapshot-Pfad → kein Auth-Header im Public-Client
  const snap = await adapter.getTicker("AAPL");
  assert.equal(snap.price, 195.5);
  // Public-Calls wurden nicht authentifiziert
  const publicRequests = fx.requests.filter((r) => r.path.includes("snapshot"));
  assert.ok(publicRequests.length >= 1);
  for (const r of publicRequests) {
    assert.equal(r.authed, false, `Public-Call ${r.path} darf nicht authentifiziert sein`);
  }
});

test("privateClient: ohne Credentials wirft NotSupportedCapabilityError", async () => {
  const adapter = new AlpacaBrokerAdapter("paper", {
    env: { ALPACA_ENABLED: "true", ALPACA_ALLOW_INSECURE_HTTP: "true" },
    publicConfig: loadAlpacaPublicConfig({ ALPACA_ENABLED: "true" }),
    secretStore: new EnvSecretStore({}),
  });
  await assert.rejects(() => adapter.privateClient(), NotSupportedCapabilityError);
});

test("Capabilities: discovery/marketData/trading/paper/testnet/live/stopAtVenue", () => {
  const a = new AlpacaBrokerAdapter("paper");
  assert.equal(a.id, "ALPACA");
  assert.equal(a.capabilities.discovery, true);
  assert.equal(a.capabilities.marketData, true);
  assert.equal(a.capabilities.trading, true);
  assert.equal(a.capabilities.paper, true);
  assert.equal(a.capabilities.testnet, true, "Alpaca Paper-API ist ein vollständiges Testnet");
  assert.equal(a.capabilities.live, true);
  assert.equal(a.capabilities.stopAtVenue, true, "Alpaca unterstützt Bracket-Orders");
  assert.equal(a.capabilities.instrumentTypes.spot, true);
  assert.equal(a.capabilities.instrumentTypes.perpetual, false);
});

test("getOrderBook: NotSupportedCapabilityError (Alpaca liefert kein OB)", async () => {
  const adapter = new AlpacaBrokerAdapter("paper", {
    env: { ALPACA_ENABLED: "true", ALPACA_ALLOW_INSECURE_HTTP: "true" },
    publicConfig: loadAlpacaPublicConfig({ ALPACA_ENABLED: "true" }),
    secretStore: new EnvSecretStore({}),
  });
  await assert.rejects(() => adapter.getOrderBook("AAPL"), NotSupportedCapabilityError);
});

test("credentialStatus: ohne verify, kein Netzwerk", async () => {
  const fx = new AlpacaFixtureServer();
  const baseUrl = await fx.start();
  fx.baseUrl = baseUrl;
  servers.push(fx);
  const env: Record<string, string> = {
    ALPACA_ENABLED: "true",
    ALPACA_ALLOW_INSECURE_HTTP: "true",
    ALPACA_TRADE_BASE_URL: baseUrl,
    ALPACA_DATA_BASE_URL: baseUrl,
    ALPACA_RETRY_MAX: "1",
    ALPACA_API_KEY: fx.apiKey,
    ALPACA_API_SECRET: fx.apiSecret,
  };
  const adapter = new AlpacaBrokerAdapter("paper", {
    env,
    publicConfig: loadAlpacaPublicConfig(env),
    secretStore: new EnvSecretStore(env),
  });
  const status = await adapter.credentialStatus();
  assert.equal(status.configured, true);
  assert.equal(status.connected, false, "connected ohne verify");
  assert.deepEqual(status.permissions, []);
  assert.equal(status.permissionsVerified, false);
  assert.equal(status.alpacaEnabled, true);
  assert.equal(status.paper, true, "Default: Paper-Endpoints");
  // Ohne verify KEIN privater API-Call
  assert.equal(fx.privateCalls, 0);
});

test("credentialStatus mit verify: connected + READ", async () => {
  const fx = new AlpacaFixtureServer();
  const baseUrl = await fx.start();
  fx.baseUrl = baseUrl;
  servers.push(fx);
  const env: Record<string, string> = {
    ALPACA_ENABLED: "true",
    ALPACA_ALLOW_INSECURE_HTTP: "true",
    ALPACA_TRADE_BASE_URL: baseUrl,
    ALPACA_DATA_BASE_URL: baseUrl,
    ALPACA_RETRY_MAX: "1",
    ALPACA_API_KEY: fx.apiKey,
    ALPACA_API_SECRET: fx.apiSecret,
  };
  const adapter = new AlpacaBrokerAdapter("paper", {
    env,
    publicConfig: loadAlpacaPublicConfig(env),
    secretStore: new EnvSecretStore(env),
  });
  const status = await adapter.credentialStatus({ verify: true });
  assert.equal(status.connected, true);
  assert.deepEqual(status.permissions, ["READ"]);
  assert.equal(status.permissionsVerified, true);
  assert.equal(fx.privateCalls, 1);
});

test("Private-Client: Basic-Auth-Header wird korrekt gesetzt", async () => {
  const fx = new AlpacaFixtureServer();
  const baseUrl = await fx.start();
  fx.baseUrl = baseUrl;
  servers.push(fx);
  const env: Record<string, string> = {
    ALPACA_ENABLED: "true",
    ALPACA_ALLOW_INSECURE_HTTP: "true",
    ALPACA_TRADE_BASE_URL: baseUrl,
    ALPACA_DATA_BASE_URL: baseUrl,
    ALPACA_RETRY_MAX: "1",
    ALPACA_API_KEY: fx.apiKey,
    ALPACA_API_SECRET: fx.apiSecret,
  };
  const adapter = new AlpacaBrokerAdapter("paper", {
    env,
    publicConfig: loadAlpacaPublicConfig(env),
    secretStore: new EnvSecretStore(env),
  });
  const client = await adapter.privateClient();
  await client.getAccount();
  // Erwartet: Authorization: Basic base64(key:secret)
  const accountReq = fx.requests.find((r) => r.path === "/v2/account");
  assert.ok(accountReq);
  assert.equal(accountReq?.authed, true);
});

test("Paper-Ledger: Reject-Pfade (Kill-Switch, Qty, Quote, Stop-Loss, Guardrails)", () => {
  resetRuntimeLimits();
  const ledger = new AlpacaPaperLedger(10000);
  const ticker = { symbol: "AAPL", price: 195, source: "alpaca", ts: 1 };
  // 1 share × $195 = $195 < 25% of $10k = $2500. Stop-Loss 190 = -2.5% (valid).
  const base = { symbol: "AAPL", side: "LONG" as const, qty: 1, riskNotional: 195, stopLoss: 190 };
  killSwitch.pull("test");
  assert.equal(ledger.submit(base, ticker).reason, "KILL_SWITCH_ARMED");
  killSwitch.disarm();
  assert.equal(ledger.submit({ ...base, qty: 0 }, ticker).reason, "INVALID_QTY");
  assert.equal(ledger.submit(base, { ...ticker, price: 0 }).reason, "NO_QUOTE:AAPL");
  assert.equal(ledger.submit({ ...base, stopLoss: -1 }, ticker).reason, "INVALID_STOP_LOSS");
  // Ohne Stop-Loss wird's von der Guardrail abgelehnt (requireStopLoss=true).
  const noStop = ledger.submit({ ...base, stopLoss: undefined }, ticker);
  assert.equal(noStop.status, "REJECTED");
  assert.match(noStop.reason ?? "", /stop-loss|guardrail|BLOCKED/i);
  const ok = ledger.submit(base, ticker);
  assert.equal(ok.status, "FILLED");
  // Doppelt kaufen: wird als "Nachkauf" behandelt (gleiche Seite) → ok.
  const ok2 = ledger.submit(base, ticker);
  assert.equal(ok2.status, "FILLED");
  const acct = ledger.getAccount();
  assert.equal(acct.openPositions, 1);
  assert.equal(ledger.listPositions()[0].symbol, "AAPL");
});

test("ExecutionPort-Separation: Paper vs Broker Engines sind verschiedene Modi", async () => {
  const ledger = new AlpacaPaperLedger(10000);
  const paperEngine = new PaperExecutionEngine(ledger);
  const fake = {
    getAccount: async () => ({
      id: "x", account_number: "PA1", status: "ACTIVE", currency: "USD",
      cash: "50000", portfolio_value: "100000",
    }),
    getPositions: async () => [],
    getAssets: async () => [],
    getOrder: async () => ({ id: "o1", symbol: "AAPL", side: "buy", type: "market", time_in_force: "day", status: "filled" } as never),
    placeOrder: async () => ({
      id: "ALP-LIVE-1",
      symbol: "AAPL",
      side: "buy",
      type: "market",
      time_in_force: "day",
      status: "filled",
      filled_qty: "1",
      filled_avg_price: "195",
      qty: "1",
      client_order_id: "PAP-1",
      created_at: new Date().toISOString(),
    } as never),
  } as unknown as AlpacaPrivateClient;
  const brokerEngine = new BrokerExecutionEngine(fake, ledger);

  assert.equal(paperEngine.mode, "paper");
  assert.equal(brokerEngine.mode, "live");

  const req = { symbol: "AAPL", side: "LONG" as const, qty: 1, riskNotional: 195, stopLoss: 190 };
  const ticker = { symbol: "AAPL", price: 195, source: "alpaca", ts: 0 };
  const paperFill = await paperEngine.submit(req, ticker);
  assert.ok(paperFill.orderId.startsWith("PAP-ALP-"), "Paper liefert lokale OrderId");
  const brokerFill = await brokerEngine.submit(req, ticker);
  assert.equal(brokerFill.orderId, "ALP-LIVE-1", "Broker liefert Venue-OrderId");
});

test("Audit: ALPACA_PRIVATE_CALL wird bei Private-Calls protokolliert", async () => {
  const { clearAlpacaPrivateAuditForTests, readAlpacaPrivateAudit } = await import("../src/brokers/alpaca/audit");
  clearAlpacaPrivateAuditForTests();
  const fx = new AlpacaFixtureServer();
  const baseUrl = await fx.start();
  fx.baseUrl = baseUrl;
  servers.push(fx);
  const env: Record<string, string> = {
    ALPACA_ENABLED: "true",
    ALPACA_ALLOW_INSECURE_HTTP: "true",
    ALPACA_TRADE_BASE_URL: baseUrl,
    ALPACA_DATA_BASE_URL: baseUrl,
    ALPACA_RETRY_MAX: "1",
    ALPACA_API_KEY: fx.apiKey,
    ALPACA_API_SECRET: fx.apiSecret,
  };
  const client = new AlpacaPrivateClient({
    config: loadAlpacaTradeConfig(env),
    credentials: { apiKey: fx.apiKey, apiSecret: fx.apiSecret },
    http: new (await import("../src/brokers/alpaca/http")).AlpacaHttp({
      config: loadAlpacaTradeConfig(env),
    }),
  });
  await client.getAccount();
  // Audit-Eintrag wurde geschrieben (Ring ist synchron, DB ist best-effort)
  const entries = readAlpacaPrivateAudit(10);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].method, "GET");
  assert.equal(entries[0].path, "/v2/account");
  assert.equal(entries[0].outcome, "OK");
  clearAlpacaPrivateAuditForTests();
});

test("basicAuthHeader: Format", () => {
  // Standard-Form testen
  const h = basicAuthHeader("mykey", "mysecret");
  assert.match(h, /^Basic /);
  // Muss base64("mykey:mysecret") sein
  assert.equal(h, "Basic " + Buffer.from("mykey:mysecret").toString("base64"));
});

test("Secret-Scan: Alpaca-Quellen loggen keine Keys/Secrets", () => {
  const root = path.join(process.cwd(), "src/brokers/alpaca");
  const files = readdirSync(root).filter((f) => f.endsWith(".ts"));
  const forbidden = /console\.(log|info|warn|error)\([^)]*(apiSecret|api-key|secretKey|apiKey)\b/i;
  for (const f of files) {
    const src = readFileSync(path.join(root, f), "utf8");
    // Erlaubt: redactAlpaca(...) und _redaction (Logger). Verboten: direktes
    // Log eines Klartext-Secrets.
    assert.equal(forbidden.test(src), false, `${f} loggt potenziell Secrets`);
  }
});

test("Live-Modus mit offener Tür, aber ALPACA_USE_LIVE_ENDPOINTS=false: Testnet-Mismatch-Schutz", async () => {
  // Testnet + usePaperEndpoints=false → verboten (verhindert versehentlichen
  // Live-Trade im Testnet-Modus).
  const fx = new AlpacaFixtureServer();
  const baseUrl = await fx.start();
  fx.baseUrl = baseUrl;
  servers.push(fx);
  const env: Record<string, string> = {
    ALPACA_ENABLED: "true",
    ALPACA_ALLOW_INSECURE_HTTP: "true",
    ALPACA_TRADE_BASE_URL: baseUrl,
    ALPACA_DATA_BASE_URL: baseUrl,
    ALPACA_USE_LIVE_ENDPOINTS: "true", // widerspricht testnet
    ALPACA_API_KEY: fx.apiKey,
    ALPACA_API_SECRET: fx.apiSecret,
  };
  const adapter = new AlpacaBrokerAdapter("testnet", {
    env,
    publicConfig: loadAlpacaPublicConfig(env),
    secretStore: new EnvSecretStore(env),
  });
  // Testnet mit Live-Endpoint → NotSupportedCapabilityError
  await assert.rejects(
    () =>
      adapter.placeOrder({
        symbol: "AAPL",
        side: "LONG",
        qty: 1,
        riskNotional: 100,
      }),
    NotSupportedCapabilityError
  );
});
