/**
 * Offline-/Online-Parität (RMA-P6-01, v1.53.0).
 *
 * Beide Pfade verwenden **dieselbe** Registry und **dieselben** Executors
 * (`./compute.ts`):
 *
 *   * **offline** (Backtest/Recherche): Wert wird aus den Rohkerzen neu
 *     berechnet (`planMaterialization`, Politik `bar_close`).
 *   * **online** (Materialisierung/Live): Wert wird aus dem Store gelesen
 *     (`feature_values`, dieselbe Definition, derselbe Fingerprint).
 *
 * Dieses Modul vergleicht beide Seiten **inhaltlich** (`valueHash`) und meldet
 * jede Divergenz mit Grund — inklusive Datenrevision: derselbe Schlüssel, aber
 * ein anderer Dataset-Hash im Source-Manifest bedeutet, dass die Rohdaten
 * zwischenzeitlich revidiert wurden (der Store behält den historischen Wert,
 * siehe `feature_data_revisions`).
 *
 * Der Vergleich ist rein und mengenbegrenzt (`FEATURE_LIMITS`) — das CLI
 * `npm run features:parity` und die Tests nutzen exakt diese Funktion.
 */
import {
  FEATURE_LIMITS,
  FeatureStoreError,
  type FeatureRef,
  type FeatureValueDraft,
  type FeatureValueRow,
} from "./types";
import { valueKey } from "./materialize";

/** Grund einer Paritätsabweichung (geschlossene Aufzählung). */
export type ParityDivergenceReason = "MISSING_STORED" | "VALUE_MISMATCH" | "DATASET_REVISION" | "DEFINITION_MISMATCH";

/** Eine gemeldete Abweichung (bounded: max. `maxDivergences` im Report). */
export interface ParityDivergence {
  entityId: string;
  featureId: string;
  version: number;
  eventTime: string;
  reason: ParityDivergenceReason;
  offlineValueHash: string | null;
  storedValueHash: string | null;
}

/** Ergebnis eines Paritätsvergleichs. */
export interface ParityReport {
  checked: number;
  matched: number;
  divergent: number;
  missingStored: number;
  /** Abweichungen (auf `maxDivergences` begrenzt, Zähler oben sind exakt). */
  divergences: readonly ParityDivergence[];
  /** `true`, wenn mehr Abweichungen existieren als gemeldet werden. */
  truncated: boolean;
}

/** Eingabe des Vergleichs: eine Seite offline, eine Seite Store. */
export interface ParityComparisonInput {
  offline: readonly FeatureValueDraft[];
  stored: readonly FeatureValueRow[];
  registry: { require(ref: FeatureRef | { featureId: string }): { definitionHash: string } };
  /** Obergrenze gemeldeter Abweichungen (Detailtiefe, nicht Korrektheit). */
  maxDivergences?: number;
}

/**
 * Vergleicht offline berechnete Werte mit den im Store liegenden Zeilen.
 *
 * Geprüft wird ausschließlich die Schnittmenge „offline geplanter Wert“;
 * zusätzliche Store-Zeilen (z. B. aus früheren Läufen oder anderen Batches)
 * sind keine Divergenz — sie sind schlicht nicht Teil dieses Vergleichs.
 */
export function compareParity(input: ParityComparisonInput): ParityReport {
  const maxDivergences = input.maxDivergences ?? 20;
  if (!Number.isInteger(maxDivergences) || maxDivergences < 1 || maxDivergences > 500) {
    throw new FeatureStoreError(
      "FEATURE_PARITY_INVALID",
      `maxDivergences muss eine ganze Zahl in 1..500 sein (erhalten: ${String(maxDivergences)}).`
    );
  }
  const storedByKey = new Map<string, FeatureValueRow>();
  for (const row of input.stored) {
    storedByKey.set(valueKey(row.featureId, row.featureVersion, row.entityId, row.timeframe, row.eventTime), row);
  }

  let checked = 0;
  let matched = 0;
  let divergent = 0;
  let missingStored = 0;
  let truncated = false;
  const divergences: ParityDivergence[] = [];

  const push = (divergence: ParityDivergence): void => {
    divergent += 1;
    if (divergences.length < maxDivergences) divergences.push(divergence);
    else truncated = true;
  };

  for (const draft of input.offline) {
    const definition = input.registry.require({ featureId: draft.featureId, version: draft.featureVersion });
    if (definition.definitionHash !== draft.definitionHash) {
      push({
        entityId: draft.entityId,
        featureId: draft.featureId,
        version: draft.featureVersion,
        eventTime: draft.eventTime.toISOString(),
        reason: "DEFINITION_MISMATCH",
        offlineValueHash: draft.valueHash,
        storedValueHash: null,
      });
      continue;
    }
    checked += 1;
    const row = storedByKey.get(valueKey(draft.featureId, draft.featureVersion, draft.entityId, draft.timeframe, draft.eventTime));
    if (!row) {
      missingStored += 1;
      push({
        entityId: draft.entityId,
        featureId: draft.featureId,
        version: draft.featureVersion,
        eventTime: draft.eventTime.toISOString(),
        reason: "MISSING_STORED",
        offlineValueHash: draft.valueHash,
        storedValueHash: null,
      });
      continue;
    }
    if (row.valueHash === draft.valueHash) {
      matched += 1;
      continue;
    }
    const reason: ParityDivergenceReason =
      row.sourceManifest.datasetHash !== draft.sourceManifest.datasetHash
        ? "DATASET_REVISION"
        : row.definitionHash !== draft.definitionHash
          ? "DEFINITION_MISMATCH"
          : "VALUE_MISMATCH";
    push({
      entityId: draft.entityId,
      featureId: draft.featureId,
      version: draft.featureVersion,
      eventTime: draft.eventTime.toISOString(),
      reason,
      offlineValueHash: draft.valueHash,
      storedValueHash: row.valueHash,
    });
  }

  return {
    checked,
    matched,
    divergent,
    missingStored,
    divergences: Object.freeze(divergences),
    truncated,
  };
}

/**
 * Prüft die Mengenbegrenzung eines Paritätsvergleichs (DoS-Deckel).
 *
 * @throws {FeatureStoreError} `FEATURE_PARITY_LIMIT` bei Überschreitung.
 */
export function assertParityWithinLimits(offlineCount: number, storedCount: number): void {
  const max = FEATURE_LIMITS.pitSourceRows;
  if (offlineCount > max || storedCount > max) {
    throw new FeatureStoreError(
      "FEATURE_PARITY_LIMIT",
      `Paritätsvergleich zu groß (${offlineCount} offline / ${storedCount} gespeichert, Grenze ${max}). ` +
        "Entities oder Zeitraum eingrenzen.",
      { offlineCount, storedCount, max }
    );
  }
}
