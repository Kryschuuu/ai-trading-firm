/**
 * Shared, hard safety bounds for historical candle sync and persistence.
 *
 * A venue request is still bounded independently by its adapter/HTTP page cap;
 * these limits apply to the aggregate series and the total work requested by a
 * single sync run.
 */

/** Maximum number of candles accepted for one instrument × timeframe series. */
export const MAX_CANDLES_PER_SERIES = 100_000;

/** Maximum theoretical candle rows requested in one sync run. */
export const MAX_CANDLES_PER_SYNC_RUN = 1_000_000;

/** Maximum number of sequential venue pages fetched for one series. */
export const MAX_CANDLE_PAGES_PER_SERIES = 1_000;

/** Default HistoricalStore retention; aligned with the sync's per-series cap. */
export const DEFAULT_MAX_BARS_PER_SERIES = MAX_CANDLES_PER_SERIES;
