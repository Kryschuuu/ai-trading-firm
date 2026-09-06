/**
 * Bitunix Unit-Tests (Task 07): Signatur-Goldens, Mapping, Orders,
 * Gates (16er-Matrix), Redactor, Errors, Config, Secrets.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  compactJson,
  encodeQueryParams,
  MonotonicTimestamp,
  NonceFactory,
  sha256Hex,
  signBitunixRequest,
  verifyBitunixSign,
} from "../src/brokers/bitunix/signing";
import { mapTradingPair, mapTradingPairs } from "../src/brokers/bitunix/mapping";
import { OrderSerializationError, serializePlaceOrder, serializePlaceOrderJson } from "../src/brokers/bitunix/orders";
import { assertBitunixEnabled, assertLiveOrderAllowed, snapshotLiveGate } from "../src/brokers/bitunix/gates";
import { BitunixDisabledError, classifyBitunixFailure, safeSnippet } from "../src/brokers/bitunix/errors";
import { createBitunixLogger, redactBitunix, safeErrorMessage } from "../src/brokers/bitunix/redactor";
import { loadBitunixConfig } from "../src/brokers/bitunix/config";
import { EnvSecretStore, createDefaultBitunixSecretStore, loadBitunixCredentials } from "../src/brokers/bitunix/secrets";
import { BitunixPaperLedger } from "../src/brokers/bitunix/paper";

const gateDirs: string[] = [];
/** Hermetischer Live-Gate-State-Speicher je Flag-Kombination (Task 11). */
function tmpGateDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), "bitunix-live-gate-"));
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
import { LiveTradingGateError } from "../src/contracts/broker";
import { BITUNIX_DEFAULT_MAKER_FEE, BITUNIX_DEFAULT_TAKER_FEE } from "../src/brokers/bitunix/config";
import { killSwitch, resetRuntimeLimits } from "../src/lib/riskGuard";

function expectedSign(input: {
  nonce: string;
  timestamp: string;
  apiKey: string;
  secret: string;
  queryParams?: string;
  body?: string;
}) {
  const digest = createHash("sha256")
    .update(input.nonce + input.timestamp + input.apiKey + (input.queryParams ?? "") + (input.body ?? ""), "utf8")
    .digest("hex");
  const sign = createHash("sha256").update(digest + input.secret, "utf8").digest("hex");
  return { digest, sign };
}

test("Signing-Golden 1: offizielles Doku-Beispiel (id1uid200 + uid-Body)", () => {
  const input = {
    nonce: "123456",
    timestamp: "20241120123045",
    apiKey: "yourApiKey",
    secret: "yourSecretKey",
    queryParams: "id1uid200",
    body: '{"uid":"2899"}',
  };
  const got = signBitunixRequest(input);
  const exp = expectedSign(input);
  assert.equal(got.digest, "2afbe5b84c60cd282534783e77410b44ed17f4ba66facce2a33150dd866a0794");
  assert.equal(got.sign, "018fe88fda21ec2c852b0f83750c4054c3ae4751a2af67f68d1c7c66fcd76736");
  assert.deepEqual(got, exp);
  assert.equal(verifyBitunixSign(input, got.sign), true);
  assert.equal(verifyBitunixSign(input, "00" + got.sign.slice(2)), false);
});

test("Signing-Golden 2: leere Felder", () => {
  const input = { nonce: "", timestamp: "", apiKey: "", secret: "", queryParams: "", body: "" };
  const got = signBitunixRequest(input);
  assert.equal(got.digest, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(got.sign, "cd372fb85148700fa88095e3492d3f9f5beb43e555e5ff26d95f5a6adc36f8e6");
  assert.deepEqual(got, expectedSign(input));
});

test("Signing-Golden 3: Unicode-Body", () => {
  const input = {
    nonce: "nonce",
    timestamp: "ts",
    apiKey: "key",
    secret: "secret",
    queryParams: "",
    body: '{"note":"ä€"}',
  };
  const got = signBitunixRequest(input);
  assert.equal(got.digest, "8e0260309b92c0557df10dc7fd36cd4e369b73b285404c2771491827d95ac402");
  assert.equal(got.sign, "60d775f743e60ff30e13a0d80f250f4f8433738647c78e3cc3feeebc8bc9723c");
  assert.deepEqual(got, expectedSign(input));
});

test("Signing-Golden 4: Query mit Sonderzeichen, ASCII-sortiert", () => {
  const queryParams = encodeQueryParams({ a: "1", z: "x&y", m: "=" });
  assert.equal(queryParams, "a1m=zx&y");
  const input = { nonce: "n", timestamp: "t", apiKey: "k", secret: "s", queryParams, body: "" };
  const got = signBitunixRequest(input);
  assert.equal(got.digest, "68460671b6225bec20e2fa2913ced2ca96051e8f36e2d70fcfa2b0e0b8a268f8");
  assert.equal(got.sign, "500b99e25155f257ff734d34adf822471ff9b95ed2d5722630ecc7ba37fcdfd3");
});

test("Signing-Golden 5: Place-Order-Body (SL/TP, compact JSON)", () => {
  const body = compactJson({
    symbol: "BTCUSDT",
    qty: "0.01",
    side: "BUY",
    tradeSide: "OPEN",
    orderType: "MARKET",
    slPrice: "60000",
    tpPrice: "70000",
  });
  const input = {
    nonce: "abc",
    timestamp: "1700000000000",
    apiKey: "ak",
    secret: "sk",
    queryParams: "",
    body,
  };
  const got = signBitunixRequest(input);
  assert.equal(got.digest, "7a134c56a026df8281c897318f7677631bd5347f761431363ec253f67873b3ca");
  assert.equal(got.sign, "5b4f6ae0a55b7d7628af08cab7684c4f37c911104d9d8bc1b91c9826b3940a86");
  assert.equal(verifyBitunixSign(input, got.sign), true);
  assert.equal(verifyBitunixSign(input, ""), false);
});

test("encodeQueryParams lässt leere/null-Werte weg und sortiert Keys", () => {
  assert.equal(encodeQueryParams({ b: "2", a: "1", c: "", d: null, e: undefined }), "a1b2");
  assert.equal(compactJson(null), "");
  assert.equal(compactJson(""), "");
  assert.equal(compactJson({ a: 1 }), '{"a":1}');
  assert.equal(sha256Hex("abc"), createHash("sha256").update("abc", "utf8").digest("hex"));
});

test("NonceFactory: 64 Werte eindeutig im Fenster", () => {
  const n = new NonceFactory(8);
  const seen = new Set<string>();
  for (let i = 0; i < 64; i++) seen.add(n.next());
  assert.equal(seen.size, 64);
  assert.equal(n.size, 8, "Fenster kapt auf windowSize");
  assert.equal(n.has("nope"), false);
});

test("MonotonicTimestamp: Wanduhr darf nicht zurückspringen", () => {
  let clock = 1000;
  const ts = new MonotonicTimestamp(() => clock);
  assert.equal(ts.next(), "1000");
  clock = 999;
  assert.equal(ts.next(), "1001");
  clock = 5000;
  assert.equal(ts.next(), "5000");
  assert.equal(ts.lastValue, 5000);
});

test("Mapping: trading_pairs → MarketInstrument (perpetual, Fees, Status)", () => {
  const now = new Date("2026-08-27T00:00:00.000Z");
  const mapped = mapTradingPair(
    {
      symbol: "btcusdt",
      base: "btc",
      quote: "usdt",
      minTradeVolume: "0.001",
      basePrecision: 3,
      quotePrecision: 1,
      maxLeverage: 125,
      symbolStatus: "OPEN",
      unknown: true,
    },
    now
  );
  assert.ok(mapped);
  assert.equal(mapped.id, "BITUNIX:BTCUSDT");
  assert.equal(mapped.venue, "BITUNIX");
  assert.equal(mapped.marketType, "perpetual");
  assert.equal(mapped.assetClass, "crypto");
  assert.equal(mapped.status, "active");
  assert.equal(mapped.leverageAvailable, true);
  assert.equal(mapped.shortAvailable, true);
  // liveTradable = Instrument ist beim Broker live-handelbar (Fähigkeit),
  // liveAvailable = systemseitige Freigabe (bleibt false) — getrennte Konzepte.
  assert.equal(mapped.liveTradable, true);
  assert.equal(mapped.liveAvailable, false);
  assert.equal(mapped.makerFee, BITUNIX_DEFAULT_MAKER_FEE);
  assert.equal(mapped.takerFee, BITUNIX_DEFAULT_TAKER_FEE);
  assert.equal(mapped.quantityStep, 0.001);
  assert.equal(mapped.priceStep, 0.1);
  assert.equal(mapped.lastSeen, now.toISOString());
});

test("Mapping: CANCEL_ONLY/STOP/unknown Status, kaputte Zeilen übersprungen", () => {
  const halt = mapTradingPair({ symbol: "ETHUSDT", symbolStatus: "CANCEL_ONLY" });
  assert.equal(halt?.status, "halted");
  const stop = mapTradingPair({ symbol: "SOLUSDT", symbolStatus: "STOP" });
  assert.equal(stop?.status, "halted");
  const preview = mapTradingPair({ symbol: "XRPUSDT", symbolStatus: "WEIRD" });
  assert.equal(preview?.status, "preview");
  assert.equal(mapTradingPair({ symbol: "??" }), null);
  assert.equal(mapTradingPair({} as never), null);
  const batch = mapTradingPairs([{ symbol: "BTCUSDT" }, { symbol: "nope!" }, "x"]);
  assert.equal(batch.length, 1);
  assert.equal(batch[0].symbol, "BTCUSDT");
  assert.deepEqual(mapTradingPairs(null), []);
});

test("Orders: LONG MARKET mit SL/TP, SHORT LIMIT, Validierung", () => {
  const market = serializePlaceOrder({
    symbol: "btcusdt",
    side: "LONG",
    qty: 0.01,
    riskNotional: 650,
    stopLoss: 60000,
    takeProfit: 70000,
  });
  assert.equal(market.side, "BUY");
  assert.equal(market.tradeSide, "OPEN");
  assert.equal(market.orderType, "MARKET");
  assert.equal(market.slPrice, "60000");
  assert.equal(market.tpPrice, "70000");
  assert.equal(market.slStopType, "LAST_PRICE");
  assert.equal(market.tpOrderType, "MARKET");
  const limit = serializePlaceOrder({
    symbol: "ETHUSDT",
    side: "SHORT",
    qty: 1,
    limitPrice: 3300,
    riskNotional: 3300,
  });
  assert.equal(limit.side, "SELL");
  assert.equal(limit.orderType, "LIMIT");
  assert.equal(limit.price, "3300");
  assert.equal(limit.effect, "GTC");
  assert.match(serializePlaceOrderJson({ symbol: "BTCUSDT", side: "LONG", qty: 1, riskNotional: 1 }), /BTCUSDT/);
  assert.throws(() => serializePlaceOrder({ symbol: "bad$", side: "LONG", qty: 1, riskNotional: 1 }), OrderSerializationError);
  assert.throws(() => serializePlaceOrder({ symbol: "BTCUSDT", side: "LONG", qty: 0, riskNotional: 1 }), OrderSerializationError);
});

test("Orders (B1): SL/TP-Geometrie — inkorrekte Staffelung wird abgelehnt, korrekte akzeptiert", () => {
  // LONG: StopLoss-Referenz = Limit-Preis (Entry). SL muss UNTER, TP ÜBER dem Entry liegen.
  assert.throws(
    () =>
      serializePlaceOrder({
        symbol: "BTCUSDT",
        side: "LONG",
        qty: 0.01,
        limitPrice: 65000,
        riskNotional: 650,
        stopLoss: 65001, // SL >= Entry → Fehler
      }),
    OrderSerializationError
  );
  assert.throws(
    () =>
      serializePlaceOrder({
        symbol: "BTCUSDT",
        side: "LONG",
        qty: 0.01,
        limitPrice: 65000,
        riskNotional: 650,
        takeProfit: 64999, // TP <= Entry → Fehler
      }),
    OrderSerializationError
  );
  // LONG korrekte Geometrie: SL unter, TP über dem Entry.
  const longOk = serializePlaceOrder({
    symbol: "BTCUSDT",
    side: "LONG",
    qty: 0.01,
    limitPrice: 65000,
    riskNotional: 650,
    stopLoss: 60000,
    takeProfit: 70000,
  });
  assert.equal(longOk.slPrice, "60000");
  assert.equal(longOk.tpPrice, "70000");

  // SHORT gespiegelt: SL muss ÜBER, TP UNTER dem Entry liegen.
  assert.throws(
    () =>
      serializePlaceOrder({
        symbol: "ETHUSDT",
        side: "SHORT",
        qty: 1,
        limitPrice: 3300,
        riskNotional: 3300,
        stopLoss: 3299, // SL <= Entry → Fehler
      }),
    OrderSerializationError
  );
  assert.throws(
    () =>
      serializePlaceOrder({
        symbol: "ETHUSDT",
        side: "SHORT",
        qty: 1,
        limitPrice: 3300,
        riskNotional: 3300,
        takeProfit: 3301, // TP >= Entry → Fehler
      }),
    OrderSerializationError
  );
  const shortOk = serializePlaceOrder({
    symbol: "ETHUSDT",
    side: "SHORT",
    qty: 1,
    limitPrice: 3300,
    riskNotional: 3300,
    stopLoss: 3400,
    takeProfit: 3200,
  });
  assert.equal(shortOk.slPrice, "3400");
  assert.equal(shortOk.tpPrice, "3200");

  // MARKET ohne festen Entry (kein limitPrice/markPriceHint): Geometrie nicht prüfbar
  // → überspringen (kein falscher Deny). Regression des Engine-Pfads.
  const marketNoHint = serializePlaceOrder({
    symbol: "BTCUSDT",
    side: "LONG",
    qty: 0.01,
    riskNotional: 650,
    stopLoss: 60000,
    takeProfit: 70000,
  });
  assert.equal(marketNoHint.orderType, "MARKET");
  assert.equal(marketNoHint.slPrice, "60000");
  assert.equal(marketNoHint.tpPrice, "70000");

  // MARKET MIT markPriceHint nutzt diesen als Entry-Bezugspunkt (B1).
  assert.throws(
    () =>
      serializePlaceOrder({
        symbol: "BTCUSDT",
        side: "LONG",
        qty: 0.01,
        riskNotional: 650,
        markPriceHint: 65000,
        stopLoss: 65001,
      }),
    OrderSerializationError
  );
  const marketHintOk = serializePlaceOrder({
    symbol: "BTCUSDT",
    side: "SHORT",
    qty: 0.01,
    riskNotional: 650,
    markPriceHint: 65000,
    stopLoss: 66000,
    takeProfit: 64000,
  });
  assert.equal(marketHintOk.orderType, "MARKET");
  assert.equal(marketHintOk.slPrice, "66000");
  assert.equal(marketHintOk.tpPrice, "64000");
});

test("Gates: 16 Flag-Kombinationen — Enforcer (Task 11) denied ohne State-Machine", () => {
  const flags = ["BITUNIX_ENABLED", "BITUNIX_LIVE_ENABLED", "LIVE_TRADING_ENABLED", "REQUIRE_HUMAN_APPROVAL"] as const;
  let threw = 0;
  for (let mask = 0; mask < 16; mask++) {
    const env: Record<string, string> = {};
    env.BITUNIX_ENABLED = mask & 1 ? "true" : "false";
    env.BITUNIX_LIVE_ENABLED = mask & 2 ? "true" : "false";
    env.LIVE_TRADING_ENABLED = mask & 4 ? "true" : "false";
    env.REQUIRE_HUMAN_APPROVAL = mask & 8 ? "false" : "true";
    // Hermetischer Gate-State-Speicher (kein State-File => DISCONNECTED).
    env.LIVE_GATE_DATA_DIR = tmpGateDir();
    const snap = snapshotLiveGate(env);
    const wouldAllow =
      env.BITUNIX_ENABLED === "true" &&
      env.BITUNIX_LIVE_ENABLED === "true" &&
      env.LIVE_TRADING_ENABLED === "true" &&
      env.REQUIRE_HUMAN_APPROVAL === "false";
    assert.equal(snap.flagsWouldAllow, wouldAllow, flags.join("+"));
    // Seit Task 11 ist der zentrale Enforcer aktiv:
    assert.equal(snap.liveGateServiceEnabled, true);
    assert.equal(snap.decision.code, "STATE_NOT_LIVE_ENABLED", flags.join("+"));
    assert.throws(() => assertLiveOrderAllowed("BITUNIX", env), LiveTradingGateError);
    threw++;
  }
  assert.equal(threw, 16);
  const complete = {
    BITUNIX_ENABLED: "true",
    BITUNIX_LIVE_ENABLED: "true",
    LIVE_TRADING_ENABLED: "true",
    REQUIRE_HUMAN_APPROVAL: "false",
    LIVE_GATE_DATA_DIR: tmpGateDir(),
  };
  try {
    assertLiveOrderAllowed("BITUNIX", complete);
    assert.fail("sollte werfen");
  } catch (e) {
    assert.ok(e instanceof LiveTradingGateError);
    // Flags allein genügen NICHT: State-Machine + Suite + Control Plane fehlen.
    assert.match((e as Error).message, /STATE_NOT_LIVE_ENABLED|SECURITY_SUITE|CONTROL_PLANE/);
  }
});

test("assertBitunixEnabled: Default aus, nur exakt true", () => {
  assert.throws(() => assertBitunixEnabled({}), BitunixDisabledError);
  assert.throws(() => assertBitunixEnabled({ BITUNIX_ENABLED: "1" }), BitunixDisabledError);
  assert.doesNotThrow(() => assertBitunixEnabled({ BITUNIX_ENABLED: "true" }));
});

test("classifyBitunixFailure + safeSnippet", () => {
  assert.equal(classifyBitunixFailure({ venueCode: 10007 }).kind, "auth");
  assert.equal(classifyBitunixFailure({ httpStatus: 401 }).kind, "auth");
  assert.equal(classifyBitunixFailure({ httpStatus: 403 }).kind, "permission");
  assert.equal(classifyBitunixFailure({ venueCode: 10006 }).kind, "permission");
  assert.equal(classifyBitunixFailure({ httpStatus: 429 }).kind, "rate-limit");
  assert.equal(classifyBitunixFailure({ venueCode: 10001 }).kind, "rate-limit");
  assert.equal(classifyBitunixFailure({ httpStatus: 503 }).kind, "maintenance");
  assert.equal(classifyBitunixFailure({ venueMsg: "under maintenance" }).kind, "maintenance");
  assert.equal(classifyBitunixFailure({ httpStatus: 400 }).kind, "unknown");
  assert.equal(safeSnippet("abc\x00def", 3), "abc");
  assert.equal(safeSnippet(null), "<leer>");
});

test("Redactor: Keys, Hex-Tokens, Header-Muster, Logger", () => {
  const secret = "super-secret-value-xyz";
  const hex = "a".repeat(32);
  const raw = `api-key=${secret} sign=${hex} BITUNIX_API_SECRET=${secret} token=${hex}`;
  const red = redactBitunix(raw, [secret]);
  assert.ok(!red.includes(secret), red);
  assert.ok(!red.includes(hex), red);
  assert.match(red, /\[REDACTED\]/);
  const lines: string[] = [];
  const orig = console.info;
  console.info = (m: string) => {
    lines.push(m);
  };
  try {
    createBitunixLogger(() => [secret]).info(`leak ${secret} ${hex}`);
  } finally {
    console.info = orig;
  }
  assert.ok(lines[0]?.startsWith("[bitunix] "));
  assert.ok(!lines[0]?.includes(secret));
  assert.match(safeErrorMessage(new Error(`fail ${secret}`), [secret]), /REDACTED/);
});

test("Config-Defaults: Flags aus, Loopback nur mit Insecure-Flag", () => {
  const def = loadBitunixConfig({});
  assert.equal(def.enabled, false);
  assert.equal(def.liveFlag, false);
  assert.equal(def.platformLive, false);
  assert.equal(def.requireHumanApproval, true);
  assert.ok(def.allowedHosts.includes("fapi.bitunix.com"));
  assert.equal(def.allowedHosts.includes("127.0.0.1"), false);
  const testCfg = loadBitunixConfig({
    BITUNIX_ALLOW_INSECURE_HTTP: "true",
    BITUNIX_ALLOWED_HOSTS: "example.test",
    BITUNIX_BASE_URL: "http://127.0.0.1:9/",
  });
  assert.ok(testCfg.allowedHosts.includes("127.0.0.1"));
  assert.ok(testCfg.allowedHosts.includes("example.test"));
  assert.equal(testCfg.restBaseUrl, "http://127.0.0.1:9");
  assert.equal(testCfg.allowInsecureHttp, true);
});

test("Secrets: Env-Fallback, nie Throw mit Klartext", async () => {
  const store = new EnvSecretStore({ BITUNIX_API_KEY: " k ", BITUNIX_API_SECRET: " s " });
  const creds = await loadBitunixCredentials(store);
  assert.deepEqual(creds, { apiKey: "k", apiSecret: "s" });
  const missing = await loadBitunixCredentials(new EnvSecretStore({ BITUNIX_API_KEY: "only" }));
  assert.equal(missing, null);
  const empty = await loadBitunixCredentials(new EnvSecretStore({ BITUNIX_API_KEY: " ", BITUNIX_API_SECRET: "x" }));
  assert.equal(empty, null);
});

test("Secrets: Default-Store ohne SECRET_STORE_KEY — SEC-07 fail-closed, kein Env-Fallback ohne Flag", async () => {
  const prev = process.env.SECRET_STORE_KEY;
  const prevNode = process.env.NODE_ENV;
  delete process.env.SECRET_STORE_KEY;
  (process.env as any).NODE_ENV = "production";
  try {
    const store = createDefaultBitunixSecretStore({
      BITUNIX_API_KEY: "env-key-abcdef01234567",
      BITUNIX_API_SECRET: "env-secret-abcdef0123",
      NODE_ENV: "production",
    });
    const creds = await loadBitunixCredentials(store);
    assert.equal(creds, null);
  } finally {
    if (prev !== undefined) process.env.SECRET_STORE_KEY = prev;
    else delete process.env.SECRET_STORE_KEY;
    (process.env as any).NODE_ENV = prevNode;
  }
});

test("Secrets: Default-Store ohne SECRET_STORE_KEY — mit BROKER_ALLOW_ENV_FALLBACK in Dev faellt auf Env", async () => {
  const prev = process.env.SECRET_STORE_KEY;
  delete process.env.SECRET_STORE_KEY;
  try {
    const store = createDefaultBitunixSecretStore({
      BITUNIX_API_KEY: "env-key-abcdef01234567",
      BITUNIX_API_SECRET: "env-secret-abcdef0123",
      BROKER_ALLOW_ENV_FALLBACK: "true",
      NODE_ENV: "development",
    });
    const creds = await loadBitunixCredentials(store);
    assert.deepEqual(creds, {
      apiKey: "env-key-abcdef01234567",
      apiSecret: "env-secret-abcdef0123",
    });
  } finally {
    if (prev !== undefined) process.env.SECRET_STORE_KEY = prev;
    else delete process.env.SECRET_STORE_KEY;
  }
});

test("Mapping: base/quote-Inferenz aus Suffix, Fees-Default, Precision-Fallback", () => {
  const inferred = mapTradingPair({ symbol: "BTCUSDT", maxLeverage: 1, basePrecision: 99, quotePrecision: -1 });
  assert.equal(inferred?.base, "BTC");
  assert.equal(inferred?.quote, "USDT");
  assert.equal(inferred?.leverageAvailable, false);
  assert.equal(inferred?.quantityStep, 1e-8);
  assert.equal(inferred?.priceStep, 0.01);
  assert.equal(mapTradingPair({ symbol: "XXXX" }), null);
  assert.equal(mapTradingPair(null as never), null);
  assert.equal(compactJson(undefined), "");
  assert.equal(verifyBitunixSign({ nonce: "n", timestamp: "t", apiKey: "k", secret: "s" }, "ab"), false);
  assert.equal(redactBitunix(""), "");
  assert.match(safeErrorMessage("plain"), /plain/);
  assert.match(safeErrorMessage(12), /unbekannter Fehler/);
});

test("Paper-Ledger: Reject-Pfade (Kill-Switch, Qty, Quote, Nachkauf)", () => {
  resetRuntimeLimits();
  const ledger = new BitunixPaperLedger(10000);
  const ticker = { symbol: "BTCUSDT", price: 65000, source: "bitunix", ts: 1 };
  const base = { symbol: "BTCUSDT", side: "LONG" as const, qty: 0.01, riskNotional: 650, stopLoss: 60000 };
  killSwitch.pull("test");
  assert.equal(ledger.submit(base, ticker).reason, "KILL_SWITCH_ARMED");
  killSwitch.disarm();
  assert.equal(ledger.submit({ ...base, qty: 0 }, ticker).reason, "INVALID_QTY");
  assert.equal(ledger.submit(base, { ...ticker, price: 0 }).reason, "NO_QUOTE:BTCUSDT");
  assert.equal(ledger.submit({ ...base, stopLoss: -1 }, ticker).reason, "INVALID_STOP_LOSS");
  const ok = ledger.submit(base, ticker);
  assert.equal(ok.status, "FILLED");
  assert.equal(ledger.submit(base, ticker).reason?.startsWith("POSITION_ALREADY_OPEN"), true);
  const acct = ledger.getAccount();
  assert.equal(acct.openPositions, 1);
  assert.equal(ledger.listPositions()[0].symbol, "BTCUSDT");
});
