-- RMA-P5-05 (v1.69.0) — versionierte Signal-Decay-Exits.
-- Append-only: neue Spalten auf positions, eine neue Tabelle, Trigger.
-- Keine bestehende Migration wird umgeschrieben. Kein Backfill: Altzeilen
-- bleiben ohne Entry-Snapshot (MISSING, kein stilles 0, kein Exit).
--
-- Äquivalent zu `npx drizzle-kit push` aus `src/db/schema.ts`
-- (`positions.entry_signal` … + `signal_decay_events`); diese Datei ist der
-- idempotente SQL-Pfad:
--   psql "$DATABASE_URL" -f drizzle/2026-09-22_signal_decay.sql
--
-- Zeitsemantik der Event-Tabelle:
--   calculated_as_of  Feature-Berechnungszeit (Close der verwendeten Kerze)
--   available_at      Verfügbarkeit; CHECK ≤ as_of (kein Look-ahead in der Zeile)
--   as_of             Entscheidungszeit
--   computed_at       Schreibzeit, CHECK ≥ as_of
--
-- Rollback / Feature-Flag:
--   1. SIGNAL_DECAY_MODE=off  oder Klassen-Flags aus (Default) — kein Exit,
--      keine neuen Events. Bestehende Zeilen bleiben lesbar.
--   2. SIGNAL_DECAY_MODE=monitor — Counterfactual, kein Close.
--   3. Reversible Bereinigung NUR wenn kein v1.69.0-Code mehr läuft:
--        DROP TRIGGER IF EXISTS positions_entry_signal_immutable ON positions;
--        DROP TRIGGER IF EXISTS signal_decay_events_immutable ON signal_decay_events;
--        DROP TABLE IF EXISTS signal_decay_events;
--        ALTER TABLE positions DROP COLUMN IF EXISTS entry_signal,
--          DROP COLUMN IF EXISTS entry_signal_hash,
--          DROP COLUMN IF EXISTS signal_decay_streak,
--          DROP COLUMN IF EXISTS signal_decay_last_key,
--          DROP COLUMN IF EXISTS signal_decay_policy_version,
--          DROP COLUMN IF EXISTS strategy_class;
--      Der erweiterte backtest_trades-Check darf SIGNAL_DECAY enthalten
--      bleiben (additiv, bestehende Gründe unverändert).

-- 1) Positions-Spalten (verhaltensneutral: Defaults / NULL) -------------------
ALTER TABLE "positions" ADD COLUMN IF NOT EXISTS "entry_signal" jsonb;
ALTER TABLE "positions" ADD COLUMN IF NOT EXISTS "entry_signal_hash" text;
ALTER TABLE "positions" ADD COLUMN IF NOT EXISTS "signal_decay_streak" integer NOT NULL DEFAULT 0;
ALTER TABLE "positions" ADD COLUMN IF NOT EXISTS "signal_decay_last_key" text;
ALTER TABLE "positions" ADD COLUMN IF NOT EXISTS "signal_decay_policy_version" text;
ALTER TABLE "positions" ADD COLUMN IF NOT EXISTS "strategy_class" text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'positions_signal_decay_streak_check') THEN
    ALTER TABLE "positions" ADD CONSTRAINT "positions_signal_decay_streak_check"
      CHECK ("signal_decay_streak" >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'positions_strategy_class_check') THEN
    ALTER TABLE "positions" ADD CONSTRAINT "positions_strategy_class_check"
      CHECK ("strategy_class" IS NULL OR "strategy_class" IN ('mean-reversion', 'trend', 'breakout', 'unclassified'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'positions_entry_signal_hash_check') THEN
    ALTER TABLE "positions" ADD CONSTRAINT "positions_entry_signal_hash_check"
      CHECK ("entry_signal_hash" IS NULL OR "entry_signal_hash" ~ '^sig1:[0-9a-f]{64}$');
  END IF;
END $$;

-- Entry-Snapshot ist nach dem ersten Schreiben unveränderlich.
CREATE OR REPLACE FUNCTION positions_entry_signal_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.entry_signal IS NOT NULL AND NEW.entry_signal IS DISTINCT FROM OLD.entry_signal THEN
    RAISE EXCEPTION 'entry_signal is immutable once set';
  END IF;
  IF OLD.entry_signal_hash IS NOT NULL AND NEW.entry_signal_hash IS DISTINCT FROM OLD.entry_signal_hash THEN
    RAISE EXCEPTION 'entry_signal_hash is immutable once set';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS positions_entry_signal_immutable ON "positions";
CREATE TRIGGER positions_entry_signal_immutable
  BEFORE UPDATE ON "positions"
  FOR EACH ROW
  EXECUTE FUNCTION positions_entry_signal_immutable();

-- 2) Append-only Event-Tabelle ------------------------------------------------
CREATE TABLE IF NOT EXISTS "signal_decay_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "event_id" text NOT NULL,
  "position_id" uuid NOT NULL REFERENCES "positions"("id"),
  "strategy_class" text NOT NULL,
  "mode" text NOT NULL,
  "outcome" text NOT NULL,
  "policy_version" text NOT NULL,
  "policy_reason" text NOT NULL,
  "entry_strength" numeric,
  "current_strength" numeric,
  "entry_confidence" numeric,
  "current_confidence" numeric,
  "entry_direction" text,
  "current_direction" text,
  "coverage" numeric,
  "semantics_version" text,
  "feature_version" text,
  "model_version" text,
  "config_version" text,
  "migration_id" text,
  "confirm_streak" integer NOT NULL,
  "confirmation_required" integer NOT NULL,
  "counterfactual_pnl" numeric,
  "as_of" timestamptz NOT NULL,
  "available_at" timestamptz,
  "calculated_as_of" timestamptz,
  "computed_at" timestamptz NOT NULL,
  "entry_signal_hash" text,
  "observation_key" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "signal_decay_events_event_id_unique"
  ON "signal_decay_events" ("event_id");
CREATE INDEX IF NOT EXISTS "signal_decay_events_position_asof_idx"
  ON "signal_decay_events" ("position_id", "as_of");
CREATE INDEX IF NOT EXISTS "signal_decay_events_outcome_asof_idx"
  ON "signal_decay_events" ("outcome", "as_of");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'signal_decay_events_mode_check') THEN
    ALTER TABLE "signal_decay_events" ADD CONSTRAINT "signal_decay_events_mode_check"
      CHECK ("mode" IN ('monitor', 'active'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'signal_decay_events_outcome_check') THEN
    ALTER TABLE "signal_decay_events" ADD CONSTRAINT "signal_decay_events_outcome_check"
      CHECK ("outcome" IN (
        'MISSING_ENTRY', 'MISSING_CURRENT', 'STALE', 'INCOMPATIBLE', 'INVALID', 'FUTURE',
        'LOW_COVERAGE', 'MIN_HOLD', 'HOLD', 'CONFIRMING', 'WOULD_EXIT', 'EXIT', 'SUPPRESSED_KILL_SWITCH'
      ));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'signal_decay_events_class_check') THEN
    ALTER TABLE "signal_decay_events" ADD CONSTRAINT "signal_decay_events_class_check"
      CHECK ("strategy_class" IN ('mean-reversion', 'trend', 'breakout', 'unclassified'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'signal_decay_events_streak_check') THEN
    ALTER TABLE "signal_decay_events" ADD CONSTRAINT "signal_decay_events_streak_check"
      CHECK ("confirm_streak" >= 0 AND "confirmation_required" >= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'signal_decay_events_coverage_check') THEN
    ALTER TABLE "signal_decay_events" ADD CONSTRAINT "signal_decay_events_coverage_check"
      CHECK ("coverage" IS NULL OR ("coverage" >= 0 AND "coverage" <= 1));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'signal_decay_events_strength_check') THEN
    ALTER TABLE "signal_decay_events" ADD CONSTRAINT "signal_decay_events_strength_check"
      CHECK (
        ("entry_strength" IS NULL OR ("entry_strength" >= 0 AND "entry_strength" <= 1))
        AND ("current_strength" IS NULL OR ("current_strength" >= 0 AND "current_strength" <= 1))
        AND ("entry_confidence" IS NULL OR ("entry_confidence" >= 0 AND "entry_confidence" <= 1))
        AND ("current_confidence" IS NULL OR ("current_confidence" >= 0 AND "current_confidence" <= 1))
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'signal_decay_events_time_check') THEN
    ALTER TABLE "signal_decay_events" ADD CONSTRAINT "signal_decay_events_time_check"
      CHECK ("computed_at" >= "as_of");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'signal_decay_events_available_check') THEN
    ALTER TABLE "signal_decay_events" ADD CONSTRAINT "signal_decay_events_available_check"
      CHECK ("available_at" IS NULL OR "available_at" <= "as_of");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'signal_decay_events_calculated_check') THEN
    ALTER TABLE "signal_decay_events" ADD CONSTRAINT "signal_decay_events_calculated_check"
      CHECK ("calculated_as_of" IS NULL OR "available_at" IS NULL OR "calculated_as_of" <= "available_at");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'signal_decay_events_event_id_check') THEN
    ALTER TABLE "signal_decay_events" ADD CONSTRAINT "signal_decay_events_event_id_check"
      CHECK ("event_id" ~ '^sde1:[0-9a-f]{64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'signal_decay_events_policy_check') THEN
    ALTER TABLE "signal_decay_events" ADD CONSTRAINT "signal_decay_events_policy_check"
      CHECK ("policy_version" ~ '^sdp1:[0-9a-f]{64}$');
  END IF;
END $$;

CREATE OR REPLACE FUNCTION signal_decay_events_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'signal_decay_events is append-only';
END;
$$;

DROP TRIGGER IF EXISTS signal_decay_events_immutable ON "signal_decay_events";
CREATE TRIGGER signal_decay_events_immutable
  BEFORE UPDATE OR DELETE ON "signal_decay_events"
  FOR EACH ROW
  EXECUTE FUNCTION signal_decay_events_immutable();

DROP TRIGGER IF EXISTS signal_decay_events_no_truncate ON "signal_decay_events";
CREATE TRIGGER signal_decay_events_no_truncate
  BEFORE TRUNCATE ON "signal_decay_events"
  FOR EACH STATEMENT
  EXECUTE FUNCTION signal_decay_events_immutable();

-- 3) Backtest-Exitgrund additiv um SIGNAL_DECAY erweitern --------------------
-- Bestehende Gründe bleiben erlaubt. Nur ausführen, wenn die Tabelle existiert.
DO $$
BEGIN
  IF to_regclass('public.backtest_trades') IS NOT NULL THEN
    ALTER TABLE "backtest_trades" DROP CONSTRAINT IF EXISTS "backtest_trades_exit_reason_check";
    ALTER TABLE "backtest_trades" ADD CONSTRAINT "backtest_trades_exit_reason_check"
      CHECK ("exit_reason" IN (
        'STOP_LOSS', 'TAKE_PROFIT', 'SIGNAL_EXIT', 'MAX_HOLDING', 'RISK_STOP', 'END_OF_DATA', 'SIGNAL_DECAY'
      ));
  END IF;
END $$;
