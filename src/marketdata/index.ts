/**
 * Public API of the market-data sync module.
 *
 * This module is the only place that talks to venue public REST APIs for
 * universe discovery and historical warmup. The scanner never imports it.
 */

export {
  MarketDataSyncService,
  formatSyncLog,
  type MarketDataAdapter,
  type MarketDataSyncOptions,
} from "./sync";
export { UnsupportedVenueError, sanitizeSyncErrorMessage, sanitizeVenue } from "./errors";
export { calculateRelativeSpread } from "./spread";
export {
  SYNC_TIMEFRAMES,
  SYNC_CANDLE_LIMIT,
  type MarketCandle,
  type MarketInstrument,
  type MarketOrderBook,
  type MarketOrderBookLevel,
  type MarketTicker,
  type RateLimiter,
  type SyncError,
  type SyncResult,
  type SyncTimeframe,
} from "./types";
export {
  BitunixMarketDataAdapter,
  createBitunixMarketDataAdapter,
  mockBitunixPublicClient,
} from "./adapters/bitunix";
