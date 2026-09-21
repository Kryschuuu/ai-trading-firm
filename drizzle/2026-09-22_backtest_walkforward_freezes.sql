-- RMA-P1-02 (v1.60.0) — append-only immutable train/select/freeze evidence.
--
-- One row per completed walk-forward window plus one final-decision row. The
-- artifact is bounded by the candidate/score-table contracts in
-- src/backtest/walkforwardTraining.ts. No provider payload, secret or PII is
-- stored. Existing migrations are intentionally not modified.
--
-- Deployment: apply after 2026-09-20_backtest_trades.sql (or use
-- `npx drizzle-kit push`). Rollback is feature-gated: stop new training runs,
-- retain backtest_runs/backtest_trades, then DROP TABLE this table only. The
-- run/report remains readable but freeze evidence is unavailable (fail-closed,
-- never interpreted as a successful selection).

CREATE TABLE IF NOT EXISTS "backtest_walkforward_freezes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "run_id" uuid NOT NULL REFERENCES "backtest_runs"("id"),
  "freeze_key" text NOT NULL,
  "phase" text NOT NULL,
  "window_index" integer,
  "selected_candidate_id" text NOT NULL,
  "freeze_hash" text NOT NULL,
  "artifact_json" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "backtest_walkforward_freezes_phase_check"
    CHECK ("phase" IN ('window', 'final-decision')),
  CONSTRAINT "backtest_walkforward_freezes_window_check"
    CHECK (("phase" = 'final-decision' AND "window_index" IS NULL)
      OR ("phase" = 'window' AND "window_index" >= 0)),
  CONSTRAINT "backtest_walkforward_freezes_hash_check"
    CHECK ("freeze_hash" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS "backtest_walkforward_freezes_key_unique"
  ON "backtest_walkforward_freezes" ("freeze_key");

CREATE UNIQUE INDEX IF NOT EXISTS "backtest_walkforward_freezes_run_phase_window_unique"
  ON "backtest_walkforward_freezes" ("run_id", "phase", "window_index");

CREATE INDEX IF NOT EXISTS "backtest_walkforward_freezes_run_idx"
  ON "backtest_walkforward_freezes" ("run_id", "window_index");

-- Database-level immutability, not only an application convention.
CREATE OR REPLACE FUNCTION backtest_walkforward_freeze_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'walk-forward freeze artifacts are append-only';
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'backtest_walkforward_freezes_immutable'
  ) THEN
    CREATE TRIGGER backtest_walkforward_freezes_immutable
      BEFORE UPDATE OR DELETE ON "backtest_walkforward_freezes"
      FOR EACH ROW EXECUTE FUNCTION backtest_walkforward_freeze_immutable();
  END IF;
END $$;
