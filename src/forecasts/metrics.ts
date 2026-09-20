/**
 * Segmentbildung und Score-Berichte des Forecast-Ledgers
 * (RMA-P3-01, v1.55.0).
 *
 * Alle Segmente werden aus denselben Score-Zeilen berechnet wie das
 * Gesamt-Aggregat — damit reconciliert jede Segmentzahl gegen die
 * Einzelresolutions (getestet). Die Menge ist hart begrenzt
 * (`FORECAST_LIMITS`); ein Überschreiten wird LAUT gemeldet, nie still
 * gekürzt. Entity-/Forecast-IDs erscheinen in den Berichtszeilen, aber
 * niemals in Metrik-Labels.
 */

import { scoreSegment, type SegmentScore } from "./scoring";
import {
  FORECAST_LIMITS,
  FORECAST_METRICS_VERSION,
  FORECAST_RESOLUTION_POLICY_VERSION,
  type ForecastHorizonId,
  type ForecastStatus,
  type ForecastVoidReason,
  type ScoreRow,
} from "./types";
import type { DueForecast } from "./ports";

/** Dimensionen, nach denen segmentiert werden kann. */
export const SCORE_DIMENSIONS = ["agentRole", "promptVersion", "horizonId", "entityId", "regime"] as const;
export type ScoreDimension = (typeof SCORE_DIMENSIONS)[number];

/** Anfrage eines Score-Berichts (alle Filter optional, bounded). */
export interface ScoreQuery {
  agentRole?: string;
  promptVersion?: number;
  horizonId?: ForecastHorizonId;
  entityId?: string;
  regime?: string;
  fromAsOf?: Date;
  toAsOf?: Date;
  /** Mindeststichprobe je Segment. */
  minSample?: number;
  /** Bezugszeit für Fälligkeit/Coverage. */
  now?: Date;
  /** Quellenlimit (hart geklemmt auf `maxScoreForecasts`). */
  limit?: number;
}

/** Ein Segment des Berichts. */
export interface ReportSegment {
  /** Segment-Schlüssel, z. B. `{ agentRole: "TECHNICAL_ANALYST", horizonId: "4h" }`. */
  key: Partial<Record<ScoreDimension, string | number>>;
  score: SegmentScore;
}

/** Vollständiger Score-Bericht. */
export interface ScoreReport {
  generatedAt: string;
  metricsVersion: string;
  policyVersion: string;
  minSample: number;
  filters: Omit<ScoreQuery, "minSample" | "now" | "limit">;
  /** Bezugszeit der Fälligkeits-/Coverage-Berechnung. */
  asOfComputedAt: string;
  /** Quelle erreichte das Limit — Zahlen sind ein Ausschnitt (laut markiert). */
  truncated: boolean;
  /** Anzahl betrachteter Forecasts (alle Status). */
  totalCount: number;
  /** Aggregat über alle betrachteten Forecasts. */
  overall: SegmentScore;
  /** Gruppierte Segmente, deterministisch sortiert (Count absteigend, dann Schlüssel). */
  segments: ReportSegment[];
}

/** Projectionsfehler des Berichtspfads. */
export class ForecastReportError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail?: Record<string, unknown>
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * Bildet eine Ledger-Sicht (Forecast + jüngste Resolution) auf eine
 * Score-Zeile ab. PENDING und VOID behalten ihren Status — sie gehen nie
 * als 0 oder korrekt in Scores ein (das entscheidet `scoreSegment`).
 */
export function scoreRowOf(view: DueForecast): ScoreRow {
  const resolution = view.latestResolution;
  const probabilityIndex = view.contract.categories.indexOf(view.contract.targetCategory);
  const probability = probabilityIndex >= 0 ? view.contract.probabilities[probabilityIndex] : Number.NaN;
  if (!Number.isFinite(probability)) {
    throw new ForecastReportError("row:target-missing", `Forecast ${view.forecastId}: Target-Wahrscheinlichkeit fehlt.`);
  }
  const status: ForecastStatus = view.status;
  const outcome = status === "RESOLVED" && resolution !== null ? resolution.outcome : null;
  return {
    forecastId: view.forecastId,
    agentRole: view.contract.agentRole,
    promptVersion: view.contract.promptVersion,
    model: view.contract.model,
    entityId: view.contract.entityId,
    horizonId: view.contract.horizonId,
    regime: view.contract.regime,
    asOf: view.contract.asOf,
    resolvesAt: view.contract.resolvesAt,
    status,
    probability,
    probabilities: view.contract.probabilities,
    categories: view.contract.categories,
    targetCategory: view.contract.targetCategory,
    outcomeIndex: outcome !== null ? outcome.outcomeIndex : null,
    outcomeBinary: outcome !== null ? outcome.outcomeBinary : null,
    voidReason: status === "VOID" ? (resolution?.voidReason ?? null) : null,
    resolutionVersion: resolution?.resolutionVersion ?? null,
  };
}

/** Dimensionsschlüssel einer Zeile. */
export function segmentKeyOf(row: ScoreRow): Partial<Record<ScoreDimension, string | number>> {
  return {
    agentRole: row.agentRole,
    promptVersion: row.promptVersion,
    horizonId: row.horizonId,
    entityId: row.entityId,
    regime: row.regime,
  };
}

function stableKeyText(key: Partial<Record<ScoreDimension, string | number>>): string {
  return SCORE_DIMENSIONS.map((dim) => `${dim}=${String(key[dim] ?? "")}`).join("|");
}

/**
 * Baut den Score-Bericht aus Ledger-Sichten (rein, deterministisch).
 *
 * @throws ForecastReportError `report:too-many-segments`, wenn mehr Segmente
 *   entstünden als `maxScoreSegments` — der Aufrufer muss die Anfrage
 *   eingrenzen (kein stilles Kürzen).
 */
export function buildScoreReport(
  views: readonly DueForecast[],
  options: { truncated: boolean; minSample: number; now: Date; filters?: ScoreQuery }
): ScoreReport {
  const rows = views.map(scoreRowOf);
  const minSample = Math.max(1, Math.floor(options.minSample));
  const overall = scoreSegment(rows, minSample, options.now);

  const grouped = new Map<string, { key: Partial<Record<ScoreDimension, string | number>>; rows: ScoreRow[] }>();
  for (const row of rows) {
    const key = segmentKeyOf(row);
    const id = stableKeyText(key);
    const bucket = grouped.get(id);
    if (bucket) bucket.rows.push(row);
    else grouped.set(id, { key, rows: [row] });
  }
  if (grouped.size > FORECAST_LIMITS.maxScoreSegments) {
    throw new ForecastReportError(
      "report:too-many-segments",
      `Anfrage erzeugt ${grouped.size} Segmente (Limit ${FORECAST_LIMITS.maxScoreSegments}) — Zeitraum oder Filter eingrenzen.`,
      { segments: grouped.size, limit: FORECAST_LIMITS.maxScoreSegments }
    );
  }
  const segments: ReportSegment[] = [...grouped.values()]
    .map((bucket) => ({ key: bucket.key, score: scoreSegment(bucket.rows, minSample, options.now) }))
    .sort((a, b) => {
      const byCount = b.score.resolvedCount - a.score.resolvedCount;
      if (byCount !== 0) return byCount;
      return stableKeyText(a.key) < stableKeyText(b.key) ? -1 : 1;
    });

  return {
    generatedAt: options.now.toISOString(),
    metricsVersion: FORECAST_METRICS_VERSION,
    policyVersion: FORECAST_RESOLUTION_POLICY_VERSION,
    minSample,
    filters: {
      agentRole: options.filters?.agentRole,
      promptVersion: options.filters?.promptVersion,
      horizonId: options.filters?.horizonId,
      entityId: options.filters?.entityId,
      regime: options.filters?.regime,
      fromAsOf: options.filters?.fromAsOf,
      toAsOf: options.filters?.toAsOf,
    },
    asOfComputedAt: options.now.toISOString(),
    truncated: options.truncated,
    totalCount: rows.length,
    overall,
    segments,
  };
}

/** VOID-Gründe eines Berichts als bounded Zählung (Betriebsdiagnose). */
export function voidReasonCounts(rows: readonly ScoreRow[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    if (row.status !== "VOID" || row.voidReason === null) continue;
    const reason: ForecastVoidReason = row.voidReason;
    counts[reason] = (counts[reason] ?? 0) + 1;
  }
  return counts;
}
