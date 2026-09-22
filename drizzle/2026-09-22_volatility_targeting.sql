-- RMA-P5-01 (v1.67.0) — Kontinuierliches Portfolio-Volatility-Targeting.
-- Append-only: EINE neue Tabelle + Indizes/Constraints; keine bestehende
-- Tabelle wird verändert, keine Spalte umgebaut, kein Backfill nötig.
--
-- Äquivalent zu `npx drizzle-kit push` aus `src/db/schema.ts`
-- (`volatilityTargetingSnapshots`); diese Datei ist der idempotente SQL-Pfad
-- für Umgebungen ohne drizzle-kit:
--   psql "$DATABASE_URL" -f drizzle/2026-09-22_volatility_targeting.sql
--
-- ── Semantik ────────────────────────────────────────────────────────────────
-- `volatility_targeting_snapshots`
--   EINE Zeile je Volatility-Targeting-Snapshot: Portfolio-Volatilitäts-
--   forecast, konfiguriertes Ziel, roher/angewendeter Multiplikator,
--   gewichtete Datenabdeckung, Realisierung + Target-Error sowie die
--   Reproduktions-Hashes (Konfiguration + Daten).
--
--   Der natürliche Schlüssel `snapshot_id` (`vt1:<sha256>` über
--   Minuten-Fenster|ConfigHash|DataHash) stellt Idempotenz bei Retries/
--   Restarts sicher (ON CONFLICT DO NOTHING, UNIQUE-Index).
--
-- Zeitsemantik (drei getrennte Zeitachsen — kein Look-ahead):
--   as_of        = Entscheidungszeit; alle Returns stammen aus Kerzen mit
--                  Event-Time ≤ as_of.
--   computed_at  = Berechnungszeit, immer ≥ as_of (CHECK).
--   event_time   = jüngstes Event der ÄLTESTEN Komponente — die
--                  Frischegrenze des Forecasts (Staleness-Gate). NULL bei
--                  Fallback ohne Daten.
--
-- Fail-closed statt falscher Neutralität:
--   Bei Fallback (stale/ill-conditioned/geringe Abdeckung/NaN) ist
--   `forecast_annualized_vol` NULL (nicht 0) und `applied_multiplier`
--   sinkt sofort auf das konfigurierte Minimum (CHECK ≤ 1 — der Faktor
--   kann das Basis-Risikobudget nie überschreiten).
--
-- ── Rollback / Feature-Flag ─────────────────────────────────────────────────
--   1. Feature-Flag: `PORTFOLIO_VOL_TARGETING_MODE=monitor` (Default) oder
--      `=off` deaktiviert die Anwendung sofort; bestehende Zeilen bleiben
--      lesbar (Monitoring-Historie), kein Rollback der Daten nötig.
--   2. Reversible Bereinigung (nur wenn kein v1.67.0-Code mehr läuft):
--      DROP TABLE IF EXISTS "volatility_targeting_snapshots" CASCADE;

-- 1) Append-only Volatility-Targeting-Snapshot-Historie ----------------------
CREATE TABLE IF NOT EXISTS "volatility_targeting_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "snapshot_id" text NOT NULL,
  "mode" text NOT NULL,
  "monitor_only" boolean NOT NULL,
  "status" text NOT NULL,
  "reason_code" text NOT NULL,
  "reason" text NOT NULL,
  "as_of" timestamptz NOT NULL,
  "computed_at" timestamptz NOT NULL,
  "event_time" timestamptz,
  "target_annualized_vol" numeric NOT NULL,
  "forecast_annualized_vol" numeric,
  "realized_annualized_vol" numeric,
  "target_error" numeric,
  "raw_multiplier" numeric,
  "prev_multiplier" numeric NOT NULL,
  "applied_multiplier" numeric NOT NULL,
  "coverage" numeric NOT NULL,
  "observations" integer NOT NULL,
  "annualization" numeric NOT NULL,
  "shrinkage" numeric NOT NULL,
  "regularization" text NOT NULL,
  "weights" jsonb NOT NULL,
  "config_hash" text NOT NULL,
  "data_hash" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

-- 2) Idempotente Indizes ------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS "volatility_targeting_snapshots_id_unique"
  ON "volatility_targeting_snapshots" ("snapshot_id");

CREATE INDEX IF NOT EXISTS "volatility_targeting_snapshots_asof_idx"
  ON "volatility_targeting_snapshots" ("as_of");

CREATE INDEX IF NOT EXISTS "volatility_targeting_snapshots_status_idx"
  ON "volatility_targeting_snapshots" ("status");

CREATE INDEX IF NOT EXISTS "volatility_targeting_snapshots_mode_idx"
  ON "volatility_targeting_snapshots" ("mode");

-- 3) Idempotente CHECK-Constraints --------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'volatility_targeting_snapshots_mode_check') THEN
    ALTER TABLE "volatility_targeting_snapshots" ADD CONSTRAINT "volatility_targeting_snapshots_mode_check"
      CHECK ("mode" IN ('monitor','active'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'volatility_targeting_snapshots_monitor_only_check') THEN
    ALTER TABLE "volatility_targeting_snapshots" ADD CONSTRAINT "volatility_targeting_snapshots_monitor_only_check"
      CHECK ("monitor_only" = ("mode" = 'monitor'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'volatility_targeting_snapshots_status_check') THEN
    ALTER TABLE "volatility_targeting_snapshots" ADD CONSTRAINT "volatility_targeting_snapshots_status_check"
      CHECK ("status" IN ('OK','FALLBACK','NO_EXPOSURE'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'volatility_targeting_snapshots_time_check') THEN
    ALTER TABLE "volatility_targeting_snapshots" ADD CONSTRAINT "volatility_targeting_snapshots_time_check"
      CHECK ("computed_at" >= "as_of");
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'volatility_targeting_snapshots_multiplier_check') THEN
    ALTER TABLE "volatility_targeting_snapshots" ADD CONSTRAINT "volatility_targeting_snapshots_multiplier_check"
      CHECK ("applied_multiplier" > 0 AND "applied_multiplier" <= 1);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'volatility_targeting_snapshots_raw_multiplier_check') THEN
    ALTER TABLE "volatility_targeting_snapshots" ADD CONSTRAINT "volatility_targeting_snapshots_raw_multiplier_check"
      CHECK ("raw_multiplier" IS NULL OR "raw_multiplier" > 0);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'volatility_targeting_snapshots_prev_multiplier_check') THEN
    ALTER TABLE "volatility_targeting_snapshots" ADD CONSTRAINT "volatility_targeting_snapshots_prev_multiplier_check"
      CHECK ("prev_multiplier" > 0 AND "prev_multiplier" <= 1);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'volatility_targeting_snapshots_coverage_check') THEN
    ALTER TABLE "volatility_targeting_snapshots" ADD CONSTRAINT "volatility_targeting_snapshots_coverage_check"
      CHECK ("coverage" >= 0 AND "coverage" <= 1);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'volatility_targeting_snapshots_observations_check') THEN
    ALTER TABLE "volatility_targeting_snapshots" ADD CONSTRAINT "volatility_targeting_snapshots_observations_check"
      CHECK ("observations" >= 0);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'volatility_targeting_snapshots_regularization_check') THEN
    ALTER TABLE "volatility_targeting_snapshots" ADD CONSTRAINT "volatility_targeting_snapshots_regularization_check"
      CHECK ("regularization" IN ('none','ridge','skipped'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'volatility_targeting_snapshots_snapshot_id_check') THEN
    ALTER TABLE "volatility_targeting_snapshots" ADD CONSTRAINT "volatility_targeting_snapshots_snapshot_id_check"
      CHECK ("snapshot_id" ~ '^vt1:[0-9a-f]{64}$');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'volatility_targeting_snapshots_config_hash_check') THEN
    ALTER TABLE "volatility_targeting_snapshots" ADD CONSTRAINT "volatility_targeting_snapshots_config_hash_check"
      CHECK ("config_hash" ~ '^cfg1:[0-9a-f]{64}$');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'volatility_targeting_snapshots_data_hash_check') THEN
    ALTER TABLE "volatility_targeting_snapshots" ADD CONSTRAINT "volatility_targeting_snapshots_data_hash_check"
      CHECK ("data_hash" ~ '^data1:[0-9a-f]{64}$');
  END IF;
END $$;
