/**
 * Yahoo-Sync-Adapter (ALPACA/IBKR-Quelle) — Tests.
 *
 * Coverage: Symbol-Abbildung (Aktien/FX/`=F`/50-Index-Tabelle —
 * Vollständigkeit gegen `PRESET_INDICES` pinnen), Range-Stufenleiter,
 * Intervall-Lücken (3m/2h/4h), Quote-/Chart-Mapper (Null-Lücken, Volumen-0),
 * Funnel (Discovery, Bulk + Cache, Depth-aus-Quote, Chart-Schnitt,
 * INVALID_SYMBOL ohne Request, User-Agent, keine Credentials).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";

import { SyncVenuesFixtureServer } from "../../../tests/fixtures/syncVenuesFixtureServer";
import { classifyMarketDataError } from "../../../src/lib/marketDataErrors";
import { UnsupportedTimeframeError } from "../../../src/marketdata/errors";
import { seededInstrumentsForVenue } from "../../../src/marketdata/adapters/seeded";
import {
  YAHOO_INDEX_MAP,
  YAHOO_TIMEFRAME_MAP,
  YAHOO_USER_AGENT,
  YahooSyncClient,
  createYahooMarketDataAdapter,
  mapYahooChart,
  mapYahooQuote,
  toYahooInterval,
  toYahooSymbol,
  yahooRangeFor,
} from "../../../src/marketdata/adapters/yahoo";
import { SyncHttpClient } from "../../../src/marketdata/adapters/http";
import { PRESET_COMMODITIES, PRESET_EQUITIES, PRESET_INDICES } from "../../../src/universe/presets";
import type { InstrumentInput } from "../../../src/universe/types";
import type { MarketDataAdapter } from "../../../src/marketdata/sync";

const servers: SyncVenuesFixtureServer[] = [];
after(async () => {
  await Promise.all(servers.map((s) => s.stop()));
});

function inputs(symbols: Array<{ symbol: string; assetClass: InstrumentInput["assetClass"] }>): InstrumentInput[] {
  return symbols.map((s) => ({ venue: "IBKR", symbol: s.symbol, assetClass: s.assetClass }));
}

async function harness(venue: string, universe: readonly InstrumentInput[]) {
  const fx = new SyncVenuesFixtureServer();
  const base = await fx.start();
  servers.push(fx);
  // Produktions-Header spiegeln (registerAdapters setzt den Browser-UA).
  const http = new SyncHttpClient({ baseUrl: base, headers: { "User-Agent": YAHOO_USER_AGENT } });
  const adapter = createYahooMarketDataAdapter({
    venue,
    client: new YahooSyncClient(http),
    instruments: universe,
    now: () => new Date("2026-08-29T12:00:00.000Z"),
  });
  return { fx, adapter };
}


/** Bulk-Zugriff mit hartem Setup-Fehler statt `possibly undefined`. */
function bulkOf(adapter: MarketDataAdapter): NonNullable<MarketDataAdapter["getTickers"]> {
  assert.ok(adapter.getTickers, "Adapter ohne Bulk (Test-Setup)");
  return adapter.getTickers;
}

// ── 1) Symbol-Abbildung ──────────────────────────────────────────────────────

test("toYahooSymbol: Regeln je Asset-Klasse", () => {
  assert.equal(toYahooSymbol("AAPL", "equity"), "AAPL");
  assert.equal(toYahooSymbol("SPY", "etf"), "SPY");
  assert.equal(toYahooSymbol("BRK.B", "equity"), "BRK-B", "Aktienklassen: Punkt ⇒ Strich");
  assert.equal(toYahooSymbol("EUR.USD", "fx"), "EURUSD=X");
  assert.equal(toYahooSymbol("EURUSD=X", "fx"), "EURUSD=X", "=X bleibt as-is");
  assert.equal(toYahooSymbol("CL", "commodity"), "CL=F");
  assert.equal(toYahooSymbol("GC", "commodity"), "GC=F");
  assert.equal(toYahooSymbol("SPX", "index"), "^GSPC");
  assert.equal(toYahooSymbol("NKY", "index"), "^N225");
  assert.equal(toYahooSymbol("BTC", "crypto"), null, "Krypto läuft nie über Yahoo");
  assert.equal(toYahooSymbol("SPX", "other"), null);
  assert.equal(toYahooSymbol("???", "index"), null);
  assert.equal(toYahooSymbol("", "equity"), null);
});

test("YAHOO_INDEX_MAP deckt alle 50 Preset-Indizes ab (kein ^ in der Speicherung)", () => {
  assert.equal(Object.keys(YAHOO_INDEX_MAP).length, 50);
  assert.equal(PRESET_INDICES.length, 50);
  for (const entry of PRESET_INDICES) {
    const mapped = toYahooSymbol(entry.symbol, "index");
    assert.ok(mapped, `Index ${entry.symbol} ohne Yahoo-Abbildung`);
    assert.ok(!entry.symbol.includes("^"), `Preset ${entry.symbol} enthält ^`);
  }
});

test("Aktien- und Rohstoff-Presets sind vollständig abbildbar", () => {
  for (const entry of PRESET_EQUITIES) {
    assert.ok(toYahooSymbol(entry.symbol, "equity"), entry.symbol);
  }
  for (const entry of PRESET_COMMODITIES) {
    assert.ok(toYahooSymbol(entry.symbol, "commodity"), entry.symbol);
  }
});

// ── 2) Intervalle + Ranges ───────────────────────────────────────────────────

test("toYahooInterval: Lücken 3m/2h/4h werfen, 5d ok", () => {
  assert.equal(toYahooInterval("1h"), "1h");
  assert.equal(toYahooInterval("5d"), "5d");
  assert.equal(Object.keys(YAHOO_TIMEFRAME_MAP).length, 10);
  for (const gap of ["3m", "2h", "4h"]) {
    assert.throws(() => toYahooInterval(gap), UnsupportedTimeframeError, gap);
  }
});

test("yahooRangeFor: großzügige Stufenleiter je Limit", () => {
  assert.equal(yahooRangeFor("1m", 150), "1d");
  assert.equal(yahooRangeFor("1m", 1000), "5d");
  assert.equal(yahooRangeFor("5m", 150), "5d");
  assert.equal(yahooRangeFor("5m", 1000), "1mo");
  assert.equal(yahooRangeFor("1h", 61), "1mo");
  assert.equal(yahooRangeFor("1h", 150), "3mo");
  assert.equal(yahooRangeFor("1h", 1000), "6mo");
  assert.equal(yahooRangeFor("1d", 150), "2y");
  assert.equal(yahooRangeFor("1d", 1000), "5y");
  assert.equal(yahooRangeFor("5d", 150), "5y");
  assert.throws(() => yahooRangeFor("2h", 150), UnsupportedTimeframeError);
});

// ── 3) Mapper-Units ──────────────────────────────────────────────────────────

test("mapYahooQuote: Shares × Preis, Speicher-Symbol, unbrauchbar ⇒ null", () => {
  const row = mapYahooQuote("AAPL", {
    symbol: "AAPL",
    regularMarketPrice: 200,
    regularMarketVolume: 1_000_000,
    regularMarketTime: 1_700_000_000,
  });
  assert.ok(row);
  assert.equal(row!.symbol, "AAPL");
  assert.equal(row!.quoteVol, 200_000_000);
  assert.equal(row!.baseVol, 1_000_000);
  assert.equal(row!.ts, 1_700_000_000_000);
  assert.equal(row!.source, "yahoo");

  assert.equal(mapYahooQuote("AAPL", { symbol: "AAPL" }), null, "ohne Preis keine Zeile");
  assert.equal(mapYahooQuote("AAPL", { regularMarketPrice: 0 }), null);
});

test("mapYahooChart: Null-Lücken übersprungen, Volumen-null ⇒ 0, sortiert", () => {
  const rows = mapYahooChart({
    timestamp: [300, 100, 200, null as never, 400],
    indicators: {
      quote: [
        {
          open: [10, 10, null, 10, 10],
          high: [11, 11, 11, 11, 11],
          low: [9, 9, 9, 9, 9],
          close: [10.5, 10.5, 10.5, 10.5, 10.5],
          volume: [5, null, 7, 8, 9],
        },
      ],
    },
  });
  assert.deepEqual(
    rows.map((c) => c.time),
    [100_000, 300_000, 400_000],
    "null-Zeit und null-OHLC entfallen, Rest aufsteigend",
  );
  assert.equal(rows[0].volume, 0, "Volumen-null ⇒ 0 bei valider OHLC-Zeile");
  assert.deepEqual(mapYahooChart({}), []);
});

// ── 4) Funnel gegen den Fixture-Server ───────────────────────────────────────

test("Funnel: Discovery → Bulk → Depth-aus-Quote → Chart", async () => {
  const { fx, adapter } = await harness(
    "IBKR",
    inputs([
      { symbol: "AAPL", assetClass: "equity" },
      { symbol: "EUR.USD", assetClass: "fx" },
      { symbol: "CL", assetClass: "commodity" },
      { symbol: "SPX", assetClass: "index" },
    ]),
  );

  const instruments = await adapter.discoverInstruments();
  assert.equal(instruments.length, 4);
  assert.ok(instruments.every((i) => i.venue === "IBKR" && i.id.startsWith("IBKR:")));
  assert.ok(!instruments.some((i) => i.symbol.includes("^") || i.symbol.includes("=") && i.symbol !== "EUR.USD"));

  // Bulk: EIN Request, Yahoo-Ticker in der Query, Antwort unter
  // Speicher-Symbolen (nie ^GSPC/CL=F als `symbol`).
  const bulk = await bulkOf(adapter)();
  assert.equal(bulk.length, 4);
  assert.equal(fx.count("/v7/finance/quote"), 1);
  const quoteQuery = fx.requests.find((r) => r.path === "/v7/finance/quote")!.query.symbols;
  assert.ok(quoteQuery.includes("AAPL"), quoteQuery);
  assert.ok(quoteQuery.includes("EURUSD=X"), quoteQuery);
  assert.ok(quoteQuery.includes("CL=F"), quoteQuery);
  assert.ok(quoteQuery.includes("^GSPC"), quoteQuery);
  assert.deepEqual(
    bulk.map((t) => t.symbol).sort(),
    ["AAPL", "CL", "EUR.USD", "SPX"],
  );
  assert.ok(bulk.every((t) => (t.quoteVol ?? 0) > 0));

  // Depth kommt aus dem Bulk-Cache (kein Extra-Request), Bid < Ask.
  const book = await adapter.getOrderBook("AAPL");
  assert.equal(fx.count("/v7/finance/quote"), 1, "Cache: kein zweiter Quote-Call");
  assert.equal(book.symbol, "AAPL");
  assert.ok(book.bids.length === 1 && book.asks.length === 1);
  assert.ok(book.asks[0].price > book.bids[0].price);

  // Chart: Schnitt auf `limit`, Yahoo-Pfad encodiert (^ ⇒ %5E).
  const candles = await adapter.getCandles("EUR.USD", "1h", 61);
  assert.equal(candles.length, 61);
  assert.ok(candles.every((c) => (c.time ?? 0) > 0 && c.volume >= 0));
  const chartReq = fx.requests.find((r) => r.path.startsWith("/v8/finance/chart/"))!;
  assert.ok(chartReq.path.includes("EURUSD%3DX"), chartReq.path);
  assert.equal(chartReq.query.interval, "1h");
  assert.equal(chartReq.query.range, "1mo");

  // Yahoo bekommt einen Browser-UA, aber nie Credentials.
  assert.ok(fx.requests.every((r) => (r.userAgent ?? "").includes("Mozilla")), "Browser-UA Pflicht");
  assert.deepEqual(fx.credentialLeaks(), []);
});

test("Bulk-Lücke (Yahoo kennt Symbol nicht): Einzel-Fallback ⇒ Fehler, isoliert", async () => {
  const { fx, adapter } = await harness("IBKR", inputs([{ symbol: "ZZUNKNOWN", assetClass: "equity" }]));
  const bulk = await bulkOf(adapter)();
  assert.equal(bulk.length, 0, "unbekannte Zeile fehlt im Bulk");
  assert.equal(fx.count("/v7/finance/quote"), 1);
  // Read-Through: Einzel-Call, dann Fehler (kein Treffer ⇒ unbrauchbar).
  await assert.rejects(() => adapter.getTicker("ZZUNKNOWN"), /unbrauchbar/);
  assert.equal(fx.count("/v7/finance/quote"), 2);
});

test("strukturell nicht abbildbar ⇒ INVALID_SYMBOL ohne Request", async () => {
  const { fx, adapter } = await harness(
    "ALPACA",
    inputs([
      { symbol: "BTC", assetClass: "crypto" },
      { symbol: "AAPL", assetClass: "equity" },
    ]),
  );
  // Bulk überspringt BTC (kein Yahoo-Ticker formulierbar) …
  const bulk = await bulkOf(adapter)();
  assert.deepEqual(bulk.map((t) => t.symbol), ["AAPL"]);
  // … Einzel-Calls werfen INVALID_SYMBOL (isoliert, klassifizierbar).
  for (const call of [
    () => adapter.getTicker("BTC"),
    () => adapter.getOrderBook("BTC"),
    () => adapter.getCandles("BTC", "1h", 10),
  ]) {
    const err = (await call().then(
      () => null,
      (e: unknown) => e,
    )) as Error;
    assert.ok(err instanceof Error);
    const r = classifyMarketDataError(err);
    assert.equal(r.reason, "INVALID_SYMBOL");
    assert.equal(r.retryable, false);
  }
  assert.ok(
    fx.requests.every((r) => !(r.query.symbols ?? "").includes("BTC")),
    "kein Request für BTC",
  );
});

test("Symbol außerhalb des kuratierten Universums ⇒ INVALID_SYMBOL", async () => {
  const { adapter } = await harness("ALPACA", inputs([{ symbol: "AAPL", assetClass: "equity" }]));
  const err = (await adapter.getTicker("MSFT").then(
    () => null,
    (e: unknown) => e,
  )) as Error;
  const r = classifyMarketDataError(err);
  assert.equal(r.reason, "INVALID_SYMBOL");
});

test("Index ohne Bid/Ask: leeres Buch (Spread null), kein Fehler", async () => {
  const { adapter, fx } = await harness("IBKR", inputs([{ symbol: "SPX", assetClass: "index" }]));
  fx.noQuoteBookSymbols.add("^GSPC");
  await bulkOf(adapter)();
  const book = await adapter.getOrderBook("SPX");
  assert.deepEqual(book.bids, []);
  assert.deepEqual(book.asks, []);
});

test("Discovery spiegelt das kuratierte Universum (Seed-Schnitt ALPACA)", () => {
  const alpaca = seededInstrumentsForVenue("ALPACA");
  assert.equal(alpaca.length, 52, "50 Aktien + SPY/QQQ");
  assert.ok(alpaca.some((i) => i.symbol === "SPY"));
  assert.ok(alpaca.some((i) => i.symbol === "BRK.B"));
  const ibkr = seededInstrumentsForVenue("IBKR");
  assert.equal(ibkr.length, 125, "50 + 50 + 22 + SPY/QQQ/EUR.USD");
  assert.ok(ibkr.some((i) => i.symbol === "EUR.USD"));
});
