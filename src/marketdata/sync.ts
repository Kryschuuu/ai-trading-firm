/**
 * MarketDataSyncService — single orchestration point for
 * Discovery → Ticker-Enrichment → Orderbook-Enrichment → Candle-Backfill
 * → Registry / HistoricalStore persistence.
 *
 * Network I/O lives HERE, not in the scanner. `scanUniverse()` remains a
 * pure function over already-persisted local data.
 */

import type { HistoricalStore } from "../lib/marketdata/historicalStore";
import type { InstrumentRegistry } from "../universe/registry";
import { sanitizeSyncErrorMessage, sanitizeVenue, UnsupportedVenueError } from "./errors";
import { calculateRelativeSpread } from "./spread";
import {
  SYNC_CANDLE_LIMIT,
  SYNC_TIMEFRAMES,
  type MarketCandle,
  type MarketInstrument,
  type MarketOrderBook,
  type MarketTicker,
  type RateLimiter,
  type SyncError,
  type SyncResult,
  type SyncTimeframe,
} from "./types";

/**
 * Venue-agnostic public market-data port.
 *
 * Jede Venue (Bitunix, Binance, Bitfinex, …) implementiert dieses Interface,
 * um Austauschbarkeit zu gewährleisten. Implementierungen dürfen ausschließlich
 * **öffentliche** Market-Data-Endpunkte verwenden — niemals PrivateClient,
 * API-Keys oder Live-Order-Pfade.
 *
 * Optionales `getTickers` ermöglicht den gebündelten 1×-Tickers-Call, wenn
 * die Venue-API Batch-Abrufe unterstützt. `syncVenue` fällt sonst auf
 * per-Symbol `getTicker` zurück (Unit-Tests mit Mock-Adaptern).
 */
export interface MarketDataAdapter {
  discoverInstruments(): Promise<MarketInstrument[]>;
  getTicker(symbol: string): Promise<MarketTicker>;
  getTickers?(symbols?: string[]): Promise<MarketTicker[]>;
  getOrderBook(symbol: string): Promise<MarketOrderBook>;
  getCandles(symbol: string, timeframe: string, limit: number): Promise<MarketCandle[]>;
}

/** Optional constructor extras (rate limiter, clock) — the 3 required deps stay positional. */
export interface MarketDataSyncOptions {
  now?: () => Date;
  rateLimiter?: RateLimiter;
  candleLimit?: number;
  timeframes?: readonly string[];
}

export class MarketDataSyncService {
  private readonly now: () => Date;
  private readonly rateLimiter?: RateLimiter;
  private readonly candleLimit: number;
  private readonly timeframes: readonly string[];

  constructor(
    private readonly registry: InstrumentRegistry,
    private readonly history: HistoricalStore,
    private readonly adapters: Map<string, MarketDataAdapter>,
    options: MarketDataSyncOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.rateLimiter = options.rateLimiter;
    this.candleLimit = options.candleLimit ?? SYNC_CANDLE_LIMIT;
    this.timeframes = options.timeframes ?? SYNC_TIMEFRAMES;
  }

  // Orchestriert Discovery → Enrichment → Backfill für eine Venue.
  // WICHTIG: Diese Klasse darf NIEMALS von scanUniverse() aufgerufen werden.
  // Der Scanner bleibt deterministisch und netzwerkfrei.
  async syncVenue(venue: string): Promise<SyncResult> {
    const started = performance.now();
    const key = sanitizeVenue(venue).toUpperCase();
    const adapter = this.adapters.get(key) ?? this.adapters.get(venue);
    if (!adapter) throw new UnsupportedVenueError(venue);

    const errors: SyncError[] = [];
    const candlesByTimeframe: Record<string, number> = {};
    for (const tf of this.timeframes) candlesByTimeframe[tf] = 0;

    await this.limit();
    const discovered = await adapter.discoverInstruments();
    const instruments = Array.isArray(discovered) ? discovered : [];

    const tickerBySymbol = await this.loadTickers(adapter, instruments, errors);

    let tickersEnriched = 0;
    let orderbooksEnriched = 0;

    for (const instrument of instruments) {
      const symbol = typeof instrument.symbol === "string" ? instrument.symbol : "";
      const instrumentId =
        typeof instrument.id === "string" && instrument.id
          ? instrument.id
          : symbol
            ? `${key}:${symbol}`
            : undefined;

      let ticker: MarketTicker | undefined = symbol
        ? tickerBySymbol.get(symbol.toUpperCase())
        : undefined;
      if (!ticker) {
        try {
          await this.limit();
          ticker = await adapter.getTicker(symbol);
          if (ticker?.symbol) tickerBySymbol.set(String(ticker.symbol).toUpperCase(), ticker);
        } catch (e) {
          errors.push({
            stage: "ticker",
            instrumentId,
            symbol,
            message: sanitizeSyncErrorMessage(e),
          });
        }
      }
      if (ticker) tickersEnriched += 1;

      let spread: number | null = null;
      try {
        await this.limit();
        const book = await adapter.getOrderBook(symbol);
        spread = calculateRelativeSpread(book.bids[0]?.price, book.asks[0]?.price);
        orderbooksEnriched += 1;
      } catch (e) {
        errors.push({
          stage: "orderbook",
          instrumentId,
          symbol,
          message: sanitizeSyncErrorMessage(e),
        });
      }

      try {
        this.registry.upsert(
          {
            ...instrument,
            venue: instrument.venue || key,
            symbol,
            volume24h: ticker?.quoteVol ?? null,
            spread,
            lastSeen: this.now().toISOString(),
          },
          `sync:${key}`,
        );
      } catch (e) {
        errors.push({
          stage: "upsert",
          instrumentId,
          symbol,
          message: sanitizeSyncErrorMessage(e),
        });
      }

      for (const timeframe of this.timeframes) {
        try {
          await this.limit();
          const candles = await adapter.getCandles(symbol, timeframe, this.candleLimit);
          const rows = Array.isArray(candles) ? candles : [];
          const written = this.history.append(
            rows,
            instrumentId ?? `${key}:${symbol}`,
            { venue: key, feed: `${key}:rest` },
            timeframe,
            this.now(),
          );
          candlesByTimeframe[timeframe] = (candlesByTimeframe[timeframe] ?? 0) + written;
        } catch (e) {
          errors.push({
            stage: "candles",
            instrumentId,
            symbol,
            timeframe,
            message: sanitizeSyncErrorMessage(e),
          });
        }
      }
    }

    return {
      venue: key,
      instrumentsDiscovered: instruments.length,
      tickersEnriched,
      orderbooksEnriched,
      candlesByTimeframe,
      errors,
      durationMs: performance.now() - started,
    };
  }

  /**
   * 1 × tickers (batch) when the adapter supports it; otherwise the
   * per-instrument `getTicker` path in the main loop is used.
   */
  private async loadTickers(
    adapter: MarketDataAdapter,
    instruments: MarketInstrument[],
    errors: SyncError[],
  ): Promise<Map<string, MarketTicker>> {
    const out = new Map<string, MarketTicker>();
    if (!adapter.getTickers || instruments.length === 0) return out;
    try {
      await this.limit();
      const batch = await adapter.getTickers(instruments.map((i) => i.symbol));
      for (const t of batch ?? []) {
        if (t?.symbol) out.set(String(t.symbol).toUpperCase(), t);
      }
    } catch (e) {
      errors.push({ stage: "ticker", message: sanitizeSyncErrorMessage(e) });
    }
    return out;
  }

  private async limit(): Promise<void> {
    if (this.rateLimiter) await this.rateLimiter.take();
  }
}

/** Structured CLI lines — counters only, never symbols or secrets. */
export function formatSyncLog(result: SyncResult, candleLimit = SYNC_CANDLE_LIMIT): string[] {
  const n = result.instrumentsDiscovered;
  const expected = n * candleLimit;
  const lines = [
    `[market-sync] ${result.venue} discovery: ${n} instruments`,
    `[market-sync] tickers enriched: ${result.tickersEnriched}`,
    `[market-sync] orderbooks enriched: ${result.orderbooksEnriched}`,
  ];
  const tfs = Object.keys(result.candlesByTimeframe).length
    ? Object.keys(result.candlesByTimeframe)
    : [...SYNC_TIMEFRAMES];
  for (const tf of tfs) {
    lines.push(`[market-sync] ${tf} candles: ${result.candlesByTimeframe[tf] ?? 0}/${expected}`);
  }
  if (result.errors.length) {
    lines.push(`[market-sync] errors: ${result.errors.length}`);
  }
  lines.push(`[market-sync] duration: ${result.durationMs.toFixed(0)} ms`);
  return lines;
}

export type { SyncTimeframe };
