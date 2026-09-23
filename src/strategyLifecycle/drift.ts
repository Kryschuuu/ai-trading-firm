/**
 * Backtest↔Paper↔Live-Drift-Bewertung (RMA-P1-05) — reine Funktionen.
 *
 * Vergleichbare Metriken je Segment (performance, risk, execution,
 * dataQuality) gegen eine Baseline (Backtest-OOS bzw. Paper-Fenster):
 *   - absolute und relative Toleranzen,
 *   - Mindeststichprobe (unterhalb ⇒ INCONCLUSIVE, fail-closed),
 *   - Confidence ∈ [0,1] aus Stichprobe und Datenfrische,
 *   - null/unbekannte Werte werden NIE als 0 gewertet.
 *
 * Zeitsemantik: alle Zeiten sind Millisekunden-Epochen. `eventTime` =
 * Beobachtungsende der Metrik, `availableAt` = wann sie im Prozess bekannt
 * war, `computedAt` = Bewertungszeit. Staleness misst gegen `availableAt`,
 * nie gegen den Roh-Eventzeitstempel späterer Kerzen.
 */

import { createHash } from "node:crypto";

export const DRIFT_SEGMENTS = ["performance", "risk", "execution", "dataQuality"] as const;
export type DriftSegment = (typeof DRIFT_SEGMENTS)[number];

export type DriftVerdict = "OK" | "BREACH" | "INCONCLUSIVE";

export type DriftMetricDirection = "lower-is-better" | "higher-is-better" | "band";

export interface DriftMetricSpec {
  readonly key: string;
  readonly segment: DriftSegment;
  readonly direction: DriftMetricDirection;
  /** Absolute Toleranz in METRIK-Einheiten (>= 0). */
  readonly absTolerance: number;
  /** Relative Toleranz gegenüber der Baseline (0.15 = 15 %); >= 0. */
  readonly relTolerance: number;
}

/**
 * Kanonisches Metrik-Set. Einheiten:
 *   - winRate: Anteil [0,1]
 *   - profitFactor: Verhältnis (>0)
 *   - maxDrawdownPct: Prozent des Kapitals (0–100)
 *   - avgSlippageBps: Basispunkte
 *   - dataQualityScore: [0,1]
 *   - avgTradePnl: Kontowährung je Trade
 */
export const DRIFT_METRIC_SPECS: readonly DriftMetricSpec[] = [
  { key: "winRate", segment: "performance", direction: "band", absTolerance: 0.08, relTolerance: 0.25 },
  { key: "profitFactor", segment: "performance", direction: "band", absTolerance: 0.25, relTolerance: 0.25 },
  { key: "avgTradePnl", segment: "performance", direction: "band", absTolerance: 0.0001, relTolerance: 0.5 },
  { key: "maxDrawdownPct", segment: "risk", direction: "lower-is-better", absTolerance: 5, relTolerance: 0.5 },
  { key: "avgSlippageBps", segment: "execution", direction: "lower-is-better", absTolerance: 10, relTolerance: 0.5 },
  { key: "dataQualityScore", segment: "dataQuality", direction: "higher-is-better", absTolerance: 0.1, relTolerance: 0.15 },
] as const;

export const DRIFT_METRIC_BY_KEY: ReadonlyMap<string, DriftMetricSpec> = new Map(
  DRIFT_METRIC_SPECS.map((s) => [s.key, s])
);

/** Drift-Window-Konfiguration (Policy-Teil; versioniert über `slp1`). */
export interface DriftPolicy {
  readonly version: string;
  /** Mindeststichprobe (Trades/Observationen) je Seite. */
  readonly minSample: number;
  /** Max. Alter der Basis-/Current-Metrik ab availableAt (ms). */
  readonly maxMetricAgeMs: number;
  /** Confidence-Schwelle, ab der ein OK die Promotion trägt. */
  readonly minConfidence: number;
}

const DRIFT_POLICY_BODY = {
  minSample: 20,
  maxMetricAgeMs: 48 * 60 * 60 * 1000,
  minConfidence: 0.6,
} as const;

function hashHex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export const DEFAULT_DRIFT_POLICY: DriftPolicy = Object.freeze({
  ...DRIFT_POLICY_BODY,
  version: `sld1:${hashHex(
    JSON.stringify(
      Object.keys(DRIFT_POLICY_BODY)
        .sort()
        .map((k) => [k, (DRIFT_POLICY_BODY as Record<string, unknown>)[k]])
    )
  )}`,
});

export interface MetricWindow {
  /** Metrikwert — null = unbekannt (fail-closed, nie 0). */
  readonly value: number | null;
  /** Stichprobe (Trades/Observationen). */
  readonly sampleSize: number | null;
  readonly eventTimeMs: number;
  readonly availableAtMs: number;
  readonly computedAtMs: number;
}

export interface MetricPair {
  readonly key: string;
  readonly baseline: MetricWindow | null;
  readonly current: MetricWindow | null;
}

export interface MetricDriftResult {
  readonly key: string;
  readonly segment: DriftSegment;
  readonly verdict: DriftVerdict;
  readonly reasonCode:
    | "OK"
    | "ABOVE_ABS_TOL"
    | "ABOVE_REL_TOL"
    | "BELOW_ABS_TOL"
    | "BELOW_REL_TOL"
    | "BASELINE_MISSING"
    | "CURRENT_MISSING"
    | "NULL_VALUE"
    | "STALE"
    | "SAMPLE_TOO_SMALL"
    | "UNKNOWN_METRIC";
  readonly baselineValue: number | null;
  readonly currentValue: number | null;
  readonly delta: number | null;
  readonly relDelta: number | null;
  readonly sampleSize: number | null;
  readonly confidence: number;
  readonly message: string;
}

export interface SegmentDriftResult {
  readonly segment: DriftSegment;
  readonly verdict: DriftVerdict;
  readonly breachedKeys: readonly string[];
  readonly inconclusiveKeys: readonly string[];
  readonly metrics: readonly MetricDriftResult[];
}

export interface DriftEvaluation {
  readonly verdict: DriftVerdict;
  /** Schlechtestes Segment — OK nur wenn ALLE Segmente OK. */
  readonly policyVersion: string;
  readonly confidence: number;
  readonly evaluatedAtMs: number;
  readonly segments: readonly SegmentDriftResult[];
  /** Abgestufte Reaktionsempfehlung (fail-closed kann nur senken/stoppen). */
  readonly recommendedAction: "NONE" | "SCALE_DOWN" | "DEGRADE" | "PAUSE";
}

/**
 * Ergebnis der PAUSE-Stufe: nur bei dataQuality-Breach mit sehr niedriger
 * Confidence oder mehreren gleichzeitigen Segment-Breaches.
 */
function recommendedAction(
  verdict: DriftVerdict,
  segments: readonly SegmentDriftResult[],
  confidence: number
): DriftEvaluation["recommendedAction"] {
  if (verdict === "OK") return "NONE";
  if (verdict === "INCONCLUSIVE") return "DEGRADE"; // fail-closed: Risiko senken
  const breached = segments.filter((s) => s.verdict === "BREACH");
  const multi = breached.length >= 2;
  const dataBad = breached.some((s) => s.segment === "dataQuality");
  if (multi && confidence >= 0.5) return "PAUSE";
  if (dataBad && breached.some((s) => s.segment === "risk")) return "PAUSE";
  return breached.some((s) => s.segment === "risk") || multi ? "DEGRADE" : "SCALE_DOWN";
}

function evaluateMetric(
  pair: MetricPair,
  policy: DriftPolicy,
  nowMs: number
): MetricDriftResult {
  const spec = DRIFT_METRIC_BY_KEY.get(pair.key);
  if (!spec) {
    return {
      key: pair.key,
      segment: "performance",
      verdict: "INCONCLUSIVE",
      reasonCode: "UNKNOWN_METRIC",
      baselineValue: null,
      currentValue: null,
      delta: null,
      relDelta: null,
      sampleSize: null,
      confidence: 0,
      message: `Unbekannte Metrik "${pair.key}" — fail-closed.`,
    };
  }

  const base = pair.baseline;
  const curr = pair.current;

  if (!base) {
    return {
      key: pair.key,
      segment: spec.segment,
      verdict: "INCONCLUSIVE",
      reasonCode: "BASELINE_MISSING",
      baselineValue: null,
      currentValue: curr?.value ?? null,
      delta: null,
      relDelta: null,
      sampleSize: curr?.sampleSize ?? null,
      confidence: 0,
      message: "Baseline fehlt — Drift nicht bewertbar (fail-closed).",
    };
  }
  if (!curr) {
    return {
      key: pair.key,
      segment: spec.segment,
      verdict: "INCONCLUSIVE",
      reasonCode: "CURRENT_MISSING",
      baselineValue: base.value,
      currentValue: null,
      delta: null,
      relDelta: null,
      sampleSize: base.sampleSize,
      confidence: 0,
      message: "Aktuelle Metrik fehlt — kein stiller Neutralwert.",
    };
  }

  // null-Werte nie als 0
  if (base.value === null || curr.value === null) {
    return {
      key: pair.key,
      segment: spec.segment,
      verdict: "INCONCLUSIVE",
      reasonCode: "NULL_VALUE",
      baselineValue: base.value,
      currentValue: curr.value,
      delta: null,
      relDelta: null,
      sampleSize: curr.sampleSize,
      confidence: 0,
      message: "Metrikwert null/unbekannt — wird nicht als 0 gewertet.",
    };
  }

  // Staleness gegen availableAt
  const baseAge = nowMs - base.availableAtMs;
  const currAge = nowMs - curr.availableAtMs;
  if (
    !Number.isFinite(baseAge) ||
    !Number.isFinite(currAge) ||
    baseAge < 0 ||
    currAge < 0 ||
    baseAge > policy.maxMetricAgeMs ||
    currAge > policy.maxMetricAgeMs
  ) {
    return {
      key: pair.key,
      segment: spec.segment,
      verdict: "INCONCLUSIVE",
      reasonCode: "STALE",
      baselineValue: base.value,
      currentValue: curr.value,
      delta: curr.value - base.value,
      relDelta: null,
      sampleSize: curr.sampleSize,
      confidence: 0,
      message: `Metrik stale (max ${policy.maxMetricAgeMs} ms).`,
    };
  }

  // Mindeststichprobe
  const sample =
    curr.sampleSize !== null && base.sampleSize !== null
      ? Math.min(curr.sampleSize, base.sampleSize)
      : curr.sampleSize ?? base.sampleSize;
  if (sample === null || !Number.isFinite(sample) || sample < policy.minSample) {
    return {
      key: pair.key,
      segment: spec.segment,
      verdict: "INCONCLUSIVE",
      reasonCode: "SAMPLE_TOO_SMALL",
      baselineValue: base.value,
      currentValue: curr.value,
      delta: curr.value - base.value,
      relDelta: null,
      sampleSize: sample,
      confidence: 0,
      message: `Stichprobe ${sample ?? "unbekannt"} < Mindeststichprobe ${policy.minSample}.`,
    };
  }

  const delta = curr.value - base.value;
  const relDelta = base.value !== 0 ? delta / Math.abs(base.value) : delta !== 0 ? null : 0;
  // Confidence: lineare Skala sample/minSample (gedeckelt 1) × Frische-Faktor.
  const sampleConf = Math.min(1, sample / Math.max(1, policy.minSample * 2));
  const freshest = Math.max(baseAge, currAge);
  const freshConf = 1 - Math.min(1, freshest / Math.max(1, policy.maxMetricAgeMs));
  const confidence = Math.max(0, Math.min(1, 0.5 * sampleConf + 0.5 * freshConf));

  // Toleranzbreite: max(abs, rel×|baseline|)
  const tol = Math.max(spec.absTolerance, Math.abs(base.value) * spec.relTolerance);

  let verdict: DriftVerdict = "OK";
  let reasonCode: MetricDriftResult["reasonCode"] = "OK";
  let message = "Innerhalb der Toleranz.";

  if (spec.direction === "lower-is-better") {
    if (delta > tol) {
      verdict = "BREACH";
      reasonCode = relDelta !== null && Math.abs(delta) > spec.absTolerance && Math.abs(delta) <= Math.abs(base.value) * spec.relTolerance
        ? "ABOVE_REL_TOL"
        : "ABOVE_ABS_TOL";
      message = `Wert ${curr.value} liegt ${delta} über Baseline (Toleranz ${tol}).`;
    }
  } else if (spec.direction === "higher-is-better") {
    if (delta < -tol) {
      verdict = "BREACH";
      reasonCode = "BELOW_ABS_TOL";
      message = `Wert ${curr.value} liegt ${-delta} unter Baseline (Toleranz ${tol}).`;
    }
  } else {
    if (Math.abs(delta) > tol) {
      verdict = "BREACH";
      reasonCode = relDelta !== null && Math.abs(delta) <= Math.abs(base.value) * spec.relTolerance && spec.absTolerance < Math.abs(base.value) * spec.relTolerance
        ? "ABOVE_REL_TOL"
        : Math.abs(delta) > spec.absTolerance
          ? "ABOVE_ABS_TOL"
          : "ABOVE_REL_TOL";
      message = `Abweichung ${delta} überschreitet Toleranz ${tol}.`;
    }
  }

  return {
    key: pair.key,
    segment: spec.segment,
    verdict,
    reasonCode,
    baselineValue: base.value,
    currentValue: curr.value,
    delta,
    relDelta,
    sampleSize: sample,
    confidence,
    message,
  };
}

const SEGMENT_WORST: Record<DriftVerdict, number> = { OK: 0, INCONCLUSIVE: 1, BREACH: 2 };

function worst(a: DriftVerdict, b: DriftVerdict): DriftVerdict {
  return SEGMENT_WORST[a] >= SEGMENT_WORST[b] ? a : b;
}

/**
 * Bewertet alle Metrikpaare gegen die Drift-Policy.
 * Gesamtverdict `BREACH` nur wenn mindestens eine Metrik verletzt ist;
 * `INCONCLUSIVE` wenn keine Verletzung, aber fehlende/stale/kleine Daten —
 * die Empfehlung skaliert Risiko in beiden Fällen NIEMALS nach oben.
 */
export function evaluateDrift(
  pairs: readonly MetricPair[],
  policy: DriftPolicy = DEFAULT_DRIFT_POLICY,
  nowMs: number = Date.now()
): DriftEvaluation {
  const results = pairs.map((p) => evaluateMetric(p, policy, nowMs));

  const bySegment = new Map<DriftSegment, MetricDriftResult[]>();
  for (const spec of DRIFT_METRIC_SPECS) bySegment.set(spec.segment, []);
  for (const r of results) {
    const list = bySegment.get(r.segment) ?? [];
    list.push(r);
    bySegment.set(r.segment, list);
  }

  const segments: SegmentDriftResult[] = [];
  for (const segment of DRIFT_SEGMENTS) {
    const metrics = bySegment.get(segment) ?? [];
    if (metrics.length === 0) {
      // Segment ohne Paare: nicht bewertet — triggert kein OK für die Gesamtsumme.
      segments.push({
        segment,
        verdict: "INCONCLUSIVE",
        breachedKeys: [],
        inconclusiveKeys: [],
        metrics: [],
      });
      continue;
    }
    let verdict: DriftVerdict = "OK";
    for (const m of metrics) verdict = worst(verdict, m.verdict);
    segments.push({
      segment,
      verdict,
      breachedKeys: metrics.filter((m) => m.verdict === "BREACH").map((m) => m.key),
      inconclusiveKeys: metrics.filter((m) => m.verdict === "INCONCLUSIVE").map((m) => m.key),
      metrics,
    });
  }

  let verdict: DriftVerdict = "OK";
  for (const s of segments) verdict = worst(verdict, s.verdict);

  const confidences = results.map((r) => r.confidence);
  const confidence =
    confidences.length > 0
      ? confidences.reduce((a, b) => a + b, 0) / confidences.length
      : 0;

  return {
    verdict,
    policyVersion: policy.version,
    confidence,
    evaluatedAtMs: nowMs,
    segments,
    recommendedAction: recommendedAction(verdict, segments, confidence),
  };
}

/** Hilfskonstruktion: Metrikfenster mit konsistenter Zeitsemantik. */
export function metricWindow(
  value: number | null,
  sampleSize: number | null,
  availableAtMs: number,
  nowMs: number,
  eventTimeMs: number = availableAtMs,
  computedAtMs: number = nowMs
): MetricWindow {
  return {
    value: value !== null && Number.isFinite(value) ? value : null,
    sampleSize: sampleSize !== null && Number.isFinite(sampleSize) && sampleSize >= 0 ? sampleSize : null,
    eventTimeMs,
    availableAtMs,
    computedAtMs,
  };
}
