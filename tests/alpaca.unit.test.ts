/**
 * Alpaca Unit-Tests (Task 12): Config, Secrets, Redactor, Errors,
 * Mapping, Orders, Gates, Capability-Tabelle.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ALPACA_ACCOUNT_CURRENCY,
  ALPACA_DATA_HOST,
  ALPACA_PAPER_TRADE_HOST,
  ALPACA_TRADE_HOST,
  alpacaEnabled,
  alpacaLiveEnabled,
  humanApprovalRequired,
  loadAlpacaPublicConfig,
  loadAlpacaTradeConfig,
} from "../src/brokers/alpaca/config";
import { EnvSecretStore, createDefaultAlpacaSecretStore, loadAlpacaCredentials } from "../src/brokers/alpaca/secrets";
import { classifyAlpacaFailure, safeSnippet, AlpacaApiError, AlpacaDisabledError } from "../src/brokers/alpaca/errors";
import { createAlpacaLogger, redactAlpaca, safeAlpacaErrorMessage } from "../src/brokers/alpaca/redactor";
import { mapAsset, mapAssets, mapBar, mapBars, mapOrderResult, mapPosition, mapAccount } from "../src/brokers/alpaca/mapping";
import {
  clientOrderIdFor,
  makeClientOrderId,
  OrderSerializationError,
  serializePlaceOrder,
  serializePlaceOrderJson,
} from "../src/brokers/alpaca/orders";
import { assertAlpacaEnabled, assertLiveOrderAllowed, snapshotAlpacaLiveGate } from "../src/brokers/alpaca/gates";
import { basicAuthHeader, TokenBucket } from "../src/brokers/alpaca/http";
import { LiveTradingGateError } from "../src/contracts/broker";
import { killSwitch, resetRuntimeLimits } from "../src/lib/riskGuard";

const gateDirs: string[] = [];
function tmpGateDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), "alpaca-live-gate-"));
  gateDirs.push(d);
  return d;
}
process.on("exit", () => {
  for (const d of gateDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* Cleanup best-effort. */
    }
  }
});

before(() => {
  resetRuntimeLimits();
  killSwitch.disarm();
});

after(() => {
  killSwitch.disarm();
});

test("Config: Defaults sind restriktiv (alle Flags aus, Paper-Endpoints, TLS)", () => {
  const pub = loadAlpacaPublicConfig({});
  const trade = loadAlpacaTradeConfig({});
  assert.equal(pub.enabled, false);
  assert.equal(pub.liveFlag, false);
  assert.equal(pub.platformLive, false);
  assert.equal(pub.requireHumanApproval, true);
  assert.equal(pub.usePaperEndpoints, true);
  assert.ok(pub.allowedHosts.includes(ALPACA_TRADE_HOST));
  assert.ok(pub.allowedHosts.includes(ALPACA_PAPER_TRADE_HOST));
  assert.ok(pub.allowedHosts.includes(ALPACA_DATA_HOST));
  assert.ok(trade.tradeBaseUrl.startsWith("https://"));
  assert.ok(trade.dataBaseUrl.startsWith("https://"));
  assert.equal(ALPACA_ACCOUNT_CURRENCY, "USD");
});

test("Config: ALPACA_USE_LIVE_ENDPOINTS=true schaltet Trade-URL auf Live", () => {
  const trade = loadAlpacaTradeConfig({ ALPACA_USE_LIVE_ENDPOINTS: "true" });
  assert.equal(trade.usePaperEndpoints, false);
  assert.ok(trade.tradeBaseUrl.startsWith("https://api.alpaca.markets"));
});

test("Config: Loopback-Hosts nur mit Insecure-Flag", () => {
  const def = loadAlpacaPublicConfig({});
  assert.equal(def.allowedHosts.includes("127.0.0.1"), false);
  const ins = loadAlpacaPublicConfig({ ALPACA_ALLOW_INSECURE_HTTP: "true" });
  assert.equal(ins.allowedHosts.includes("127.0.0.1"), true);
  assert.equal(ins.allowInsecureHttp, true);
});

test("Config: ALPACA_ALLOWED_HOSTS wird gemerged", () => {
  const c = loadAlpacaPublicConfig({ ALPACA_ALLOWED_HOSTS: "example.test,foo.bar" });
  assert.ok(c.allowedHosts.includes("example.test"));
  assert.ok(c.allowedHosts.includes("foo.bar"));
});

test("alpacaEnabled/alpacaLiveEnabled/humanApprovalRequired: nur exakt 'true'", () => {
  assert.equal(alpacaEnabled({}), false);
  assert.equal(alpacaEnabled({ ALPACA_ENABLED: "1" }), false);
  assert.equal(alpacaEnabled({ ALPACA_ENABLED: "true" }), true);
  assert.equal(alpacaLiveEnabled({ ALPACA_LIVE_ENABLED: "true" }), true);
  assert.equal(humanApprovalRequired({ REQUIRE_HUMAN_APPROVAL: "false" }), false);
  assert.equal(humanApprovalRequired({ REQUIRE_HUMAN_APPROVAL: "true" }), true);
  assert.equal(humanApprovalRequired({}), true, "Default: Approval erforderlich");
});

test("Errors: classifyAlpacaFailure (HTTP-Status + Venue-Code)", () => {
  assert.equal(classifyAlpacaFailure({ httpStatus: 401 }).kind, "auth");
  assert.equal(classifyAlpacaFailure({ httpStatus: 403 }).kind, "permission");
  assert.equal(classifyAlpacaFailure({ httpStatus: 422 }).kind, "validation");
  assert.equal(classifyAlpacaFailure({ httpStatus: 429 }).kind, "rate-limit");
  assert.equal(classifyAlpacaFailure({ httpStatus: 503 }).kind, "maintenance");
  assert.equal(classifyAlpacaFailure({ httpStatus: 400 }).kind, "validation");
  assert.equal(classifyAlpacaFailure({ httpStatus: 500 }).kind, "unknown");
  // Alpaca-spezifische Codes
  assert.equal(classifyAlpacaFailure({ venueCode: "40110000" }).kind, "auth");
  assert.equal(classifyAlpacaFailure({ venueCode: "42210000" }).kind, "validation");
  assert.equal(safeSnippet(null), "<leer>");
  assert.equal(safeSnippet("abc\x00def", 3), "abc");
  // AlpacaDisabledError
  const err = new AlpacaDisabledError();
  assert.equal(err.code, "ALPACA_DISABLED");
  assert.equal(err.kind, "disabled");
});

test("Redactor: Key/Secret/Basic-Auth-Header, Hex-Tokens, Logger", () => {
  const key = "super-secret-key-abc";
  const secret = "ultra-secret-xyz";
  const raw = `key=${key} secret=${secret} ALPACA_API_SECRET=${secret} APCA-API-SECRET-KEY=${secret}`;
  const red = redactAlpaca(raw, [key, secret]);
  assert.ok(!red.includes(key), "Key muss weg");
  assert.ok(!red.includes(secret), "Secret muss weg");
  assert.match(red, /\[REDACTED\]/);
  // Basic-Auth-Header
  const authLine = `Authorization: Basic ${Buffer.from(`${key}:${secret}`).toString("base64")}`;
  const redAuth = redactAlpaca(authLine, [key, secret]);
  assert.ok(!redAuth.includes(Buffer.from(`${key}:${secret}`).toString("base64")));
  // Hex-Tokens
  const hex = "a".repeat(32);
  assert.ok(!redactAlpaca(`token=${hex}`).includes(hex));
  // Logger
  const lines: string[] = [];
  const orig = console.info;
  console.info = (m: string) => {
    lines.push(m);
  };
  try {
    createAlpacaLogger(() => [secret]).info(`leak ${secret} ${hex}`);
  } finally {
    console.info = orig;
  }
  assert.ok(lines[0]?.startsWith("[alpaca] "));
  assert.ok(!lines[0]?.includes(secret));
  assert.match(safeAlpacaErrorMessage(new Error(`fail ${secret}`), [secret]), /REDACTED/);
});

test("Secrets: Env-Fallback, Trim, nie Throw mit Klartext", async () => {
  const store = new EnvSecretStore({
    ALPACA_API_KEY: " k ",
    ALPACA_API_SECRET: " s ",
  });
  const creds = await loadAlpacaCredentials(store);
  assert.deepEqual(creds, { apiKey: "k", apiSecret: "s" });
  const missing = await loadAlpacaCredentials(new EnvSecretStore({ ALPACA_API_KEY: "only" }));
  assert.equal(missing, null);
  const empty = await loadAlpacaCredentials(new EnvSecretStore({ ALPACA_API_KEY: " ", ALPACA_API_SECRET: "x" }));
  assert.equal(empty, null);
});

test("Secrets: Default-Store ohne SECRET_STORE_KEY fällt auf Env zurück", async () => {
  const prev = process.env.SECRET_STORE_KEY;
  delete process.env.SECRET_STORE_KEY;
  try {
    const store = createDefaultAlpacaSecretStore({
      ALPACA_API_KEY: "env-key-abcdef01234567",
      ALPACA_API_SECRET: "env-secret-abcdef0123",
    });
    const creds = await loadAlpacaCredentials(store);
    assert.deepEqual(creds, {
      apiKey: "env-key-abcdef01234567",
      apiSecret: "env-secret-abcdef0123",
    });
  } finally {
    if (prev !== undefined) process.env.SECRET_STORE_KEY = prev;
  }
});

test("Mapping: us_equity Asset → MarketInstrument (equity, USD)", () => {
  const now = new Date("2026-09-01T00:00:00.000Z");
  const mapped = mapAsset(
    {
      id: "aapl-id",
      class: "us_equity",
      exchange: "NASDAQ",
      symbol: "AAPL",
      name: "Apple Inc.",
      status: "active",
      tradable: true,
      marginable: true,
      shortable: true,
      easy_to_borrow: true,
      fractionable: true,
    },
    now
  );
  assert.ok(mapped);
  assert.equal(mapped.id, "ALPACA:AAPL");
  assert.equal(mapped.venue, "ALPACA");
  assert.equal(mapped.symbol, "AAPL");
  assert.equal(mapped.assetClass, "equity");
  assert.equal(mapped.marketType, "spot");
  assert.equal(mapped.status, "active");
  assert.equal(mapped.quote, "USD");
  assert.equal(mapped.base, "AAPL");
  assert.equal(mapped.shortAvailable, true);
  assert.equal(mapped.liveTradable, true);
  assert.equal(mapped.liveAvailable, false, "systemseitig gesperrt");
  assert.equal(mapped.lastSeen, now.toISOString());
});

test("Mapping: crypto Asset (BTC/USD) → MarketInstrument", () => {
  const mapped = mapAsset({
    id: "btc-id",
    class: "crypto",
    exchange: "CRYPTO",
    symbol: "BTC/USD",
    name: "Bitcoin",
    status: "active",
    tradable: true,
    marginable: false,
    shortable: false,
    fractionable: true,
  });
  assert.ok(mapped);
  assert.equal(mapped.symbol, "BTC/USD");
  assert.equal(mapped.assetClass, "crypto");
  assert.equal(mapped.marketType, "spot");
  assert.equal(mapped.base, "BTC");
  assert.equal(mapped.quote, "USD");
});

test("Mapping: Filter (inaktiv, not tradable, leeres Symbol)", () => {
  assert.equal(mapAsset({ id: "x", exchange: "X", name: "x", symbol: "AAPL", class: "us_equity", status: "inactive", tradable: true } as never), null);
  assert.equal(mapAsset({ id: "x", exchange: "X", name: "x", symbol: "AAPL", class: "us_equity", status: "active", tradable: false } as never), null);
  assert.equal(mapAsset({ id: "x", exchange: "X", name: "x", symbol: "", class: "us_equity", status: "active", tradable: true } as never), null);
  assert.equal(mapAsset(null as never), null);
  const arr = mapAssets([
    { id: "x", exchange: "X", name: "x", symbol: "AAPL", class: "us_equity", status: "active", tradable: true },
    { id: "y", exchange: "X", name: "x", symbol: "", class: "us_equity", status: "active", tradable: true },
    "x" as unknown as never,
  ]);
  assert.equal(arr.length, 1);
  assert.equal(arr[0].symbol, "AAPL");
});

test("Mapping: Bar → MarketCandle (epoch-ms, NaN-Filter)", () => {
  const now = "2026-09-01T00:00:00.000Z";
  const c = mapBar({ t: now, o: 100, h: 110, l: 90, c: 105, v: 1000 });
  assert.ok(c);
  assert.equal(c?.time, Date.parse(now));
  assert.equal(c?.close, 105);
  assert.equal(mapBar({ t: "not-a-date", o: 1, h: 1, l: 1, c: 1, v: 1 }), null);
  assert.equal(mapBar({ t: now, o: NaN, h: 1, l: 1, c: 1, v: 1 }), null);
  assert.deepEqual(mapBars([]), []);
  assert.deepEqual(mapBars(null as never), []);
  assert.deepEqual(mapBars([{ t: now, o: 100, h: 110, l: 90, c: 105, v: 1000 }]), [
    { time: Date.parse(now), open: 100, high: 110, low: 90, close: 105, volume: 1000 },
  ]);
});

test("Mapping: OrderResult/Position/Account", () => {
  const order = mapOrderResult(
    {
      id: "o1",
      symbol: "AAPL",
      side: "buy",
      qty: "10",
      filled_qty: "10",
      filled_avg_price: "195.5",
      status: "filled",
    },
    10
  );
  assert.equal(order.status, "FILLED");
  assert.equal(order.qty, 10);
  assert.equal(order.fillPrice, 195.5);
  assert.equal(order.side, "LONG");

  const rej = mapOrderResult(
    { id: "o2", symbol: "AAPL", side: "buy", qty: "10", status: "rejected" },
    10
  );
  assert.equal(rej.status, "REJECTED");
  assert.equal(rej.reason, "rejected");

  const pos = mapPosition({
    asset_id: "x",
    symbol: "AAPL",
    exchange: "NASDAQ",
    asset_class: "us_equity",
    qty: "10",
    avg_entry_price: "190",
    side: "long",
    market_value: "1955",
    cost_basis: "1900",
    unrealized_pl: "55",
    unrealized_plpc: "0.0289",
    current_price: "195.5",
    lastday_price: "194",
    change_today: "0.0077",
  });
  assert.ok(pos);
  assert.equal(pos?.side, "LONG");
  assert.equal(pos?.qty, 10);

  const acc = mapAccount(
    {
      id: "x",
      account_number: "PA1",
      status: "ACTIVE",
      currency: "USD",
      cash: "5000",
      portfolio_value: "8000",
    },
    10000
  );
  assert.equal(acc.equity, 8000);
  assert.equal(acc.cash, 5000);
  assert.equal(acc.startingEquity, 10000);
  assert.equal(acc.openPositions, 0);
  // Drawdown = (10000 - 8000) / 10000 = 0.2 → > 0
  assert.equal(acc.drawdownPct > 0, true);
});

test("Orders: LONG/SHORT Market mit SL/TP → Bracket", () => {
  const market = serializePlaceOrder({
    symbol: "AAPL",
    side: "LONG",
    qty: 10,
    riskNotional: 1950,
    stopLoss: 190,
    takeProfit: 210,
  });
  assert.equal(market.symbol, "AAPL");
  assert.equal(market.side, "buy");
  assert.equal(market.type, "market");
  assert.equal(market.time_in_force, "day");
  assert.equal(market.order_class, "bracket");
  assert.equal(market.take_profit?.limit_price, 210);
  assert.equal(market.stop_loss?.stop_price, 190);

  const limit = serializePlaceOrder({
    symbol: "AAPL",
    side: "SHORT",
    qty: 5,
    limitPrice: 200,
    riskNotional: 1000,
  });
  assert.equal(limit.side, "sell");
  assert.equal(limit.type, "limit");
  assert.equal(limit.limit_price, 200);
  assert.equal(limit.order_class, undefined);
});

test("Orders: Validierung (Symbol/Qty/Side)", () => {
  assert.throws(
    () => serializePlaceOrder({ symbol: "bad$", side: "LONG", qty: 1, riskNotional: 1 }),
    OrderSerializationError
  );
  assert.throws(
    () => serializePlaceOrder({ symbol: "AAPL", side: "LONG", qty: 0, riskNotional: 1 }),
    OrderSerializationError
  );
  assert.throws(
    () => serializePlaceOrder({ symbol: "AAPL", side: "BUY" as never, qty: 1, riskNotional: 1 }),
    OrderSerializationError
  );
  // JSON-Form muss gültiges JSON sein
  const json = serializePlaceOrderJson({ symbol: "AAPL", side: "LONG", qty: 1, riskNotional: 1 });
  assert.doesNotThrow(() => JSON.parse(json));
});

test("Orders: client_order_id (max 48 Zeichen, alphanumerisch)", () => {
  const id = clientOrderIdFor({ symbol: "BTC/USD", side: "LONG", qty: 0.01, riskNotional: 650 });
  assert.ok(id.length <= 48, `id ${id} zu lang`);
  assert.match(id, /^[A-Z0-9]+$/, `id ${id} enthält verbotene Zeichen`);
  const m = makeClientOrderId("TEST", 1700000000000);
  assert.match(m, /^[A-Z0-9]+$/);
});

test("Gates: 16 Flag-Kombinationen — Enforcer denied ohne State-Machine", () => {
  const flags = ["ALPACA_ENABLED", "ALPACA_LIVE_ENABLED", "LIVE_TRADING_ENABLED", "REQUIRE_HUMAN_APPROVAL"] as const;
  let threw = 0;
  for (let mask = 0; mask < 16; mask++) {
    const env: Record<string, string> = {};
    env.ALPACA_ENABLED = mask & 1 ? "true" : "false";
    env.ALPACA_LIVE_ENABLED = mask & 2 ? "true" : "false";
    env.LIVE_TRADING_ENABLED = mask & 4 ? "true" : "false";
    env.REQUIRE_HUMAN_APPROVAL = mask & 8 ? "false" : "true";
    env.LIVE_GATE_DATA_DIR = tmpGateDir();
    const snap = snapshotAlpacaLiveGate(env);
    const wouldAllow =
      env.ALPACA_ENABLED === "true" &&
      env.ALPACA_LIVE_ENABLED === "true" &&
      env.LIVE_TRADING_ENABLED === "true" &&
      env.REQUIRE_HUMAN_APPROVAL === "false";
    assert.equal(snap.flagsWouldAllow, wouldAllow, flags.join("+"));
    assert.equal(snap.liveGateServiceEnabled, true);
    assert.equal(snap.decision.code, "STATE_NOT_LIVE_ENABLED", flags.join("+"));
    assert.throws(() => assertLiveOrderAllowed("ALPACA", env), LiveTradingGateError);
    threw++;
  }
  assert.equal(threw, 16);
});

test("assertAlpacaEnabled: Default aus, nur exakt true", () => {
  assert.throws(() => assertAlpacaEnabled({}), AlpacaDisabledError);
  assert.throws(() => assertAlpacaEnabled({ ALPACA_ENABLED: "1" }), AlpacaDisabledError);
  assert.doesNotThrow(() => assertAlpacaEnabled({ ALPACA_ENABLED: "true" }));
});

test("HTTP: TokenBucket (Burst-Verbrauch, Refill)", async () => {
  const tb = new TokenBucket(2, 2);
  await tb.take();
  await tb.take();
  // Nach 2 Tokens muss take() mindestens einen Moment warten.
  const t0 = Date.now();
  await tb.take();
  const dt = Date.now() - t0;
  assert.ok(dt >= 400, `Erwartete Wartezeit > 400ms, war ${dt}ms`);
});

test("HTTP: basicAuthHeader (Standard-Form)", () => {
  const h = basicAuthHeader("k", "s");
  assert.match(h, /^Basic /);
  // base64("k:s") = "azpz"
  assert.equal(h, "Basic " + Buffer.from("k:s").toString("base64"));
});

test("AlpacaApiError: Code + Kind + Status", () => {
  const e = new AlpacaApiError("auth", "msg", { httpStatus: 401, venueCode: "40110000" });
  assert.equal(e.code, "ALPACA_AUTH");
  assert.equal(e.kind, "auth");
  assert.equal(e.httpStatus, 401);
  assert.equal(e.venueCode, "40110000");
  assert.equal(e instanceof Error, true);
});
