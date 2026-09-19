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
  enrichWithTickers,
  enrichWithOrderBooks,
  type EnrichmentReport,
  type EnrichOrderBooksOptions,
} from "./enrichment";
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
  loadMarketDataBatchErrors,
  loadMarketDataErrors,
  saveMarketDataErrors,
  syncErrorsToDataErrors,
  type MarketDataErrorBatchEntry,
  type MarketDataErrorManifest,
  type MarketDataErrorManifestEntry,
} from "./dataErrors";
// ── Qualitäts-Layer & Aggregation (GAP-07, v1.47.0) ────────────────────────
export {
  AGGREGATION_SOURCE,
  AGGREGATION_TARGETS,
  aggregateCandles,
  aggregateInstrument,
  checkAggregationConsistency,
  type AggregateOptions,
  type AggregationResult,
} from "./aggregate";
export {
  AGGREGATE_ENABLED_ENV,
  CROSSCHECK_ENABLED_ENV,
  CROSSCHECK_TOLERANCE_BOUNDS,
  CROSSCHECK_TOLERANCE_DEFAULT,
  CROSSCHECK_TOLERANCE_ENV,
  DEFAULT_STALE_HOURS,
  OUTLIER_ATR_MULT_BOUNDS,
  OUTLIER_ATR_MULT_DEFAULT,
  OUTLIER_ATR_MULT_ENV,
  QUALITY_CLASSES,
  QUALITY_MODE_ENV,
  QUALITY_REASON,
  QUALITY_REPORT_FILE,
  STALE_HOURS_BOUNDS,
  STALE_HOURS_ENV,
  buildQualityReport,
  crosscheckCandles,
  evaluateStaleSeries,
  isQualityClass,
  loadQualityConfig,
  loadQualityReport,
  parseOnFlag,
  parseQualityMode,
  qualityStrictDataErrors,
  qualityStrictDataErrorsForScan,
  recordQualityFindings,
  saveQualityReport,
  summarizeStaleByVenue,
  trueRanges,
  validateCandleSeries,
  type CrosscheckResult,
  type QualityCandle,
  type QualityClass,
  type QualityConfig,
  type QualityFinding,
  type QualityMode,
  type QualityReport,
  type QualitySeriesReport,
  type StaleSeriesState,
  type VenueStaleSummary,
} from "./quality";
export {
  loadVenueSyncStatuses,
  saveVenueSyncStatus,
  syncResultToVenueStatus,
  MARKET_SYNC_STATUS_FILE,
  type VenueStaleStatus,
  type VenueSyncStatus,
} from "./syncStatus";
