/**
 * Integration: komplette Sync-Funnels je neuer Venue + 26-Seed-Abnahme.
 *
 * Gegen den lokalen `SyncVenuesFixtureServer` (kein echtes Netz, 0
 * Credentials): je Venue `MarketDataSyncService.syncVenue()` über den
 * echten Adapter — Assertion: Discovery, Ticker-/Orderbook-Enrichment,
 * Candle-Backfill (≥ Warmup), Registry-Metriken (`volume24h` + `spread`).
 *
 * Abnahme-Test: Die 26 Seed-Instrumente (`src/universe/seed.ts`) werden über
 * alle 5 Venues synchronisiert (Allowlist = Seed-Symbole) — danach trägt
 * JEDES Seed-Instrument ≥ 61 1h-Kerzen, `volume24h > 0` und `spread !==
 * null`, und `scanUniverse()` meldet Readiness `READY` (vorher `WARMING`).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { SyncVenuesFixtureServer } from "../../../tests/fixtures/syncVenuesFixtureServer";
import { HistoricalStore } from "../../lib/marketdata/historicalStore";
import { DEFAULT_SCANNER_CONFIG } from "../../scanner/config";
import { scanUniverse } from "../../scanner/pipeline";
import { requiredWarmupCandles } from "../../scanner/warmup";
import { PRESET_CRYPTO } from "../../universe/presets";
import { InstrumentRegistry } from "../../universe/registry";
import { buildSeedInstruments } from "../../universe/seed";
import type { InstrumentInput } from "../../universe/types";
import {
  BinanceSyncClient,
  createBinanceMarketDataAdapter,
  KrakenSyncClient,
  createKrakenMarketDataAdapter,
  SyncHttpClient,
  YahooSyncClient,
  YAHOO_USER_AGENT,
  createPaperMarketDataAdapter,
  createYahooMarketDataAdapter,
  seededInstrumentsForVenue,
  toYahooSymbol,
  type MarketDataAdapter,
} from "../index";
import { syncErrorsToDataErrors } from "../dataErrors";
import { MarketDataSyncService } from "../sync";
import type { SyncResult } from "../types";

const dirs: string[] = [];
const servers: SyncVenuesFixtureServer[] = [];
after(async () => {
  await Promise.all(servers.map((s) => s.stop()));
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const NOW = new Date("2026-08-29T12:00:00.000Z");

function tmp(): string {
  const d = mkdtempSync(path.join(tmpdir(), "mds-venues-"));
  dirs.push(d);
  return d;
}

function store() {
  const dir = tmp();
  const registry = new InstrumentRegistry({ dir, autoSave: true, now: () => NOW });
  const history = new HistoricalStore(path.join(dir, "history"));
  return { registry, history };
}

function binanceAdapter(base: string): MarketDataAdapter {
  return createBinanceMarketDataAdapter({
    client: new BinanceSyncClient(new SyncHttpClient({ baseUrl: base })),
    now: () => NOW,
  });
}

function krakenAdapter(base: string): MarketDataAdapter {
  return createKrakenMarketDataAdapter({
    client: new KrakenSyncClient(new SyncHttpClient({ baseUrl: base })),
    now: () => NOW,
  });
}

function yahooAdapter(base: string, venue: string, instruments: readonly InstrumentInput[]): MarketDataAdapter {
  const http = new SyncHttpClient({ baseUrl: base, headers: { "User-Agent": YAHOO_USER_AGENT } });
  return createYahooMarketDataAdapter({ venue, client: new YahooSyncClient(http), instruments, now: () => NOW });
}

function paperAdapter(base: string, instruments: readonly InstrumentInput[]): MarketDataAdapter {
  return createPaperMarketDataAdapter({
    binance: new BinanceSyncClient(new SyncHttpClient({ baseUrl: base })),
    yahoo: new YahooSyncClient(
      new SyncHttpClient({ baseUrl: base, headers: { "User-Agent": YAHOO_USER_AGENT } }),
    ),
    instruments,
    now: () => NOW,
  });
}

function serviceFor(
  registry: InstrumentRegistry,
  history: HistoricalStore,
  venue: string,
  adapter: MarketDataAdapter,
): MarketDataSyncService {
  return new MarketDataSyncService(registry, history, new Map([[venue, adapter]]), {
    clock: () => NOW,
    requiredWarmupCandles: 61,
  });
}

function smallUniverse(venue: string, rows: Array<{ symbol: string; assetClass: InstrumentInput["assetClass"] }>): InstrumentInput[] {
  return rows.map((r) => ({ venue, symbol: r.symbol, assetClass: r.assetClass }));
}

// ── Funnel je Venue (kleine Universen) ───────────────────────────────────────

test("Funnel BINANCE: Discovery → Enrichment → Backfill (≥ 61 Bars, Metriken)", async () => {
  const fx = new SyncVenuesFixtureServer();
  const base = await fx.start();
  servers.push(fx);
  const { registry, history } = store();
  const service = serviceFor(registry, history, "BINANCE", binanceAdapter(base));

  const result = await service.syncVenue("BINANCE");

  assert.deepEqual(result.failures, []);
  assert.equal(result.degraded, false);
  assert.equal(result.discovered, 3);
  assert.equal(result.tickersEnriched, 3);
  assert.equal(result.orderbooksEnriched, 3);
  for (const symbol of ["BTCUSDT", "ETHUSDT", "SOLUSDT"]) {
    const bars = history.query({ instrumentId: `BINANCE:${symbol}`, timeframe: "1h" });
    assert.ok(bars.length >= 61, `${symbol}: ${bars.length} Bars`);
    const row = registry.get(`BINANCE:${symbol}`);
    assert.ok(row && (row.volume24h ?? 0) > 0, `${symbol}: volume24h`);
    assert.ok(row && row.spread !== null, `${symbol}: spread`);
  }
  assert.deepEqual(fx.credentialLeaks(), []);
});

test("Funnel KRAKEN: Discovery (BTC/USD) → Enrichment → Backfill", async () => {
  const fx = new SyncVenuesFixtureServer();
  const base = await fx.start();
  servers.push(fx);
  const { registry, history } = store();
  const service = serviceFor(registry, history, "KRAKEN", krakenAdapter(base));

  const result = await service.syncVenue("KRAKEN");

  assert.deepEqual(result.failures, []);
  assert.equal(result.discovered, 3);
  assert.equal(result.tickersEnriched, 3);
  assert.equal(result.orderbooksEnriched, 3);
  for (const symbol of ["BTC/USD", "ETH/USD", "SOL/USD"]) {
    const id = `KRAKEN:${symbol}`;
    assert.ok(history.query({ instrumentId: id, timeframe: "1h" }).length >= 61, id);
    const row = registry.get(id);
    assert.ok(row && (row.volume24h ?? 0) > 0, `${id}: volume24h`);
    assert.ok(row && row.spread !== null, `${id}: spread`);
  }
  assert.deepEqual(fx.credentialLeaks(), []);
});

test("Funnel ALPACA: Aktien-Slice → Enrichment → Backfill", async () => {
  const fx = new SyncVenuesFixtureServer();
  const base = await fx.start();
  servers.push(fx);
  const { registry, history } = store();
  const adapter = yahooAdapter(
    base,
    "ALPACA",
    smallUniverse("ALPACA", [
      { symbol: "AAPL", assetClass: "equity" },
      { symbol: "MSFT", assetClass: "equity" },
      { symbol: "NVDA", assetClass: "equity" },
    ]),
  );
  const service = serviceFor(registry, history, "ALPACA", adapter);

  const result = await service.syncVenue("ALPACA");

  assert.deepEqual(result.failures, []);
  assert.equal(result.discovered, 3);
  assert.equal(result.tickersEnriched, 3);
  assert.equal(result.orderbooksEnriched, 3);
  for (const symbol of ["AAPL", "MSFT", "NVDA"]) {
    const id = `ALPACA:${symbol}`;
    assert.ok(history.query({ instrumentId: id, timeframe: "1h" }).length >= 61, id);
    const row = registry.get(id);
    assert.ok(row && (row.volume24h ?? 0) > 0, `${id}: volume24h`);
    assert.ok(row && row.spread !== null, `${id}: spread`);
  }
  assert.deepEqual(fx.credentialLeaks(), []);
});

test("Funnel IBKR: Aktie + FX + Rohstoff + Index → Backfill", async () => {
  const fx = new SyncVenuesFixtureServer();
  const base = await fx.start();
  servers.push(fx);
  const { registry, history } = store();
  const adapter = yahooAdapter(
    base,
    "IBKR",
    smallUniverse("IBKR", [
      { symbol: "AAPL", assetClass: "equity" },
      { symbol: "EUR.USD", assetClass: "fx" },
      { symbol: "CL", assetClass: "commodity" },
      { symbol: "SPX", assetClass: "index" },
    ]),
  );
  const service = serviceFor(registry, history, "IBKR", adapter);

  const result = await service.syncVenue("IBKR");

  assert.deepEqual(result.failures, []);
  assert.equal(result.discovered, 4);
  assert.equal(result.tickersEnriched, 4);
  for (const symbol of ["AAPL", "EUR.USD", "CL", "SPX"]) {
    const id = `IBKR:${symbol}`;
    assert.ok(history.query({ instrumentId: id, timeframe: "1h" }).length >= 61, id);
    const row = registry.get(id);
    assert.ok(row && (row.volume24h ?? 0) > 0, `${id}: volume24h`);
    assert.ok(row && row.spread !== null, `${id}: spread`);
  }
  assert.deepEqual(fx.credentialLeaks(), []);
});

test("Funnel PAPER: Krypto-Bein + Yahoo-Bein → Backfill", async () => {
  const fx = new SyncVenuesFixtureServer();
  const base = await fx.start();
  servers.push(fx);
  const { registry, history } = store();
  const adapter = paperAdapter(
    base,
    smallUniverse("PAPER", [
      { symbol: "BTC", assetClass: "crypto" },
      { symbol: "AAPL", assetClass: "equity" },
      { symbol: "EURUSD=X", assetClass: "fx" },
    ]),
  );
  const service = serviceFor(registry, history, "PAPER", adapter);

  const result = await service.syncVenue("PAPER");

  assert.deepEqual(result.failures, []);
  assert.equal(result.discovered, 3);
  for (const symbol of ["BTC", "AAPL", "EURUSD=X"]) {
    const id = `PAPER:${symbol}`;
    assert.ok(history.query({ instrumentId: id, timeframe: "1h" }).length >= 61, id);
    const row = registry.get(id);
    assert.ok(row && (row.volume24h ?? 0) > 0, `${id}: volume24h`);
    assert.ok(row && row.spread !== null, `${id}: spread`);
  }
  assert.deepEqual(fx.credentialLeaks(), []);
});

test("Isolation: Yahoo-404 auf einem Chart ⇒ ein candles-Failure, Rest grün", async () => {
  const fx = new SyncVenuesFixtureServer();
  const base = await fx.start();
  servers.push(fx);
  fx.emptyChartSymbols.add("MSFT");
  const { registry, history } = store();
  const adapter = yahooAdapter(
    base,
    "ALPACA",
    smallUniverse("ALPACA", [
      { symbol: "AAPL", assetClass: "equity" },
      { symbol: "MSFT", assetClass: "equity" },
    ]),
  );
  const service = serviceFor(registry, history, "ALPACA", adapter);

  const result = await service.syncVenue("ALPACA");

  assert.equal(result.degraded, true);
  assert.ok(
    result.failures.some((f) => f.stage === "candles" && f.symbol === "MSFT" && f.reason === "NOT_FOUND"),
    JSON.stringify(result.failures),
  );
  assert.ok(history.query({ instrumentId: "ALPACA:AAPL", timeframe: "1h" }).length >= 61);
  assert.equal(history.query({ instrumentId: "ALPACA:MSFT", timeframe: "1h" }).length, 0);
});

// ── Abnahme: 26 Seeds → 61 Kerzen + Metriken → Readiness READY ───────────────

test("Abnahme: 26 Seed-Instrumente über 5 Venues ⇒ Scanner-Readiness READY", async () => {
  const fx = new SyncVenuesFixtureServer();
  // Voller Binance-Krypto-Katalog (30 Preset-Symbole — keine Bulk-Lücken).
  fx.binanceSymbols = PRESET_CRYPTO.map((c) => ({
    symbol: c.symbol,
    status: "TRADING",
    baseAsset: c.base ?? c.symbol,
    quoteAsset: c.quote,
    filters: [
      { filterType: "PRICE_FILTER", tickSize: String(c.priceStep) },
      { filterType: "LOT_SIZE", minQty: String(c.minQuantity), stepSize: String(c.minQuantity) },
    ],
  }));
  const base = await fx.start();
  servers.push(fx);

  // Fixture kennt jeden Yahoo-Ticker der Slices (keine Lücken ⇒ 0 Failures).
  for (const venue of ["ALPACA", "IBKR", "PAPER"]) {
    for (const input of seededInstrumentsForVenue(venue)) {
      if (venue === "PAPER" && input.assetClass === "crypto") continue;
      const yahoo = toYahooSymbol(input.symbol, input.assetClass ?? "other");
      assert.ok(yahoo, `Seed-Slice ${venue}:${input.symbol} ohne Yahoo-Abbildung`);
      fx.yahooSymbols.add(yahoo!);
    }
  }

  const { registry, history } = store();
  const seeds = buildSeedInstruments();
  assert.equal(seeds.length, 26);
  registry.upsertMany(seeds, "seed:test");

  // Vorher: keine Historie ⇒ WARMING (Scanner bleibt NO).
  const required = requiredWarmupCandles(DEFAULT_SCANNER_CONFIG);
  assert.equal(required, 61);
  const before = scanUniverse({
    instruments: registry.query().items,
    data: { candles: () => [] },
    asOf: NOW.toISOString(),
    config: DEFAULT_SCANNER_CONFIG,
    dataErrors: new Map(),
  });
  assert.equal(before.readiness.status, "WARMING");

  const adapters = new Map<string, MarketDataAdapter>([
    ["BINANCE", binanceAdapter(base)],
    ["KRAKEN", krakenAdapter(base)],
    ["ALPACA", yahooAdapter(base, "ALPACA", seededInstrumentsForVenue("ALPACA"))],
    ["IBKR", yahooAdapter(base, "IBKR", seededInstrumentsForVenue("IBKR"))],
    ["PAPER", paperAdapter(base, seededInstrumentsForVenue("PAPER"))],
  ]);
  const service = new MarketDataSyncService(registry, history, adapters, {
    clock: () => NOW,
    requiredWarmupCandles: 61,
  });

  const seedSymbolsByVenue = new Map<string, string[]>();
  for (const seed of seeds) {
    const list = seedSymbolsByVenue.get(seed.venue) ?? [];
    list.push(seed.symbol);
    seedSymbolsByVenue.set(seed.venue, list);
  }

  const results: SyncResult[] = [];
  for (const [venue, symbols] of seedSymbolsByVenue) {
    if (!adapters.has(venue)) continue;
    results.push(await service.syncVenue(venue, { symbolAllowlist: symbols }));
  }

  const failures = results.flatMap((r) => r.failures);
  assert.deepEqual(failures, [], `0 Failures erwartet: ${JSON.stringify(failures.slice(0, 3))}`);

  // Jedes der 26 Seeds: ≥ 61 Kerzen, Volumen, Spread.
  for (const seed of seeds) {
    const id = `${seed.venue}:${seed.symbol}`;
    const bars = history.query({ instrumentId: id, timeframe: "1h" });
    assert.ok(bars.length >= 61, `${id}: nur ${bars.length} Bars`);
    const row = registry.get(id);
    assert.ok(row, `${id} fehlt in der Registry`);
    assert.ok((row!.volume24h ?? 0) > 0, `${id}: volume24h fehlt`);
    assert.ok(row!.spread !== null && row!.spread > 0, `${id}: spread fehlt`);
  }

  // Nachher: volle Historie, keine Datenfehler ⇒ READY (Scanner flippt OK).
  const dataErrors = syncErrorsToDataErrors(failures);
  assert.equal(dataErrors.size, 0);
  const afterSync = scanUniverse({
    instruments: registry.query().items,
    data: {
      candles: (instrument) =>
        history
          .query({ instrumentId: instrument.id, timeframe: "1h" })
          .map((e) => ({ time: e.ts, open: e.open, high: e.high, low: e.low, close: e.close, volume: e.volume })),
    },
    asOf: NOW.toISOString(),
    config: DEFAULT_SCANNER_CONFIG,
    dataErrors,
  });
  assert.equal(afterSync.readiness.status, "READY");
  assert.deepEqual(fx.credentialLeaks(), []);
});
