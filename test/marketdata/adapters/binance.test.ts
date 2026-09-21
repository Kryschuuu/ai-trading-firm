/**
 * Binance-Sync-Adapter — Tests (Mapper-Units + Fixture-Funnel).
 *
 * Coverage: `exchangeInfo`→Instrument (Filter-Fallbacks, Status-Mapping),
 * Ticker/Kline-Mapper (ungültige Zeilen ⇒ `null`, Base-vs-Quote-Volumen),
 * Timeframe-Map (5d-Lücke), Funnel gegen den Fixture-Server (Discovery, Bulk,
 * Depth, Klines, 400/429-Verhalten, keine Credentials).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";

import { SyncVenuesFixtureServer } from "../../../tests/fixtures/syncVenuesFixtureServer";
import { MarketDataHttpError } from "../../../src/lib/marketDataErrors";
import { UnsupportedTimeframeError } from "../../../src/marketdata/errors";
import {
  BINANCE_TIMEFRAME_MAP,
  BinanceSyncClient,
  createBinanceMarketDataAdapter,
  mapBinanceKline,
  mapBinanceStatus,
  mapBinanceTicker,
  mapExchangeSymbolToInstrument,
  toBinanceInterval,
} from "../../../src/marketdata/adapters/binance";
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
  const adapter = createBinanceMarketDataAdapter({
    client: new BinanceSyncClient(http),
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

test("mapExchangeSymbolToInstrument: Filter → Ticks, Status → halted/delisted, Fallbacks", () => {
  const at = new Date("2026-08-29T12:00:00.000Z");
  const good = mapExchangeSymbolToInstrument(
    {
      symbol: "BTCUSDT",
      status: "TRADING",
      baseAsset: "BTC",
      quoteAsset: "USDT",
      filters: [
        { filterType: "PRICE_FILTER", tickSize: "0.01" },
        { filterType: "LOT_SIZE", minQty: "0.00001", stepSize: "0.00001" },
      ],
    },
    at,
  );
  assert.ok(good);
  assert.equal(good!.id, "BINANCE:BTCUSDT");
  assert.equal(good!.base, "BTC");
  assert.equal(good!.quote, "USDT");
  assert.equal(good!.status, "active");
  assert.equal(good!.priceStep, 0.01);
  assert.equal(good!.minQuantity, 0.00001);
  assert.equal(good!.quantityStep, 0.00001);
  assert.equal(good!.makerFee, 0.001);
  assert.equal(good!.takerFee, 0.001);
  assert.equal(good!.shortAvailable, false);
  assert.equal(good!.liveAvailable, false);
  assert.equal(good!.lastSeen, "2026-08-29T12:00:00.000Z");

  // Status-Mapping: handelbar ⇒ aktiv, pausiert ⇒ halted, Rest ⇒ delisted.
  assert.equal(mapBinanceStatus("TRADING"), "active");
  assert.equal(mapBinanceStatus("HALT"), "halted");
  assert.equal(mapBinanceStatus("BREAK"), "halted");
  assert.equal(mapBinanceStatus("PRE_TRADING"), "delisted");

  // Fehlende Filter ⇒ venue-sichere Minima (niemals NaN/0).
  const noFilters = mapExchangeSymbolToInstrument(
    { symbol: "XRPUSDT", status: "TRADING", baseAsset: "XRP", quoteAsset: "USDT" },
    at,
  );
  assert.ok(noFilters);
  assert.equal(noFilters!.minQuantity, 1e-8);
  assert.equal(noFilters!.quantityStep, 1e-8);
  assert.equal(noFilters!.priceStep, 0.01);

  // Unbrauchbar ⇒ null (Blocklist): kein Symbol, keine Assets.
  assert.equal(
    mapExchangeSymbolToInstrument({ symbol: "", status: "TRADING", baseAsset: "X", quoteAsset: "USDT" }, at),
    null,
  );
  assert.equal(
    mapExchangeSymbolToInstrument({ symbol: "XUSDT", status: "TRADING", baseAsset: "", quoteAsset: "USDT" }, at),
    null,
  );
});

test("mapBinanceTicker: Quote-Volumen, unbrauchbare Zeilen ⇒ null", () => {
  const row = mapBinanceTicker({
    symbol: "BTCUSDT",
    lastPrice: "65000.5",
    quoteVolume: "120000000",
    volume: "1846.15",
    highPrice: "66000",
    lowPrice: "64000",
    closeTime: 1_700_000_000_000,
  });
  assert.ok(row);
  assert.equal(row!.symbol, "BTCUSDT");
  assert.equal(row!.price, 65000.5);
  assert.equal(row!.quoteVol, 120_000_000, "quoteVol = Quote-Volumen, nicht Base");
  assert.equal(row!.baseVol, 1846.15);
  assert.equal(row!.source, "binance");

  assert.equal(mapBinanceTicker({ symbol: "BTCUSDT", lastPrice: "n/a", quoteVolume: "1" }), null);
  assert.equal(mapBinanceTicker({ symbol: "BTCUSDT", lastPrice: "0", quoteVolume: "1" }), null);
  assert.equal(mapBinanceTicker({ symbol: "", lastPrice: "1", quoteVolume: "1" }), null);
});

test("mapBinanceKline: Base-Volumen (Index 5), ungültige Zeilen ⇒ null", () => {
  const row = mapBinanceKline([1_700_000_000_000, "100", "101", "99", "100.5", "12.5", 1, "1250", 5]);
  assert.deepEqual(row, {
    time: 1_700_000_000_000,
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    volume: 12.5,
  });
  assert.equal(mapBinanceKline([1, "100", "101", "99", "100.5", "-1"]), null, "negatives Volumen");
  assert.equal(mapBinanceKline([1, "100", "101", "99", "0", "1"]), null, "Close 0");
  assert.equal(mapBinanceKline([1, "100"] as never), null, "zu kurz");
  assert.equal(mapBinanceKline("nonsense" as never), null);
});

test("toBinanceInterval: 9 Intervalle, 5d-Lücke wirft", () => {
  assert.equal(toBinanceInterval("1h"), "1h");
  assert.equal(toBinanceInterval("3m"), "3m");
  assert.equal(Object.keys(BINANCE_TIMEFRAME_MAP).length, 10);
  assert.throws(() => toBinanceInterval("5d"), UnsupportedTimeframeError);
  assert.throws(() => toBinanceInterval("9m"), UnsupportedTimeframeError);
});

// ── 2) Funnel gegen den Fixture-Server ───────────────────────────────────────

test("Funnel: Discovery → Bulk → Depth → Klines", async () => {
  const { fx, adapter } = await harness();

  const instruments = await adapter.discoverInstruments();
  assert.equal(instruments.length, 3);
  assert.deepEqual(
    instruments.map((i) => i.symbol).sort(),
    ["BTCUSDT", "ETHUSDT", "SOLUSDT"],
  );
  assert.ok(instruments.every((i) => i.id.startsWith("BINANCE:") && i.status === "active"));

  // Bulk: EIN Request, Filterung client-seitig.
  const bulk = await bulkOf(adapter)(["BTCUSDT", "ETHUSDT", "UNKNOWNXXX"]);
  assert.equal(bulk.length, 2, "unbekannte Symbole sind Lücken, kein Wurf");
  assert.equal(fx.count("/api/v3/ticker/24hr"), 1);
  const btc = bulk.find((t) => t.symbol === "BTCUSDT")!;
  assert.ok(btc.price > 0);
  assert.ok((btc.quoteVol ?? 0) > 0);

  // Einzel-Ticker + Depth.
  const single = await adapter.getTicker("BTCUSDT");
  assert.equal(single.symbol, "BTCUSDT");
  const book = await adapter.getOrderBook("BTCUSDT");
  assert.ok(book.bids.length > 0 && book.asks.length > 0);
  assert.ok(book.asks[0].price > book.bids[0].price);

  // Klines: Limit-Einhaltung, Zeitordnung, positive OHLC.
  const candles = await adapter.getCandles("BTCUSDT", "1h", 61);
  assert.equal(candles.length, 61);
  assert.ok(candles.every((c) => (c.time ?? 0) > 0 && c.open > 0 && c.volume >= 0));
  assert.deepEqual(
    candles.map((c) => c.time),
    [...candles.map((c) => c.time)].sort((a, b) => (a ?? 0) - (b ?? 0)),
  );

  // Keine Credentials im Sync-Pfad.
  assert.deepEqual(fx.credentialLeaks(), []);
});

test("unbekanntes Symbol: Binance-400 bleibt typisiert (→ INVALID_SYMBOL)", async () => {
  const { adapter } = await harness();
  const err = (await adapter.getTicker("NOPEUSDT").then(
    () => null,
    (e: unknown) => e,
  )) as MarketDataHttpError;
  assert.ok(err instanceof MarketDataHttpError);
  assert.equal(err.httpStatus, 400);
});

test("429 auf Klines: 3 Versuche (Client-Retry), dann typisierter Wurf", async () => {
  const { fx, adapter } = await harness();
  fx.statusByPath.set("/api/v3/klines", 429);
  const err = (await adapter.getCandles("BTCUSDT", "1h", 10).then(
    () => null,
    (e: unknown) => e,
  )) as MarketDataHttpError;
  assert.ok(err instanceof MarketDataHttpError);
  assert.equal(err.httpStatus, 429);
  assert.equal(fx.count("/api/v3/klines"), 3, "1 + 2 Retries");
});
