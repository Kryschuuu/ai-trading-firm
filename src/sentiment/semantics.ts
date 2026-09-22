/**
 * Semantik, Unsicherheitsmodellierung und Envelope-Konstruktion für Sentiment (RMA-P2-05).
 *
 * Implementiert die Trennung von direktionaler Wahrscheinlichkeit und Quellenqualität,
 * die strikte Unterscheidung von NEUTRAL und ABSTAIN sowie Point-in-Time-Zeitsemantik.
 */

import {
  SENTIMENT_ABSTAIN_REASONS,
  SENTIMENT_DIRECTIONS,
  SENTIMENT_EVENT_TYPES,
  SENTIMENT_HORIZONS,
  SENTIMENT_HORIZON_MINUTES,
  SENTIMENT_LIMITS,
  SENTIMENT_PROMPT_VERSION,
  SENTIMENT_SCHEMA_VERSION,
  type DeduplicatedNewsSource,
  type SentimentAbstainReason,
  type SentimentDirection,
  type SentimentEventType,
  type SentimentHorizon,
  type StructuredSentimentForecast,
} from "./types";
import {
  computeSentimentContentHash,
  computeSentimentForecastId,
  computeSourceDeduplicationHash,
} from "./hashes";

/**
 * Wandelt Richtung und Konfidenz in eine geklemmte Wahrscheinlichkeit um.
 *
 * Formel (kompatibel mit P3.1 Policy fp1):
 *   sign(BULLISH) = +1, sign(BEARISH) = -1, sign(NEUTRAL) = 0
 *   p_up = clamp(0.5 + sign * confidence / 2, 0.01, 0.99)
 */
export function probabilityFromDirection(
  direction: SentimentDirection | null,
  confidence: number
): number | null {
  if (direction === null) return null;
  const c = Math.max(0, Math.min(1, Number.isFinite(confidence) ? confidence : 0));
  let p = 0.5;
  if (direction === "BULLISH") {
    p = 0.5 + c / 2;
  } else if (direction === "BEARISH") {
    p = 0.5 - c / 2;
  }
  return Math.min(
    SENTIMENT_LIMITS.probabilityClipMax,
    Math.max(SENTIMENT_LIMITS.probabilityClipMin, Number(p.toFixed(6)))
  );
}

/**
 * Berechnet Quellenabdeckung und Zeitstempel aus deduplizierten Quellen.
 *
 * Trennt Quellenqualität explizit von der direktionalen Einschätzung.
 */
export function evaluateSourcesQuality(
  sources: readonly DeduplicatedNewsSource[],
  asOf: Date
): {
  sourceCount: number;
  rawSourceCount: number;
  coverage: number;
  isStale: boolean;
  earliestAt: Date | null;
  latestAt: Date | null;
  sourceEventTime: Date | null;
} {
  const asOfMs = asOf.getTime();
  let rawCount = 0;
  let earliestMs: number | null = null;
  let latestMs: number | null = null;
  let validSourceCount = 0;

  for (const s of sources) {
    rawCount += Math.max(1, s.syndicationCount);
    const pub = s.latestAt ?? s.earliestAt;
    if (pub !== null) {
      const pubMs = pub.getTime();
      // Point-in-Time: Quellen nach asOf ignorieren
      if (pubMs <= asOfMs) {
        validSourceCount++;
        if (earliestMs === null || s.earliestAt && s.earliestAt.getTime() < earliestMs) {
          earliestMs = (s.earliestAt ?? pub).getTime();
        }
        if (latestMs === null || pubMs > latestMs) {
          latestMs = pubMs;
        }
      }
    } else {
      validSourceCount++;
    }
  }

  const sourceCount = sources.length;
  if (sourceCount === 0 || validSourceCount === 0) {
    return {
      sourceCount: 0,
      rawSourceCount: rawCount,
      coverage: 0,
      isStale: false,
      earliestAt: null,
      latestAt: null,
      sourceEventTime: null,
    };
  }

  // Veraltungsprüfung: Wenn alle Quellen älter als 48h sind
  const staleThreshold = asOfMs - SENTIMENT_LIMITS.staleSourceThresholdMs;
  const isStale = latestMs !== null && latestMs < staleThreshold;

  if (isStale) {
    return {
      sourceCount,
      rawSourceCount: rawCount,
      coverage: 0,
      isStale: true,
      earliestAt: earliestMs !== null ? new Date(earliestMs) : null,
      latestAt: latestMs !== null ? new Date(latestMs) : null,
      sourceEventTime: latestMs !== null ? new Date(latestMs) : null,
    };
  }

  // Coverage: 1 Quelle = 0.33, 2 Quellen = 0.67, 3+ Quellen = 1.0 (gedeckt)
  // Syndikationen erhöhen den Zähler bewusst NICHT!
  const rawCoverage = Math.min(1.0, sourceCount / 3);
  const coverage = Number(Math.max(SENTIMENT_LIMITS.minCoverageForActive, rawCoverage).toFixed(4));

  return {
    sourceCount,
    rawSourceCount: Math.max(sourceCount, rawCount),
    coverage,
    isStale: false,
    earliestAt: earliestMs !== null ? new Date(earliestMs) : null,
    latestAt: latestMs !== null ? new Date(latestMs) : null,
    sourceEventTime: latestMs !== null ? new Date(latestMs) : null,
  };
}

export interface BuildSentimentForecastInput {
  entityId: string;
  symbol: string;
  sources: readonly DeduplicatedNewsSource[];
  asOf?: Date;
  horizon?: SentimentHorizon;
  eventType?: SentimentEventType;
  direction?: SentimentDirection;
  confidence?: number;
  impactScore?: number;
  riskFlags?: readonly string[];
  summary?: string;
  promptVersion?: number;
  model?: string;
  schemaVersion?: string;
  ledgerForecastId?: string | null;
  /** Manuelle Vorgabe zur Enthaltung. */
  forcedAbstain?: SentimentAbstainReason;
}

/**
 * Konstruiert einen vollständigen, konsistenten Sentiment-Forecast-Envelope.
 *
 * Verhindert strikt:
 * - Dass 0 Quellen als neutrales 0.5 gebucht werden (Fail-closed ⇒ ABSTAIN).
 * - Dass Look-ahead-Zeiten gespeichert werden.
 * - Dass aktuelle Preise oder spätere Outcomes gespeichert werden.
 */
export function buildStructuredSentimentForecast(
  input: BuildSentimentForecastInput
): StructuredSentimentForecast {
  const asOf = input.asOf ?? new Date();
  const horizon: SentimentHorizon = input.horizon && (SENTIMENT_HORIZONS as readonly string[]).includes(input.horizon)
    ? input.horizon
    : "24h";
  const horizonMinutes = SENTIMENT_HORIZON_MINUTES[horizon];
  const validUntil = new Date(asOf.getTime() + horizonMinutes * 60_000);

  const eventType: SentimentEventType = input.eventType && (SENTIMENT_EVENT_TYPES as readonly string[]).includes(input.eventType)
    ? input.eventType
    : "GENERAL";

  const promptVersion = Number.isInteger(input.promptVersion) && (input.promptVersion ?? 0) >= 0
    ? (input.promptVersion as number)
    : SENTIMENT_PROMPT_VERSION;
  const model = input.model && typeof input.model === "string" ? input.model.slice(0, 128) : "hubble-sentiment";
  const schemaVersion = input.schemaVersion ?? SENTIMENT_SCHEMA_VERSION;

  const entityId = input.entityId.trim();
  const symbol = input.symbol.trim().toUpperCase();

  // Quellenqualität und Zeitstempel ermitteln
  const quality = evaluateSourcesQuality(input.sources, asOf);
  const sourceDeduplicationHash = computeSourceDeduplicationHash(input.sources);

  // ── Entscheidungslogik ACTIVE vs. ABSTAIN ─────────────────────────────────
  let status: "ACTIVE" | "ABSTAIN" = "ACTIVE";
  let abstain = false;
  let abstainReason: SentimentAbstainReason | null = null;
  let direction: SentimentDirection | null = null;
  let probability: number | null = null;
  let confidence = 0;
  let impactScore = 50;
  let summary = "";
  const riskFlags: string[] = Array.isArray(input.riskFlags)
    ? input.riskFlags.map(String).slice(0, SENTIMENT_LIMITS.maxRiskFlags)
    : [];

  if (input.forcedAbstain) {
    status = "ABSTAIN";
    abstain = true;
    abstainReason = input.forcedAbstain;
  } else if (quality.sourceCount === 0) {
    status = "ABSTAIN";
    abstain = true;
    abstainReason = "NO_SOURCES";
  } else if (quality.isStale) {
    status = "ABSTAIN";
    abstain = true;
    abstainReason = "STALE_SOURCES";
  }

  if (abstain) {
    // Enthaltung: Direktionale Wahrscheinlichkeit ist NULL (nicht 0.5!), Konfidenz ist 0
    direction = null;
    probability = null;
    confidence = 0;
    impactScore = 50;
    summary = input.summary && input.summary.length > 0
      ? input.summary.slice(0, SENTIMENT_LIMITS.maxSummaryLength)
      : `Keine aktuellen Quellen vorhanden (Abstain: ${abstainReason ?? "NO_SOURCES"})`;
  } else {
    // Aktiver Forecast
    const rawDir = input.direction && (SENTIMENT_DIRECTIONS as readonly string[]).includes(input.direction)
      ? input.direction
      : "NEUTRAL";
    direction = rawDir;
    confidence = Math.max(0, Math.min(1, Number.isFinite(input.confidence) ? (input.confidence as number) : 0));
    probability = probabilityFromDirection(direction, confidence);
    impactScore = Math.max(0, Math.min(100, Number.isFinite(input.impactScore) ? (input.impactScore as number) : 50));
    summary = input.summary && input.summary.length > 0
      ? input.summary.slice(0, SENTIMENT_LIMITS.maxSummaryLength)
      : `Sentiment ${direction} (${Math.round(confidence * 100)} % Konfidenz aus ${quality.sourceCount} Quellen)`;
  }

  // Hashes berechnen
  const contentHash = computeSentimentContentHash({
    entityId,
    symbol,
    horizon,
    direction,
    probability,
    summary,
    riskFlags,
    sourceDeduplicationHash,
  });

  const forecastId = computeSentimentForecastId({
    schemaVersion,
    promptVersion,
    model,
    entityId,
    eventType,
    horizon,
    asOf,
    direction,
    probability,
    sourceDeduplicationHash,
  });

  // Rückwärtskompatible Felder für bestehende Konsumenten
  const legacySentiment: "BULLISH" | "BEARISH" | "NEUTRAL" = direction ?? "NEUTRAL";
  const legacyView: "BULLISH" | "BEARISH" | "NEUTRAL" = direction ?? "NEUTRAL";
  const legacyThesis = summary;

  return {
    forecastId,
    entityId,
    symbol,
    direction,
    status,
    probability,
    confidence,
    abstain,
    abstainReason,
    horizon,
    horizonMinutes,
    eventType,
    sourceCount: quality.sourceCount,
    rawSourceCount: quality.rawSourceCount,
    coverage: quality.coverage,
    sourceEventTime: quality.sourceEventTime,
    sourceEarliestAt: quality.earliestAt,
    sourceLatestAt: quality.latestAt,
    asOf,
    validUntil,
    promptVersion,
    model,
    schemaVersion,
    sourceDeduplicationHash,
    contentHash,
    ledgerForecastId: input.ledgerForecastId ?? null,
    summary,
    riskFlags,
    impactScore,

    // Rückwärtskompatibilität
    instrumentId: entityId,
    sentiment: legacySentiment,
    view: legacyView,
    thesis: legacyThesis,
  };
}
