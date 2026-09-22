/**
 * Deterministische Hashing- und Schlüssel-Funktionen für Sentiment (RMA-P2-05).
 *
 * Alle Hashes basieren auf `stableStringify` (sortierte Keys) und SHA-256.
 * Gleiche fachliche Eingaben erzeugen byte-identische Schlüssel über
 * Prozess- und Systemgrenzen hinweg.
 */

import { createHash } from "node:crypto";
import { stableStringify } from "../lib/ruleEngine";
import type { DeduplicatedNewsSource, StructuredSentimentForecast } from "./types";

/**
 * Erzeugt einen SHA-256-Fingerprint über eine Liste deduplizierter Quellen.
 * Format: `sd1:<sha256>`
 */
export function computeSourceDeduplicationHash(
  sources: readonly DeduplicatedNewsSource[]
): string {
  if (!sources || sources.length === 0) {
    return "sd1:0000000000000000000000000000000000000000000000000000000000000000";
  }

  // Sortierung nach contentHash für strikten Determinismus
  const canonical = [...sources]
    .map((s) => ({
      contentHash: s.contentHash,
      syndicationCount: s.syndicationCount,
      sources: [...s.sources].sort(),
      earliestAt: s.earliestAt ? s.earliestAt.toISOString() : null,
      latestAt: s.latestAt ? s.latestAt.toISOString() : null,
    }))
    .sort((a, b) => a.contentHash.localeCompare(b.contentHash));

  const hex = createHash("sha256").update(stableStringify(canonical), "utf8").digest("hex");
  return `sd1:${hex}`;
}

/**
 * Fachlicher Inhalts-Hash eines Sentiment-Forecasts.
 * Format: `sc1:<sha256>`
 */
export function computeSentimentContentHash(input: {
  entityId: string;
  symbol: string;
  horizon: string;
  direction: string | null;
  probability: number | null;
  summary: string;
  riskFlags: readonly string[];
  sourceDeduplicationHash: string;
}): string {
  const payload = {
    entityId: input.entityId.trim().toUpperCase(),
    symbol: input.symbol.trim().toUpperCase(),
    horizon: input.horizon,
    direction: input.direction ?? "NONE",
    probability: input.probability !== null ? Number(input.probability.toFixed(6)) : null,
    summary: input.summary.trim(),
    riskFlags: [...input.riskFlags].sort(),
    sourceDeduplicationHash: input.sourceDeduplicationHash,
  };

  const hex = createHash("sha256").update(stableStringify(payload), "utf8").digest("hex");
  return `sc1:${hex}`;
}

/**
 * Unveränderliche Forecast-ID (natürlicher Idempotenzschlüssel).
 * Format: `sf1:<sha256>`
 *
 * Schützt vor doppelter Erfassung: Wiederholte Analystenläufe oder Retries
 * mit identischer Entität, As-of-Zeit und Quellenlage erzeugen exakt
 * denselben Schlüssel.
 */
export function computeSentimentForecastId(input: {
  schemaVersion: string;
  promptVersion: number;
  model: string;
  entityId: string;
  eventType: string;
  horizon: string;
  asOf: Date;
  direction: string | null;
  probability: number | null;
  sourceDeduplicationHash: string;
}): string {
  const payload = {
    schemaVersion: input.schemaVersion,
    promptVersion: input.promptVersion,
    model: input.model.trim(),
    entityId: input.entityId.trim().toUpperCase(),
    eventType: input.eventType,
    horizon: input.horizon,
    asOfMs: input.asOf.getTime(),
    direction: input.direction ?? "ABSTAIN",
    probability: input.probability !== null ? Number(input.probability.toFixed(6)) : null,
    sourceDeduplicationHash: input.sourceDeduplicationHash,
  };

  const hex = createHash("sha256").update(stableStringify(payload), "utf8").digest("hex");
  return `sf1:${hex}`;
}
