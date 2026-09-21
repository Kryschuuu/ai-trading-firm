/**
 * Kraken-Sync-Adapter — Tests (Mapper-Units + Fixture-Funnel).
 *
 * Coverage: Asset-ID-Normalisierung (X/Z-Präfix, XBT→BTC), Speicher-Symbol
 * (`wsname` primär, `altname`-Fallback, niemals geraten), Umschlag-Fehler
 * (Unknown-pair ⇒ INVALID_SYMBOL, Rate-Limit ⇒ RATE_LIMITED, 5xx-Texte ⇒
 * UPSTREAM_5XX), Intervall-Lücken (3m/2h/5d), Funnel (Discovery-Memo,
 * Bulk-Chunking, OHLC-Schnitt, Reload-bei-Fehlschlag, keine Credentials).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";

import { SyncVenuesFixtureServer } from "../../../tests/fixtures/syncVenuesFixtureServer";
import { classifyMarketDataError, MarketDataHttpError } from "../../../src/lib/marketDataErrors";
import { UnsupportedTimeframeError } from "../../../src/marketdata/errors";
import {
  KRAKEN_TIMEFRAME_MAP,
  KrakenSyncClient,
  createKrakenMarketDataAdapter,
  krakenStorageSymbol,
  mapAssetPairToInstrument,
  mapKrakenOhlc,
  mapKrakenTicker,
  normalizeKrakenAsset,
  toKrakenInterval,
  unwrapKraken,
} from "../../../src/marketdata/adapters/kraken";
import { SyncHttpClient } from "../../../src/marketdata/adapters/http";
import type { MarketDataAdapter } from "../../../src/marketdata/sync";

const servers: SyncVenuesFixtureServer[] = [];
after(async () => {
  await Promise.all(servers.map((s) => s.stop()));
});

async function harness() {
  const fx = new SyncVenuesFixtureServer();
  const base = await fx.start();
  servers.push(fx);
  const http = new SyncHttpClient({ baseUrl: base });
  const adapter = createKrakenMarketDataAdapter({
    client: new KrakenSyncClient(http),
    now: () => new Date("2026-08-29T12:00:00.000Z"),
  });
  return { fx, adapter };
}


/** Bulk-Zugriff mit hartem Setup-Fehler statt `possibly undefined`. */
function bulkOf(adapter: MarketDataAdapter): NonNullable<MarketDataAdapter["getTickers"]> {
  assert.ok(adapter.getTickers, "Adapter ohne Bulk (Test-Setup)");
  return adapter.getTickers;
}

// ── 1) Mapper-Units (kein HTTP) ─────────────────────────────────────────────

test("normalizeKrakenAsset: X/Z-Präfix nur bei 4+ Zeichen, XBT→BTC", () => {
  assert.equal(normalizeKrakenAsset("XXBT"), "BTC");
  assert.equal(normalizeKrakenAsset("XETH"), "ETH");
  assert.equal(normalizeKrakenAsset("ZUSD"), "USD");
  assert.equal(normalizeKrakenAsset("ZEUR"), "EUR");
  assert.equal(normalizeKrakenAsset("SOL"), "SOL", "3-Zeichen-Codes unangetastet");
  assert.equal(normalizeKrakenAsset("XTZ"), "XTZ", "Tezos ist kein X-Präfix");
  assert.equal(normalizeKrakenAsset("USDT"), "USDT");
  assert.equal(normalizeKrakenAsset(""), null);
  assert.equal(normalizeKrakenAsset(undefined), null);
});

test("krakenStorageSymbol: wsname primär (Seed-Schreibweise BTC/USD)", () => {
  assert.equal(
    krakenStorageSymbol("XXBTZUSD", { altname: "XBTUSD", wsname: "XBT/USD" }),
    "BTC/USD",
  );
  assert.equal(
    krakenStorageSymbol("SOLUSD", { altname: "SOLUSD", wsname: "SOL/USD" }),
    "SOL/USD",
  );
});

test("krakenStorageSymbol: base/quote-IDs vor altname-Suffix-Schnitt", () => {
  assert.equal(
    krakenStorageSymbol("XXBTZUSD", { base: "XXBT", quote: "ZUSD" }),
    "BTC/USD",
    "Asset-IDs sind eindeutig (kein Suffix-Raten)",
  );
  assert.equal(krakenStorageSymbol("XXBTZUSD", { altname: "XBTUSD" }), "BTC/USD");
  assert.equal(krakenStorageSymbol("ZEURZUSD", { altname: "EURUSD" }), "EUR/USD");
  assert.equal(krakenStorageSymbol("XXBTZCAD", { altname: "XBTCAD" }), "BTC/CAD");
  assert.equal(krakenStorageSymbol("???", {}), null, "unlösbar ⇒ null, niemals geraten");
  assert.equal(krakenStorageSymbol("???", { altname: "QQQ" }), null);
});

test("mapAssetPairToInstrument: Dezimalstellen → Ticks, Fiat/Fiat ⇒ fx", () => {
  const at = new Date("2026-08-29T12:00:00.000Z");
  const btc = mapAssetPairToInstrument(
    "XXBTZUSD",
    {
      altname: "XBTUSD",
      wsname: "XBT/USD",
      base: "XXBT",
      quote: "ZUSD",
      pair_decimals: 1,
      lot_decimals: 8,
      leverage_buy: [],
      leverage_sell: [],
    },
    at,
  );
  assert.ok(btc);
  assert.equal(btc!.id, "KRAKEN:BTC/USD");
  assert.equal(btc!.base, "BTC");
  assert.equal(btc!.quote, "USD");
  assert.equal(btc!.assetClass, "crypto");
  assert.equal(btc!.priceStep, 0.1);
  assert.equal(btc!.quantityStep, 1e-8);
  assert.equal(btc!.minQuantity, 1e-8);
  assert.equal(btc!.makerFee, 0.0016);
  assert.equal(btc!.takerFee, 0.0026);
  assert.equal(btc!.leverageAvailable, false);

  const eurusd = mapAssetPairToInstrument(
    "ZEURZUSD",
    { altname: "EURUSD", wsname: "EUR/USD", base: "ZEUR", quote: "ZUSD" },
    at,
  );
  assert.ok(eurusd);
  assert.equal(eurusd!.assetClass, "fx");

  const levered = mapAssetPairToInstrument(
    "XXBTZUSD",
    { altname: "XBTUSD", wsname: "XBT/USD", base: "XXBT", quote: "ZUSD", leverage_buy: [2, 5] },
    at,
  );
  assert.equal(levered!.leverageAvailable, true);

  assert.equal(mapAssetPairToInstrument("???", {}, at), null);
});

test("mapKrakenTicker: quoteVol = Base × Preis (Näherung), Index [1] = 24h", () => {
  const row = mapKrakenTicker("BTC/USD", {
    c: ["65000.0", "0.5"],
    v: ["100.0", "5000.0"],
    h: ["66000.0", "66000.0"],
    l: ["64000.0", "64000.0"],
  });
  assert.ok(row);
  assert.equal(row!.price, 65000);
  assert.equal(row!.quoteVol, 5000 * 65000);
  assert.equal(row!.baseVol, 5000);
  assert.equal(mapKrakenTicker("BTC/USD", { c: ["0", "0"], v: ["1", "1"] }), null);
});

test("mapKrakenOhlc: Sekunden ⇒ ms, Base-Volumen (Index 6)", () => {
  const row = mapKrakenOhlc([1_700_000_000, "100", "101", "99", "100.5", "100.2", "12.5", 42]);
  assert.deepEqual(row, {
    time: 1_700_000_000_000,
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    volume: 12.5,
  });
  assert.equal(mapKrakenOhlc([0, "100", "101", "99", "100.5", "100", "1", 1]), null);
});

test("unwrapKraken: Umschlag-Fehler → Taxonomie-Codes", () => {
  const cases: Array<{ error: string[]; reason: string; retryable: boolean }> = [
    { error: ["EQuery:Unknown asset pair: XX"], reason: "INVALID_SYMBOL", retryable: false },
    { error: ["EAPI:Rate limit exceeded"], reason: "RATE_LIMITED", retryable: true },
    { error: ["EGeneral:Service unavailable"], reason: "UPSTREAM_5XX", retryable: true },
    { error: ["EGeneral:Internal error"], reason: "UPSTREAM_5XX", retryable: true },
    { error: ["EGeneral:Invalid arguments"], reason: "UNKNOWN", retryable: false },
  ];
  for (const c of cases) {
    const err = (() => {
      try {
        unwrapKraken({ error: c.error }, "Ticker");
        return null;
      } catch (e) {
        return e;
      }
    })();
    assert.ok(err instanceof Error, c.error[0]);
    const r = classifyMarketDataError(err);
    assert.equal(r.reason, c.reason, c.error[0]);
    assert.equal(r.retryable, c.retryable, c.error[0]);
  }
  assert.deepEqual(unwrapKraken({ error: [], result: { a: 1 } }, "X"), { a: 1 });
  assert.throws(() => unwrapKraken({ error: [] }, "X"), /ohne result-Feld/);
});

test("toKrakenInterval: Minuten-Map, Lücken 3m/2h/5d werfen", () => {
  assert.equal(toKrakenInterval("1h"), 60);
  assert.equal(toKrakenInterval("4h"), 240);
  assert.equal(toKrakenInterval("1d"), 1440);
  assert.equal(Object.keys(KRAKEN_TIMEFRAME_MAP).length, 10);
  for (const gap of ["3m", "2h", "5d"]) {
    assert.throws(() => toKrakenInterval(gap), UnsupportedTimeframeError, gap);
  }
});

// ── 2) Funnel gegen den Fixture-Server ───────────────────────────────────────

test("Funnel: Discovery (BTC/USD) → Bulk → Depth → OHLC", async () => {
  const { fx, adapter } = await harness();

  const instruments = await adapter.discoverInstruments();
  assert.equal(instruments.length, 3);
  assert.deepEqual(
    instruments.map((i) => i.symbol).sort(),
    ["BTC/USD", "ETH/USD", "SOL/USD"],
  );

  const bulk = await bulkOf(adapter)(["BTC/USD", "ETH/USD", "NOPE/USD"]);
  assert.equal(bulk.length, 2, "unauflösbar ⇒ Lücke, kein Wurf");
  assert.equal(fx.count("/0/public/Ticker"), 1, "ein Bulk-Call für 2 Paare");
  assert.ok((bulk[0].quoteVol ?? 0) > 0);

  const book = await adapter.getOrderBook("BTC/USD");
  assert.ok(book.bids.length > 0 && book.asks.length > 0);

  // OHLC: Schnitt auf `limit` (Fixture liefert 200, laufende Kerze inklusive).
  const candles = await adapter.getCandles("BTC/USD", "1h", 61);
  assert.equal(candles.length, 61);
  assert.ok(candles.every((c) => (c.time ?? 0) > 0 && c.volume >= 0));

  assert.deepEqual(fx.credentialLeaks(), []);
});

test("Bulk-Chunking: 55 Paare ⇒ 2 Ticker-Calls", async () => {
  const { fx, adapter } = await harness();
  for (let i = 0; i < 52; i++) {
    const key = `TKN${i}USD`;
    fx.krakenPairs[key] = {
      altname: key,
      wsname: `TKN${i}/USD`,
      base: `TKN${i}`,
      quote: "USD",
      pair_decimals: 4,
      lot_decimals: 8,
      leverage_buy: [],
      leverage_sell: [],
    };
  }
  const instruments = await adapter.discoverInstruments();
  assert.equal(instruments.length, 55);
  const bulk = await bulkOf(adapter)();
  assert.equal(bulk.length, 55);
  assert.equal(fx.count("/0/public/Ticker"), 2, "50 + 5");
});

test("unbekanntes Paar: Reload, dann isoliertes INVALID_SYMBOL", async () => {
  const { fx, adapter } = await harness();
  const err = (await adapter.getTicker("NOPE/USD").then(
    () => null,
    (e: unknown) => e,
  )) as Error & { code?: unknown };
  assert.ok(err instanceof Error);
  assert.equal(err.code, "INVALID_SYMBOL");
  const r = classifyMarketDataError(err);
  assert.equal(r.reason, "INVALID_SYMBOL");
  assert.equal(r.retryable, false);
  assert.equal(fx.count("/0/public/AssetPairs"), 2, "Initial-Ladung + genau ein Reload, keine Schleife");
});

test("Kraken-429 (HTTP) bleibt typisiert (→ RATE_LIMITED, retryable)", async () => {
  const { fx, adapter } = await harness();
  fx.statusByPath.set("/0/public/OHLC", 429);
  const err = (await adapter.getCandles("BTC/USD", "1h", 5).then(
    () => null,
    (e: unknown) => e,
  )) as MarketDataHttpError;
  assert.ok(err instanceof MarketDataHttpError);
  assert.equal(err.httpStatus, 429);
  assert.equal(fx.count("/0/public/OHLC"), 3, "1 + 2 Retries");
  const r = classifyMarketDataError(err);
  assert.equal(r.reason, "RATE_LIMITED");
  assert.equal(r.retryable, true);
});

test("Kraken-Umschlag-Fehler bei HTTP 200 (Rate limit) ⇒ RATE_LIMITED", async () => {
  const { fx, adapter } = await harness();
  await adapter.discoverInstruments();
  fx.krakenError = ["EAPI:Rate limit exceeded"];
  const err = (await adapter.getTicker("BTC/USD").then(
    () => null,
    (e: unknown) => e,
  )) as Error;
  assert.ok(err instanceof Error);
  const r = classifyMarketDataError(err);
  assert.equal(r.reason, "RATE_LIMITED");
  assert.equal(r.retryable, true);
});
