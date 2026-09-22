/**
 * Auswertung persistenter Regime-Snapshots (RMA-P2-01, v1.61.0) — REIN,
 * keine IO: Stabilität, Transitions, Coverage sowie regimebezogene
 * OOS-Kennzahlen über die Historie aus `regime_snapshots`.
 *
 * Eingabe sind kanonische Snapshot-Zeilen (Symbol, as_of, Roh-/Bestätigt-
 * klasse, Confidence, Coverage, Degraded, optionale Forward-Returns). Alle
 * Aggregationen sind deterministisch (feste Sortierung, gebündelte Keys) und
 * gebounded: das Transitionsmatrix-Vokabular ist die feste Regime-Liste
 * (6 × 6 = 36 Einträge), Treiber-/Familien-Auswertungen finden hier nicht
 * statt (die sind je Snapshot auf ≤ 5 begrenzt).
 *
 * Look-ahead-Hinweis OOS: Forward-Returns werden AUSSERHALB dieser
 * Evaluation berechnet (`scripts/regime-eval.ts`) und beschreiben die
 * ZUKUNFT nach einem Snapshot — Messung, keine Entscheidung. Snapshots ohne
 * ausreichenden Horizont (`forwardReturnPct: null`) werden fail-closed
 * AUSSCHLIESSEN (nie mit 0 ersetzt).
 */
import {
  REGIME_FEATURE_VERSION,
  REGIME_MODEL_VERSION,
} from "./regimeFeatures";

/** Kanonische Snapshot-Zeile für die Evaluation (Parser: regime-eval-Script). */
export interface RegimeEvalRow {
  symbol: string;
  /** as_of in ms. */
  asOfMs: number;
  rawRegime: string;
  confirmedRegime: string;
  /** Confidence [0,1] oder `null` (UNKNOWN). */
  confidence: number | null;
  coverage: number;
  degraded: boolean;
  /**
   * Forward-Return in % über den Evaluationshorizont; `null` = Horizont
   * nicht erreichbar (wird ausgeschlossen, nie als 0 gewertet).
   */
  forwardReturnPct?: number | null;
}

/** Alle 6 Klassen des Vertrags — feste Ordnung für Matrix und Reports. */
export const REGIME_EVAL_LABELS = [
  "TREND_UP",
  "TREND_DOWN",
  "RANGE",
  "HIGH_VOL",
  "CRASH",
  "UNKNOWN",
] as const;

const round = (v: number, digits: number): number => {
  if (!Number.isFinite(v)) return 0;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

const mean = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;

export interface RegimeStabilityReport {
  schemaVersion: 1;
  featureVersion: string;
  modelVersion: string;
  /** Anzahl ausgewerteter Snapshots (nach Sortierung). */
  snapshots: number;
  symbols: number;
  window: { fromMs: number | null; toMs: number | null };
  /** Bestätigte Zustandswechsel über alle Symbole (kanonische Reihenfolge). */
  transitions: number;
  /** Transitions je Symbol (Mittel), gebounded auf [0, …]. */
  transitionsPerSymbol: number;
  /** Wechselquote = Transitions / max(1, Snapshots − Symbole). */
  flipRate: number;
  coverage: {
    mean: number;
    min: number;
    /** Anteil degradieter Snapshots [0,1]. */
    degradedShare: number;
  };
  confidence: {
    /** Mittel über bekannte Snapshots (UNKNOWN zählt nicht mit). */
    mean: number | null;
    min: number | null;
    knownShare: number;
  };
  /** Bestätigte Klasse → Anzahl (feste Vokabular-Liste). */
  byConfirmed: Record<string, number>;
  /** Rohklasse → Anzahl. */
  byRaw: Record<string, number>;
  /** `VON→NACH` → Anzahl (nur echte Wechsel, feste 6×6-Möglichkeiten). */
  transitionsByPair: Record<string, number>;
}

/**
 * Stabilitäts-/Transitions-/Coverage-Report aus den Snapshot-Zeilen.
 * Deterministisch: Zeilen werden nach (symbol, asOfMs) sortiert; Wechsel
 * werden je Symbol über die bestätigte Klasse gezählt.
 */
export function evaluateRegimeStability(rows: readonly RegimeEvalRow[]): RegimeStabilityReport {
  const sorted = [...rows].sort((a, b) => a.symbol.localeCompare(b.symbol) || a.asOfMs - b.asOfMs);
  const symbols = new Set(sorted.map((r) => r.symbol));

  const byConfirmed: Record<string, number> = {};
  const byRaw: Record<string, number> = {};
  const transitionsByPair: Record<string, number> = {};
  for (const label of REGIME_EVAL_LABELS) {
    byConfirmed[label] = 0;
    byRaw[label] = 0;
    for (const to of REGIME_EVAL_LABELS) transitionsByPair[`${label}→${to}`] = 0;
  }

  let transitions = 0;
  const coverages: number[] = [];
  const confidences: number[] = [];
  let degradedCount = 0;
  let knownCount = 0;

  let prev: RegimeEvalRow | null = null;
  for (const row of sorted) {
    const confirmed = (byConfirmed[row.confirmedRegime] != null ? row.confirmedRegime : "UNKNOWN") as string;
    const raw = (byRaw[row.rawRegime] != null ? row.rawRegime : "UNKNOWN") as string;
    byConfirmed[confirmed] += 1;
    byRaw[raw] += 1;
    coverages.push(Math.min(Math.max(row.coverage, 0), 1));
    if (row.degraded) degradedCount += 1;
    if (row.confidence != null && Number.isFinite(row.confidence)) {
      confidences.push(Math.min(Math.max(row.confidence, 0), 1));
      knownCount += 1;
    }
    if (prev && prev.symbol === row.symbol && prev.confirmedRegime !== confirmed) {
      transitions += 1;
      const pair = `${prev.confirmedRegime}→${confirmed}`;
      transitionsByPair[pair] = (transitionsByPair[pair] ?? 0) + 1;
    }
    prev = row;
  }

  const snapshotCount = sorted.length;
  const symbolCount = symbols.size;
  const windowSteps = Math.max(1, snapshotCount - symbolCount);
  return {
    schemaVersion: 1,
    featureVersion: REGIME_FEATURE_VERSION,
    modelVersion: REGIME_MODEL_VERSION,
    snapshots: snapshotCount,
    symbols: symbolCount,
    window: {
      fromMs: snapshotCount > 0 ? sorted[0].asOfMs : null,
      toMs: snapshotCount > 0 ? sorted[snapshotCount - 1].asOfMs : null,
    },
    transitions,
    transitionsPerSymbol: symbolCount > 0 ? round(transitions / symbolCount, 4) : 0,
    flipRate: snapshotCount > 0 ? round(transitions / windowSteps, 4) : 0,
    coverage: {
      mean: round(mean(coverages), 4),
      min: coverages.length > 0 ? round(Math.min(...coverages), 4) : 0,
      degradedShare: snapshotCount > 0 ? round(degradedCount / snapshotCount, 4) : 0,
    },
    confidence: {
      mean: confidences.length > 0 ? round(mean(confidences), 4) : null,
      min: confidences.length > 0 ? round(Math.min(...confidences), 4) : null,
      knownShare: snapshotCount > 0 ? round(knownCount / snapshotCount, 4) : 0,
    },
    byConfirmed,
    byRaw,
    transitionsByPair,
  };
}

export interface RegimeOosMetrics {
  regime: string;
  /** Snapshots dieser Klasse (alle). */
  snapshots: number;
  /** Mit Forward-Return ausgewertete Snapshots. */
  samples: number;
  /** Ohne Horizont ausgeschlossene Snapshots (fail-closed, nie 0). */
  excluded: number;
  /** Mittlerer Forward-Return in % über die ausgewerteten Snapshots. */
  meanForwardReturnPct: number | null;
  /** Anteil positiver Forward-Returns [0,1]. */
  positiveShare: number | null;
}

/**
 * OOS-Kennzahlen je bestätigter Regime-Klasse aus Forward-Returns.
 * Snapshots ohne belegbaren Horizont (`null`) werden ausgeschlossen und
 * als `excluded` ausgewiesen — nie als 0 % gewertet.
 */
export function evaluateRegimeOos(rows: readonly RegimeEvalRow[]): RegimeOosMetrics[] {
  const buckets = new Map<string, { returns: number[]; snapshots: number; excluded: number }>();
  for (const label of REGIME_EVAL_LABELS) buckets.set(label, { returns: [], snapshots: 0, excluded: 0 });
  for (const row of rows) {
    const key = (buckets.has(row.confirmedRegime) ? row.confirmedRegime : "UNKNOWN") as string;
    const bucket = buckets.get(key)!;
    bucket.snapshots += 1;
    const fwd = row.forwardReturnPct;
    if (fwd == null || !Number.isFinite(fwd)) bucket.excluded += 1;
    else bucket.returns.push(fwd);
  }
  const out: RegimeOosMetrics[] = [];
  for (const label of REGIME_EVAL_LABELS) {
    const bucket = buckets.get(label)!;
    if (bucket.snapshots === 0) continue;
    const returns = bucket.returns;
    out.push({
      regime: label,
      snapshots: bucket.snapshots,
      samples: returns.length,
      excluded: bucket.excluded,
      meanForwardReturnPct: returns.length > 0 ? round(mean(returns), 4) : null,
      positiveShare:
        returns.length > 0 ? round(returns.filter((r) => r > 0).length / returns.length, 4) : null,
    });
  }
  return out;
}

/** Gesamtreport für das Eval-Artefakt (Stabilität + OOS, gebounded). */
export function buildRegimeEvalReport(rows: readonly RegimeEvalRow[]): {
  schemaVersion: 1;
  generatedAt: string;
  featureVersion: string;
  modelVersion: string;
  stability: RegimeStabilityReport;
  oos: RegimeOosMetrics[];
} {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    featureVersion: REGIME_FEATURE_VERSION,
    modelVersion: REGIME_MODEL_VERSION,
    stability: evaluateRegimeStability(rows),
    oos: evaluateRegimeOos(rows),
  };
}
