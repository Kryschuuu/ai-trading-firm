-- STX-05-03 (Phase 5, Finding STX-07) — Screening-Persistenz + Idempotenz.
-- Additiv/append-only: genau zwei neue Tabellen; keine Änderungen an
-- backtest_runs, strategy_versions oder strategy_lifecycle_*.
-- Voraussetzung: 2026-09-19_backtest_runs.sql und
--                2026-10-01_strategy_catalog.sql (STX-04-01).
-- Das konkrete Datum ersetzt den Platzhalter 2026-09-2X im Auftrag.
--
-- Screening-Runs halten den gemeinsamen PIT-Cutoff und die aufgelösten
-- Gewichte + Limits in config_json. ssr1:<sha256> über canonicalJson von
-- { cells, asOf (UTC-ISO), codeVersion, config } identifiziert den Lauf.
-- UNIQUE(candidate_set_hash, code_version): Retry ⇒ bestehender Run.
--
-- Zellen referenzieren IMMER strategy_versions.id; backtest_run_id ist
-- optional. ssm1:<sha256> über canonicalJson von
-- { runId, strategyVersionId, instrumentId, venue, timeframe } dedupliziert
-- INSERT-Retries. Der Store schreibt Zellen ausschließlich insert-only;
-- insbesondere priority wird niemals nachträglich verändert.
-- Kein DELETE-Pfad, keine FK-Cascades, kein Universe-Pseudoinstrument.
--
-- Beide Pfade erzeugen dasselbe Schema:
--   psql "$DATABASE_URL" -f drizzle/2026-10-01_strategy_screening.sql
--   npx drizzle-kit push  (src/db/schema.ts)
-- Rollback: Anwendungsschreiber/Leser stoppen; nach Export der Ergebnisse
-- nur die neuen Tabellen in FK-Reihenfolge entfernen (siehe
-- docs/STRATEGY_SCREENING.md). Bestehende Tabellen bleiben unverändert.

CREATE TABLE IF NOT EXISTS "strategy_screening_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "run_kind" text NOT NULL,
  "as_of" timestamptz NOT NULL,
  "candidate_set_hash" text NOT NULL,
  "code_version" text NOT NULL,
  "data_version" text,
  "config_json" jsonb NOT NULL,
  "status" text NOT NULL,
  "cells_total" integer NOT NULL DEFAULT 0,
  "cells_done" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "strategy_screening_runs_hash_code_unique"
  ON "strategy_screening_runs" ("candidate_set_hash", "code_version");

DO $$ BEGIN
  ALTER TABLE "strategy_screening_runs"
    ADD CONSTRAINT "strategy_screening_runs_kind_check"
    CHECK ("run_kind" IN ('DISCOVERY','MATRIX','BACKTEST_BATCH'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "strategy_screening_runs"
    ADD CONSTRAINT "strategy_screening_runs_hash_check"
    CHECK ("candidate_set_hash" ~ '^ssr1:[0-9a-f]{64}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "strategy_screening_runs"
    ADD CONSTRAINT "strategy_screening_runs_status_check"
    CHECK ("status" IN ('PENDING','RUNNING','DONE','FAILED','ABORTED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "strategy_screening_runs"
    ADD CONSTRAINT "strategy_screening_runs_counts_check"
    CHECK ("cells_total" >= 0 AND "cells_done" >= 0 AND "cells_done" <= "cells_total");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "strategy_screening_runs"
    ADD CONSTRAINT "strategy_screening_runs_config_check"
    CHECK (jsonb_typeof("config_json") = 'object');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "strategy_market_results" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "run_id" uuid NOT NULL
    CONSTRAINT "strategy_market_results_run_fk"
    REFERENCES "strategy_screening_runs"("id"),
  "strategy_version_id" uuid NOT NULL
    CONSTRAINT "strategy_market_results_strategy_version_fk"
    REFERENCES "strategy_versions"("id"),
  "instrument_id" text NOT NULL,
  "venue" text NOT NULL,
  "timeframe" text NOT NULL,
  "template_id" text NOT NULL,
  "priority" numeric,
  "status" text NOT NULL,
  "reasons" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "backtest_run_id" uuid
    CONSTRAINT "strategy_market_results_backtest_run_fk"
    REFERENCES "backtest_runs"("id"),
  "metrics" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "idempotency_key" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "strategy_market_results_idem_unique"
  ON "strategy_market_results" ("idempotency_key");
CREATE INDEX IF NOT EXISTS "strategy_market_results_run_status_idx"
  ON "strategy_market_results" ("run_id", "status");
CREATE INDEX IF NOT EXISTS "strategy_market_results_run_priority_idx"
  ON "strategy_market_results" ("run_id", "priority" DESC NULLS LAST);

DO $$ BEGIN
  ALTER TABLE "strategy_market_results"
    ADD CONSTRAINT "strategy_market_results_idem_check"
    CHECK ("idempotency_key" ~ '^ssm1:[0-9a-f]{64}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "strategy_market_results"
    ADD CONSTRAINT "strategy_market_results_reasons_check"
    CHECK (jsonb_typeof("reasons") = 'array');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "strategy_market_results"
    ADD CONSTRAINT "strategy_market_results_metrics_check"
    CHECK (jsonb_typeof("metrics") = 'object');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
