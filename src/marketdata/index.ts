/**
 * Public API of the market-data sync module (MDSYNC-001).
 *
 * This module is the only place that talks to venue public REST APIs for
 * universe discovery and historical warmup. The scanner never imports it,
 * and no HTTP route may either (`test/marketdata/security.test.ts` erzwingt
 * beides statisch).
 */

export {
  MarketDataSyncService,
  defaultSyncLogger,
  formatDegradedLog,
  formatSyncLog,
  rankInstruments,
  resolveSyncOptions,
  defaultRequiredWarmupCandles,
  MAX_CANDLE_LIMIT,
  MAX_CONCURRENCY,
  MAX_INSTRUMENTS_CEILING,
  MIN_CONCURRENCY,
  type MarketDataAdapter,
  type ResolvedSyncOptions,
  type SyncLogger,
  type SyncOptions,
  // Kompatibilitätsname älterer Aufrufer:
  type MarketDataSyncOptions,
} from "./sync";
export {
  InsufficientCandleLimitError,
  SyncPartialFailureError,
  UnsupportedTimeframeError,
  UnsupportedVenueError,
  isSyncableSymbol,
  normalizeSyncSymbol,
  sanitizeSyncErrorMessage,
  sanitizeVenue,
} from "./errors";
export { calculateRelativeSpread } from "./spread";
export {
  candleTimeMs,
  MARKET_SYNC_TIMEFRAMES,
  SYNC_CANDLE_LIMIT,
  SYNC_LIMITS,
  SYNC_TIMEFRAMES,
  type MarketCandle,
  type MarketInstrument,
  type MarketOrderBook,
  type MarketOrderBookLevel,
  type MarketTicker,
  type RateLimiter,
  type SupportedTimeframe,
  type SyncError,
  type SyncFailure,
  type SyncResult,
  type SyncTimeframe,
  type TimeframeSyncStats,
} from "./types";
export {
  AdapterRegistry,
  createAdapterRegistry,
  type AdapterRegistryOptions,
  type SkippedAdapter,
} from "./adapterRegistry";
export {
  BITUNIX_VENUE,
  KNOWN_SYNC_VENUES,
  MARKET_SYNC_ENABLED_FLAG,
  MARKET_SYNC_VENUES_FLAG,
  createMarketDataAdapters,
  marketSyncEnabled,
  marketSyncVenueAllowlist,
  registerAdapters,
  registerMarketDataAdapters,
  type RegisterAdaptersOptions,
  type RegisterAdaptersResult,
} from "./registerAdapters";
export {
  BITUNIX_MARKET_DATA_VENUE,
  BITUNIX_SUPPORTED_INTERVALS,
  BITUNIX_TIMEFRAME_MAP,
  createBitunixMarketDataAdapter,
  mapInstrumentStatus,
  mapTradingPairToInstrument,
  toBitunixInterval,
  type BitunixMarketAdapterDeps,
} from "./adapters/bitunix";
export {
  clearMarketDataErrors,
  loadMarketDataErrors,
  saveMarketDataErrors,
  syncErrorsToDataErrors,
  type MarketDataErrorManifest,
  type MarketDataErrorManifestEntry,
} from "./dataErrors";
