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
import { BitunixPaperLedger } from "../src/brokers/bitunix/paper";
import { BrokerExecutionEngine, PaperExecutionEngine } from "../src/brokers/bitunix/execution";
import { mapTradingPair } from "../src/brokers/bitunix/mapping";
import { InstrumentRegistry } from "../src/universe/registry";
import { LiveTradingGateError, NotSupportedCapabilityError } from "../src/contracts/broker";
import { killSwitch, resetRuntimeLimits } from "../src/lib/riskGuard";
import {
  allowEnv,
  mockPort,
  seedState,
  resetLiveGateTestGlobals,
} from "./fixtures/liveGateTestUtil";
import {
  getLiveGateRuntime,
  registerGatePort,
  setVenueReadinessProvider,
  writeSuiteStamp,
} from "../src/live-gate";

const dirs: string[] = [];
const servers: BitunixFixtureServer[] = [];
after(async () => {
  resetRuntimeLimits();
  killSwitch.disarm();
  resetLiveGateTestGlobals();
  await Promise.all(servers.map((s) => s.stop()));
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/**
 * Öffnet das Live-Gate hermetisch (State LIVE_ENABLED + Suite-Stamp + Readiness
 * + Mock-Port) für einen env-Namen. Liefert das selbe env zurück — der Adapter
 * muss es als `env` bekommen, damit `assertLiveOrderAllowed` dieselbe Quelle liest.
 */
function openLiveGate(env: Record<string, string>): void {
  seedState(env, "BITUNIX", "LIVE_ENABLED");
  writeSuiteStamp(getLiveGateRuntime(env).dir, {
    passed: true,
    runId: "suite-live-ok",
    sha: "deadbeef",
    source: "ci",
  });
  setVenueReadinessProvider(() => ({ active: true }));
  registerGatePort("BITUNIX", mockPort());
}

/** Fake Private-Client mit Zählern — dokumentiert, welche Methoden live laufen. */
function spyPrivateClient(
  order: { status: string; filledQty: number } = { status: "NEW", filledQty: 0 }
): {
  client: BitunixPrivateClient;
  calls: { place: number; getAccount: number; getPositions: number; getOrder: number; getExecutions: number };
} {
  const calls = { place: 0, getAccount: 0, getPositions: 0, getOrder: 0, getExecutions: 0 };
  const client = {
    placeSerializedOrder: async (body: { symbol: string }) => {
      calls.place += 1;
      assert.equal(body.symbol, "BTCUSDT");
      return { orderId: "BX-LIVE-1", clientId: "c1" };
    },
    getAccount: async () => {
      calls.getAccount += 1;
      return {
        equity: 99999,
        cash: 88888,
        openPositions: 0,
        startingEquity: 99999,
        drawdownPct: 0,
      };
    },
    getPositions: async () => {
      calls.getPositions += 1;
      return [
        {
          symbol: "BTCUSDT",
          side: "LONG" as const,
          qty: 0.05,
          entryPrice: 60000,
          lastPrice: 61000,
          unrealizedPnl: 50,
          stopLoss: null,
          takeProfit: null,
        },
      ];
    },
    // H3: Order-Detail (Venue-Status) für die Reconciliation.
    getOrder: async (orderId: string) => {
      calls.getOrder += 1;
      assert.equal(orderId, "BX-LIVE-1");
      if (order.status === "MISSING") return null;
      return {
        orderId,
        symbol: "BTCUSDT",
        side: "LONG" as const,
        qty: 0.05,
        filledQty: order.filledQty,
        avgPrice: 0,
        status: order.status,
      };
    },
    // H3: Ausführungen (Trades) — die ECHTE Fill-Quelle. Bei PART_FILLED
    // liefert die Venue einen Teilfill mit echtem Preis.
    getExecutions: async () => {
      calls.getExecutions += 1;
      if (order.filledQty <= 0) return [];
      return [
        {
          tradeId: "T1",
          orderId: "BX-LIVE-1",
          symbol: "BTCUSDT",
          side: "LONG" as const,
          qty: order.filledQty,
          price: 65000,
          fee: 0.5,
          ts: 1,
        },
      ];
    },
  } as unknown as BitunixPrivateClient;
  return { client, calls };
}

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

test("Live-Gate OFFEN: placeOrder/getAccount/getPositions nutzen die Broker-Engine (Private-Client), NICHT das Paper-Ledger", async () => {
  resetLiveGateTestGlobals();
  const fx = new BitunixFixtureServer();
  const base = await fx.start();
  servers.push(fx);
  // Flags + hermetischer Gate-State + Suite + Readiness + Mock-Port = Gate OFFEN.
  const env = {
    ...allowEnv(),
    BITUNIX_BASE_URL: base,
    BITUNIX_ALLOW_INSECURE_HTTP: "true",
    BITUNIX_RETRY_MAX: "1",
  };
  openLiveGate(env);
  const { client, calls } = spyPrivateClient();
  const adapter = new BitunixBrokerAdapter("live", {
    env,
    config: loadBitunixConfig(env),
    privateClient: client,
    secretStore: new EnvSecretStore(env),
  });

  const fill = await adapter.placeOrder({
    symbol: "BTCUSDT",
    side: "LONG",
    qty: 0.05,
    riskNotional: 3000,
    stopLoss: 50000,
    takeProfit: 70000,
  });
  assert.equal(calls.place, 1, "Live-Order muss den Private-Client treffen");
  assert.equal(fill.orderId, "BX-LIVE-1", "OrderId muss vom Broker stammen, nicht vom Paper-Ledger");
  // H3: Eine akzeptierte Live-Order ist NEW (kein Fill), nicht FILLED.
  assert.equal(fill.status, "NEW", "Venue-Annahme ist NEW — kein fiktiver Fill");
  assert.equal(fill.fillPrice, 0, "Bei NEW gibt es keinen Fill-Preis");
  assert.equal(fill.reason, "ORDER_ACCEPTED");

  const acct = await adapter.getAccount();
  assert.equal(acct.equity, 99999, "Live-Account muss Broker-Daten liefern, nicht Paper-Equity 10000");
  // >= 1: die Guardrail-Vorprüfung in BrokerExecutionEngine.submit ruft das
  // Konto (Equity/Positionen) zusätzlich ab — geprüft bleibt, dass der
  // Private-Client (nicht das Paper-Ledger) die Quelle ist.
  assert.ok(calls.getAccount >= 1, "Live-Account muss den Private-Client treffen");

  const pos = await adapter.getPositions();
  assert.equal(pos.length, 1);
  assert.equal(pos[0].qty, 0.05, "Live-Positionen müssen vom Broker stammen");
  // BrokerEngine.getAccount ruft intern getPositions (openPositions) — daher >= 1.
  assert.ok(calls.getPositions >= 1, "Live-Positionen müssen den Private-Client treffen");

  // Gegenprobe: das Paper-Ledger des Modus 'paper' ist NICHT berührt (eigenes Depot).
  const paper = new BitunixBrokerAdapter("paper", {
    env,
    config: loadBitunixConfig(env),
    secretStore: new EnvSecretStore(env),
  });
  const paperAcct = await paper.getAccount();
  assert.equal(paperAcct.startingEquity, 10000, "Paper-Ledger bleibt unabhängig vom Live-Pfad");

  // Fixture hat keine signierten Private-Calls erhalten — der Live-Pfad lief über
  // den injizierten (Fake-)Private-Client, nicht über das echte Ledger.
  assert.equal(fx.privateCalls, 0);
  resetLiveGateTestGlobals();
});

test("ExecutionPort-Separation: PaperExecutionEngine vs. BrokerExecutionEngine sind verschiedene Implementierungen", async () => {
  const ledger = new BitunixPaperLedger(10000);
  const paperEngine = new PaperExecutionEngine(ledger);
  const { client: fake, calls } = spyPrivateClient();
  const brokerEngine = new BrokerExecutionEngine(fake);

  assert.equal(paperEngine.mode, "paper");
  assert.equal(brokerEngine.mode, "live");

  // Gleicher Request, gleicher Ticker → Paper simuliert lokal, Broker sendet echt.
  const req = { symbol: "BTCUSDT", side: "LONG" as const, qty: 0.01, riskNotional: 650, stopLoss: 60000 };
  const ticker = { symbol: "BTCUSDT", price: 65000, source: "bitunix", ts: 0 };
  const paperFill = await paperEngine.submit(req, ticker);
  assert.equal(paperFill.orderId.startsWith("PAP-BX-"), true, "Paper liefert lokale Ledger-OrderId");
  const brokerFill = await brokerEngine.submit(req, ticker);
  assert.equal(brokerFill.orderId, "BX-LIVE-1", "Broker liefert Venue-OrderId");
  assert.equal(calls.place, 1);

  // Paper-Konto reflektiert den lokalen Fill; Broker-Konto kommt aus der API.
  const paperAcct = await paperEngine.getAccount(() => 65000);
  assert.equal(paperAcct.openPositions, 1);
  const brokerAcct = await brokerEngine.getAccount();
  assert.equal(brokerAcct.equity, 99999);
});

test("H3: submit() live meldet nur die AKZEPTANZ (NEW, fillPrice 0) — nie FILLED", async () => {
  const { client: fake } = spyPrivateClient({ status: "NEW", filledQty: 0 });
  const engine = new BrokerExecutionEngine(fake);
  const req = { symbol: "BTCUSDT", side: "LONG" as const, qty: 0.01, riskNotional: 650, stopLoss: 60000, takeProfit: 70000 };
  const ticker = { symbol: "BTCUSDT", price: 65000, source: "bitunix", ts: 0 };

  const result = await engine.submit(req, ticker);
  assert.equal(result.status, "NEW", "akzeptierte Order ist NEW");
  assert.equal(result.fillPrice, 0, "kein fiktiver Fill-Preis");
  assert.equal(result.filledQty, 0);
  assert.equal(result.reason, "ORDER_ACCEPTED");
  assert.equal(result.orderId, "BX-LIVE-1");
  assert.equal(result.stopLoss, 60000);
  assert.equal(result.takeProfit, 70000);
});

test("H3: reconcile() mappt Venue PART_FILLED → PARTIALLY_FILLED mit echtem avgPrice", async () => {
  const { client: fake, calls } = spyPrivateClient({ status: "PART_FILLED", filledQty: 0.005 });
  const engine = new BrokerExecutionEngine(fake);
  const req = { symbol: "BTCUSDT", side: "LONG" as const, qty: 0.01, riskNotional: 650, stopLoss: 60000 };
  const ticker = { symbol: "BTCUSDT", price: 65000, source: "bitunix", ts: 0 };
  const placed = await engine.submit(req, ticker);

  const reconciled = await engine.reconcile(placed.orderId);
  assert.ok(reconciled, "reconcile liefert ein Ergebnis");
  assert.equal(calls.getOrder, 1, "Order-Detail wird abgefragt");
  assert.ok(calls.getExecutions >= 1, "Ausführungen (Trades) werden abgefragt");
  assert.equal(reconciled!.status, "PARTIALLY_FILLED", "Venue PART_FILLED → Contract PARTIALLY_FILLED");
  assert.equal(reconciled!.fillPrice, 65000, "echter avgPrice aus den Trades — nie 0");
  assert.equal(reconciled!.filledQty, 0.005);
  assert.equal(reconciled!.symbol, "BTCUSDT");
  assert.equal(reconciled!.side, "LONG");
});

test("H3: reconcile() NEW ohne Trades bleibt NEW (fillPrice 0) — keine Position einbuchen", async () => {
  const { client: fake } = spyPrivateClient({ status: "NEW", filledQty: 0 });
  const engine = new BrokerExecutionEngine(fake);
  const req = { symbol: "BTCUSDT", side: "LONG" as const, qty: 0.01, riskNotional: 650, stopLoss: 60000 };
  const placed = await engine.submit(req, { symbol: "BTCUSDT", price: 65000, source: "bitunix", ts: 0 });

  const reconciled = await engine.reconcile(placed.orderId);
  assert.equal(reconciled!.status, "NEW");
  assert.equal(reconciled!.fillPrice, 0);
  assert.equal(reconciled!.filledQty, 0);
});

test("H3: reconcile() FILLED mit Trades → FILLED mit avgPrice; ohne belegbaren Preis → UNKNOWN", async () => {
  // Vollständig gefüllt, Trades vorhanden → FILLED mit echtem Preis.
  const filled = spyPrivateClient({ status: "FILLED", filledQty: 0.01 });
  const engineFilled = new BrokerExecutionEngine(filled.client);
  const req = { symbol: "BTCUSDT", side: "LONG" as const, qty: 0.01, riskNotional: 650, stopLoss: 60000 };
  await engineFilled.submit(req, { symbol: "BTCUSDT", price: 65000, source: "bitunix", ts: 0 });
  const recFilled = await engineFilled.reconcile("BX-LIVE-1");
  assert.equal(recFilled!.status, "FILLED");
  assert.equal(recFilled!.fillPrice, 65000, "avgPrice aus Trades");
  assert.ok(recFilled!.fillPrice > 0);

  // Venue meldet FILLED, aber KEINE Trades (Preis nicht belegbar) → UNKNOWN,
  // niemals FILLED mit fillPrice 0.
  const ghost = spyPrivateClient({ status: "FILLED", filledQty: 0 });
  // filledQty 0 → getExecutions liefert []; getOrder meldet FILLED.
  (ghost.client as unknown as { getOrder: () => Promise<unknown> }).getOrder = async () => ({
    orderId: "BX-LIVE-1",
    symbol: "BTCUSDT",
    side: "LONG",
    qty: 0.01,
    filledQty: 0.01,
    avgPrice: 0,
    status: "FILLED",
  });
  const engineGhost = new BrokerExecutionEngine(ghost.client);
  await engineGhost.submit(req, { symbol: "BTCUSDT", price: 65000, source: "bitunix", ts: 0 });
  const recGhost = await engineGhost.reconcile("BX-LIVE-1");
  assert.equal(recGhost!.status, "UNKNOWN", "FILLED ohne belegbaren Preis → UNKNOWN (fail-safe)");
  assert.equal(recGhost!.fillPrice, 0, "kein 0-Entry");
  assert.equal(recGhost!.reason, "FILL_PRICE_UNKNOWN");

  // Order beim Venue nicht auffindbar → UNKNOWN / ORDER_NOT_FOUND.
  const missing = spyPrivateClient({ status: "MISSING", filledQty: 0 });
  const engineMissing = new BrokerExecutionEngine(missing.client);
  await engineMissing.submit(req, { symbol: "BTCUSDT", price: 65000, source: "bitunix", ts: 0 });
  const recMissing = await engineMissing.reconcile("BX-LIVE-1");
  assert.equal(recMissing!.status, "UNKNOWN");
  assert.equal(recMissing!.reason, "ORDER_NOT_FOUND");
});

test("H3: reconcile() CANCELED mit Teilfills → CANCELED mit avgPrice der Teilfills", async () => {
  const { client: fake } = spyPrivateClient({ status: "CANCELED", filledQty: 0.003 });
  const engine = new BrokerExecutionEngine(fake);
  const req = { symbol: "BTCUSDT", side: "LONG" as const, qty: 0.01, riskNotional: 650, stopLoss: 60000 };
  await engine.submit(req, { symbol: "BTCUSDT", price: 65000, source: "bitunix", ts: 0 });
  const rec = await engine.reconcile("BX-LIVE-1");
  assert.equal(rec!.status, "CANCELED");
  assert.equal(rec!.filledQty, 0.003);
  assert.equal(rec!.fillPrice, 65000);
});

test("H3: Adapter.reconcileOrder — live via Gate, paper liefert null", async () => {
  resetLiveGateTestGlobals();
  const fx = new BitunixFixtureServer();
  const base = await fx.start();
  servers.push(fx);
  const env = {
    ...allowEnv(),
    BITUNIX_BASE_URL: base,
    BITUNIX_ALLOW_INSECURE_HTTP: "true",
    BITUNIX_RETRY_MAX: "1",
  };
  openLiveGate(env);
  const { client, calls } = spyPrivateClient({ status: "PART_FILLED", filledQty: 0.005 });
  const live = new BitunixBrokerAdapter("live", {
    env,
    config: loadBitunixConfig(env),
    privateClient: client,
    secretStore: new EnvSecretStore(env),
  });

  const placed = await live.placeOrder({ symbol: "BTCUSDT", side: "LONG", qty: 0.05, riskNotional: 3000, stopLoss: 50000 });
  assert.equal(placed.status, "NEW");
  const rec = await live.reconcileOrder(placed.orderId);
  assert.equal(rec!.status, "PARTIALLY_FILLED");
  assert.equal(rec!.fillPrice, 65000, "echter avgPrice — Position erst jetzt buchen");
  assert.ok(calls.getOrder >= 1);

  // Paper/backtest: synchroner Fill, keine offene Live-Order → null.
  const paper = new BitunixBrokerAdapter("paper", {
    env,
    config: loadBitunixConfig(env),
    secretStore: new EnvSecretStore(env),
  });
  assert.equal(await paper.reconcileOrder("irgendwas"), null);
  resetLiveGateTestGlobals();
});

test("Semantik-Trennung: adapter.live ≠ instrument.liveTradable ≠ liveAvailable ≠ gate.state", async () => {
  // 1) Adapter-Capability: Bitunix KANN Live-Orders serialisieren.
  const caps = new BitunixBrokerAdapter("paper").capabilities;
  assert.equal(caps.live, true);

  // 2) Instrument-Capability: liveTradable (beim Broker live-handelbar) …
  const mapped = mapTradingPair({ symbol: "BTCUSDT", symbolStatus: "OPEN" });
  assert.ok(mapped);
  assert.equal(mapped.liveTradable, true);

  // 3) … ist NICHT dasselbe wie die systemseitige Freigabe liveAvailable=false.
  assert.equal(mapped.liveAvailable, false);

  // 4) Selbst bei offener Capability ist der Default-Gate-Zustand geschlossen:
  //    placeOrder im live-Modus wirft weiterhin LiveTradingGateError.
  const closed = new BitunixBrokerAdapter("live", {
    env: { ...allowEnv() }, // Flags an, aber State nicht LIVE_ENABLED → deny
    config: loadBitunixConfig(allowEnv()),
  });
  await assert.rejects(
    () => closed.placeOrder({ symbol: "BTCUSDT", side: "LONG", qty: 0.01, riskNotional: 650, stopLoss: 60000 }),
    LiveTradingGateError
  );
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
