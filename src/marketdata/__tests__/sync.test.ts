/**
 * Unit tests for MarketDataSyncService.
 *
 * Mock adapters only — no HTTP, no PrivateClient, no secrets.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { HistoricalStore } from "../../lib/marketdata/historicalStore";
import { InstrumentRegistry } from "../../universe/registry";
import { MarketDataSyncService, type MarketDataAdapter, type MarketDataSyncOptions } from "../sync";
import { UnsupportedVenueError } from "../errors";
import { calculateRelativeSpread } from "../spread";
import { SYNC_TIMEFRAMES, type MarketCandle, type MarketInstrument, type MarketOrderBook, type RateLimiter, type MarketTicker } from "../types";
import { DEFAULT_SCANNER_CONFIG } from "../../scanner/config";
import { liquidityFactor } from "../../scanner/factors/liquidity";
import { spreadFactor } from "../../scanner/factors/spread";
import type { MarketCandle as ScannerCandle } from "../../lib/marketdata/types";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(path.join(tmpdir(), "mds-"));
  dirs.push(d);
  return d;
}
process.on("exit", () => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

function instrument(symbol: string, venue = "BITUNIX"): MarketInstrument {
  return {
    id: `${venue}:${symbol}`,
    venue,
    symbol,
    base: symbol.replace(/USDT$/, ""),
    quote: "USDT",
    assetClass: "crypto",
    marketType: "perpetual",
    status: "active",
    minQuantity: 0.001,
    priceStep: 0.1,
    quantityStep: 0.001,
    makerFee: 0.0002,
    takerFee: 0.0006,
    leverageAvailable: true,
    shortAvailable: true,
    paperAvailable: true,
    liveTradable: true,
    liveAvailable: false,
    volume24h: null,
    spread: null,
    volatility: null,
    lastSeen: "2026-08-01T00:00:00.000Z",
  };
}

function candle(i = 0): MarketCandle {
  return { time: 1_700_000_000_000 + i * 60_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 };
}

function book(bid = 99, ask = 101): MarketOrderBook {
  return {
    symbol: "BTCUSDT",
    bids: [{ price: bid, qty: 1 }],
    asks: [{ price: ask, qty: 1 }],
    ts: 1,
  };
}

function ticker(symbol: string, quoteVol = 1_000_000): MarketTicker {
  return { symbol, price: 100, source: "mock", ts: 1, quoteVol };
}

interface CallLog {
  discover: number;
  ticker: string[];
  book: string[];
  candles: { symbol: string; timeframe: string; limit: number }[];
  /** Aufgerufene `getTickers`-Batches (Symbol-Listen). */
  tickerBatches: (string[] | undefined)[];
  /** Maximale beobachtete Parallelität über alle Adapter-Aufrufe. */
  maxConcurrency: number;
}

function mockAdapter(opts: {
  instruments?: MarketInstrument[];
  ticker?: (symbol: string) => Promise<MarketTicker>;
  /** Optionaler Batch-Pfad (`getTickers`) — sonst per-Symbol-Fallback. */
  batchTickers?: (symbols?: string[]) => Promise<MarketTicker[]>;
  book?: (symbol: string) => Promise<MarketOrderBook>;
  candles?: (symbol: string, tf: string, limit: number) => Promise<MarketCandle[]>;
  failCandles?: boolean;
}): { adapter: MarketDataAdapter; calls: CallLog } {
  const calls: CallLog = { discover: 0, ticker: [], book: [], candles: [], tickerBatches: [], maxConcurrency: 0 };
  const instruments = opts.instruments ?? [instrument("BTCUSDT"), instrument("ETHUSDT")];
  let active = 0;
  // Misst die Parallelität: ein Burst (Promise.all über N Instrumente) würde
  // hier sofort auffallen — der Sync-Orchestrator arbeitet strikt sequenziell.
  const guard = async <T,>(run: () => Promise<T>): Promise<T> => {
    active += 1;
    calls.maxConcurrency = Math.max(calls.maxConcurrency, active);
    try {
      return await run();
    } finally {
      active -= 1;
    }
  };
  const adapter: MarketDataAdapter = {
    async discoverInstruments() {
      return guard(async () => {
        calls.discover += 1;
        return instruments;
      });
    },
    async getTicker(symbol) {
      return guard(async () => {
        calls.ticker.push(symbol);
        if (opts.ticker) return opts.ticker(symbol);
        return ticker(symbol);
      });
    },
    async getOrderBook(symbol) {
      return guard(async () => {
        calls.book.push(symbol);
        if (opts.book) return opts.book(symbol);
        return book();
      });
    },
    async getCandles(symbol, timeframe, limit) {
      return guard(async () => {
        calls.candles.push({ symbol, timeframe, limit });
        if (opts.failCandles) throw new Error("kline down");
        if (opts.candles) return opts.candles(symbol, timeframe, limit);
        return [candle(0), candle(1)];
      });
    },
  };
  if (opts.batchTickers) {
    adapter.getTickers = async (symbols?: string[]) =>
      guard(async () => {
        calls.tickerBatches.push(symbols ? [...symbols] : undefined);
        return opts.batchTickers!(symbols);
      });
  }
  return { adapter, calls };
}

function harness(adapter: MarketDataAdapter, venue = "BITUNIX", options: MarketDataSyncOptions = {}) {
  const dir = tmp();
  const registry = new InstrumentRegistry({ dir, autoSave: true, now: () => new Date("2026-08-29T00:00:00.000Z") });
  const history = new HistoricalStore(path.join(dir, "history"));
  const service = new MarketDataSyncService(registry, history, new Map([[venue, adapter]]), {
    now: () => new Date("2026-08-29T00:00:00.000Z"),
    ...options,
  });
  return { registry, history, service, dir };
}

test("syncVenue() wirft UnsupportedVenueError bei unbekannter Venue", async () => {
  const { service } = harness(mockAdapter({}).adapter, "BITUNIX");
  await assert.rejects(() => service.syncVenue("NOPE"), (e: unknown) => {
    assert.ok(e instanceof UnsupportedVenueError);
    assert.equal((e as UnsupportedVenueError).code, "UNSUPPORTED_VENUE");
    assert.match((e as Error).message, /NOPE/);
    return true;
  });
});

test("syncVenue() ruft discoverInstruments() genau einmal auf", async () => {
  const { adapter, calls } = mockAdapter({});
  const { service } = harness(adapter);
  await service.syncVenue("BITUNIX");
  assert.equal(calls.discover, 1);
});

test("für jedes Instrument: getTicker, getOrderBook, getCandles × 4 Timeframes", async () => {
  const { adapter, calls } = mockAdapter({
    instruments: [instrument("BTCUSDT"), instrument("ETHUSDT")],
  });
  const { service } = harness(adapter);
  const result = await service.syncVenue("BITUNIX");
  assert.equal(calls.ticker.length, 2);
  assert.deepEqual(calls.ticker.sort(), ["BTCUSDT", "ETHUSDT"]);
  assert.equal(calls.book.length, 2);
  assert.equal(calls.candles.length, 2 * SYNC_TIMEFRAMES.length);
  for (const tf of SYNC_TIMEFRAMES) {
    assert.equal(calls.candles.filter((c) => c.timeframe === tf).length, 2);
    assert.ok(calls.candles.every((c) => c.limit === 150));
    assert.equal(result.candlesByTimeframe[tf], 4); // 2 instruments × 2 candles
  }
  assert.equal(result.tickersEnriched, 2);
  assert.equal(result.orderbooksEnriched, 2);
  assert.equal(result.instrumentsDiscovered, 2);
});

test("Adapter-Fehler in getCandles() landen in SyncResult.errors — kein Full-Abort", async () => {
  const { adapter, calls } = mockAdapter({
    instruments: [instrument("BTCUSDT"), instrument("ETHUSDT")],
    failCandles: true,
  });
  const { service, registry } = harness(adapter);
  const result = await service.syncVenue("BITUNIX");
  assert.equal(result.instrumentsDiscovered, 2);
  assert.equal(result.tickersEnriched, 2);
  assert.equal(result.orderbooksEnriched, 2);
  assert.ok(result.errors.length >= 8, `erwartet 2×4 Candle-Fehler, war ${result.errors.length}`);
  assert.ok(result.errors.every((e) => e.stage === "candles"));
  assert.equal(calls.discover, 1);
  assert.ok(registry.size >= 1, "Registry bleibt trotz Candle-Fehlern befüllt");
});

test("leeres discoverInstruments() → instrumentsDiscovered: 0, kein Crash", async () => {
  const { adapter, calls } = mockAdapter({ instruments: [] });
  const { service, registry, history } = harness(adapter);
  const result = await service.syncVenue("BITUNIX");
  assert.equal(result.instrumentsDiscovered, 0);
  assert.equal(result.tickersEnriched, 0);
  assert.equal(result.orderbooksEnriched, 0);
  assert.equal(result.errors.length, 0);
  assert.equal(registry.size, 0);
  assert.equal(history.count(), 0);
  assert.equal(calls.ticker.length, 0);
  assert.equal(calls.book.length, 0);
  assert.equal(calls.candles.length, 0);
});

test("calculateRelativeSpread: fehlende Book-Seite → null, kein Crash", () => {
  assert.equal(calculateRelativeSpread(undefined, 101), null);
  assert.equal(calculateRelativeSpread(99, undefined), null);
  assert.equal(calculateRelativeSpread(undefined, undefined), null);
  assert.equal(calculateRelativeSpread(Number.NaN, 101), null);
  assert.equal(calculateRelativeSpread(0, 101), null);
  assert.equal(calculateRelativeSpread(102, 101), null); // inverted
  const rel = calculateRelativeSpread(99, 101);
  assert.ok(rel !== null);
  assert.ok(Math.abs(rel - 2 / 100) < 1e-12);
});

test("leeres Orderbuch (bids[0]/asks[0] undefined) bricht den Sync nicht ab", async () => {
  const { adapter } = mockAdapter({
    instruments: [instrument("BTCUSDT")],
    book: async () => ({ symbol: "BTCUSDT", bids: [], asks: [], ts: 1 }),
  });
  const { service, registry } = harness(adapter);
  const result = await service.syncVenue("BITUNIX");
  assert.equal(result.orderbooksEnriched, 1);
  assert.equal(result.errors.length, 0);
  const stored = registry.get("BITUNIX:BTCUSDT");
  assert.ok(stored);
  assert.equal(stored!.spread, null);
});

test("Ticker-Fehler isoliert: Orderbuch und Kerzen laufen weiter", async () => {
  const { adapter } = mockAdapter({
    instruments: [instrument("BTCUSDT")],
    ticker: async () => {
      throw new Error("ticker 503");
    },
  });
  const { service, history } = harness(adapter);
  const result = await service.syncVenue("BITUNIX");
  assert.equal(result.tickersEnriched, 0);
  assert.equal(result.orderbooksEnriched, 1);
  assert.ok(result.errors.some((e) => e.stage === "ticker"));
  assert.ok(history.count() > 0);
});

// ── FEHLER-3: Enrichment (volume24h + orderbook-spread) ──────────────────────

test("market sync enriches 24h volume", async () => {
  const { adapter } = mockAdapter({ instruments: [instrument("BTCUSDT")] });
  const { service, registry } = harness(adapter);

  await service.syncVenue("BITUNIX");

  const btc = registry.get("BITUNIX:BTCUSDT");
  assert.ok(btc);
  assert.ok((btc!.volume24h ?? 0) > 0, `volume24h erwartet > 0, war ${btc!.volume24h}`);
  assert.equal(btc!.volume24h, 1_000_000, "volume24h kommt aus ticker.quoteVol");
  assert.equal(btc!.lastSeen, "2026-08-29T00:00:00.000Z", "lastSeen wird beim Upsert gestempelt");
});

test("market sync writes orderbook-derived spread into the registry", async () => {
  const { adapter } = mockAdapter({
    instruments: [instrument("BTCUSDT")],
    book: async () => book(100, 100.02),
  });
  const { service, registry } = harness(adapter);

  await service.syncVenue("BITUNIX");

  const btc = registry.get("BITUNIX:BTCUSDT");
  assert.ok(btc);
  assert.ok(btc!.spread !== null, "spread muss aus bestBid/bestAsk gefüllt sein");
  assert.ok(Math.abs(btc!.spread! - calculateRelativeSpread(100, 100.02)!) < 1e-12);
  assert.ok(Math.abs(btc!.spread! - 0.00019998) < 1e-6, `≈2 bp erwartet, war ${btc!.spread}`);
});

test("Batch-Tickers: 1× getTickers(symbols) für alle Instrumente, kein per-Symbol-getTicker", async () => {
  const instruments = [instrument("BTCUSDT"), instrument("ETHUSDT"), instrument("SOLUSDT")];
  const { adapter, calls } = mockAdapter({
    instruments,
    batchTickers: async (symbols) =>
      (symbols ?? instruments.map((i) => i.symbol)).map((s) => ticker(s, 2_500_000)),
  });
  const { service, registry } = harness(adapter);

  const result = await service.syncVenue("BITUNIX");

  assert.equal(calls.tickerBatches.length, 1, "genau EIN Batch-Call");
  assert.deepEqual(calls.tickerBatches[0], ["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
  assert.deepEqual(calls.ticker, [], "kein Fallback-getTicker, wenn der Batch vollständig ist");
  assert.equal(result.tickersEnriched, 3);
  for (const id of ["BITUNIX:BTCUSDT", "BITUNIX:ETHUSDT", "BITUNIX:SOLUSDT"]) {
    assert.equal(registry.get(id)?.volume24h, 2_500_000);
  }
});

test("Batch-Tickers unvollständig → per-Symbol-getTicker ergänzt nur die Lücken", async () => {
  const instruments = [instrument("BTCUSDT"), instrument("ETHUSDT")];
  const { adapter, calls } = mockAdapter({
    instruments,
    batchTickers: async () => [ticker("BTCUSDT", 5_000_000)],
  });
  const { service, registry } = harness(adapter);

  const result = await service.syncVenue("BITUNIX");

  assert.deepEqual(calls.ticker, ["ETHUSDT"], "nur das fehlende Symbol wird einzeln geholt");
  assert.equal(registry.get("BITUNIX:BTCUSDT")?.volume24h, 5_000_000);
  assert.equal(registry.get("BITUNIX:ETHUSDT")?.volume24h, 1_000_000, "Fallback-Ticker greift");
  assert.equal(result.tickersEnriched, 2);
});

test("Ticker-Symbol weicht ab → volume24h bleibt null (kein Fremd-Volumen)", async () => {
  const { adapter } = mockAdapter({
    instruments: [instrument("ETHUSDT")],
    // Venue-Client fällt auf eine fremde Zeile zurück (Symbol nicht in der Antwort).
    ticker: async () => ticker("BTCUSDT", 9_000_000),
  });
  const { service, registry } = harness(adapter);

  const result = await service.syncVenue("BITUNIX");

  const eth = registry.get("BITUNIX:ETHUSDT");
  assert.ok(eth);
  assert.equal(eth!.volume24h, null, "fremdes quoteVol darf nicht übernommen werden");
  assert.equal(result.tickersEnriched, 0);
  assert.ok(
    result.errors.some((e) => e.stage === "ticker" && /Symbol/.test(e.message)),
    "Abweichung muss als Sync-Fehler sichtbar sein",
  );
});

test("Ticker ohne quoteVol → volume24h bleibt null, Liquiditäts-Faktor fällt auf Kerze.volume × close zurück", async () => {
  const { adapter } = mockAdapter({
    instruments: [instrument("BTCUSDT")],
    // Ticker-API ohne quoteVol (z. B. illiquides/neues Listing).
    ticker: async (symbol) => ({ symbol, price: 100, source: "mock", ts: 1 }),
    candles: async () => [candle(0)], // volume 10 × close 1.5 = 15
  });
  const { service, registry, history } = harness(adapter);

  const result = await service.syncVenue("BITUNIX");
  assert.equal(result.tickersEnriched, 1);

  const btc = registry.get("BITUNIX:BTCUSDT");
  assert.ok(btc);
  assert.equal(btc!.volume24h, null, "unbekannt bleibt null — kein 0-Mapping");

  // Review-Punkt 5: Der Liquiditätsfaktor hat einen Kerzen-Fallback …
  const stored: ScannerCandle[] = history
    .query({ instrumentId: "BITUNIX:BTCUSDT", timeframe: "1h" })
    .map((e) => ({ time: e.ts, open: e.open, high: e.high, low: e.low, close: e.close, volume: e.volume }));
  assert.ok(stored.length > 0, "Kerzen müssen nach dem Sync lesbar sein");
  const liquidity = liquidityFactor.compute({
    instrument: btc!,
    candles: stored,
    asOf: Date.parse("2026-08-29T00:00:00.000Z"),
    config: DEFAULT_SCANNER_CONFIG,
  });
  assert.equal(liquidity.available, true, "Fallback macht den Faktor verfügbar");
  assert.equal(liquidity.detail.source, "candle");
  assert.equal(liquidity.raw, 15, "10 (volume) × 1.5 (close) = 15");

  // … der Spread-Faktor aber NICHT: ohne Orderbook bleibt er unavailable.
  const noBook = spreadFactor.compute({
    instrument: { ...btc!, spread: null },
    candles: stored,
    asOf: Date.parse("2026-08-29T00:00:00.000Z"),
    config: DEFAULT_SCANNER_CONFIG,
  });
  assert.equal(noBook.available, false, "Spread-Faktor hat keinen Fallback");
});

test("Rate-Limiting: 180 Instrumente → jeder Request über den Limiter, strikt sequenziell (kein Burst)", async () => {
  const N = 180;
  const instruments = Array.from({ length: N }, (_, i) => instrument(`SYM${i}USDT`));
  const { adapter, calls } = mockAdapter({ instruments });

  let takes = 0;
  const limiter: RateLimiter = {
    async take() {
      takes += 1;
    },
  };
  const dir = tmp();
  const registry = new InstrumentRegistry({ dir, autoSave: false, now: () => new Date("2026-08-29T00:00:00.000Z") });
  const history = new HistoricalStore(path.join(dir, "history"));
  const service = new MarketDataSyncService(registry, history, new Map([["BITUNIX", adapter]]), {
    now: () => new Date("2026-08-29T00:00:00.000Z"),
    rateLimiter: limiter,
  });

  const result = await service.syncVenue("BITUNIX");

  // 1 × discovery + N × (1 ticker + 1 depth + 4 timeframe-candles)
  const expected = 1 + N * (1 + 1 + SYNC_TIMEFRAMES.length);
  assert.equal(takes, expected, `Limiter-Takes: erwartet ${expected}, war ${takes}`);
  assert.equal(calls.book.length, N, "1 depth-Call je Instrument (N × depth)");
  assert.equal(calls.ticker.length, N, "per-Symbol-Ticker, da kein Batch-Adapter");
  assert.equal(calls.maxConcurrency, 1, "keine parallelen Request-Bursts");
  assert.equal(result.orderbooksEnriched, N);
  assert.equal(registry.size, N);
});

test("Architektur: src/marketdata importiert keinen PrivateClient und loggt keine Secrets", () => {
  const root = path.join(process.cwd(), "src/marketdata");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const full = path.join(dir, e);
      if (statSync(full).isDirectory()) {
        if (e === "__tests__") continue;
        walk(full);
      } else if (e.endsWith(".ts")) files.push(full);
    }
  };
  walk(root);
  assert.ok(files.length >= 4);
  const forbiddenImport = /from\s+["'][^"']*privateClient["']|new\s+BitunixPrivateClient/;
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    assert.equal(forbiddenImport.test(src), false, `${path.relative(process.cwd(), f)} importiert PrivateClient`);
    assert.equal(
      /console\.(log|info|warn|error)\([^)]*(apiSecret|api-key|secretKey|\.sign\b)/i.test(src),
      false,
      `${path.relative(process.cwd(), f)} loggt potenziell Secrets`,
    );
  }
});

test("scanUniverse-Modul importiert MarketDataSyncService nicht", () => {
  const scannerDir = path.join(process.cwd(), "src/scanner");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const full = path.join(dir, e);
      if (statSync(full).isDirectory()) walk(full);
      else if (e.endsWith(".ts")) files.push(full);
    }
  };
  walk(scannerDir);
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    assert.equal(
      /from\s+["'][^"']*marketdata\/sync["']/.test(src) || /new\s+MarketDataSyncService/.test(src),
      false,
      `${path.relative(process.cwd(), f)} darf den Sync-Service nicht aufrufen`,
    );
    assert.equal(/(^|[^\w.])fetch\s*\(/.test(src), false);
  }
});
