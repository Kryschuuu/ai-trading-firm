/**
 * Test-Fixtures für `test/marketdata/*` (MDSYNC-001).
 *
 * Kein HTTP, kein PrivateClient, keine Secrets — der `mockMarketDataAdapter()`
 * ist der einzige Adapter im QA-Suite-Ordner. Er zählt außerdem jede Anfrage
 * (Anzahl, Reihenfolge, maximale Parallelität, Zeitstempel), damit die
 * Request-Budget- und Rate-Limit-Tests dieselbe Quelle haben wie die
 * Fachtests.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { HistoricalStore } from "../../src/lib/marketdata/historicalStore";
import { InstrumentRegistry } from "../../src/universe/registry";
import {
  MarketDataSyncService,
  type MarketDataAdapter,
  type SupportedTimeframe,
  type SyncOptions,
} from "../../src/marketdata";
import type { MarketCandle, MarketInstrument, MarketOrderBook, MarketTicker } from "../../src/marketdata";

/** Zu räumende Temp-Verzeichnisse (best-effort beim Prozess-Exit). */
const dirs: string[] = [];

export function tempDir(prefix = "mds-"): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

process.on("exit", () => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

/** Vollständiges, registry-konformes Instrument (Perp-Derivat auf USDT). */
export function instrumentOf(symbol: string, venue = "BITUNIX"): MarketInstrument {
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

/** Erzeugt `count` Symbole `SYM000USDT…` (deterministisch, policy-konform). */
export function symbols(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `SYM${String(i).padStart(3, "0")}USDT`);
}

/**
 * Trendende, rauscharme Kerzenserie: 0,02 % Trend je Bar + deterministisches
 * Rauschen. Erzeugt einen ruhigen Volatilitätsregime-Wert und einen Drawdown
 * weit unter der Filtergrenze — genau das Profil, das den Scanner-Eignungstest
 * bestehen lässt.
 */
export function trendingCandles(seed: number, count: number, startPrice = 100): MarketCandle[] {
  const out: MarketCandle[] = [];
  let price = startPrice;
  const baseTime = 1_750_000_000_000;
  for (let i = 0; i < count; i++) {
    const drift = 0.0002;
    const noise = Math.sin((seed + i) * 12.9898) * 0.0009;
    const open = price;
    const close = open * (1 + drift + noise);
    const high = Math.max(open, close) * 1.0004;
    const low = Math.min(open, close) * 0.9996;
    out.push({
      time: baseTime + i * 3_600_000,
      open: round(open, 6),
      high: round(high, 6),
      low: round(low, 6),
      close: round(close, 6),
      volume: round(1_000 + (i % 7) * 40, 4),
    });
    price = close;
  }
  return out;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export interface MockCallLog {
  discover: number;
  /** Symbole der per-Symbol-`getTicker`-Aufrufe (Lücken-Fallback). */
  ticker: string[];
  /** Symbole-Listen der `getTickers`-Batches (sollte genau 1 Eintrag haben). */
  tickerBatches: (string[] | undefined)[];
  /** Symbole der `getOrderBook`-Aufrufe (N × depth). */
  orderBook: string[];
  /** Alle `getCandles`-Aufrufe. */
  candles: { symbol: string; timeframe: string; limit: number }[];
  /** Maximale beobachtete Parallelität über alle Adapter-Aufrufe. */
  maxInFlight: number;
  /** Zeitstempel jeder Anfrage (injectierbare Uhr) für Rate-Messungen. */
  requestTimes: number[];
  /** Aufgerufene Symbole in Aufrufreihenfolge, über alle Stages. */
  order: string[];
}

export interface MockAdapterOptions {
  instruments?: MarketInstrument[];
  /** Anzahl generierter Symbole, wenn `instruments` fehlt. */
  count?: number;
  venue?: string;
  /** 24h-Volumen je Symbol (Default 50 Mio, fallend nach Index). */
  quoteVolOf?: (symbol: string, index: number) => number | null;
  /** Spread-Basis: bestBid/bestAsk je Symbol. */
  bookFor?: (symbol: string) => { bid: number; ask: number };
  /** Kerzen je (symbol, timeframe, limit). */
  candlesFor?: (symbol: string, timeframe: string, limit: number) => MarketCandle[];
  /** `getTickers` wird NICHT bereitgestellt ⇒ per-Symbol-Fallback. */
  noBulkTickers?: boolean;
  /** Symbols, deren `getOrderBook` wirft. */
  failOrderBookFor?: readonly string[];
  /** Symbols, deren `getCandles` wirft. */
  failCandlesFor?: readonly string[];
  /** Symbols, deren `getTicker` wirft. */
  failTickerFor?: readonly string[];
  /** Werfende Discovery (Netzwerkfehler im Discovery-Stage). */
  failDiscovery?: boolean;
  /** Asynchrone Verzögerung je Anfrage (für Parallelitäts-/Rate-Messung). */
  delay?: () => Promise<void>;
  /** Uhr für die Request-Zeitstempel (Default: `() => Date.now()`). */
  clock?: () => number;
}

/**
 * Der Mock-Adapter: öffentliches Market-Data-Interface, rein im Speicher.
 * `calls` ist nach dem Lauf vollständig ausgewertet (Zähler + Reihenfolge).
 */
export function mockMarketDataAdapter(options: MockAdapterOptions = {}): {
  adapter: MarketDataAdapter;
  calls: MockCallLog;
} {
  const venue = options.venue ?? "BITUNIX";
  const instruments = options.instruments ?? symbols(options.count ?? 3).map((s) => instrumentOf(s, venue));
  const failBook = new Set(options.failOrderBookFor ?? []);
  const failCandles = new Set(options.failCandlesFor ?? []);
  const failTicker = new Set(options.failTickerFor ?? []);
  const clock = options.clock ?? (() => Date.now());

  const calls: MockCallLog = {
    discover: 0,
    ticker: [],
    tickerBatches: [],
    orderBook: [],
    candles: [],
    maxInFlight: 0,
    requestTimes: [],
    order: [],
  };

  let inFlight = 0;
  const guard = async <T,>(symbol: string, run: () => Promise<T>): Promise<T> => {
    inFlight += 1;
    calls.maxInFlight = Math.max(calls.maxInFlight, inFlight);
    calls.requestTimes.push(clock());
    calls.order.push(symbol);
    try {
      if (options.delay) await options.delay();
      return await run();
    } finally {
      inFlight -= 1;
    }
  };

  const tickerFor = (symbol: string, index: number): MarketTicker => {
    const quoteVol = options.quoteVolOf ? options.quoteVolOf(symbol, index) : 50_000_000 - index * 100_000;
    return {
      symbol,
      price: 100 + index,
      source: "mock",
      ts: 1_750_000_000_000,
      ...(quoteVol === null ? { quoteVol: null } : { quoteVol }),
      baseVol: quoteVol === null ? null : quoteVol / 100,
    };
  };

  const bookFor = (symbol: string): MarketOrderBook => {
    const { bid, ask } = options.bookFor ? options.bookFor(symbol) : { bid: 100, ask: 100.02 };
    return { symbol, bids: [{ price: bid, qty: 1 }], asks: [{ price: ask, qty: 1 }], ts: 1_750_000_000_000 };
  };

  const adapter: MarketDataAdapter = {
    venue,
    async discoverInstruments() {
      calls.discover += 1;
      calls.requestTimes.push(clock());
      if (options.failDiscovery) throw new Error("discovery failed: HTTP 503");
      return instruments;
    },
    async getTicker(symbol) {
      return guard(symbol, async () => {
        calls.ticker.push(symbol);
        if (failTicker.has(symbol)) throw new Error(`ticker unavailable for ${symbol}`);
        const index = instruments.findIndex((i) => i.symbol === symbol);
        return tickerFor(symbol, index < 0 ? 0 : index);
      });
    },
    async getOrderBook(symbol) {
      return guard(symbol, async () => {
        calls.orderBook.push(symbol);
        if (failBook.has(symbol)) throw new Error(`depth unavailable for ${symbol}`);
        return bookFor(symbol);
      });
    },
    async getCandles(symbol, timeframe, limit) {
      return guard(symbol, async () => {
        calls.candles.push({ symbol, timeframe, limit });
        if (failCandles.has(symbol)) throw new Error(`kline unavailable for ${symbol}`);
        if (options.candlesFor) return options.candlesFor(symbol, timeframe, limit);
        const index = instruments.findIndex((i) => i.symbol === symbol);
        return trendingCandles(index < 0 ? 0 : index, limit);
      });
    },
  };

  if (!options.noBulkTickers) {
    adapter.getTickers = async (symbolsArg?: string[]) =>
      guard("BULK", async () => {
        const list = symbolsArg ?? instruments.map((i) => i.symbol);
        calls.tickerBatches.push(list ? [...list] : undefined);
        return list.map((symbol, index) => tickerFor(symbol, index));
      });
  }

  return { adapter, calls };
}

/** Service + Speicher an einen deterministischen Ort, feste Uhr. */
export function syncHarness(
  adapter: MarketDataAdapter,
  venue = "BITUNIX",
  options: Partial<SyncOptions> = {}
): {
  service: MarketDataSyncService;
  registry: InstrumentRegistry;
  history: HistoricalStore;
  dir: string;
} {
  const dir = tempDir();
  const registry = new InstrumentRegistry({
    dir,
    autoSave: true,
    now: () => new Date("2026-08-29T00:00:00.000Z"),
  });
  const history = new HistoricalStore(path.join(dir, "history"));
  const service = new MarketDataSyncService(registry, history, new Map([[venue, adapter]]), {
    clock: () => new Date("2026-08-29T00:00:00.000Z"),
    // Warmup-Bedarf wird hier injiziert, damit der Test nicht an einer
    // allfälligen SCANNER_CONFIG_FILE hängt; der Default-Pfad wird separat
    // in "candleLimit below requiredWarmupCandles…" geprüft.
    requiredWarmupCandles: 61,
    ...options,
  });
  return { service, registry, history, dir };
}

/** Bequemer Zugriff auf geschriebene Bars je Timeframe. */
export function barsOf(
  history: HistoricalStore,
  instrumentId: string,
  timeframe: SupportedTimeframe
): number {
  return history.query({ instrumentId, timeframe }).length;
}
