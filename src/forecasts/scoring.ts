/**
 * Proper Scoring Rules für das Forecast-Ledger (RMA-P3-01, v1.55.0).
 *
 * Reine, deterministische Formeln ohne IO — vollständig unit-testbar.
 *
 * ── Formeln und Konventionen ────────────────────────────────────────────────
 * Binäre Sicht (alle Forecasts mit Designation einer Target-Kategorie):
 *   p := P(Target-Kategorie), y := 1 wenn Target-Kategorie eingetreten.
 *
 *   Brier Score        BS  = mean( (p − y)² )          ∈ [0, 1], 0 = perfekt
 *   Brier Skill Score  BSS = 1 − BS / BS_ref           (Referenz = Klimatologie
 *                                                        des Segments, d. h. der
 *                                                        konstante Forecast p = ȳ)
 *   Log Loss           LL  = −mean( y·ln p + (1−y)·ln(1−p) )
 *                            mit Klemmung p ∈ [ε, 1−ε] (ε = `logLossEpsilon`),
 *                            zusätzlich zur Capture-Clip [0.01, 0.99].
 *
 * Kategoriale Sicht (vollständiger Vektor, Brier-Originalkonvention):
 *   BS_multi = mean_t( Σ_j (p_tj − o_tj)² )            ∈ [0, 2]
 *   (o_tj = 1 für die eingetretene Kategorie, sonst 0). Für exakt zwei
 *   Kategorien gilt BS_multi = 2·BS — beide Werte werden berichtet und sind
 *   in der API-Dokumentation (`docs/FORECASTS.md`) erklärt.
 *
 * ── Unsicherheit ────────────────────────────────────────────────────────────
 *   * Wilson-Score-Intervall für binäre Raten (beobachtete Trefferquote,
 *     Reliability-Bins). Exakt für k=0 und k=n, keine NaNs.
 *   * Standardfehler des Brier Scores über die Stichprobenvarianz der
 *     Einzelverluste (Normalapproximation): SE = sd(l_i)/√n.
 *
 * ── Status-Gates ────────────────────────────────────────────────────────────
 *   * PENDING (unreif) und VOID gehen NIEMALS als 0 oder als korrekt in
 *     Scores ein — sie zählen ausschließlich in Coverage/Stichprobenzähler.
 *   * Segmente unter der Mindeststichprobe liefern zwar Zahlen, werden aber
 *     mit `status = "insufficient-sample"` markiert und dürfen keine
 *     Entscheidung tragen (analog zum Trade-Journal, `journalAnalytics.ts`).
 */

import { FORECAST_LIMITS, FORECAST_METRICS_VERSION, type ScoreRow } from "./types";
import { WILSON_Z_95, wilsonInterval } from "@/lib/stats";

export { WILSON_Z_95, wilsonInterval };

/** Ein binäres Bewertungs-Paar: Wahrscheinlichkeit vs. Outcome. */
export interface BinaryPair {
  /** Prognosewahrscheinlichkeit des Ereignisses, ∈ [0, 1]. */
  p: number;
  /** Eingetreten (1) oder nicht (0). */
  y: 0 | 1;
}

/** Prüft eine Wahrscheinlichkeit auf Endlichkeit und Bereich. */
export function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** Klemmt eine Wahrscheinlichkeit hart auf [min, max] (Policy/Defensive). */
export function clipProbability(p: number, min: number, max: number): number {
  if (!Number.isFinite(p)) {
    throw new Error(`clipProbability: nicht-endliche Wahrscheinlichkeit (${String(p)})`);
  }
  return Math.min(max, Math.max(min, p));
}

/**
 * Brier Score (binäre Konvention): mean((p − y)²).
 *
 * @throws bei leerer Liste oder ungültigen Paaren — ein leerer Score ist
 *   „keine Aussage“, nicht 0 (fail-closed).
 */
export function brierScore(pairs: readonly BinaryPair[]): number {
  if (pairs.length === 0) throw new Error("brierScore: leere Stichprobe ist keine Aussage (nicht 0).");
  let sum = 0;
  for (const { p, y } of pairs) {
    if (!isProbability(p) || (y !== 0 && y !== 1)) {
      throw new Error(`brierScore: ungültiges Paar p=${String(p)} y=${String(y)}`);
    }
    sum += (p - y) * (p - y);
  }
  return sum / pairs.length;
}

/**
 * Brier Score (kategorial, Originalkonvention nach Brier 1950):
 * mean_t Σ_j (p_tj − o_tj)². Für zwei Kategorien identisch zu 2·brierScore.
 *
 * @throws bei leerer Stichprobe, Vektorsumme ≠ 1 (Toleranz) oder ungültigem
 *   Outcome-Index.
 */
export function brierScoreMultiClass(
  samples: readonly { probabilities: readonly number[]; outcomeIndex: number }[],
  tolerance: number = FORECAST_LIMITS.probabilitySumTolerance
): number {
  if (samples.length === 0) throw new Error("brierScoreMultiClass: leere Stichprobe ist keine Aussage (nicht 0).");
  let sum = 0;
  for (const sample of samples) {
    const probs = sample.probabilities;
    if (!Array.isArray(probs) || probs.length < 2) {
      throw new Error("brierScoreMultiClass: Vektor braucht mindestens 2 Kategorien.");
    }
    const total = probs.reduce((acc, p) => acc + p, 0);
    if (Math.abs(total - 1) > tolerance) {
      throw new Error(`brierScoreMultiClass: Vektorsumme ${total} ≠ 1 (Toleranz ${tolerance}).`);
    }
    if (!Number.isInteger(sample.outcomeIndex) || sample.outcomeIndex < 0 || sample.outcomeIndex >= probs.length) {
      throw new Error(`brierScoreMultiClass: Outcome-Index ${String(sample.outcomeIndex)} außerhalb des Vektors.`);
    }
    for (let j = 0; j < probs.length; j++) {
      const p = probs[j];
      if (!isProbability(p)) throw new Error(`brierScoreMultiClass: ungültige Wahrscheinlichkeit ${String(p)}.`);
      const o = j === sample.outcomeIndex ? 1 : 0;
      sum += (p - o) * (p - o);
    }
  }
  return sum / samples.length;
}

/** Wilson-Intervall: Re-Export aus `src/lib/stats.ts` (eine Implementierung). */

/**
 * Standardfehler + Normalapproximations-Konfidenzintervall des Brier Scores.
 * Basis: Stichprobenvarianz der Einzelverluste l_i = (p_i − y_i)².
 *
 * @returns `null` für n < 2 (keine Varianzschätzung möglich).
 */
export function brierUncertainty(
  pairs: readonly BinaryPair[],
  z: number = WILSON_Z_95
): { se: number; lower: number; upper: number } | null {
  if (pairs.length < 2) return null;
  const losses = pairs.map(({ p, y }) => (p - y) * (p - y));
  const mean = losses.reduce((a, b) => a + b, 0) / losses.length;
  const variance = losses.reduce((a, l) => a + (l - mean) * (l - mean), 0) / (losses.length - 1);
  const se = Math.sqrt(Math.max(0, variance) / losses.length);
  return { se, lower: Math.max(0, mean - z * se), upper: Math.min(1, mean + z * se) };
}

/**
 * Brier Skill Score gegen die Klimatologie-Referenz (konstanter Forecast
 * p = beobachtete Basisrate ȳ des Segments).
 *
 * @returns `null`, wenn die Referenz degeneriert (BS_ref = 0, d. h. alle
 *   Outcomes identisch) — Skill ist dann nicht definiert, nicht „unendlich“.
 */
export function brierSkillScore(bs: number, baselineRate: number): number | null {
  if (!Number.isFinite(bs) || !isProbability(baselineRate)) return null;
  const ref = baselineRate * (1 - baselineRate);
  if (ref <= 1e-12) return null;
  return 1 - bs / ref;
}

/**
 * Log Loss (binär) mit Klemmung gegen log(0).
 * Die Klemmung ist Defensive für Fremd-/Altdaten; Capture-forecasts liegen
 * durch Policy `fp1` bereits in [0.01, 0.99].
 */
export function logLossBinary(
  pairs: readonly BinaryPair[],
  epsilon: number = FORECAST_LIMITS.logLossEpsilon
): number {
  if (pairs.length === 0) throw new Error("logLossBinary: leere Stichprobe ist keine Aussage (nicht 0).");
  if (!(epsilon > 0 && epsilon < 0.5)) throw new Error(`logLossBinary: ungültiges Epsilon ${epsilon}.`);
  let sum = 0;
  for (const { p, y } of pairs) {
    if (!isProbability(p) || (y !== 0 && y !== 1)) {
      throw new Error(`logLossBinary: ungültiges Paar p=${String(p)} y=${String(y)}`);
    }
    const pc = clipProbability(p, epsilon, 1 - epsilon);
    sum += y === 1 ? -Math.log(pc) : -Math.log(1 - pc);
  }
  return sum / pairs.length;
}

/** Ein Reliability-Bin mit Zählern und Wilson-Unsicherheit. */
export interface ReliabilityBin {
  /** 0-basierter Bin-Index. */
  index: number;
  /** Untere/obere Grenze (oberes Ende des letzten Bins geschlossen bei 1). */
  lower: number;
  upper: number;
  /** Anzahl der resolved Forecasts im Bin. */
  count: number;
  /** Mittlere Prognose im Bin (`null` bei count = 0). */
  meanForecast: number | null;
  /** Beobachtete Ereignisrate (`null` bei count = 0). */
  observedRate: number | null;
  /** Wilson-95-Intervall der beobachteten Rate (`null` bei count = 0). */
  wilson95: { lower: number; upper: number } | null;
}

/**
 * Bin-Index einer Wahrscheinlichkeit für `bins` gleich breite Bins.
 *
 * Grenzwertkonvention (getestet): p = 1 fällt in den letzten Bin
 * (`floor(1·k) = k` wird gekappt), p = 0 in den ersten; exakte
 * Bingrenzen (z. B. p = 0.3 bei 10 Bins) gehören zum DARÜBER liegenden Bin
 * (`[0.3, 0.4)`), weil `floor` links abgeschlossen ist.
 */
export function reliabilityBinIndex(p: number, bins: number): number {
  if (!isProbability(p)) throw new Error(`reliabilityBinIndex: ungültige Wahrscheinlichkeit ${String(p)}.`);
  if (!Number.isInteger(bins) || bins < 1) throw new Error(`reliabilityBinIndex: ungültige Bin-Anzahl ${bins}.`);
  return Math.min(Math.floor(p * bins), bins - 1);
}

/**
 * Reliability-Diagramm-Daten: gleich breite Bins über der Prognose, je Bin
 * Count, mittlere Prognose, beobachtete Rate und Wilson-Intervall.
 * Leere Bins werden mit `count = 0` berichtet (vollständiges Diagramm).
 */
export function reliabilityBins(
  pairs: readonly BinaryPair[],
  bins: number = FORECAST_LIMITS.reliabilityBins
): ReliabilityBin[] {
  if (!Number.isInteger(bins) || bins < 1) throw new Error(`reliabilityBins: ungültige Bin-Anzahl ${bins}.`);
  const acc: { count: number; sumP: number; hits: number }[] = Array.from({ length: bins }, () => ({
    count: 0,
    sumP: 0,
    hits: 0,
  }));
  for (const { p, y } of pairs) {
    const idx = reliabilityBinIndex(p, bins);
    acc[idx].count += 1;
    acc[idx].sumP += p;
    acc[idx].hits += y;
  }
  return acc.map((bin, index) => {
    const wilson = bin.count > 0 ? wilsonInterval(bin.hits, bin.count) : null;
    return {
      index,
      lower: index / bins,
      upper: (index + 1) / bins,
      count: bin.count,
      meanForecast: bin.count > 0 ? bin.sumP / bin.count : null,
      observedRate: bin.count > 0 ? bin.hits / bin.count : null,
      wilson95: wilson ? { lower: wilson.lower, upper: wilson.upper } : null,
    };
  });
}

/**
 * Expected Calibration Error: count-gewichtete mittlere Abweichung von
 * Prognose und beobachteter Rate über die nicht-leeren Bins.
 * `null` bei leerer Stichprobe.
 */
export function expectedCalibrationError(
  pairs: readonly BinaryPair[],
  bins: number = FORECAST_LIMITS.reliabilityBins
): number | null {
  if (pairs.length === 0) return null;
  const computed = reliabilityBins(pairs, bins);
  let ece = 0;
  for (const bin of computed) {
    if (bin.count === 0 || bin.meanForecast === null || bin.observedRate === null) continue;
    ece += (bin.count / pairs.length) * Math.abs(bin.meanForecast - bin.observedRate);
  }
  return ece;
}

/** Aggregat eines Segments (siehe `metrics.ts` für Segmentbildung). */
export interface SegmentScore {
  /** Anzahl RESOLVED (geht in alle Scores ein). */
  resolvedCount: number;
  /** Anzahl VOID (geht in Coverage, nie in Scores ein). */
  voidCount: number;
  /** Anzahl PENDING/unreif (geht nur in den Totalzähler). */
  pendingCount: number;
  /** Zur Bezugszeit fällige Forecasts (`resolves_at <= now`). */
  dueCount: number;
  /** (resolved + void) / due — `null` wenn nichts fällig ist. */
  coverage: number | null;
  /** Mittlerer Forecast (Target-Wahrscheinlichkeit) der resolved Zeilen. */
  meanForecast: number | null;
  /** Beobachtete Ereignisrate der resolved Zeilen. */
  hitRate: number | null;
  /** Wilson-95 der Ereignisrate. */
  hitRateWilson95: { lower: number; upper: number } | null;
  /** Brier Score (binäre Konvention) + Unsicherheit. */
  brierScore: number | null;
  brierUncertainty: { se: number; lower: number; upper: number } | null;
  /** Brier Skill Score gegen die Segment-Klimatologie. */
  brierSkillScore: number | null;
  /** Brier Score in kategorialer Originalkonvention (2·BS bei 2 Kategorien). */
  brierScoreMultiClass: number | null;
  /** Log Loss (binär). */
  logLoss: number | null;
  /** Expected Calibration Error. */
  expectedCalibrationError: number | null;
  /** Vollständiges Reliability-Diagramm (inkl. leerer Bins). */
  reliability: ReliabilityBin[];
  /** `ok` oder `insufficient-sample` (Mindeststichprobe nicht erreicht). */
  status: "ok" | "insufficient-sample";
  metricsVersion: string;
}

/**
 * Bewertet eine Menge von Score-Zeilen als EIN Segment.
 *
 * Regeln (Akzeptanzkriterien):
 *   * ausschließlich RESOLVED-Zeilen gehen in Scores ein,
 *   * VOID/PENDING zählen nie als 0 oder korrekt, aber in Coverage bzw. Zähler,
 *   * unterhalb der Mindeststichprobe: `status = insufficient-sample`
 *     (Zahlen bleiben sichtbar, Entscheidungsnutzung ist ausgeschlossen).
 */
export function scoreSegment(rows: readonly ScoreRow[], minSample: number, now: Date): SegmentScore {
  const resolved = rows.filter((r) => r.status === "RESOLVED" && r.outcomeBinary !== null);
  const voidCount = rows.filter((r) => r.status === "VOID").length;
  const pendingCount = rows.filter((r) => r.status === "PENDING").length;
  const dueCount = rows.filter((r) => r.resolvesAt.getTime() <= now.getTime()).length;

  const pairs: BinaryPair[] = resolved.map((r) => ({ p: r.probability, y: r.outcomeBinary as 0 | 1 }));
  const hits = pairs.reduce((acc, pair) => acc + pair.y, 0);
  const hitRate = pairs.length > 0 ? hits / pairs.length : null;

  const bs = pairs.length > 0 ? brierScore(pairs) : null;
  const skill = bs !== null && hitRate !== null ? brierSkillScore(bs, hitRate) : null;
  const multiSamples = resolved
    .filter((r) => r.outcomeIndex !== null)
    .map((r) => ({ probabilities: r.probabilities, outcomeIndex: r.outcomeIndex as number }));

  const sufficient = pairs.length >= Math.max(1, Math.floor(minSample));
  return {
    resolvedCount: pairs.length,
    voidCount,
    pendingCount,
    dueCount,
    coverage: dueCount > 0 ? (pairs.length + voidCount) / dueCount : null,
    meanForecast: pairs.length > 0 ? pairs.reduce((a, b) => a + b.p, 0) / pairs.length : null,
    hitRate,
    hitRateWilson95: pairs.length > 0 ? (() => { const w = wilsonInterval(hits, pairs.length); return w ? { lower: w.lower, upper: w.upper } : null; })() : null,
    brierScore: bs,
    brierUncertainty: pairs.length > 0 ? brierUncertainty(pairs) : null,
    brierSkillScore: skill,
    brierScoreMultiClass: multiSamples.length > 0 ? brierScoreMultiClass(multiSamples) : null,
    logLoss: pairs.length > 0 ? logLossBinary(pairs) : null,
    expectedCalibrationError: pairs.length > 0 ? expectedCalibrationError(pairs) : null,
    reliability: reliabilityBins(pairs),
    status: sufficient ? "ok" : "insufficient-sample",
    metricsVersion: FORECAST_METRICS_VERSION,
  };
}
