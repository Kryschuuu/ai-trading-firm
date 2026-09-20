/**
 * Source-Quality-Propagation (RMA-P6-01, v1.53.0).
 *
 * Der Quality-Layer (`src/marketdata/quality.ts`, GAP-07) klassifiziert
 * Kerzenserien (`GAP`, `OUTLIER`, `INVALID`, `DUPLICATE`, `CROSSCHECK`) und
 * persistiert einen Report. Featurewerte tragen den **schwersten** Befund, der
 * das **verwendete Fenster** betrifft:
 *
 *   * Befund mit `ts` (Zeitstempel der betroffenen Kerze) zählt, wenn er in
 *     `[windowStart, windowEnd]` liegt;
 *   * Befund **ohne** `ts` (z. B. `CROSSCHECK` auf Serienebene) betrifft die
 *     ganze Reihe und zählt für jedes Fenster;
 *   * existiert für die Reihe **kein** Report, ist der Status `UNKNOWN`
 *     („nicht geprüft“) — niemals `OK`. Ein Gate, das geprüfte Daten
 *     verlangt, muss `UNKNOWN` fail-closed behandeln.
 *
 * Das Modul ist rein (kein IO); die CLI liest den Report und reicht die
 * Befunde herein.
 */
import type { QualityFinding, QualityReport } from "../marketdata/quality";
import type { FeatureQualityStatus } from "./types";

/** Übersetzt eine Quality-Klasse in den Feature-Status (gleiche Namen). */
export function featureStatusOfQualityClass(cls: QualityFinding["cls"]): FeatureQualityStatus {
  return cls;
}

/** Befunde einer Reihe (`instrumentId` ⟂ `timeframe`), leere Liste wenn keine. */
export function findingsForSeries(
  report: QualityReport | null,
  instrumentId: string,
  timeframe: string
): readonly QualityFinding[] {
  if (!report) return [];
  const series = report.series.find((s) => s.instrumentId === instrumentId && s.timeframe === timeframe);
  return series?.findings ?? [];
}

/**
 * Qualitätsstatus eines Fensters `[windowStartMs, windowEndMs]`.
 *
 * @param findings Befunde der Reihe (siehe {@link findingsForSeries}).
 */
export function qualityStatusForWindow(
  findings: readonly QualityFinding[],
  windowStartMs: number,
  windowEndMs: number,
  severityOf: (status: FeatureQualityStatus) => number
): FeatureQualityStatus {
  let worst: FeatureQualityStatus = "OK";
  for (const finding of findings) {
    const applies =
      finding.ts === undefined ||
      (Number.isFinite(finding.ts) && finding.ts >= windowStartMs && finding.ts <= windowEndMs);
    if (!applies) continue;
    const status = featureStatusOfQualityClass(finding.cls);
    if (severityOf(status) > severityOf(worst)) worst = status;
  }
  return worst;
}
