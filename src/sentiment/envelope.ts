/**
 * Envelope-Serialisierung und Adapter zu bestehenden Systemkomponenten (RMA-P2-05).
 *
 * Stellt die Brücke zum P3.1 Forecast-Ledger her und gewährleistet die
 * nahtlose Rückwärtskompatibilität zu Cycle- und Agenten-Konsumenten.
 */

import type { StructuredSentimentForecast } from "./types";

/**
 * P3.1-kompatibler Forecast-Vertrag ohne Preis- oder Outcome-Informationen.
 *
 * Dieser Payload kann direkt vom P3.1 Forecast-Ledger referenziert oder
 * bei Verfügbarkeit von Marktdaten aufgelöst werden.
 */
export interface P31ForecastBridgeContract {
  agentRole: "NEWS_ANALYST";
  promptVersion: number;
  model: string;
  entityType: "instrument";
  entityId: string;
  symbol: string;
  targetKind: "CLOSE_DIRECTION";
  categories: readonly ["DOWN", "UP"];
  probabilities: readonly [number, number];
  targetCategory: "UP";
  horizonId: "4h" | "24h" | "72h";
  timeframe: "1h";
  asOf: Date;
  resolvesAt: Date;
  availabilityDeadline: Date;
  regime: string;
  policyVersion: string;
  contractVersion: number;
  sentimentForecastId: string;
}

/**
 * Konvertiert einen aktiven Sentiment-Forecast in ein P3.1-kompatibles Format.
 *
 * WICHTIG: Es werden weder Referenzkurse noch spätere Outcomes gespeichert
 * (Pure Sentiment Point-in-Time).
 */
export function toP31ForecastPayload(
  forecast: StructuredSentimentForecast
): P31ForecastBridgeContract | null {
  if (forecast.status === "ABSTAIN" || forecast.probability === null) {
    return null;
  }

  const pUp = forecast.probability;
  const pDown = Number((1 - pUp).toFixed(6));

  return {
    agentRole: "NEWS_ANALYST",
    promptVersion: forecast.promptVersion,
    model: forecast.model,
    entityType: "instrument",
    entityId: forecast.entityId,
    symbol: forecast.symbol,
    targetKind: "CLOSE_DIRECTION",
    categories: ["DOWN", "UP"],
    probabilities: [pDown, pUp],
    targetCategory: "UP",
    horizonId: forecast.horizon,
    timeframe: "1h",
    asOf: forecast.asOf,
    resolvesAt: forecast.validUntil,
    availabilityDeadline: new Date(forecast.validUntil.getTime() + 2 * 3600_000),
    regime: "UNKNOWN",
    policyVersion: "fp1",
    contractVersion: 1,
    sentimentForecastId: forecast.forecastId,
  };
}

/**
 * Erzeugt die flache Struktur für `agentMessages.meta.analysis`
 * (bestehender Analystenpfad in `src/lib/analysts.ts`).
 */
export function toLegacyAgentMessageAnalysis(forecast: StructuredSentimentForecast): {
  view: "BULLISH" | "BEARISH" | "NEUTRAL";
  confidence: number;
  thesis: string;
} {
  return {
    view: forecast.view,
    confidence: forecast.confidence,
    thesis: forecast.thesis,
  };
}
