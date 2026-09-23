-- RMA-P4-03 (v1.71.0) — TWAP- und Depth-aware Execution.
-- Append-only: vier neue Tabellen, keine Änderung bestehender Objekte.
-- Kein Backfill (neue Domäne ohne Altbestand). Kein FK-CASCADE.
--
-- Äquivalent zu `npx drizzle-kit push` aus `src/db/schema.ts`
-- (`execution_twap_parents|slices|events|evaluations`); diese Datei ist der
-- idempotente SQL-Pfad:
--   psql "$DATABASE_URL" -f drizzle/2026-09-23_twap_execution.sql
--
-- Zeitsemantik:
--   start_at / deadline_at / scheduled_at sind Ereigniszeiten (ms-epoch als
--   timestamptz). Events: event_time ≤ available_at ≤ computed_at.
--   arrival_* und depth_qty / impact_bps / participation_cap bleiben NULL,
--   wenn sie nicht gemessen wurden. NULL ist nicht 0 und nicht „unbegrenzt“.
--
-- Rollback / Feature-Flag:
--   1. TWAP_EXECUTION_ENABLED=false (Default) — keine schreibende API, kein
--      Submit. Bestehende Zeilen bleiben lesbar. GET bleibt erlaubt.
--   2. Reversible Bereinigung NUR wenn kein v1.71.0-Code mehr läuft:
--        DROP TRIGGER IF EXISTS execution_twap_events_immutable ON execution_twap_events;
--        DROP TRIGGER IF EXISTS execution_twap_evaluations_immutable ON execution_twap_evaluations;
--        DROP TABLE IF EXISTS execution_twap_evaluations;
--        DROP TABLE IF EXISTS execution_twap_events;
--        DROP TABLE IF EXISTS execution_twap_slices;
--        DROP TABLE IF EXISTS execution_twap_parents;

-- 1) Parents -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "execution_twap_parents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "parent_key" text NOT NULL,
  "venue" text NOT NULL,
  "mode" text NOT NULL,
  "symbol" text NOT NULL,
  "side" text NOT NULL,
  "target_qty" numeric NOT NULL,
  "filled_qty" numeric NOT NULL DEFAULT '0',
  "unscheduled_qty" numeric,
  "start_at" timestamptz NOT NULL,
  "deadline_at" timestamptz NOT NULL,
  "slice_interval_ms" integer NOT NULL,
  "policy_version" text NOT NULL,
  "policy_json" jsonb NOT NULL,
  "jitter_seed" text,
  "status" text NOT NULL DEFAULT 'PLANNED',
  "reason" text,
  "cursor_index" integer NOT NULL DEFAULT 0,
  "plan_version" integer NOT NULL DEFAULT 0,
  "lease_owner" text,
  "lease_token" text,
  "lease_until" timestamptz,
  "version" integer NOT NULL DEFAULT 1,
  "limit_price" numeric,
  "arrival_mid" numeric,
  "arrival_event_time" timestamptz,
  "arrival_available_at" timestamptz,
  "has_stop_loss" boolean NOT NULL DEFAULT false,
  "scope" text NOT NULL DEFAULT 'twap',
  "quote_currency" text NOT NULL DEFAULT 'USD',
  "quantity_step" numeric NOT NULL,
  "price_step" numeric NOT NULL,
  "min_quantity" numeric NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "execution_twap_parents_key_unique" ON "execution_twap_parents" ("parent_key");
CREATE INDEX IF NOT EXISTS "execution_twap_parents_status_idx" ON "execution_twap_parents" ("status", "created_at");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_twap_parents_venue_check') THEN
    ALTER TABLE "execution_twap_parents" ADD CONSTRAINT "execution_twap_parents_venue_check"
      CHECK ("venue" IN ('PAPER', 'ALPACA', 'IBKR', 'BINANCE', 'KRAKEN', 'DYDX', 'BITUNIX'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_twap_parents_mode_check') THEN
    ALTER TABLE "execution_twap_parents" ADD CONSTRAINT "execution_twap_parents_mode_check"
      CHECK ("mode" IN ('backtest', 'paper', 'testnet', 'live'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_twap_parents_side_check') THEN
    ALTER TABLE "execution_twap_parents" ADD CONSTRAINT "execution_twap_parents_side_check"
      CHECK ("side" IN ('LONG', 'SHORT'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_twap_parents_status_check') THEN
    ALTER TABLE "execution_twap_parents" ADD CONSTRAINT "execution_twap_parents_status_check"
      CHECK ("status" IN ('PLANNED', 'RUNNING', 'PAUSED', 'COMPLETED', 'EXPIRED', 'CANCELLED', 'FAILED'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_twap_parents_target_check') THEN
    ALTER TABLE "execution_twap_parents" ADD CONSTRAINT "execution_twap_parents_target_check" CHECK ("target_qty" > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_twap_parents_filled_check') THEN
    ALTER TABLE "execution_twap_parents" ADD CONSTRAINT "execution_twap_parents_filled_check" CHECK ("filled_qty" >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_twap_parents_window_check') THEN
    ALTER TABLE "execution_twap_parents" ADD CONSTRAINT "execution_twap_parents_window_check" CHECK ("deadline_at" > "start_at");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_twap_parents_interval_check') THEN
    ALTER TABLE "execution_twap_parents" ADD CONSTRAINT "execution_twap_parents_interval_check" CHECK ("slice_interval_ms" >= 1000);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_twap_parents_key_check') THEN
    ALTER TABLE "execution_twap_parents" ADD CONSTRAINT "execution_twap_parents_key_check"
      CHECK ("parent_key" ~ '^etp1:[0-9a-f]{64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_twap_parents_policy_check') THEN
    ALTER TABLE "execution_twap_parents" ADD CONSTRAINT "execution_twap_parents_policy_check"
      CHECK ("policy_version" ~ '^etw1:[0-9a-f]{64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_twap_parents_reason_check') THEN
    ALTER TABLE "execution_twap_parents" ADD CONSTRAINT "execution_twap_parents_reason_check"
      CHECK ("reason" IS NULL OR length("reason") BETWEEN 1 AND 64);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_twap_parents_steps_check') THEN
    ALTER TABLE "execution_twap_parents" ADD CONSTRAINT "execution_twap_parents_steps_check"
      CHECK ("quantity_step" > 0 AND "price_step" > 0 AND "min_quantity" > 0);
  END IF;
END $$;

-- 2) Slices ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "execution_twap_slices" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "parent_id" uuid NOT NULL REFERENCES "execution_twap_parents" ("id"),
  "slice_index" integer NOT NULL,
  "child_key" text NOT NULL,
  "plan_version" integer NOT NULL,
  "target_qty" numeric NOT NULL,
  "filled_qty" numeric NOT NULL DEFAULT '0',
  "scheduled_at" timestamptz NOT NULL,
  "status" text NOT NULL DEFAULT 'PENDING',
  "submit_claim" text,
  "claimed_at" timestamptz,
  "qty_frozen" boolean NOT NULL DEFAULT false,
  "workflow_key" text,
  "workflow_id" text,
  "limit_price" numeric,
  "skip_reason" text,
  "depth_qty" numeric,
  "impact_bps" numeric,
  "participation_cap" numeric,
  "version" integer NOT NULL DEFAULT 1,
  "submitted_at" timestamptz,
  "completed_at" timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS "execution_twap_slices_parent_index_unique" ON "execution_twap_slices" ("parent_id", "slice_index");
CREATE UNIQUE INDEX IF NOT EXISTS "execution_twap_slices_child_key_unique" ON "execution_twap_slices" ("child_key");
CREATE INDEX IF NOT EXISTS "execution_twap_slices_parent_idx" ON "execution_twap_slices" ("parent_id", "status");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_twap_slices_index_check') THEN
    ALTER TABLE "execution_twap_slices" ADD CONSTRAINT "execution_twap_slices_index_check" CHECK ("slice_index" >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_twap_slices_qty_check') THEN
    ALTER TABLE "execution_twap_slices" ADD CONSTRAINT "execution_twap_slices_qty_check" CHECK ("target_qty" > 0 AND "filled_qty" >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_twap_slices_status_check') THEN
    ALTER TABLE "execution_twap_slices" ADD CONSTRAINT "execution_twap_slices_status_check"
      CHECK ("status" IN ('PENDING', 'SUBMITTED', 'PARTIAL', 'DONE', 'SKIPPED', 'CANCELLED'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_twap_slices_child_key_check') THEN
    ALTER TABLE "execution_twap_slices" ADD CONSTRAINT "execution_twap_slices_child_key_check"
      CHECK ("child_key" ~ '^etc1:[0-9a-f]{64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_twap_slices_reason_check') THEN
    ALTER TABLE "execution_twap_slices" ADD CONSTRAINT "execution_twap_slices_reason_check"
      CHECK ("skip_reason" IS NULL OR length("skip_reason") BETWEEN 1 AND 64);
  END IF;
END $$;

-- 3) Events (append-only) ----------------------------------------------------
CREATE TABLE IF NOT EXISTS "execution_twap_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "parent_id" uuid NOT NULL REFERENCES "execution_twap_parents" ("id"),
  "slice_id" uuid REFERENCES "execution_twap_slices" ("id"),
  "seq" integer NOT NULL,
  "event_id" text NOT NULL,
  "kind" text NOT NULL,
  "reason" text NOT NULL,
  "from_status" text,
  "to_status" text,
  "detail" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "event_time" timestamptz NOT NULL,
  "available_at" timestamptz NOT NULL,
  "computed_at" timestamptz NOT NULL,
  "policy_version" text NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "execution_twap_events_id_unique" ON "execution_twap_events" ("event_id");
CREATE UNIQUE INDEX IF NOT EXISTS "execution_twap_events_parent_seq_unique" ON "execution_twap_events" ("parent_id", "seq");
CREATE INDEX IF NOT EXISTS "execution_twap_events_parent_idx" ON "execution_twap_events" ("parent_id", "seq");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_twap_events_seq_check') THEN
    ALTER TABLE "execution_twap_events" ADD CONSTRAINT "execution_twap_events_seq_check" CHECK ("seq" >= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_twap_events_id_check') THEN
    ALTER TABLE "execution_twap_events" ADD CONSTRAINT "execution_twap_events_id_check"
      CHECK ("event_id" ~ '^ete1:[0-9a-f]{64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_twap_events_policy_check') THEN
    ALTER TABLE "execution_twap_events" ADD CONSTRAINT "execution_twap_events_policy_check"
      CHECK ("policy_version" ~ '^etw1:[0-9a-f]{64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_twap_events_reason_check') THEN
    ALTER TABLE "execution_twap_events" ADD CONSTRAINT "execution_twap_events_reason_check"
      CHECK (length("reason") BETWEEN 1 AND 64);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_twap_events_kind_check') THEN
    ALTER TABLE "execution_twap_events" ADD CONSTRAINT "execution_twap_events_kind_check"
      CHECK (length("kind") BETWEEN 1 AND 32);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_twap_events_time_check') THEN
    ALTER TABLE "execution_twap_events" ADD CONSTRAINT "execution_twap_events_time_check"
      CHECK ("available_at" >= "event_time" AND "computed_at" >= "available_at");
  END IF;
END $$;

CREATE OR REPLACE FUNCTION execution_twap_events_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'execution_twap_events is append-only';
END;
$$;

DROP TRIGGER IF EXISTS execution_twap_events_immutable ON "execution_twap_events";
CREATE TRIGGER execution_twap_events_immutable
  BEFORE UPDATE OR DELETE ON "execution_twap_events"
  FOR EACH ROW
  EXECUTE FUNCTION execution_twap_events_immutable();

DROP TRIGGER IF EXISTS execution_twap_events_no_truncate ON "execution_twap_events";
CREATE TRIGGER execution_twap_events_no_truncate
  BEFORE TRUNCATE ON "execution_twap_events"
  FOR EACH STATEMENT
  EXECUTE FUNCTION execution_twap_events_immutable();

-- 4) Evaluations (append-only) ----------------------------------------------
CREATE TABLE IF NOT EXISTS "execution_twap_evaluations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "parent_id" uuid NOT NULL REFERENCES "execution_twap_parents" ("id"),
  "eval_key" text NOT NULL,
  "as_of" timestamptz NOT NULL,
  "computed_at" timestamptz NOT NULL,
  "completion" numeric,
  "duration_ms" integer,
  "coverage" numeric,
  "twap_shortfall_bps" numeric,
  "immediate_shortfall_bps" numeric,
  "shortfall_vs_immediate_bps" numeric,
  "arrival_price" numeric,
  "twap_vwap" numeric,
  "immediate_vwap" numeric,
  "filled_qty" numeric NOT NULL,
  "target_qty" numeric NOT NULL,
  "reason" text NOT NULL,
  "detail" jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS "execution_twap_evaluations_key_unique" ON "execution_twap_evaluations" ("eval_key");
CREATE INDEX IF NOT EXISTS "execution_twap_evaluations_parent_idx" ON "execution_twap_evaluations" ("parent_id", "computed_at");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_twap_evaluations_key_check') THEN
    ALTER TABLE "execution_twap_evaluations" ADD CONSTRAINT "execution_twap_evaluations_key_check"
      CHECK ("eval_key" ~ '^etv1:[0-9a-f]{64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_twap_evaluations_reason_check') THEN
    ALTER TABLE "execution_twap_evaluations" ADD CONSTRAINT "execution_twap_evaluations_reason_check"
      CHECK (length("reason") BETWEEN 1 AND 64);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_twap_evaluations_qty_check') THEN
    ALTER TABLE "execution_twap_evaluations" ADD CONSTRAINT "execution_twap_evaluations_qty_check"
      CHECK ("filled_qty" >= 0 AND "target_qty" > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_twap_evaluations_time_check') THEN
    ALTER TABLE "execution_twap_evaluations" ADD CONSTRAINT "execution_twap_evaluations_time_check"
      CHECK ("computed_at" >= "as_of");
  END IF;
END $$;

CREATE OR REPLACE FUNCTION execution_twap_evaluations_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'execution_twap_evaluations is append-only';
END;
$$;

DROP TRIGGER IF EXISTS execution_twap_evaluations_immutable ON "execution_twap_evaluations";
CREATE TRIGGER execution_twap_evaluations_immutable
  BEFORE UPDATE OR DELETE ON "execution_twap_evaluations"
  FOR EACH ROW
  EXECUTE FUNCTION execution_twap_evaluations_immutable();

DROP TRIGGER IF EXISTS execution_twap_evaluations_no_truncate ON "execution_twap_evaluations";
CREATE TRIGGER execution_twap_evaluations_no_truncate
  BEFORE TRUNCATE ON "execution_twap_evaluations"
  FOR EACH STATEMENT
  EXECUTE FUNCTION execution_twap_evaluations_immutable();
