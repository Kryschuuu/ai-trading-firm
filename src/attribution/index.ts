/**
 * Trade-PnL-Attribution — öffentliche API des Moduls (RMA-P1-06, v1.57.0).
 *
 * Schichten:
 *   model.ts   reine, deterministische Berechnung (Spezifikation ta1)
 *   store.ts   append-only Persistenz (Idempotenz), Detail-/Aggregat-Queries,
 *              Backfill
 *   config.ts  Env-Flags (TRADE_ATTRIBUTION_ENABLED, …_METHOD_VERSION)
 *   hashes.ts  kanonische Serialisierung + Fingerprints
 */
export * from "./types";
export * from "./hashes";
export * from "./config";
export {
  computeTradeAttribution,
  attributeBacktestTrade,
  voteAlignment,
  effectiveConfidence,
  type BacktestTradeLike,
} from "./model";
export {
  recordTradeAttribution,
  queryTradeAttributions,
  aggregateTradeAttributions,
  backfillTradeAttributions,
  ATTRIBUTION_LIMITS,
  ATTRIBUTION_DIMENSIONS,
  type RecordAttributionInput,
  type RecordAttributionResult,
  type AttributionFilter,
  type AttributionDetailRow,
  type AttributionDimension,
  type AttributionGroup,
  type AttributionAggregate,
  type BackfillOptions,
  type BackfillCounts,
} from "./store";
