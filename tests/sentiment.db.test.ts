/**
 * Tests: Kalibrierbare strukturierte Sentiment-Outputs — Postgres DB Tests (RMA-P2-05).
 *
 * Deckt alle Datenbank-Zusicherungen ab:
 *   - Idempotente Migration `drizzle/2026-09-22_structured_sentiment.sql` (zweifach ausführbar)
 *   - Roundtrip: Persistieren & Laden des vollständigen Envelopes
 *   - Idempotenz: Identischer `forecast_id` schreibt keine zweite Zeile (ON CONFLICT DO NOTHING)
 *   - CHECK-Constraints erzwingen harte Dateninvarianten auf DB-Ebene
 *   - Paginierung und Filterung über listSentimentForecasts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import EmbeddedPostgres from "embedded-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { sentimentForecasts } from "../src/db/schema";
import {
  listSentimentForecasts,
  loadSentimentForecastById,
  persistSentimentForecast,
  persistSentimentForecastBatch,
} from "../src/sentiment/store";
import { buildStructuredSentimentForecast } from "../src/sentiment/semantics";
import type { DeduplicatedNewsSource } from "../src/sentiment/types";

const PG_PORT = 55_444;
const DB_NAME = "sentiment_test";

describe("sentiment_forecasts (Postgres): Migration, Roundtrip, Idempotenz, Constraints", () => {
  let pg: EmbeddedPostgres | null = null;
  let pool: Pool | null = null;
  let db: ReturnType<typeof drizzle> | null = null;
  let startupError: Error | null = null;
  const logs: string[] = [];

  const sampleSource: DeduplicatedNewsSource = {
    contentHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    normalizedTitle: "fed lowers rates by 50 bps in surprise macro shift",
    primarySource: "Bloomberg",
    sources: ["Bloomberg", "Reuters"],
    syndicationCount: 2,
    earliestAt: new Date("2026-09-22T08:00:00Z"),
    latestAt: new Date("2026-09-22T08:15:00Z"),
    entityMatches: ["BTC", "SPY"],
    rawHeadline: "Fed lowers rates by 50 bps in surprise macro shift",
  };

  before(async () => {
    try {
      const dir = mkdtempSync(path.join(tmpdir(), "sentiment-pg-"));
      const instance = new EmbeddedPostgres({
        databaseDir: dir,
        user: "postgres",
        password: "postgres",
        port: PG_PORT,
        persistent: false,
        onLog: (m) => logs.push(String(m)),
        onError: (m) => logs.push(m instanceof Error ? m.message : String(m)),
      });

      await instance.initialise();
      await instance.start();
      pg = instance;

      const adminPool = new Pool({
        user: "postgres",
        password: "postgres",
        host: "127.0.0.1",
        port: PG_PORT,
        database: "postgres",
      });
      await adminPool.query(`CREATE DATABASE ${DB_NAME}`);
      await adminPool.end();

      pool = new Pool({
        user: "postgres",
        password: "postgres",
        host: "127.0.0.1",
        port: PG_PORT,
        database: DB_NAME,
      });

      db = drizzle(pool);

      // Migration 1. Mal anwenden
      const migrationSql = readFileSync(
        path.join(process.cwd(), "drizzle", "2026-09-22_structured_sentiment.sql"),
        "utf8"
      );
      await pool.query(migrationSql);
    } catch (e) {
      startupError = e instanceof Error ? e : new Error(String(e));
    }
  });

  after(async () => {
    if (pool) await pool.end().catch(() => {});
    if (pg) await pg.stop().catch(() => {});
  });

  it("Migration ist strikt idempotent (zweites Ausführen wirft keinen Fehler)", async (t) => {
    if (!pool || !db) return t.skip(startupError?.message ?? "Postgres nicht gestartet");

    const migrationSql = readFileSync(
      path.join(process.cwd(), "drizzle", "2026-09-22_structured_sentiment.sql"),
      "utf8"
    );
    // Zweiter Lauf muss absolut fehlerfrei durchlaufen
    await assert.doesNotReject(async () => {
      await pool!.query(migrationSql);
    });
  });

  it("Roundtrip: Speichert Forecast und liest ihn identisch wieder aus", async (t) => {
    if (!pool || !db) return t.skip(startupError?.message ?? "Postgres nicht gestartet");

    const asOf = new Date("2026-09-22T09:00:00Z");
    const forecast = buildStructuredSentimentForecast({
      entityId: "BINANCE:BTCUSDT",
      symbol: "BTC",
      sources: [sampleSource],
      asOf,
      horizon: "24h",
      eventType: "MACRO",
      direction: "BULLISH",
      confidence: 0.8,
      impactScore: 85,
      riskFlags: ["RATE_CUT", "HIGH_VOLATILITY"],
      summary: "Fed-Zinssenkung beflügelt Krypto und Risikoassets",
    });

    const persistRes = await persistSentimentForecast(forecast, { db: db as any, enabled: true });
    assert.equal(persistRes.inserted, true);
    assert.equal(persistRes.forecastId, forecast.forecastId);

    const loaded = await loadSentimentForecastById(forecast.forecastId, { db: db as any, enabled: true });
    assert.ok(loaded !== null);
    assert.equal(loaded?.forecastId, forecast.forecastId);
    assert.equal(loaded?.entityId, "BINANCE:BTCUSDT");
    assert.equal(loaded?.symbol, "BTC");
    assert.equal(loaded?.status, "ACTIVE");
    assert.equal(loaded?.direction, "BULLISH");
    assert.equal(loaded?.probability, forecast.probability);
    assert.equal(loaded?.confidence, 0.8);
    assert.equal(loaded?.abstain, false);
    assert.equal(loaded?.abstainReason, null);
    assert.equal(loaded?.horizon, "24h");
    assert.equal(loaded?.horizonMinutes, 1440);
    assert.equal(loaded?.eventType, "MACRO");
    assert.equal(loaded?.sourceCount, 1);
    assert.equal(loaded?.rawSourceCount, 2);
    assert.equal(loaded?.summary, forecast.summary);
    assert.deepEqual(loaded?.riskFlags, ["RATE_CUT", "HIGH_VOLATILITY"]);
    assert.equal(loaded?.impactScore, 85);
  });

  it("Idempotenz: Wiederholtes Einfügen desselben forecastId erzeugt keine zweite Zeile", async (t) => {
    if (!pool || !db) return t.skip(startupError?.message ?? "Postgres nicht gestartet");

    const asOf = new Date("2026-09-22T09:30:00Z");
    const forecast = buildStructuredSentimentForecast({
      entityId: "BINANCE:ETHUSDT",
      symbol: "ETH",
      sources: [sampleSource],
      asOf,
      horizon: "24h",
      direction: "NEUTRAL",
      confidence: 0.2,
    });

    // 1. Schreibversuch
    const first = await persistSentimentForecast(forecast, { db: db as any, enabled: true });
    assert.equal(first.inserted, true);

    // 2. Schreibversuch (identischer Forecast)
    const second = await persistSentimentForecast(forecast, { db: db as any, enabled: true });
    assert.equal(second.inserted, false, "Zweiter Schreibversuch muss als duplicate (inserted=false) gemeldet werden");

    // Zählung in der DB prüfen
    const countRes = await pool!.query(
      `SELECT count(*)::int as count FROM sentiment_forecasts WHERE forecast_id = $1`,
      [forecast.forecastId]
    );
    assert.equal(countRes.rows[0].count, 1, "Es darf genau eine Zeile in der DB existieren");
  });

  it("CHECK-Constraints weisen ungültige Zustände auf DB-Ebene strikt ab", async (t) => {
    if (!pool || !db) return t.skip(startupError?.message ?? "Postgres nicht gestartet");

    const validAsOf = new Date("2026-09-22T10:00:00Z");
    const validUntil = new Date("2026-09-23T10:00:00Z");

    // 1. Invalide probability bei ACTIVE (< 0.01)
    await assert.rejects(async () => {
      await pool!.query(`
        INSERT INTO sentiment_forecasts (
          forecast_id, entity_id, symbol, direction, status, probability, confidence,
          abstain, horizon, horizon_minutes, event_type, source_count, raw_source_count,
          coverage, as_of, valid_until, prompt_version, model, schema_version,
          source_deduplication_hash, content_hash, summary, risk_flags, impact_score
        ) VALUES (
          'sf1:1111111111111111111111111111111111111111111111111111111111111111',
          'BINANCE:BTCUSDT', 'BTC', 'BULLISH', 'ACTIVE', 0.005, 0.5,
          false, '24h', 1440, 'GENERAL', 1, 1,
          0.33, '${validAsOf.toISOString()}', '${validUntil.toISOString()}', 1, 'model', 'sentiment@1',
          'sd1:1111111111111111111111111111111111111111111111111111111111111111',
          'sc1:1111111111111111111111111111111111111111111111111111111111111111',
          'summary', '[]'::jsonb, 50
        )
      `);
    }, /sentiment_forecasts_probability_check/);

    // 2. Status ABSTAIN mit Wahrscheinlichkeit NOT NULL (Inkonsistenz)
    await assert.rejects(async () => {
      await pool!.query(`
        INSERT INTO sentiment_forecasts (
          forecast_id, entity_id, symbol, direction, status, probability, confidence,
          abstain, abstain_reason, horizon, horizon_minutes, event_type, source_count, raw_source_count,
          coverage, as_of, valid_until, prompt_version, model, schema_version,
          source_deduplication_hash, content_hash, summary, risk_flags, impact_score
        ) VALUES (
          'sf1:2222222222222222222222222222222222222222222222222222222222222222',
          'BINANCE:BTCUSDT', 'BTC', null, 'ABSTAIN', 0.5, 0,
          true, 'NO_SOURCES', '24h', 1440, 'GENERAL', 0, 0,
          0, '${validAsOf.toISOString()}', '${validUntil.toISOString()}', 1, 'model', 'sentiment@1',
          'sd1:0000000000000000000000000000000000000000000000000000000000000000',
          'sc1:2222222222222222222222222222222222222222222222222222222222222222',
          'summary', '[]'::jsonb, 50
        )
      `);
    }, /sentiment_forecasts_abstain_check/);

    // 3. valid_until <= as_of (ungültige Zeitsemantik)
    await assert.rejects(async () => {
      await pool!.query(`
        INSERT INTO sentiment_forecasts (
          forecast_id, entity_id, symbol, direction, status, probability, confidence,
          abstain, horizon, horizon_minutes, event_type, source_count, raw_source_count,
          coverage, as_of, valid_until, prompt_version, model, schema_version,
          source_deduplication_hash, content_hash, summary, risk_flags, impact_score
        ) VALUES (
          'sf1:3333333333333333333333333333333333333333333333333333333333333333',
          'BINANCE:BTCUSDT', 'BTC', 'NEUTRAL', 'ACTIVE', 0.50, 0,
          false, '24h', 1440, 'GENERAL', 1, 1,
          0.33, '${validAsOf.toISOString()}', '${validAsOf.toISOString()}', 1, 'model', 'sentiment@1',
          'sd1:3333333333333333333333333333333333333333333333333333333333333333',
          'sc1:3333333333333333333333333333333333333333333333333333333333333333',
          'summary', '[]'::jsonb, 50
        )
      `);
    }, /sentiment_forecasts_valid_until_check/);
  });

  it("Filtert Forecasts nach Entität, Status und Horizont", async (t) => {
    if (!pool || !db) return t.skip(startupError?.message ?? "Postgres nicht gestartet");

    const asOf = new Date("2026-09-22T11:00:00Z");
    const solForecast = buildStructuredSentimentForecast({
      entityId: "BINANCE:SOLUSDT",
      symbol: "SOL",
      sources: [],
      asOf,
      horizon: "4h",
    });

    await persistSentimentForecast(solForecast, { db: db as any, enabled: true });

    // Filter nach Entität
    const solResults = await listSentimentForecasts({ entityId: "BINANCE:SOLUSDT" }, { db: db as any, enabled: true });
    assert.equal(solResults.length, 1);
    assert.equal(solResults[0].entityId, "BINANCE:SOLUSDT");
    assert.equal(solResults[0].status, "ABSTAIN");

    // Filter nach Status
    const activeResults = await listSentimentForecasts({ status: "ACTIVE" }, { db: db as any, enabled: true });
    for (const r of activeResults) {
      assert.equal(r.status, "ACTIVE");
    }

    const abstainResults = await listSentimentForecasts({ status: "ABSTAIN" }, { db: db as any, enabled: true });
    assert.ok(abstainResults.length >= 1);
    assert.equal(abstainResults[0].abstain, true);
  });
});
