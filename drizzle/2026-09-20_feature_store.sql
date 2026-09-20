-- RMA-P6-01 (v1.53.0) — Point-in-Time Feature Store.
-- Append-only: FÜNF neue Tabellen + Indizes/Constraints; keine bestehende
-- Tabelle wird verändert, keine Spalte umgebaut, kein Backfill nötig.
--
-- Hintergrund: Der Historical Store (`src/lib/marketdata/historicalStore.ts`)
-- speichert Rohkerzen mit Provenienz, aber keine Featuredefinition, keinen
-- Berechnungszeitpunkt und keine Verfügbarkeitssemantik. Damit ist eine
-- Look-ahead-sichere Wiederverwendung berechneter Werte nicht garantiert
-- (Roadmap-Audit 2026-09-20,
-- docs/audits/2026-09-20-roadmap-audit/findings/RMA-P6-01-point-in-time-feature-store.md).
--
-- ── Zeit-Semantik (Kern des Fixes) ─────────────────────────────────────────
--   event_time    Zeitpunkt des Ereignisses (Schlusszeit der Kerze).
--   available_at  Zeitpunkt, ab dem der Wert bekannt sein konnte.
--   computed_at   Zeitpunkt der Berechnung (Materialisierungslauf).
-- Eine Point-in-Time-Abfrage ist zulässig, wenn
--   event_time <= target AND available_at <= as_of
-- gilt; `computed_at` ist bewusst KEIN Zulässigkeitskriterium (eine späte
-- Neuberechnung alter Daten erzeugt rückwirkend kein neues Wissen).
--
-- ── Fail-closed statt Nullwert ─────────────────────────────────────────────
-- Jede Wertezeile trägt GENAU EINES: einen Wert (`value_num`/`value_bool`/
-- `value_text`, passend zum `dtype`) oder einen `null_reason`. `unavailable`
-- wird nie als 0/false/'' gespeichert.
--
-- ── Idempotenz und Revision ────────────────────────────────────────────────
-- UNIQUE (feature_id, feature_version, entity_id, timeframe, event_time):
-- ein identischer Wert wird nicht erneut geschrieben; ein abweichender Wert
-- zum selben Schlüssel wird NICHT überschrieben, sondern in
-- `feature_data_revisions` protokolliert (append-only, UNIQUE über
-- Schlüssel + eingehenden Hash).
--
-- Erklärt mit `npx drizzle-kit push` aus `src/db/schema.ts`
-- (`featureDefinitions`, `featureValues`, `featureMaterializationRuns`,
-- `featureMaterializationCursors`, `featureDataRevisions`); diese Datei ist der
-- äquivalente, idempotente SQL-Pfad für Umgebungen ohne drizzle-kit
-- (z. B. `psql "$DATABASE_URL" -f drizzle/2026-09-20_feature_store.sql`).
--
-- ── Rollback ───────────────────────────────────────────────────────────────
-- Nur wenn KEIN v1.53.0-Code mehr läuft (der Feature Store ist ein zusätzlicher
-- Lesepfad; Scanner, Zyklus, Risiko- und Live-Gates bleiben unverändert):
--   DROP TABLE IF EXISTS feature_data_revisions;
--   DROP TABLE IF EXISTS feature_materialization_cursors;
--   DROP TABLE IF EXISTS feature_values;
--   DROP TABLE IF EXISTS feature_materialization_runs;
--   DROP TABLE IF EXISTS feature_definitions;
-- Der Rollback betrifft ausschließlich Materialisierungsergebnisse; Rohdaten
-- (`data/history/candles.ndjson`) und alle übrigen Tabellen bleiben unberührt.
-- Werte können jederzeit aus denselben Rohdaten + Definitionen reproduziert
-- werden (`npm run features:materialize -- --mode=backfill`).

-- 1) Immutables Definitionsverzeichnis -------------------------------------
CREATE TABLE IF NOT EXISTS "feature_definitions" (
  "feature_id" text NOT NULL,
  "version" integer NOT NULL,
  "label" text NOT NULL,
  "description" text NOT NULL,
  "dtype" text NOT NULL,
  "enum_values" jsonb,
  "unit" text,
  "value_decimals" integer,
  "entity_type" text NOT NULL DEFAULT 'instrument',
  "timeframe" text NOT NULL,
  "lookback_bars" integer NOT NULL,
  "dependencies" jsonb NOT NULL,
  "compute_key" text NOT NULL,
  "config" jsonb NOT NULL,
  "owner" text NOT NULL,
  "code_hash" text NOT NULL,
  "config_hash" text NOT NULL,
  "definition_hash" text NOT NULL,
  "registered_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("feature_id", "version")
);

CREATE INDEX IF NOT EXISTS "feature_definitions_latest_idx"
  ON "feature_definitions" ("feature_id", "version");

-- 2) Materialisierungsläufe (Backfill-Manifest) ----------------------------
CREATE TABLE IF NOT EXISTS "feature_materialization_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "idempotency_key" text NOT NULL,
  "mode" text NOT NULL,
  "status" text NOT NULL,
  "timeframe" text NOT NULL,
  "availability_policy" text NOT NULL,
  "feature_refs" jsonb NOT NULL,
  "entity_ids" jsonb NOT NULL,
  "from_ts" timestamptz,
  "to_ts" timestamptz,
  "counts_json" jsonb NOT NULL,
  "definition_hashes" jsonb NOT NULL,
  "source_manifests" jsonb NOT NULL,
  "cursor_before" jsonb NOT NULL,
  "cursor_after" jsonb NOT NULL,
  "code_version" text NOT NULL,
  "error_code" text,
  "started_at" timestamptz NOT NULL,
  "finished_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

-- Retry mit identischen Eingaben ⇒ bestehendes Manifest, kein zweiter Lauf.
CREATE UNIQUE INDEX IF NOT EXISTS "feature_materialization_runs_key_unique"
  ON "feature_materialization_runs" ("idempotency_key");

CREATE INDEX IF NOT EXISTS "feature_materialization_runs_finished_idx"
  ON "feature_materialization_runs" ("finished_at");

-- 3) Featurewerte (append-only Wahrheitsquelle) ----------------------------
CREATE TABLE IF NOT EXISTS "feature_values" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "run_id" uuid REFERENCES "feature_materialization_runs"("id"),
  "feature_id" text NOT NULL,
  "feature_version" integer NOT NULL,
  "entity_type" text NOT NULL DEFAULT 'instrument',
  "entity_id" text NOT NULL,
  "timeframe" text NOT NULL,
  "event_time" timestamptz NOT NULL,
  "available_at" timestamptz NOT NULL,
  "computed_at" timestamptz NOT NULL,
  "dtype" text NOT NULL,
  "value_num" numeric,
  "value_bool" boolean,
  "value_text" text,
  "null_reason" text,
  "quality_status" text NOT NULL,
  "definition_hash" text NOT NULL,
  "value_hash" text NOT NULL,
  "source_manifest" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

-- Idempotenz der Materialisierung (identischer Wert ⇒ kein zweiter Write).
CREATE UNIQUE INDEX IF NOT EXISTS "feature_values_key_unique"
  ON "feature_values" ("feature_id", "feature_version", "entity_id", "timeframe", "event_time");

-- PIT-Lesepfad: entity-major, jüngste Eventzeit zuerst (Index-Range-Scan,
-- kein Seq-Scan über die wachsende Wertetabelle).
CREATE INDEX IF NOT EXISTS "feature_values_pit_idx"
  ON "feature_values" ("entity_id", "feature_id", "feature_version", "timeframe", "event_time", "available_at");

-- Coverage-/Status-/Paritätspfad (feature-major).
CREATE INDEX IF NOT EXISTS "feature_values_feature_event_idx"
  ON "feature_values" ("feature_id", "feature_version", "event_time");

CREATE INDEX IF NOT EXISTS "feature_values_run_idx"
  ON "feature_values" ("run_id");

-- 4) Cursor/Wasserstand je Featurereihe ------------------------------------
CREATE TABLE IF NOT EXISTS "feature_materialization_cursors" (
  "feature_id" text NOT NULL,
  "feature_version" integer NOT NULL,
  "entity_id" text NOT NULL,
  "timeframe" text NOT NULL,
  "watermark_event_time" timestamptz NOT NULL,
  "watermark_available_at" timestamptz NOT NULL,
  "last_run_id" uuid REFERENCES "feature_materialization_runs"("id"),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("feature_id", "feature_version", "entity_id", "timeframe")
);

CREATE INDEX IF NOT EXISTS "feature_materialization_cursors_last_run_idx"
  ON "feature_materialization_cursors" ("last_run_id");

-- 5) Protokollierte Datenrevisionen ---------------------------------------
CREATE TABLE IF NOT EXISTS "feature_data_revisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "feature_id" text NOT NULL,
  "feature_version" integer NOT NULL,
  "entity_id" text NOT NULL,
  "timeframe" text NOT NULL,
  "event_time" timestamptz NOT NULL,
  "existing_value_hash" text NOT NULL,
  "incoming_value_hash" text NOT NULL,
  "run_id" uuid REFERENCES "feature_materialization_runs"("id"),
  "detected_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

-- Dieselbe Revision wird nicht zweimal protokolliert.
CREATE UNIQUE INDEX IF NOT EXISTS "feature_data_revisions_key_unique"
  ON "feature_data_revisions" ("feature_id", "feature_version", "entity_id", "timeframe", "event_time", "incoming_value_hash");

CREATE INDEX IF NOT EXISTS "feature_data_revisions_series_idx"
  ON "feature_data_revisions" ("feature_id", "entity_id", "event_time");

-- ── Constraints (idempotent nachgezogen) ───────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feature_definitions_version_check') THEN
    ALTER TABLE "feature_definitions" ADD CONSTRAINT "feature_definitions_version_check"
      CHECK ("version" >= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feature_definitions_dtype_check') THEN
    ALTER TABLE "feature_definitions" ADD CONSTRAINT "feature_definitions_dtype_check"
      CHECK ("dtype" IN ('number', 'boolean', 'enum'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feature_definitions_enum_check') THEN
    ALTER TABLE "feature_definitions" ADD CONSTRAINT "feature_definitions_enum_check"
      CHECK (("dtype" = 'enum' AND "enum_values" IS NOT NULL) OR ("dtype" <> 'enum' AND "enum_values" IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feature_definitions_lookback_check') THEN
    ALTER TABLE "feature_definitions" ADD CONSTRAINT "feature_definitions_lookback_check"
      CHECK ("lookback_bars" >= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feature_definitions_entity_type_check') THEN
    ALTER TABLE "feature_definitions" ADD CONSTRAINT "feature_definitions_entity_type_check"
      CHECK ("entity_type" = 'instrument');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feature_definitions_code_hash_check') THEN
    ALTER TABLE "feature_definitions" ADD CONSTRAINT "feature_definitions_code_hash_check"
      CHECK ("code_hash" ~ '^fc1:[0-9a-f]{64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feature_definitions_config_hash_check') THEN
    ALTER TABLE "feature_definitions" ADD CONSTRAINT "feature_definitions_config_hash_check"
      CHECK ("config_hash" ~ '^fg1:[0-9a-f]{64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feature_definitions_hash_check') THEN
    ALTER TABLE "feature_definitions" ADD CONSTRAINT "feature_definitions_hash_check"
      CHECK ("definition_hash" ~ '^fd1:[0-9a-f]{64}$');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feature_materialization_runs_mode_check') THEN
    ALTER TABLE "feature_materialization_runs" ADD CONSTRAINT "feature_materialization_runs_mode_check"
      CHECK ("mode" IN ('INCREMENTAL', 'BACKFILL'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feature_materialization_runs_status_check') THEN
    ALTER TABLE "feature_materialization_runs" ADD CONSTRAINT "feature_materialization_runs_status_check"
      CHECK ("status" IN ('SUCCEEDED', 'FAILED'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feature_materialization_runs_policy_check') THEN
    ALTER TABLE "feature_materialization_runs" ADD CONSTRAINT "feature_materialization_runs_policy_check"
      CHECK ("availability_policy" IN ('bar_close', 'ingested'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feature_materialization_runs_error_check') THEN
    ALTER TABLE "feature_materialization_runs" ADD CONSTRAINT "feature_materialization_runs_error_check"
      CHECK (("status" = 'FAILED' AND "error_code" IS NOT NULL) OR ("status" = 'SUCCEEDED' AND "error_code" IS NULL));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feature_values_available_check') THEN
    ALTER TABLE "feature_values" ADD CONSTRAINT "feature_values_available_check"
      CHECK ("available_at" >= "event_time");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feature_values_computed_check') THEN
    ALTER TABLE "feature_values" ADD CONSTRAINT "feature_values_computed_check"
      CHECK ("computed_at" >= "available_at");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feature_values_value_exclusive_check') THEN
    ALTER TABLE "feature_values" ADD CONSTRAINT "feature_values_value_exclusive_check"
      CHECK (((CASE WHEN "value_num" IS NOT NULL THEN 1 ELSE 0 END)
            + (CASE WHEN "value_bool" IS NOT NULL THEN 1 ELSE 0 END)
            + (CASE WHEN "value_text" IS NOT NULL THEN 1 ELSE 0 END)
            + (CASE WHEN "null_reason" IS NOT NULL THEN 1 ELSE 0 END)) = 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feature_values_dtype_check') THEN
    ALTER TABLE "feature_values" ADD CONSTRAINT "feature_values_dtype_check"
      CHECK (("dtype" = 'number' AND ("value_num" IS NOT NULL OR "null_reason" IS NOT NULL))
          OR ("dtype" = 'boolean' AND ("value_bool" IS NOT NULL OR "null_reason" IS NOT NULL))
          OR ("dtype" = 'enum' AND ("value_text" IS NOT NULL OR "null_reason" IS NOT NULL)));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feature_values_null_reason_check') THEN
    ALTER TABLE "feature_values" ADD CONSTRAINT "feature_values_null_reason_check"
      CHECK ("null_reason" IS NULL OR "null_reason" IN
        ('INSUFFICIENT_LOOKBACK', 'INVALID_INPUT', 'MISSING_BARS', 'NOT_COMPUTABLE', 'DEPENDENCY_NULL', 'DEPENDENCY_MISSING'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feature_values_quality_check') THEN
    ALTER TABLE "feature_values" ADD CONSTRAINT "feature_values_quality_check"
      CHECK ("quality_status" IN ('OK', 'GAP', 'OUTLIER', 'INVALID', 'DUPLICATE', 'CROSSCHECK', 'UNKNOWN'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feature_values_definition_hash_check') THEN
    ALTER TABLE "feature_values" ADD CONSTRAINT "feature_values_definition_hash_check"
      CHECK ("definition_hash" ~ '^fd1:[0-9a-f]{64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feature_values_hash_check') THEN
    ALTER TABLE "feature_values" ADD CONSTRAINT "feature_values_hash_check"
      CHECK ("value_hash" ~ '^fv1:[0-9a-f]{64}$');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feature_materialization_cursors_watermark_check') THEN
    ALTER TABLE "feature_materialization_cursors" ADD CONSTRAINT "feature_materialization_cursors_watermark_check"
      CHECK ("watermark_available_at" >= "watermark_event_time");
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feature_data_revisions_existing_hash_check') THEN
    ALTER TABLE "feature_data_revisions" ADD CONSTRAINT "feature_data_revisions_existing_hash_check"
      CHECK ("existing_value_hash" ~ '^fv1:[0-9a-f]{64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feature_data_revisions_incoming_hash_check') THEN
    ALTER TABLE "feature_data_revisions" ADD CONSTRAINT "feature_data_revisions_incoming_hash_check"
      CHECK ("incoming_value_hash" ~ '^fv1:[0-9a-f]{64}$');
  END IF;
END $$;
