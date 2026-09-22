/**
 * Strikte Validierung und JSON-Schema-Prüfung für Sentiment-Outputs (RMA-P2-05).
 *
 * Prüft harte Grenzen, Enums, Zeitrelationen und Textlängen.
 * Unbekannte Felder werden kontrolliert verworfen (Fail-closed).
 */

import {
  SENTIMENT_ABSTAIN_REASONS,
  SENTIMENT_DIRECTIONS,
  SENTIMENT_EVENT_TYPES,
  SENTIMENT_HORIZONS,
  SENTIMENT_HORIZON_MINUTES,
  SENTIMENT_LIMITS,
  SENTIMENT_STATUSES,
  type SentimentAbstainReason,
  type SentimentDirection,
  type SentimentEventType,
  type SentimentHorizon,
  type SentimentStatus,
  type StructuredSentimentForecast,
} from "./types";

export interface ValidationResult<T> {
  valid: boolean;
  data?: T;
  error?: string;
}

/** Regex für die unveränderliche Forecast-ID. */
export const FORECAST_ID_REGEX = /^sf1:[0-9a-f]{64}$/;
/** Regex für den Source-Deduplikations-Hash. */
export const SOURCE_HASH_REGEX = /^sd1:[0-9a-f]{64}$/;
/** Regex für den Content-Hash. */
export const CONTENT_HASH_REGEX = /^sc1:[0-9a-f]{64}$/;

/**
 * Validiert einen `StructuredSentimentForecast` strikt auf alle Invarianten.
 */
export function validateStructuredSentimentForecast(
  input: unknown
): ValidationResult<StructuredSentimentForecast> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { valid: false, error: "Sentiment-Forecast muss ein Objekt sein." };
  }

  const obj = input as Record<string, unknown>;

  // 1. Forecast-ID
  if (typeof obj.forecastId !== "string" || !FORECAST_ID_REGEX.test(obj.forecastId)) {
    return { valid: false, error: "Ungültiges forecastId-Format (erwartet: sf1:<64-hex>)." };
  }

  // 2. Entity-ID und Symbol
  if (typeof obj.entityId !== "string" || obj.entityId.trim().length === 0 || obj.entityId.length > 64) {
    return { valid: false, error: "entityId fehlt oder überschreitet 64 Zeichen." };
  }
  if (typeof obj.symbol !== "string" || obj.symbol.trim().length === 0 || obj.symbol.length > 24) {
    return { valid: false, error: "symbol fehlt oder überschreitet 24 Zeichen." };
  }

  // 3. Status
  if (typeof obj.status !== "string" || !(SENTIMENT_STATUSES as readonly string[]).includes(obj.status)) {
    return { valid: false, error: `Ungültiger Status: ${String(obj.status)}.` };
  }
  const status = obj.status as SentimentStatus;

  // 4. Abstain-Konsistenz
  const abstain = Boolean(obj.abstain);
  if ((status === "ABSTAIN") !== abstain) {
    return { valid: false, error: "Inkonsistenz: status=ABSTAIN erfordert abstain=true." };
  }

  let abstainReason: SentimentAbstainReason | null = null;
  if (abstain) {
    if (
      typeof obj.abstainReason !== "string" ||
      !(SENTIMENT_ABSTAIN_REASONS as readonly string[]).includes(obj.abstainReason)
    ) {
      return { valid: false, error: `Ungültiger abstainReason: ${String(obj.abstainReason)}.` };
    }
    abstainReason = obj.abstainReason as SentimentAbstainReason;
    if (obj.direction !== null && obj.direction !== undefined) {
      return { valid: false, error: "Bei status=ABSTAIN muss direction null sein." };
    }
    if (obj.probability !== null && obj.probability !== undefined) {
      return { valid: false, error: "Bei status=ABSTAIN muss probability null sein." };
    }
  }

  // 5. Direction & Probability (bei ACTIVE)
  let direction: SentimentDirection | null = null;
  let probability: number | null = null;

  if (status === "ACTIVE") {
    if (
      typeof obj.direction !== "string" ||
      !(SENTIMENT_DIRECTIONS as readonly string[]).includes(obj.direction)
    ) {
      return { valid: false, error: `Ungültige Richtung bei ACTIVE: ${String(obj.direction)}.` };
    }
    direction = obj.direction as SentimentDirection;

    if (
      typeof obj.probability !== "number" ||
      !Number.isFinite(obj.probability) ||
      obj.probability < SENTIMENT_LIMITS.probabilityClipMin ||
      obj.probability > SENTIMENT_LIMITS.probabilityClipMax
    ) {
      return {
        valid: false,
        error: `probability bei ACTIVE muss in [${SENTIMENT_LIMITS.probabilityClipMin}, ${SENTIMENT_LIMITS.probabilityClipMax}] liegen.`,
      };
    }
    probability = obj.probability;
  }

  // 6. Confidence & Coverage
  if (
    typeof obj.confidence !== "number" ||
    !Number.isFinite(obj.confidence) ||
    obj.confidence < 0 ||
    obj.confidence > 1
  ) {
    return { valid: false, error: "confidence muss eine endliche Zahl in [0, 1] sein." };
  }
  const confidence = obj.confidence;

  if (
    typeof obj.coverage !== "number" ||
    !Number.isFinite(obj.coverage) ||
    obj.coverage < 0 ||
    obj.coverage > 1
  ) {
    return { valid: false, error: "coverage muss eine Zahl in [0, 1] sein." };
  }
  const coverage = obj.coverage;

  // 7. Horizont
  if (typeof obj.horizon !== "string" || !(SENTIMENT_HORIZONS as readonly string[]).includes(obj.horizon)) {
    return { valid: false, error: `Ungültiger Horizont: ${String(obj.horizon)}.` };
  }
  const horizon = obj.horizon as SentimentHorizon;
  const expectedMinutes = SENTIMENT_HORIZON_MINUTES[horizon];
  if (obj.horizonMinutes !== expectedMinutes) {
    return { valid: false, error: `horizonMinutes (${String(obj.horizonMinutes)}) passt nicht zu ${horizon} (${expectedMinutes}).` };
  }

  // 8. Event-Typ
  if (
    typeof obj.eventType !== "string" ||
    !(SENTIMENT_EVENT_TYPES as readonly string[]).includes(obj.eventType)
  ) {
    return { valid: false, error: `Ungültiger eventType: ${String(obj.eventType)}.` };
  }
  const eventType = obj.eventType as SentimentEventType;

  // 9. Quellen-Zählungen
  if (!Number.isInteger(obj.sourceCount) || (obj.sourceCount as number) < 0) {
    return { valid: false, error: "sourceCount muss eine nicht-negative Ganzzahl sein." };
  }
  if (!Number.isInteger(obj.rawSourceCount) || (obj.rawSourceCount as number) < (obj.sourceCount as number)) {
    return { valid: false, error: "rawSourceCount darf nicht kleiner als sourceCount sein." };
  }
  const sourceCount = obj.sourceCount as number;
  const rawSourceCount = obj.rawSourceCount as number;

  // 10. Zeitsemantik
  const asOf = obj.asOf instanceof Date ? obj.asOf : new Date(String(obj.asOf));
  if (!Number.isFinite(asOf.getTime())) {
    return { valid: false, error: "Ungültiges asOf-Datum." };
  }

  const validUntil = obj.validUntil instanceof Date ? obj.validUntil : new Date(String(obj.validUntil));
  if (!Number.isFinite(validUntil.getTime())) {
    return { valid: false, error: "Ungültiges validUntil-Datum." };
  }

  if (validUntil.getTime() <= asOf.getTime()) {
    return { valid: false, error: "validUntil muss strikt nach asOf liegen." };
  }
  if (validUntil.getTime() - asOf.getTime() > SENTIMENT_LIMITS.maxHorizonMs) {
    return { valid: false, error: "validUntil überschreitet den maximalen Horizont von 72h." };
  }

  const sourceEventTime = obj.sourceEventTime
    ? obj.sourceEventTime instanceof Date
      ? obj.sourceEventTime
      : new Date(String(obj.sourceEventTime))
    : null;
  if (sourceEventTime !== null && !Number.isFinite(sourceEventTime.getTime())) {
    return { valid: false, error: "Ungültiges sourceEventTime-Datum." };
  }

  // 11. Hashes
  if (typeof obj.sourceDeduplicationHash !== "string" || !SOURCE_HASH_REGEX.test(obj.sourceDeduplicationHash)) {
    return { valid: false, error: "Ungültiges sourceDeduplicationHash-Format." };
  }
  if (typeof obj.contentHash !== "string" || !CONTENT_HASH_REGEX.test(obj.contentHash)) {
    return { valid: false, error: "Ungültiges contentHash-Format." };
  }

  // 12. Textfelder und Risikoflags
  if (typeof obj.summary !== "string" || obj.summary.length > SENTIMENT_LIMITS.maxSummaryLength) {
    return { valid: false, error: `summary überschreitet ${SENTIMENT_LIMITS.maxSummaryLength} Zeichen.` };
  }
  const summary = obj.summary;

  if (!Array.isArray(obj.riskFlags) || obj.riskFlags.length > SENTIMENT_LIMITS.maxRiskFlags) {
    return { valid: false, error: `riskFlags überschreitet ${SENTIMENT_LIMITS.maxRiskFlags} Einträge.` };
  }
  for (const flag of obj.riskFlags) {
    if (typeof flag !== "string" || flag.length > SENTIMENT_LIMITS.maxRiskFlagLength) {
      return { valid: false, error: `Ein Risikoflag überschreitet ${SENTIMENT_LIMITS.maxRiskFlagLength} Zeichen.` };
    }
  }

  if (
    typeof obj.impactScore !== "number" ||
    !Number.isFinite(obj.impactScore) ||
    obj.impactScore < 0 ||
    obj.impactScore > 100
  ) {
    return { valid: false, error: "impactScore muss in [0, 100] liegen." };
  }

  // 13. Vollständiger typisierter Forecast
  const data: StructuredSentimentForecast = {
    forecastId: obj.forecastId,
    entityId: obj.entityId.trim(),
    symbol: obj.symbol.trim().toUpperCase(),
    direction,
    status,
    probability,
    confidence,
    abstain,
    abstainReason,
    horizon,
    horizonMinutes: expectedMinutes,
    eventType,
    sourceCount,
    rawSourceCount,
    coverage,
    sourceEventTime,
    sourceEarliestAt: obj.sourceEarliestAt ? new Date(String(obj.sourceEarliestAt)) : null,
    sourceLatestAt: obj.sourceLatestAt ? new Date(String(obj.sourceLatestAt)) : null,
    asOf,
    validUntil,
    promptVersion: Number(obj.promptVersion ?? 1),
    model: String(obj.model ?? "hubble-sentiment"),
    schemaVersion: String(obj.schemaVersion ?? "sentiment@1"),
    sourceDeduplicationHash: obj.sourceDeduplicationHash,
    contentHash: obj.contentHash,
    ledgerForecastId: typeof obj.ledgerForecastId === "string" ? obj.ledgerForecastId : null,
    summary,
    riskFlags: obj.riskFlags.map(String),
    impactScore: obj.impactScore,
    metadata: obj.metadata && typeof obj.metadata === "object" ? (obj.metadata as Record<string, unknown>) : undefined,

    // Rückwärtskompatibilität
    instrumentId: obj.entityId.trim(),
    sentiment: direction ?? "NEUTRAL",
    view: direction ?? "NEUTRAL",
    thesis: summary,
  };

  return { valid: true, data };
}
