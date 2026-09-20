/**
 * Offline-/Online-Adapter des Feature Stores (RMA-P6-01, v1.53.0).
 *
 * Beide Adapter beantworten dieselbe Frage („welche Werte waren zu `as_of`
 * bekannt?“), nutzen dieselbe Registry und dieselben Executors — sie
 * unterscheiden sich nur in der **Quelle**:
 *
 * | Adapter                     | Quelle                                        | Einsatz                     |
 * | --------------------------- | --------------------------------------------- | --------------------------- |
 * | {@link createStoreBackedSource}  | `feature_values` (materialisiert)       | Backtest/Recherche (offline) |
 * | {@link createComputeBackedSource}| Rohkerzen, on-the-fly über den Planer   | Live-Pfad/Smoke-Check (online) |
 *
 * Die Parität beider Pfade ist das Kernversprechen des Stores: derselbe
 * Definitions-Fingerprint, dieselbe Formel, dieselben Zeiten ⇒ derselbe Wert
 * (`npm run features:parity`, Tests in `tests/featureStore.test.ts`).
 */
import { barCloseTime, type FeatureBarInput } from "./compute";
import { planMaterialization } from "./materialize";
import { runPitQuery, type PitQueryRequest, type PitSource } from "./pitQuery";
import type { FeatureRegistry } from "./registry";
import { getSliceRegistry } from "./definitions";
import type { FeatureValueRow } from "./types";
import type { FeatureSeriesScope, FeatureStorePort } from "./ports";

/** Einheitliche Schnittstelle beider Adapter. */
export interface FeatureValueSource {
  /** Merkmal der Quelle (für Audit/Metrik/Doku): `store` | `compute`. */
  readonly kind: "store" | "compute";
  /** PIT-Abfrage; wirft bei Grenzverletzungen statt zu kürzen. */
  read(request: PitQueryRequest): Promise<import("./types").FeaturePitResult>;
}

/**
 * Adapter auf den **materialisierten** Store (offline/Backtest).
 *
 * Liest ausschließlich Zeilen mit `event_time <= target` und
 * `available_at <= as_of` (SQL-Vorfilter im Store, endgültige Prüfung im Join).
 */
export function createStoreBackedSource(deps: {
  store: FeatureStorePort;
  registry?: FeatureRegistry;
  maxLagMs?: number;
}): FeatureValueSource {
  const registry = deps.registry ?? getSliceRegistry();
  return {
    kind: "store",
    async read(request: PitQueryRequest) {
      return runPitQuery(request, deps.store, registry, { maxLagMs: deps.maxLagMs });
    },
  };
}

/**
 * Adapter, der Werte **on-the-fly** aus Rohkerzen berechnet (online/Live).
 *
 * Nutzt exakt denselben Planer wie die Materialisierung — nur ohne
 * Persistenz. Verfügbarkeit folgt derselben Politik (`ingested`: verspätete
 * Rohdaten sind unsichtbar, bis sie tatsächlich eingetroffen sind), sodass ein
 * Live-Consumer und ein Backtest nicht auseinanderlaufen.
 */
export function createComputeBackedSource(deps: {
  registry?: FeatureRegistry;
  timeframe: PitQueryRequest["timeframe"];
  /** Rohkerzen je Entity (bereits die Reihe des Timeframes). */
  barsFor: (entityId: string) => readonly FeatureBarInput[];
  /** Qualitätsstatus je Bar (Quelle: Quality-Layer). */
  qualityForBar?: (entityId: string, eventTimeMs: number) => import("./types").FeatureQualityStatus;
  /** Injizierte Uhr (Berechnungszeitpunkt). */
  now?: () => Date;
}): FeatureValueSource {
  const registry = deps.registry ?? getSliceRegistry();
  return {
    kind: "compute",
    async read(request: PitQueryRequest) {
      const now = deps.now ?? (() => new Date());
      const boundary = request.targetTime.getTime();
      const rows: FeatureValueRow[] = [];
      for (const entityId of request.entities) {
        const refs = request.features.map((spec) => {
          const def = registry.require(spec);
          return { featureId: def.featureId, version: def.version };
        });
        const plan = planMaterialization({
          registry,
          refs,
          entityId,
          timeframe: deps.timeframe,
          bars: deps.barsFor(entityId),
          asOf: boundary,
          availabilityPolicy: "ingested",
          computedAt: now(),
          maxRows: 2000,
          qualityForBar: deps.qualityForBar ? (ms) => (deps.qualityForBar as (e: string, m: number) => import("./types").FeatureQualityStatus)(entityId, ms) : undefined,
        });
        for (const draft of plan.drafts) {
          rows.push({
            ...draft,
            id: draft.valueHash,
            runId: null,
            createdAt: draft.computedAt,
          });
        }
      }
      const source: PitSource = { readValues: async () => rows };
      return runPitQuery(request, source, registry, { sourceLimit: 1_000_000 });
    },
  };
}

/**
 * Zeitfenster, das eine PIT-Abfrage im Store abdeckt: älteste Eventzeit bis
 * `targetTime`. Wird für begrenzte Bestandslesungen (Paritätsjob) gebraucht.
 */
export function coveredRange(
  bars: readonly FeatureBarInput[],
  targetTime: Date,
  timeframe: PitQueryRequest["timeframe"]
): { fromTs: Date; toTs: Date } {
  const first = bars.length > 0 ? barCloseTime(bars[0], timeframe) : targetTime.getTime();
  return { fromTs: new Date(first), toTs: targetTime };
}

/** Standard-Scope einer Statusabfrage (alle Registry-Features eines Timeframes). */
export function defaultScope(
  registry: FeatureRegistry,
  timeframe: PitQueryRequest["timeframe"],
  entityIds: readonly string[]
): FeatureSeriesScope {
  return {
    entityIds,
    refs: registry
      .definitions()
      .filter((def) => def.timeframe === timeframe)
      .map((def) => ({ featureId: def.featureId, version: def.version })),
    timeframe,
  };
}
