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
import { MarketDataSyncService, type MarketDataAdapter } from "../sync";
import { UnsupportedVenueError } from "../errors";
import { calculateRelativeSpread } from "../spread";
import { SYNC_TIMEFRAMES, type MarketCandle, type MarketInstrument, type MarketOrderBook, type MarketTicker } from "../types";

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
}

function mockAdapter(opts: {
  instruments?: MarketInstrument[];
  ticker?: (symbol: string) => Promise<MarketTicker>;
  book?: (symbol: string) => Promise<MarketOrderBook>;
  candles?: (symbol: string, tf: string, limit: number) => Promise<MarketCandle[]>;
  failCandles?: boolean;
}): { adapter: MarketDataAdapter; calls: CallLog } {
  const calls: CallLog = { discover: 0, ticker: [], book: [], candles: [] };
  const instruments = opts.instruments ?? [instrument("BTCUSDT"), instrument("ETHUSDT")];
  const adapter: MarketDataAdapter = {
    async discoverInstruments() {
      calls.discover += 1;
      return instruments;
    },
    async getTicker(symbol) {
      calls.ticker.push(symbol);
      if (opts.ticker) return opts.ticker(symbol);
      return ticker(symbol);
    },
    async getOrderBook(symbol) {
      calls.book.push(symbol);
      if (opts.book) return opts.book(symbol);
      return book();
    },
    async getCandles(symbol, timeframe, limit) {
      calls.candles.push({ symbol, timeframe, limit });
      if (opts.failCandles) throw new Error("kline down");
      if (opts.candles) return opts.candles(symbol, timeframe, limit);
      return [candle(0), candle(1)];
    },
  };
  return { adapter, calls };
}

function harness(adapter: MarketDataAdapter, venue = "BITUNIX") {
  const dir = tmp();
  const registry = new InstrumentRegistry({ dir, autoSave: true, now: () => new Date("2026-08-29T00:00:00.000Z") });
  const history = new HistoricalStore(path.join(dir, "history"));
  const service = new MarketDataSyncService(registry, history, new Map([[venue, adapter]]), {
    now: () => new Date("2026-08-29T00:00:00.000Z"),
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
