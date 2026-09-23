-- RMA-P1-05 (v1.73.0) — Strategy-Lifecycle mit Backtest↔Paper↔Live-Driftgates.
-- Append-only: NUR neue Tabellen + Indizes + Constraints, keine Änderung an
-- bestehenden Migrationen oder Tabellen.
--
-- Tabellen:
--   strategy_lifecycle_states       aktueller Zustand je (strategy_key, strategy_version)
--                                   mit optimistischem Lock `state_seq`, Risiko-
--                                   faktor `risk_scale` ∈ (0,1] und Recovery-Cooldown.
--   strategy_lifecycle_evidence     immutable Evidence (FK backtest_runs, Content-Hash,
--                                   Idempotency-Key, event/available/computed-Zeit).
--   strategy_lifecycle_transitions  append-only Übergangslog mit UNIQUE
--                                   `transition_key` (Idempotenz bei Retries/Parallelen).
--
-- Anwendung (idempotent, doppelt ausführbar):
--   psql "$DATABASE_URL" -f drizzle/2026-09-23_strategy_lifecycle.sql
--   oder `npx drizzle-kit push` aus src/db/schema.ts.
--
-- Rollback (sicher, rein additiv):
--   DROP TABLE IF EXISTS strategy_lifecycle_transitions;
--   DROP TABLE IF EXISTS strategy_lifecycle_evidence;
--   DROP TABLE IF EXISTS strategy_lifecycle_states;
--   Risikofaktor/PAUSE wirken nur über riskGuard.applyStrategyLifecycleScale —
--   nach DROP + Neustart bleibt der Faktor NULL (Default neutral).
--
-- Bootstrap/Backfill: LEER starten. Bestehende Strategien werden bei Bedarf
-- über `ensureLifecycleDraft` (DRAFT) angelegt; Promotion erfordert Evidenz.

CREATE TABLE IF NOT EXISTS "strategy_lifecycle_states" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "strategy_key" text NOT NULL,
  "strategy_version" integer NOT NULL,
  "state" text NOT NULL DEFAULT 'DRAFT',
  "state_seq" integer NOT NULL DEFAULT 0,
  "policy_version" text NOT NULL,
  "risk_scale" numeric NOT NULL DEFAULT '1',
  "cooldown_until" timestamptz,
  "last_evidence_id" uuid,
  "rule_key" uuid,
  "updated_by" text NOT NULL DEFAULT 'system',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "strategy_lifecycle_states_key_unique"
  ON "strategy_lifecycle_states" ("strategy_key", "strategy_version");
CREATE INDEX IF NOT EXISTS "strategy_lifecycle_states_state_idx"
  ON "strategy_lifecycle_states" ("state");

DO $$ BEGIN
  ALTER TABLE "strategy_lifecycle_states"
    ADD CONSTRAINT "strategy_lifecycle_states_state_check"
    CHECK ("state" IN ('DRAFT','BACKTEST_PENDING','BACKTEST_PASSED','PAPER','LIVE_LIMITED','LIVE','DEGRADED','PAUSED','REJECTED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "strategy_lifecycle_states"
    ADD CONSTRAINT "strategy_lifecycle_states_seq_check"
    CHECK ("state_seq" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "strategy_lifecycle_states"
    ADD CONSTRAINT "strategy_lifecycle_states_scale_check"
    CHECK ("risk_scale" > 0 AND "risk_scale" <= 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "strategy_lifecycle_states"
    ADD CONSTRAINT "strategy_lifecycle_states_version_check"
    CHECK ("strategy_version" >= 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "strategy_lifecycle_states"
    ADD CONSTRAINT "strategy_lifecycle_states_key_shape"
    CHECK (length("strategy_key") BETWEEN 1 AND 128
      AND "strategy_key" ~ '^[A-Za-z0-9._:@/-]+$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- FK auf Evidence wird nach der Evidence-Tabelle ergänzt (Reihenfolge).
-- FK auf backtest_runs ohne Cascade (Repo-Konvention).

CREATE TABLE IF NOT EXISTS "strategy_lifecycle_evidence" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "strategy_key" text NOT NULL,
  "strategy_version" integer NOT NULL,
  "kind" text NOT NULL,
  "result" text NOT NULL,
  "backtest_run_id" uuid REFERENCES "backtest_runs"("id"),
  "prompt_version" text,
  "code_version" text NOT NULL,
  "data_version" text,
  "rule_key" uuid,
  "policy_version" text NOT NULL,
  "sample_size" integer,
  "window_start" timestamptz,
  "window_end" timestamptz,
  "metrics" jsonb NOT NULL DEFAULT '{}',
  "detail" jsonb NOT NULL DEFAULT '{}',
  "event_time" timestamptz NOT NULL,
  "available_at" timestamptz NOT NULL,
  "computed_at" timestamptz NOT NULL,
  "content_hash" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "strategy_lifecycle_evidence_idem_unique"
  ON "strategy_lifecycle_evidence" ("idempotency_key");
CREATE UNIQUE INDEX IF NOT EXISTS "strategy_lifecycle_evidence_hash_unique"
  ON "strategy_lifecycle_evidence" ("content_hash");
CREATE INDEX IF NOT EXISTS "strategy_lifecycle_evidence_lookup_idx"
  ON "strategy_lifecycle_evidence" ("strategy_key", "strategy_version", "kind", "available_at");
CREATE INDEX IF NOT EXISTS "strategy_lifecycle_evidence_backtest_idx"
  ON "strategy_lifecycle_evidence" ("backtest_run_id");

DO $$ BEGIN
  ALTER TABLE "strategy_lifecycle_evidence"
    ADD CONSTRAINT "strategy_lifecycle_evidence_kind_check"
    CHECK ("kind" IN ('BACKTEST_RUN','PAPER_WINDOW','RECONCILIATION','EXECUTION_QUALITY','DRIFT','RECOVERY','OVERRIDE','DATA_QUALITY'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "strategy_lifecycle_evidence"
    ADD CONSTRAINT "strategy_lifecycle_evidence_result_check"
    CHECK ("result" IN ('PASS','FAIL','INCONCLUSIVE'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "strategy_lifecycle_evidence"
    ADD CONSTRAINT "strategy_lifecycle_evidence_sample_check"
    CHECK ("sample_size" IS NULL OR "sample_size" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "strategy_lifecycle_evidence"
    ADD CONSTRAINT "strategy_lifecycle_evidence_time_check"
    CHECK ("available_at" >= "event_time" AND "computed_at" >= "available_at");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "strategy_lifecycle_evidence"
    ADD CONSTRAINT "strategy_lifecycle_evidence_hash_check"
    CHECK ("content_hash" ~ '^sle1:[0-9a-f]{64}$'
      AND "idempotency_key" ~ '^slei1:[0-9a-f]{64}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "strategy_lifecycle_evidence"
    ADD CONSTRAINT "strategy_lifecycle_evidence_window_check"
    CHECK ("window_start" IS NULL OR "window_end" IS NULL OR "window_end" >= "window_start");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "strategy_lifecycle_states"
    ADD CONSTRAINT "strategy_lifecycle_states_last_evidence_fk"
    FOREIGN KEY ("last_evidence_id") REFERENCES "strategy_lifecycle_evidence"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "strategy_lifecycle_transitions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "state_id" uuid NOT NULL REFERENCES "strategy_lifecycle_states"("id"),
  "strategy_key" text NOT NULL,
  "strategy_version" integer NOT NULL,
  "from_state" text NOT NULL,
  "to_state" text NOT NULL,
  "transition_key" text NOT NULL,
  "trigger" text NOT NULL,
  "actor" text NOT NULL,
  "actor_role" text NOT NULL,
  "reason" text NOT NULL,
  "evidence_id" uuid,
  "policy_version" text NOT NULL,
  "risk_scale" text NOT NULL,
  "seq_before" integer NOT NULL,
  "seq_after" integer NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "strategy_lifecycle_transitions_key_unique"
  ON "strategy_lifecycle_transitions" ("transition_key");
CREATE INDEX IF NOT EXISTS "strategy_lifecycle_transitions_lookup_idx"
  ON "strategy_lifecycle_transitions" ("strategy_key", "strategy_version", "created_at");
CREATE INDEX IF NOT EXISTS "strategy_lifecycle_transitions_state_idx"
  ON "strategy_lifecycle_transitions" ("state_id");

DO $$ BEGIN
  ALTER TABLE "strategy_lifecycle_transitions"
    ADD CONSTRAINT "strategy_lifecycle_transitions_states_check"
    CHECK ("from_state" IN ('DRAFT','BACKTEST_PENDING','BACKTEST_PASSED','PAPER','LIVE_LIMITED','LIVE','DEGRADED','PAUSED','REJECTED')
      AND "to_state" IN ('DRAFT','BACKTEST_PENDING','BACKTEST_PASSED','PAPER','LIVE_LIMITED','LIVE','DEGRADED','PAUSED','REJECTED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "strategy_lifecycle_transitions"
    ADD CONSTRAINT "strategy_lifecycle_transitions_key_check"
    CHECK ("transition_key" ~ '^slt1:[0-9a-f]{64}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "strategy_lifecycle_transitions"
    ADD CONSTRAINT "strategy_lifecycle_transitions_trigger_check"
    CHECK ("trigger" IN ('operator','system','backtest','drift','recovery','override'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "strategy_lifecycle_transitions"
    ADD CONSTRAINT "strategy_lifecycle_transitions_seq_check"
    CHECK ("seq_after" = "seq_before" + 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "strategy_lifecycle_transitions"
    ADD CONSTRAINT "strategy_lifecycle_transitions_scale_check"
    CHECK (length("risk_scale") BETWEEN 1 AND 8);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "strategy_lifecycle_transitions"
    ADD CONSTRAINT "strategy_lifecycle_transitions_reason_check"
    CHECK (length("reason") BETWEEN 1 AND 500);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "strategy_lifecycle_transitions"
    ADD CONSTRAINT "strategy_lifecycle_transitions_evidence_fk"
    FOREIGN KEY ("evidence_id") REFERENCES "strategy_lifecycle_evidence"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
