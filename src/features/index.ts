/**
 * Point-in-Time Feature Store (RMA-P6-01, v1.53.0) — öffentliche API.
 *
 * Ein Einstiegspunkt für Registry, Berechnung, Materialisierung, Abfrage und
 * Persistenz. Consumer importieren **nur** von hier, damit die Modulgrenzen
 * (rein vs. DB) stabil bleiben.
 *
 * Schnellstart:
 *
 * ```ts
 * import {
 *   getSliceRegistry,
 *   materializeSlice,
 *   getFeatureStore,
 *   createStoreBackedSource,
 *   validatePitQuery,
 *   pitQuery,
 * } from "@/features";
 *
 * const registry = getSliceRegistry();
 * await materializeSlice(
 *   {
 *     refs: [{ featureId: "scanner.atr_band", version: 1 }], // zieht scanner.atr mit
 *     entities: ["BITUNIX:BTCUSDT"],
 *     timeframe: "1h",
 *     barsFor: (entityId) => loadBars(entityId),
 *     asOf: new Date(),
 *     availabilityPolicy: "ingested",
 *     mode: "INCREMENTAL",
 *   },
 *   { store: getFeatureStore() }
 * );
 *
 * const checked = validatePitQuery({
 *   asOf: "2026-09-20T12:00:00Z",
 *   entities: "BITUNIX:BTCUSDT",
 *   features: "scanner.atr_band",
 *   timeframe: "1h",
 * });
 * if (checked.ok) console.log(await pitQuery(checked.request, { store: getFeatureStore() }));
 * ```
 */
export * from "./types";
export * from "./registry";
export * from "./validate";
export * from "./compute";
export * from "./definitions";
export * from "./materialize";
export * from "./pitQuery";
export * from "./parity";
export * from "./ports";
export * from "./adapters";
export * from "./sourceQuality";
export { DrizzleFeatureStore, FeaturePersistenceError, getFeatureStore, resetFeatureStoreForTests } from "./store";
export type { FeatureAuditSink, FeatureDb, FeatureStoreDeps } from "./store";
export {
  barsInRange,
  expectedBarsInRange,
  featureStoreStatus,
  materializeSlice,
  parityCheck,
  pitQuery,
} from "./service";
export type {
  FeatureServiceAudit,
  FeatureStatusView,
  FeatureStoreStatus,
  MaterializeDeps,
  MaterializeSliceInput,
  MaterializeSliceResult,
  ParityCheckInput,
  ParityCheckResult,
} from "./service";
