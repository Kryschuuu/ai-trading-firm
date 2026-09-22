-- RMA-P4-02 (v1.70.0) — Post-Only-/Timeout-/Market-Fallback-State-Machine.
-- Append-only: drei neue Tabellen, keine Änderung bestehender Objekte.
-- Kein Backfill (neue Domäne ohne Altbestand).
--
-- Äquivalent zu `npx drizzle-kit push` aus `src/db/schema.ts`
-- (`execution_workflows`, `execution_workflow_events`, `execution_workflow_fills`);
-- diese Datei ist der idempotente SQL-Pfad:
--   psql "$DATABASE_URL" -f drizzle/2026-09-22_post_only_fallback.sql
--
-- Zeitsemantik:
--   Events: event_time (Ereignis) ≤ available_at (Bekanntheit) ≤ computed_at
--     (Persistenz) — CHECK-Constraints; Fills: event_time ≤ available_at.
--
-- Rollback / Feature-Flag:
--   1. Der Controller läuft nur auf expliziten Aufruf (API/Job mit
--      EXECUTION_POLICY_ENABLED=true); Default false — kein Verhalten ändert
--      sich ohne Opt-in. Bestehende Paper-/Backtest-Pfade bleiben unberührt.
--   2. Reversible Bereinigung NUR wenn kein v1.70.0-Code mehr läuft:
--        DROP TABLE IF EXISTS execution_workflow_fills;
--        DROP TABLE IF EXISTS execution_workflow_events;
--        DROP TABLE IF EXISTS execution_workflows;

-- 1) Workflows ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "execution_workflows" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workflow_key" text NOT NULL,
  "venue" text NOT NULL,
  "mode" text NOT NULL,
  "symbol" text NOT NULL,
  "side" text NOT NULL,
  "target_qty" numeric NOT NULL,
  "filled_qty" numeric NOT NULL DEFAULT '0',
  "fee_quote_total" numeric,
  "state" text NOT NULL DEFAULT 'NEW',
  "version" integer NOT NULL DEFAULT 1,
  "policy_version" text NOT NULL,
  "policy_json" jsonb NOT NULL,
  "attempt" integer NOT NULL DEFAULT 0,
  "reprices_used" integer NOT NULL DEFAULT 0,
  "cancel_attempts" integer NOT NULL DEFAULT 0,
  "client_order_base" text NOT NULL,
  "has_stop_loss" boolean NOT NULL DEFAULT false,
  "active_order_id" text,
  "active_client_order_id" text,
  "fallback_order_id" text,
  "fallback_client_order_id" text,
  "limit_price" numeric,
  "submitted_at" timestamptz,
  "ack_at" timestamptz,
  "cancel_requested_at" timestamptz,
  "cancel_confirmed_at" timestamptz,
  "error_code" text,
  "reason" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "execution_workflows_key_unique" ON "execution_workflows" ("workflow_key");
CREATE INDEX IF NOT EXISTS "execution_workflows_updated_idx" ON "execution_workflows" ("updated_at");
CREATE INDEX IF NOT EXISTS "execution_workflows_state_idx" ON "execution_workflows" ("state");
CREATE INDEX IF NOT EXISTS "execution_workflows_open_idx" ON "execution_workflows" ("venue", "symbol")
  WHERE "state" NOT IN ('DONE', 'FAILED');

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_workflows_mode_check') THEN
    ALTER TABLE "execution_workflows" ADD CONSTRAINT "execution_workflows_mode_check"
      CHECK ("mode" IN ('backtest', 'paper', 'testnet', 'live'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_workflows_side_check') THEN
    ALTER TABLE "execution_workflows" ADD CONSTRAINT "execution_workflows_side_check"
      CHECK ("side" IN ('LONG', 'SHORT'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_workflows_state_check') THEN
    ALTER TABLE "execution_workflows" ADD CONSTRAINT "execution_workflows_state_check"
      CHECK ("state" IN ('NEW', 'SUBMITTED', 'ACK', 'PARTIAL', 'CANCEL_PENDING', 'CANCELLED', 'FALLBACK_SUBMITTED', 'DONE', 'REJECTED', 'FAILED'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_workflows_target_check') THEN
    ALTER TABLE "execution_workflows" ADD CONSTRAINT "execution_workflows_target_check" CHECK ("target_qty" > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_workflows_filled_check') THEN
    ALTER TABLE "execution_workflows" ADD CONSTRAINT "execution_workflows_filled_check"
      CHECK ("filled_qty" >= 0 AND "filled_qty" <= "target_qty" + 0.000000001);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_workflows_fee_check') THEN
    ALTER TABLE "execution_workflows" ADD CONSTRAINT "execution_workflows_fee_check"
      CHECK ("fee_quote_total" IS NULL OR "fee_quote_total" >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_workflows_version_check') THEN
    ALTER TABLE "execution_workflows" ADD CONSTRAINT "execution_workflows_version_check" CHECK ("version" >= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_workflows_attempt_check') THEN
    ALTER TABLE "execution_workflows" ADD CONSTRAINT "execution_workflows_attempt_check" CHECK ("attempt" >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_workflows_reprices_check') THEN
    ALTER TABLE "execution_workflows" ADD CONSTRAINT "execution_workflows_reprices_check" CHECK ("reprices_used" >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_workflows_cancel_attempts_check') THEN
    ALTER TABLE "execution_workflows" ADD CONSTRAINT "execution_workflows_cancel_attempts_check" CHECK ("cancel_attempts" >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_workflows_limit_check') THEN
    ALTER TABLE "execution_workflows" ADD CONSTRAINT "execution_workflows_limit_check"
      CHECK ("limit_price" IS NULL OR "limit_price" > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_workflows_key_check') THEN
    ALTER TABLE "execution_workflows" ADD CONSTRAINT "execution_workflows_key_check"
      CHECK ("workflow_key" ~ '^eow1:[0-9a-f]{64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_workflows_policy_check') THEN
    ALTER TABLE "execution_workflows" ADD CONSTRAINT "execution_workflows_policy_check"
      CHECK ("policy_version" ~ '^eop1:[0-9a-f]{64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_workflows_venue_check') THEN
    ALTER TABLE "execution_workflows" ADD CONSTRAINT "execution_workflows_venue_check"
      CHECK ("venue" IN ('PAPER', 'ALPACA', 'IBKR', 'BINANCE', 'KRAKEN', 'DYDX', 'BITUNIX'));
  END IF;
END $$;

-- 2) Events (append-only) ----------------------------------------------------
CREATE TABLE IF NOT EXISTS "execution_workflow_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workflow_id" uuid NOT NULL REFERENCES "execution_workflows" ("id"),
  "seq" integer NOT NULL,
  "event_id" text NOT NULL,
  "from_state" text,
  "to_state" text NOT NULL,
  "reason" text NOT NULL,
  "policy_version" text NOT NULL,
  "order_id" text,
  "client_order_id" text,
  "filled_qty_delta" numeric,
  "filled_qty_total" numeric,
  "fee_delta" numeric,
  "quote_mid" numeric,
  "spread_bps" numeric,
  "event_time" timestamptz NOT NULL,
  "available_at" timestamptz NOT NULL,
  "computed_at" timestamptz NOT NULL,
  "detail" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "execution_workflow_events_workflow_seq_unique"
  ON "execution_workflow_events" ("workflow_id", "seq");
CREATE UNIQUE INDEX IF NOT EXISTS "execution_workflow_events_event_id_unique"
  ON "execution_workflow_events" ("event_id");
CREATE INDEX IF NOT EXISTS "execution_workflow_events_workflow_idx"
  ON "execution_workflow_events" ("workflow_id", "seq");
CREATE INDEX IF NOT EXISTS "execution_workflow_events_reason_idx"
  ON "execution_workflow_events" ("reason");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_workflow_events_seq_check') THEN
    ALTER TABLE "execution_workflow_events" ADD CONSTRAINT "execution_workflow_events_seq_check" CHECK ("seq" >= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_workflow_events_to_state_check') THEN
    ALTER TABLE "execution_workflow_events" ADD CONSTRAINT "execution_workflow_events_to_state_check"
      CHECK ("to_state" IN ('NEW', 'SUBMITTED', 'ACK', 'PARTIAL', 'CANCEL_PENDING', 'CANCELLED', 'FALLBACK_SUBMITTED', 'DONE', 'REJECTED', 'FAILED'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_workflow_events_from_state_check') THEN
    ALTER TABLE "execution_workflow_events" ADD CONSTRAINT "execution_workflow_events_from_state_check"
      CHECK ("from_state" IS NULL OR "from_state" IN ('NEW', 'SUBMITTED', 'ACK', 'PARTIAL', 'CANCEL_PENDING', 'CANCELLED', 'FALLBACK_SUBMITTED', 'DONE', 'REJECTED', 'FAILED'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_workflow_events_time_check') THEN
    ALTER TABLE "execution_workflow_events" ADD CONSTRAINT "execution_workflow_events_time_check"
      CHECK ("available_at" >= "event_time" AND "computed_at" >= "available_at");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_workflow_events_event_id_check') THEN
    ALTER TABLE "execution_workflow_events" ADD CONSTRAINT "execution_workflow_events_event_id_check"
      CHECK ("event_id" ~ '^eoe1:[0-9a-f]{64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_workflow_events_policy_check') THEN
    ALTER TABLE "execution_workflow_events" ADD CONSTRAINT "execution_workflow_events_policy_check"
      CHECK ("policy_version" ~ '^eop1:[0-9a-f]{64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_workflow_events_reason_check') THEN
    ALTER TABLE "execution_workflow_events" ADD CONSTRAINT "execution_workflow_events_reason_check"
      CHECK (length("reason") > 0 AND length("reason") <= 64);
  END IF;
END $$;

-- 3) Fills -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "execution_workflow_fills" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workflow_id" uuid NOT NULL REFERENCES "execution_workflows" ("id"),
  "fill_id" text NOT NULL,
  "order_id" text NOT NULL,
  "qty" numeric NOT NULL,
  "price" numeric NOT NULL,
  "fee_quote" numeric,
  "event_time" timestamptz NOT NULL,
  "available_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "execution_workflow_fills_workflow_fill_unique"
  ON "execution_workflow_fills" ("workflow_id", "fill_id");
CREATE INDEX IF NOT EXISTS "execution_workflow_fills_workflow_idx"
  ON "execution_workflow_fills" ("workflow_id", "event_time");
CREATE INDEX IF NOT EXISTS "execution_workflow_fills_order_idx"
  ON "execution_workflow_fills" ("order_id");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_workflow_fills_qty_check') THEN
    ALTER TABLE "execution_workflow_fills" ADD CONSTRAINT "execution_workflow_fills_qty_check" CHECK ("qty" > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_workflow_fills_price_check') THEN
    ALTER TABLE "execution_workflow_fills" ADD CONSTRAINT "execution_workflow_fills_price_check" CHECK ("price" > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_workflow_fills_fee_check') THEN
    ALTER TABLE "execution_workflow_fills" ADD CONSTRAINT "execution_workflow_fills_fee_check"
      CHECK ("fee_quote" IS NULL OR "fee_quote" >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_workflow_fills_time_check') THEN
    ALTER TABLE "execution_workflow_fills" ADD CONSTRAINT "execution_workflow_fills_time_check"
      CHECK ("available_at" >= "event_time");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_workflow_fills_fill_id_check') THEN
    ALTER TABLE "execution_workflow_fills" ADD CONSTRAINT "execution_workflow_fills_fill_id_check"
      CHECK (length("fill_id") > 0 AND length("fill_id") <= 128);
  END IF;
END $$;
