/**
 * Forecast-Ledger, Brier Score und Kalibrierung (RMA-P3-01, v1.55.0) —
 * öffentliche API.
 *
 * Ein Einstiegspunkt für Vertragstypen, Capture-Policy, Scoring, Resolver und
 * Persistenz. Consumer importieren **nur** von hier, damit die Modulgrenzen
 * (rein vs. DB) stabil bleiben.
 *
 * Schnellstart:
 *
 * ```ts
 * import {
 *   captureAnalystForecast,
 *   runForecastResolverJob,
 *   forecastScoreReport,
 * } from "@/forecasts";
 *
 * // Capture (aus dem Analystenpfad):
 * await captureAnalystForecast({
 *   role: "TECHNICAL_ANALYST",
 *   symbol: "BTC",
 *   view: "BULLISH",
 *   confidence: 0.6,
 *   promptVersion: 3,
 *   model: "qwen2.5:3b-instruct-q4_K_M",
 * });
 *
 * // Auflösung (Scheduler oder POST /api/firm/forecasts/resolve):
 * await runForecastResolverJob();
 *
 * // Kalibrierungsbericht (GET /api/firm/forecasts/scores):
 * const report = await forecastScoreReport({ agentRole: "TECHNICAL_ANALYST" });
 * ```
 */
export * from "./types";
export * from "./capture";
export * from "./scoring";
export * from "./hashes";
export * from "./metrics";
export * from "./ports";
export {
  DrizzleForecastLedger,
  ForecastLedgerError,
  contractFromRow,
  resolutionFromRow,
  effectiveStatus,
  latestOf,
} from "./ledger";
export type { ForecastAuditSink, ForecastDb, ForecastLedgerDeps } from "./ledger";
export { HistoricalStoreOutcomeSource, FORECAST_STORE_FEED, provenanceOfEntity } from "./outcomeSource";
export type { OutcomeSourceDeps } from "./outcomeSource";
export {
  evaluateForecast,
  expectedBarCount,
  runForecastResolution,
  reResolveForecast,
  voidForecastByOperator,
  ResolverInputError,
  FORECAST_OPERATOR_REASONS,
} from "./resolver";
export type {
  ForecastResolverDeps,
  LiveBar,
  OperatorResolutionInput,
  ResolverRunResult,
  ForecastOperatorReason,
} from "./resolver";
export {
  captureAnalystForecast,
  defaultReferenceProvider,
  forecastLedgerEnabled,
  forecastMinSample,
  forecastScoreReport,
  forecastList,
  forecastOperationsStatus,
  getForecastLedger,
  getForecastOutcomeSource,
  forecastResolverDeps,
  paperEntityIdOf,
  resetForecastServiceForTests,
  runForecastResolverJob,
  operatorReResolve,
  operatorVoid,
  FORECAST_LEDGER_ENABLED_ENV,
  FORECAST_RESOLVER_INTERVAL_ENV,
  FORECAST_MIN_SAMPLE_ENV,
} from "./service";
export type { AnalystCaptureInput, AnalystCaptureResult, ForecastReferenceProvider } from "./service";
