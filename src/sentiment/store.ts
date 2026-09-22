/**
 * Persistenzschicht für strukturierte Sentiment-Outputs (RMA-P2-05, v1.64.0).
 *
 * Verwaltet append-only Schreibvorgänge in `sentiment_forecasts`, garantiert
 * Idempotenz über den natürlichen Schlüssel `forecast_id` (`sf1:<sha256>`)
 * und stellt Point-in-Time-Lesepfade bereit.
 */

import { and, desc, eq, gte, lte } from "drizzle-orm";
import { db as defaultDb } from "../db";
import { sentimentForecasts } from "../db/schema";
import { structuredLog } from "../lib/logger";
import { metricLabel, telemetry } from "../lib/telemetry";
import {
  SENTIMENT_LIMITS,
  type StructuredSentimentForecast,
} from "./types";
import { validateStructuredSentimentForecast } from "./validation";

export interface PersistSentimentResult {
  inserted: boolean;
  forecastId: string;
}

export interface ListSentimentQuery {
  entityId?: string;
  status?: string;
  horizon?: string;
  from?: Date;
  to?: Date;
  limit?: number;
}

export interface SentimentStoreDeps {
  db?: typeof defaultDb;
  enabled?: boolean;
}

/** Feature-Flag-Prüfung für Persistenz (Default: true; Rollback via env). */
export function structuredSentimentPersistenceEnabled(env = process.env): boolean {
  if (!env.DATABASE_URL) return false;
  const raw = env.STRUCTURED_SENTIMENT_ENABLED;
  if (raw === undefined || raw.trim() === "") return true;
  return raw.trim().toLowerCase() !== "false" && raw.trim() !== "0";
}

/** Mappt eine Datenbank-Zeile zurück in den typisierten Envelope. */
export function rowToSentimentForecast(
  row: typeof sentimentForecasts.$inferSelect
): StructuredSentimentForecast {
  const direction = (row.direction as StructuredSentimentForecast["direction"]) ?? null;
  const status = row.status as StructuredSentimentForecast["status"];
  const probability = row.probability !== null ? Number(row.probability) : null;
  const confidence = Number(row.confidence);
  const coverage = Number(row.coverage);
  const impactScore = Number(row.impactScore);

  const forecast: StructuredSentimentForecast = {
    forecastId: row.forecastId,
    entityId: row.entityId,
    symbol: row.symbol,
    direction,
    status,
    probability,
    confidence,
    abstain: row.abstain,
    abstainReason: (row.abstainReason as StructuredSentimentForecast["abstainReason"]) ?? null,
    horizon: row.horizon as StructuredSentimentForecast["horizon"],
    horizonMinutes: row.horizonMinutes,
    eventType: row.eventType as StructuredSentimentForecast["eventType"],
    sourceCount: row.sourceCount,
    rawSourceCount: row.rawSourceCount,
    coverage,
    sourceEventTime: row.sourceEventTime,
    sourceEarliestAt: row.sourceEarliestAt,
    sourceLatestAt: row.sourceLatestAt,
    asOf: row.asOf,
    validUntil: row.validUntil,
    promptVersion: row.promptVersion,
    model: row.model,
    schemaVersion: row.schemaVersion,
    sourceDeduplicationHash: row.sourceDeduplicationHash,
    contentHash: row.contentHash,
    ledgerForecastId: row.ledgerForecastId,
    summary: row.summary,
    riskFlags: Array.isArray(row.riskFlags) ? (row.riskFlags as string[]) : [],
    impactScore,
    metadata: row.metadata && typeof row.metadata === "object" ? (row.metadata as Record<string, unknown>) : undefined,

    // Rückwärtskompatibilität
    instrumentId: row.entityId,
    sentiment: direction ?? "NEUTRAL",
    view: direction ?? "NEUTRAL",
    thesis: row.summary,
  };

  return forecast;
}

/**
 * Persistiert einen einzelnen Sentiment-Forecast idempotent.
 *
 * Wenn die Zeile bereits existiert (`forecast_id`), erfolgt kein Schreibvorgang
 * und `inserted: false` wird zurückgegeben (No-Op).
 */
export async function persistSentimentForecast(
  forecast: StructuredSentimentForecast,
  deps: SentimentStoreDeps = {}
): Promise<PersistSentimentResult> {
  if (deps.enabled === false || (deps.enabled === undefined && !structuredSentimentPersistenceEnabled())) {
    return { inserted: false, forecastId: forecast.forecastId };
  }

  const validation = validateStructuredSentimentForecast(forecast);
  if (!validation.valid || !validation.data) {
    throw new Error(`Ungültiger Forecast kann nicht persistiert werden: ${validation.error}`);
  }

  const database = deps.db ?? defaultDb;

  try {
    const insertResult = await database
      .insert(sentimentForecasts)
      .values({
        forecastId: forecast.forecastId,
        entityId: forecast.entityId,
        symbol: forecast.symbol,
        direction: forecast.direction,
        status: forecast.status,
        probability: forecast.probability !== null ? String(forecast.probability) : null,
        confidence: String(forecast.confidence),
        abstain: forecast.abstain,
        abstainReason: forecast.abstainReason,
        horizon: forecast.horizon,
        horizonMinutes: forecast.horizonMinutes,
        eventType: forecast.eventType,
        sourceCount: forecast.sourceCount,
        rawSourceCount: forecast.rawSourceCount,
        coverage: String(forecast.coverage),
        sourceEventTime: forecast.sourceEventTime,
        sourceEarliestAt: forecast.sourceEarliestAt,
        sourceLatestAt: forecast.sourceLatestAt,
        asOf: forecast.asOf,
        validUntil: forecast.validUntil,
        promptVersion: forecast.promptVersion,
        model: forecast.model,
        schemaVersion: forecast.schemaVersion,
        sourceDeduplicationHash: forecast.sourceDeduplicationHash,
        contentHash: forecast.contentHash,
        ledgerForecastId: forecast.ledgerForecastId,
        summary: forecast.summary,
        riskFlags: forecast.riskFlags,
        impactScore: String(forecast.impactScore),
        metadata: forecast.metadata ?? null,
      })
      .onConflictDoNothing({ target: sentimentForecasts.forecastId })
      .returning({ id: sentimentForecasts.id });

    const inserted = insertResult.length > 0;
    telemetry.sentiment.captures.inc({
      result: inserted ? "captured" : "duplicate",
    });

    structuredLog("info", "sentiment_forecast_persisted", {
      forecastId: forecast.forecastId,
      entityId: forecast.entityId,
      status: forecast.status,
      direction: forecast.direction ?? "NONE",
      inserted,
    });

    return { inserted, forecastId: forecast.forecastId };
  } catch (err) {
    structuredLog("error", "sentiment_forecast_persist_failed", {
      forecastId: forecast.forecastId,
      error: err instanceof Error ? err.message : String(err),
    });
    telemetry.sentiment.captures.inc({
      result: "skipped",
      reason: "error",
    });
    throw err;
  }
}

/**
 * Persistiert eine Liste von Sentiment-Forecasts stapelweise und idempotent.
 */
export async function persistSentimentForecastBatch(
  forecasts: readonly StructuredSentimentForecast[],
  deps: SentimentStoreDeps = {}
): Promise<{ total: number; inserted: number; duplicates: number }> {
  if (forecasts.length === 0) {
    return { total: 0, inserted: 0, duplicates: 0 };
  }

  let insertedCount = 0;
  let duplicateCount = 0;

  for (const f of forecasts) {
    try {
      const res = await persistSentimentForecast(f, deps);
      if (res.inserted) insertedCount++;
      else duplicateCount++;
    } catch {
      // Einzelner Fehler bricht den Gesamtstapel nicht still ab,
      // bleibt aber in Zählern und Logs sichtbar
    }
  }

  return { total: forecasts.length, inserted: insertedCount, duplicates: duplicateCount };
}

/**
 * Lädt einen Sentiment-Forecast anhand seiner unveränderlichen Forecast-ID.
 */
export async function loadSentimentForecastById(
  forecastId: string,
  deps: SentimentStoreDeps = {}
): Promise<StructuredSentimentForecast | null> {
  if (!process.env.DATABASE_URL && !deps.db) {
    return null;
  }
  const database = deps.db ?? defaultDb;
  const rows = await database
    .select()
    .from(sentimentForecasts)
    .where(eq(sentimentForecasts.forecastId, forecastId))
    .limit(1);

  if (rows.length === 0) return null;
  return rowToSentimentForecast(rows[0]);
}

/**
 * Listet Sentiment-Forecasts mit Filtern und strikter Obergrenze.
 */
export async function listSentimentForecasts(
  query: ListSentimentQuery = {},
  deps: SentimentStoreDeps = {}
): Promise<StructuredSentimentForecast[]> {
  if (!process.env.DATABASE_URL && !deps.db) {
    return [];
  }
  const database = deps.db ?? defaultDb;
  const limit = Math.min(
    SENTIMENT_LIMITS.maxListLimit,
    Math.max(1, query.limit ?? (SENTIMENT_LIMITS.defaultListLimit as number))
  );

  const conditions = [];

  if (query.entityId && typeof query.entityId === "string") {
    conditions.push(eq(sentimentForecasts.entityId, query.entityId.trim()));
  }
  if (query.status && typeof query.status === "string") {
    conditions.push(eq(sentimentForecasts.status, query.status.trim().toUpperCase()));
  }
  if (query.horizon && typeof query.horizon === "string") {
    conditions.push(eq(sentimentForecasts.horizon, query.horizon.trim().toLowerCase()));
  }
  if (query.from && Number.isFinite(query.from.getTime())) {
    conditions.push(gte(sentimentForecasts.asOf, query.from));
  }
  if (query.to && Number.isFinite(query.to.getTime())) {
    conditions.push(lte(sentimentForecasts.asOf, query.to));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await database
    .select()
    .from(sentimentForecasts)
    .where(whereClause)
    .orderBy(desc(sentimentForecasts.asOf))
    .limit(limit);

  return rows.map(rowToSentimentForecast);
}
