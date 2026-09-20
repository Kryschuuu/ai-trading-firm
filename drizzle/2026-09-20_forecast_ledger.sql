-- RMA-P3-01 (v1.55.0) — Forecast-Ledger, Brier Score und Kalibrierung.
-- Append-only: VIER neue Tabellen + Indizes/Constraints; keine bestehende
-- Tabelle wird verändert, keine Spalte umgebaut, kein Backfill nötig.
--
-- Hintergrund: Agenten-Confidence (`src/lib/analysts.ts`) und Trade-Outcomes
-- (`trade_journal`) wurden getrennt gespeichert; es gab kein Proper Scoring
-- Rule, keine Forecast-Horizonte und keine Reliability Bins. Nicht gehandelte
-- Forecasts wurden nie systematisch ausgewertet (Roadmap-Audit 2026-09-20,
-- docs/audits/2026-09-20-roadmap-audit/findings/RMA-P3-01-forecast-calibration.md).
--
-- ── Zeit-Semantik (Kern des Fixes) ─────────────────────────────────────────
--   as_of                  Entstehung des Forecasts (Analysezeitpunkt).
--   reference_time         Schlusszeit der letzten vor `as_of` geschlossenen
--                          Kerze (Referenzkurs des Ziel-Events).
--   resolves_at            Schlusszeit der Kerze, die über das Ziel-Event
--                          entscheidet (`reference_time + horizon`).
--   availability_deadline  `resolves_at + 2h` Settling-Frist. Die automatische
--                          Auflösung verwendet ausschließlich Kerzen mit
--                          `fetched_at <= availability_deadline` — später
--                          eintreffende oder korrigierte Daten sind für die
--                          Erstauflösung unsichtbar (kein Look-ahead, keine
--                          stille Mutation). Korrekturen laufen über neue
--                          Resolution-Versionen (append-only).
--
-- ── Fail-closed statt Nullwert ─────────────────────────────────────────────
-- Missing/Halt/Corporate Action führt nach Policy zu VOID oder delayed, nie
-- automatisch falsch: ein Forecast ohne Resolution ist PENDING und geht weder
-- als 0 noch als korrekt in Scores ein; ein VOID trägt einen geschlossenen
-- Grund (`MISSING_DATA` | `INVALID_DATA` | `TRADING_HALT` | `STALE_DATA` |
-- `CORPORATE_ACTION` | `DATA_CORRECTION`).
--
-- ── Idempotenz und Versionierung ───────────────────────────────────────────
-- forecasts.idempotency_key (`fk1:<sha256>`) UNIQUE: Retries/doppelt erfasste
-- Analysen schreiben keinen zweiten Forecast.
-- forecast_resolutions: UNIQUE (forecast_id, outcome_hash) macht identische
-- Auflösungen idempotent; ein abweichendes Ergebnis erhält die nächste
-- resolution_version — Historie wird nie überschrieben.
-- forecast_resolution_runs: UNIQUE idempotency_key (`frk1:<sha256>`).
--
-- Erklärt mit `npx drizzle-kit push` aus `src/db/schema.ts`
-- (`forecasts`, `forecastResolutions`, `forecastResolutionRuns`,
-- `forecastResolverCursors`); diese Datei ist der äquivalente, idempotente
-- SQL-Pfad für Umgebungen ohne drizzle-kit
-- (z. B. `psql "$DATABASE_URL" -f drizzle/2026-09-20_forecast_ledger.sql`).
--
-- ── Rollback / Feature-Flag ────────────────────────────────────────────────
-- Der Ledger ist ein zusätzlicher Auswertungspfad; Handels-, Risiko- und
-- Live-Gate-Pfade bleiben unverändert. Zwei sichere Rückzugsoptionen:
--   1. Feature-Flag: `FORECAST_LEDGER_ENABLED=false` stoppt Capture UND
--      Resolver-Job (bestehende Zeilen bleiben lesbar).
--   2. Tabellen-Drop (nur wenn kein v1.55.0-Code mehr schreibt):
--        DROP TABLE IF EXISTS forecast_resolver_cursors;
--        DROP TABLE IF EXISTS forecast_resolution_runs;
--        DROP TABLE IF EXISTS forecast_resolutions;
--        DROP TABLE IF EXISTS forecasts;
--      Betroffen sind ausschließlich Forecast-Auswertungsdaten; alle übrigen
--      Tabellen (Trade-Journal, Positionen, Audit, Feature Store, …) bleiben
--      unberührt.

-- 1) Immutable Forecast-Verträge ---------------------------------------------
CREATE TABLE IF NOT EXISTS "forecasts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "idempotency_key" text NOT NULL,
  "agent_role" text NOT NULL,
  "prompt_version" integer NOT NULL,
  "model" text NOT NULL,
  "entity_type" text NOT NULL DEFAULT 'instrument',
  "entity_id" text NOT NULL,
  "symbol" text NOT NULL,
  "target_kind" text NOT NULL,
  "categories" jsonb NOT NULL,
  "probabilities" jsonb NOT NULL,
  "target_category" text NOT NULL,
  "probability" numeric NOT NULL,
  "horizon_id" text NOT NULL,
  "horizon_minutes" integer NOT NULL,
  "timeframe" text NOT NULL,
  "as_of" timestamptz NOT NULL,
  "reference_time" timestamptz NOT NULL,
  "reference_close" numeric NOT NULL,
  "resolves_at" timestamptz NOT NULL,
  "availability_deadline" timestamptz NOT NULL,
  "regime" text NOT NULL DEFAULT 'UNKNOWN',
  "policy_version" text NOT NULL,
  "contract_version" integer NOT NULL,
  "source_manifest" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "forecasts_key_unique" ON "forecasts" ("idempotency_key");
CREATE INDEX IF NOT EXISTS "forecasts_agent_asof_idx" ON "forecasts" ("agent_role", "as_of");
CREATE INDEX IF NOT EXISTS "forecasts_entity_asof_idx" ON "forecasts" ("entity_id", "as_of");
CREATE INDEX IF NOT EXISTS "forecasts_horizon_asof_idx" ON "forecasts" ("horizon_id", "as_of");
CREATE INDEX IF NOT EXISTS "forecasts_deadline_idx" ON "forecasts" ("availability_deadline");

-- 2) Versionierte Auflösungen (append-only) ----------------------------------
CREATE TABLE IF NOT EXISTS "forecast_resolutions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "forecast_id" uuid NOT NULL REFERENCES "forecasts"("id"),
  "resolution_version" integer NOT NULL,
  "status" text NOT NULL,
  "outcome_index" integer,
  "outcome_label" text,
  "outcome_binary" integer,
  "reference_close" numeric,
  "outcome_close" numeric,
  "void_reason" text,
  "resolution_kind" text NOT NULL,
  "resolved_at" timestamptz NOT NULL,
  "policy_version" text NOT NULL,
  "outcome_hash" text NOT NULL,
  "outcome_manifest" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "forecast_resolutions_version_unique"
  ON "forecast_resolutions" ("forecast_id", "resolution_version");
CREATE UNIQUE INDEX IF NOT EXISTS "forecast_resolutions_outcome_hash_unique"
  ON "forecast_resolutions" ("forecast_id", "outcome_hash");
CREATE INDEX IF NOT EXISTS "forecast_resolutions_status_idx"
  ON "forecast_resolutions" ("status", "resolved_at");

-- 3) Lauf-Manifeste des Resolver-Jobs ----------------------------------------
CREATE TABLE IF NOT EXISTS "forecast_resolution_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "idempotency_key" text NOT NULL,
  "mode" text NOT NULL,
  "status" text NOT NULL,
  "counts_json" jsonb NOT NULL,
  "cursor_before" jsonb NOT NULL,
  "cursor_after" jsonb NOT NULL,
  "code_version" text NOT NULL,
  "error_code" text,
  "started_at" timestamptz NOT NULL,
  "finished_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "forecast_resolution_runs_key_unique"
  ON "forecast_resolution_runs" ("idempotency_key");
CREATE INDEX IF NOT EXISTS "forecast_resolution_runs_finished_idx"
  ON "forecast_resolution_runs" ("finished_at");

-- 4) Wasserstand des Resolver-Jobs -------------------------------------------
CREATE TABLE IF NOT EXISTS "forecast_resolver_cursors" (
  "cursor_id" text PRIMARY KEY,
  "watermark_deadline" timestamptz NOT NULL,
  "last_run_id" uuid REFERENCES "forecast_resolution_runs"("id"),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "forecast_resolver_cursors_last_run_idx"
  ON "forecast_resolver_cursors" ("last_run_id");

-- ── Constraints (idempotent nachgezogen) ───────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'forecasts_entity_type_check') THEN
    ALTER TABLE "forecasts" ADD CONSTRAINT "forecasts_entity_type_check"
      CHECK ("entity_type" = 'instrument');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'forecasts_target_kind_check') THEN
    ALTER TABLE "forecasts" ADD CONSTRAINT "forecasts_target_kind_check"
      CHECK ("target_kind" = 'CLOSE_DIRECTION');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'forecasts_horizon_check') THEN
    ALTER TABLE "forecasts" ADD CONSTRAINT "forecasts_horizon_check"
      CHECK ("horizon_id" IN ('4h','24h','72h'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'forecasts_horizon_minutes_check') THEN
    ALTER TABLE "forecasts" ADD CONSTRAINT "forecasts_horizon_minutes_check"
      CHECK ("horizon_minutes" IN (240, 1440, 4320));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'forecasts_timeframe_check') THEN
    ALTER TABLE "forecasts" ADD CONSTRAINT "forecasts_timeframe_check"
      CHECK ("timeframe" = '1h');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'forecasts_probability_check') THEN
    ALTER TABLE "forecasts" ADD CONSTRAINT "forecasts_probability_check"
      CHECK ("probability" >= 0 AND "probability" <= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'forecasts_prompt_version_check') THEN
    ALTER TABLE "forecasts" ADD CONSTRAINT "forecasts_prompt_version_check"
      CHECK ("prompt_version" >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'forecasts_contract_version_check') THEN
    ALTER TABLE "forecasts" ADD CONSTRAINT "forecasts_contract_version_check"
      CHECK ("contract_version" >= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'forecasts_time_order_check') THEN
    ALTER TABLE "forecasts" ADD CONSTRAINT "forecasts_time_order_check"
      CHECK ("reference_time" <= "as_of" AND "resolves_at" > "as_of" AND "availability_deadline" > "resolves_at");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'forecasts_key_hash_check') THEN
    ALTER TABLE "forecasts" ADD CONSTRAINT "forecasts_key_hash_check"
      CHECK ("idempotency_key" ~ '^fk1:[0-9a-f]{64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'forecasts_regime_check') THEN
    ALTER TABLE "forecasts" ADD CONSTRAINT "forecasts_regime_check"
      CHECK ("regime" IN ('NORMAL','ELEVATED','EXTREME','PERSISTED','UNKNOWN'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'forecasts_categories_json_check') THEN
    ALTER TABLE "forecasts" ADD CONSTRAINT "forecasts_categories_json_check"
      CHECK (jsonb_typeof("categories") = 'array' AND jsonb_array_length("categories") >= 2);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'forecasts_probabilities_json_check') THEN
    ALTER TABLE "forecasts" ADD CONSTRAINT "forecasts_probabilities_json_check"
      CHECK (jsonb_typeof("probabilities") = 'array' AND jsonb_array_length("probabilities") = jsonb_array_length("categories"));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'forecast_resolutions_status_check') THEN
    ALTER TABLE "forecast_resolutions" ADD CONSTRAINT "forecast_resolutions_status_check"
      CHECK ("status" IN ('RESOLVED','VOID'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'forecast_resolutions_exclusive_check') THEN
    ALTER TABLE "forecast_resolutions" ADD CONSTRAINT "forecast_resolutions_exclusive_check"
      CHECK (("status" = 'RESOLVED' AND "outcome_index" IS NOT NULL AND "void_reason" IS NULL)
        OR ("status" = 'VOID' AND "outcome_index" IS NULL AND "void_reason" IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'forecast_resolutions_binary_check') THEN
    ALTER TABLE "forecast_resolutions" ADD CONSTRAINT "forecast_resolutions_binary_check"
      CHECK ("outcome_binary" IS NULL OR "outcome_binary" IN (0, 1));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'forecast_resolutions_void_reason_check') THEN
    ALTER TABLE "forecast_resolutions" ADD CONSTRAINT "forecast_resolutions_void_reason_check"
      CHECK ("void_reason" IS NULL OR "void_reason" IN
        ('MISSING_DATA','INVALID_DATA','TRADING_HALT','STALE_DATA','CORPORATE_ACTION','DATA_CORRECTION'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'forecast_resolutions_kind_check') THEN
    ALTER TABLE "forecast_resolutions" ADD CONSTRAINT "forecast_resolutions_kind_check"
      CHECK ("resolution_kind" IN ('AUTOMATIC','OPERATOR'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'forecast_resolutions_version_check') THEN
    ALTER TABLE "forecast_resolutions" ADD CONSTRAINT "forecast_resolutions_version_check"
      CHECK ("resolution_version" >= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'forecast_resolutions_hash_check') THEN
    ALTER TABLE "forecast_resolutions" ADD CONSTRAINT "forecast_resolutions_hash_check"
      CHECK ("outcome_hash" ~ '^fo1:[0-9a-f]{64}$');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'forecast_resolution_runs_mode_check') THEN
    ALTER TABLE "forecast_resolution_runs" ADD CONSTRAINT "forecast_resolution_runs_mode_check"
      CHECK ("mode" IN ('AUTOMATIC','OPERATOR'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'forecast_resolution_runs_status_check') THEN
    ALTER TABLE "forecast_resolution_runs" ADD CONSTRAINT "forecast_resolution_runs_status_check"
      CHECK ("status" IN ('SUCCEEDED','FAILED'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'forecast_resolution_runs_error_check') THEN
    ALTER TABLE "forecast_resolution_runs" ADD CONSTRAINT "forecast_resolution_runs_error_check"
      CHECK (("status" = 'FAILED' AND "error_code" IS NOT NULL)
        OR ("status" = 'SUCCEEDED' AND "error_code" IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'forecast_resolution_runs_key_hash_check') THEN
    ALTER TABLE "forecast_resolution_runs" ADD CONSTRAINT "forecast_resolution_runs_key_hash_check"
      CHECK ("idempotency_key" ~ '^frk1:[0-9a-f]{64}$');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'forecast_resolver_cursors_id_check') THEN
    ALTER TABLE "forecast_resolver_cursors" ADD CONSTRAINT "forecast_resolver_cursors_id_check"
      CHECK ("cursor_id" = 'resolution');
  END IF;
END
$$;
