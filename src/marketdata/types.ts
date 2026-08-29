/**
 * Adapter-facing market-data contracts for `MarketDataSyncService`.
 *
 * These types are the venue-agnostic boundary between public REST adapters
 * (Bitunix, Binance, Bitfinex, …) and persistence (`InstrumentRegistry`,
 * `HistoricalStore`). They are intentionally independent of private trading
 * APIs — no credentials, no order payloads, no account state.
 *
 * `MarketInstrument` is the universe contract (single source of truth) so a
 * discovered row can be upserted without a second mapping layer.
 */

export type { MarketInstrument } from "../universe/types";

/** Current ticker / 24h stats from a public market-data endpoint. */
export interface MarketTicker {
  symbol: string;
  price: number;
  /** Public feed id, e.g. `"bitunix"`. Never a secret. */
  source: string;
  /** Unix-epoch milliseconds. */
  ts: number;
  markPrice?: number;
  /** 24h quote-volume — maps to `MarketInstrument.volume24h`. */
  quoteVol?: number;
  baseVol?: number;
  high?: number;
  low?: number;
}

/** One price level of an order book. */
export interface MarketOrderBookLevel {
  price: number;
  qty: number;
}

/** Public order-book snapshot used only to compute relative spread. */
export interface MarketOrderBook {
  symbol?: string;
  instrumentId?: string;
  bids: MarketOrderBookLevel[];
  asks: MarketOrderBookLevel[];
  ts: number;
}

/** One OHLCV candle. `time` is unix-epoch milliseconds. */
export interface MarketCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Timeframes the sync service always backfills. */
export const SYNC_TIMEFRAMES = ["5m", "15m", "30m", "1h"] as const;
export type SyncTimeframe = (typeof SYNC_TIMEFRAMES)[number];

/** Default candle page size per instrument × timeframe. */
export const SYNC_CANDLE_LIMIT = 150;

/** Isolated, non-fatal failure recorded in `SyncResult.errors`. */
export interface SyncError {
  /** Stage that failed. */
  stage: "discovery" | "ticker" | "orderbook" | "candles" | "upsert";
  /** Optional instrument id (`VENUE:SYMBOL`) — never a secret. */
  instrumentId?: string;
  /** Optional venue-native symbol — never a secret. */
  symbol?: string;
  /** Set when `stage === "candles"`. */
  timeframe?: string;
  /** Redacted, truncated human-readable reason. */
  message: string;
}

/**
 * Aggregated outcome of `MarketDataSyncService.syncVenue()`.
 * CLI logs only the counters — never symbols or payloads.
 */
export interface SyncResult {
  venue: string;
  instrumentsDiscovered: number;
  tickersEnriched: number;
  orderbooksEnriched: number;
  candlesByTimeframe: Record<string, number>;
  errors: SyncError[];
  durationMs: number;
}

/** Optional token-bucket (or any serial limiter) used by the orchestrator. */
export interface RateLimiter {
  take(): Promise<void>;
}
