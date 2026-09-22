-- RMA-P2-05 (v1.64.0) — Kalibrierbare strukturierte Sentiment-Outputs.
-- Append-only: EINE neue Tabelle + Indizes/Constraints; keine bestehende
-- Tabelle wird verändert, keine Spalte umgebaut, kein Backfill nötig.
--
-- Äquivalent zu `npx drizzle-kit push` aus `src/db/schema.ts` (`sentimentForecasts`);
-- diese Datei ist der idempotente SQL-Pfad für Umgebungen ohne drizzle-kit:
--   psql "$DATABASE_URL" -f drizzle/2026-09-22_structured_sentiment.sql
--
-- ── Semantik ────────────────────────────────────────────────────────────────
-- `sentiment_forecasts`  EINE Zeile je unveränderlichem Forecast-Envelope
--                        (Entity × Horizont × As-of-Zeit × Deduplikationshash).
--                        Der natürliche Schlüssel `forecast_id` (`sf1:<sha256>`)
--                        stellt Idempotenz bei Retries sicher.
--
-- Zeitsemantik:
--   source_event_time = Veröffentlichungszeit der maßgeblichen Quelle (Ereigniszeit).
--   as_of             = Ingestions-/Analysezeit (`generated_at`).
--   valid_until       = Ende des Prognosehorizonts (`resolves_at = as_of + horizon`).
--   Es wird beim Erzeugen KEIN Marktpreis und kein späteres Outcome gespeichert.
--
-- Fail-closed statt falscher Neutralität:
--   0 Quellen oder stale Quellen erzeugen Status ABSTAIN mit expliziter
--   coverage = 0 und probability = NULL, niemals stilles neutrales 0.5.
--
-- Rollback / Feature-Flag:
--   1. Feature-Flag: `STRUCTURED_SENTIMENT_ENABLED=false` deaktiviert Persistenz.
--   2. Reversible Bereinigung (nur wenn kein v1.64.0-Code mehr läuft):
--      DROP TABLE IF EXISTS "sentiment_forecasts" CASCADE;

-- 1) Append-only Sentiment-Forecast-Historie ----------------------------------
CREATE TABLE IF NOT EXISTS "sentiment_forecasts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "forecast_id" text NOT NULL,
  "entity_id" text NOT NULL,
  "symbol" text NOT NULL,
  "direction" text,
  "status" text NOT NULL,
  "probability" numeric,
  "confidence" numeric NOT NULL,
  "abstain" boolean NOT NULL DEFAULT false,
  "abstain_reason" text,
  "horizon" text NOT NULL,
  "horizon_minutes" integer NOT NULL,
  "event_type" text NOT NULL DEFAULT 'GENERAL',
  "source_count" integer NOT NULL,
  "raw_source_count" integer NOT NULL,
  "coverage" numeric NOT NULL,
  "source_event_time" timestamptz,
  "source_earliest_at" timestamptz,
  "source_latest_at" timestamptz,
  "as_of" timestamptz NOT NULL,
  "valid_until" timestamptz NOT NULL,
  "prompt_version" integer NOT NULL,
  "model" text NOT NULL,
  "schema_version" text NOT NULL,
  "source_deduplication_hash" text NOT NULL,
  "content_hash" text NOT NULL,
  "ledger_forecast_id" text,
  "summary" text NOT NULL,
  "risk_flags" jsonb NOT NULL,
  "impact_score" numeric NOT NULL,
  "metadata" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

-- 2) Idempotente Indizes ----------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS "sentiment_forecasts_forecast_id_unique"
  ON "sentiment_forecasts" ("forecast_id");

CREATE INDEX IF NOT EXISTS "sentiment_forecasts_entity_asof_idx"
  ON "sentiment_forecasts" ("entity_id", "as_of");

CREATE INDEX IF NOT EXISTS "sentiment_forecasts_asof_status_idx"
  ON "sentiment_forecasts" ("as_of", "status");

CREATE INDEX IF NOT EXISTS "sentiment_forecasts_status_horizon_idx"
  ON "sentiment_forecasts" ("status", "horizon");

-- 3) Idempotente CHECK-Constraints ------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sentiment_forecasts_status_check') THEN
    ALTER TABLE "sentiment_forecasts" ADD CONSTRAINT "sentiment_forecasts_status_check"
      CHECK ("status" IN ('ACTIVE','ABSTAIN'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sentiment_forecasts_direction_check') THEN
    ALTER TABLE "sentiment_forecasts" ADD CONSTRAINT "sentiment_forecasts_direction_check"
      CHECK ("direction" IS NULL OR "direction" IN ('BULLISH','BEARISH','NEUTRAL'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sentiment_forecasts_abstain_check') THEN
    ALTER TABLE "sentiment_forecasts" ADD CONSTRAINT "sentiment_forecasts_abstain_check"
      CHECK (("status" = 'ABSTAIN') = ("abstain" = true)
             AND ("abstain" = true) = ("abstain_reason" IS NOT NULL)
             AND ("abstain" = true) = ("probability" IS NULL)
             AND ("abstain" = true) = ("direction" IS NULL));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sentiment_forecasts_probability_check') THEN
    ALTER TABLE "sentiment_forecasts" ADD CONSTRAINT "sentiment_forecasts_probability_check"
      CHECK ("probability" IS NULL OR ("probability" >= 0.01 AND "probability" <= 0.99));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sentiment_forecasts_confidence_check') THEN
    ALTER TABLE "sentiment_forecasts" ADD CONSTRAINT "sentiment_forecasts_confidence_check"
      CHECK ("confidence" >= 0 AND "confidence" <= 1);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sentiment_forecasts_coverage_check') THEN
    ALTER TABLE "sentiment_forecasts" ADD CONSTRAINT "sentiment_forecasts_coverage_check"
      CHECK ("coverage" >= 0 AND "coverage" <= 1);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sentiment_forecasts_horizon_check') THEN
    ALTER TABLE "sentiment_forecasts" ADD CONSTRAINT "sentiment_forecasts_horizon_check"
      CHECK ("horizon" IN ('4h','24h','72h'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sentiment_forecasts_valid_until_check') THEN
    ALTER TABLE "sentiment_forecasts" ADD CONSTRAINT "sentiment_forecasts_valid_until_check"
      CHECK ("valid_until" > "as_of");
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sentiment_forecasts_source_count_check') THEN
    ALTER TABLE "sentiment_forecasts" ADD CONSTRAINT "sentiment_forecasts_source_count_check"
      CHECK ("source_count" >= 0 AND "raw_source_count" >= "source_count");
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sentiment_forecasts_forecast_id_check') THEN
    ALTER TABLE "sentiment_forecasts" ADD CONSTRAINT "sentiment_forecasts_forecast_id_check"
      CHECK ("forecast_id" ~ '^sf1:[0-9a-f]{64}$');
  END IF;
END $$;
