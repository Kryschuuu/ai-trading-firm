-- STX-07-02 (Phase 7): Copy risk policy + idempotency links.
-- Additive and idempotent: exactly two new Phase-7 tables; no copied event,
-- position, intent, receipt, or reconciliation tables.
--
-- Prerequisite: drizzle/2026-09-20_execution_quality.sql, which owns
-- execution_quality_intents. Its `id` is TEXT (the production key is `eq-…`),
-- therefore the FK column below is TEXT as well. A UUID FK would be invalid in
-- PostgreSQL and would not reference the repository's existing intent IDs.
--
-- Apply: psql "$DATABASE_URL" -f drizzle/2026-10-03_copy_subscriptions.sql
-- Rollback after stopping copy readers/writers:
--   DROP TABLE IF EXISTS copy_order_links;
--   DROP TABLE IF EXISTS copy_subscriptions;
-- No row is created by this migration; subscriptions remain disabled by default.

BEGIN;

CREATE TABLE IF NOT EXISTS copy_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  follower_account text NOT NULL,
  leader_venue text NOT NULL,
  leader_account text NOT NULL,
  leader_symbol text NOT NULL,
  follower_instrument_id text,
  sizing_mode text NOT NULL,
  sizing_params jsonb NOT NULL,
  leverage_policy text NOT NULL,
  policy_json jsonb NOT NULL,
  policy_version text NOT NULL,
  mode text NOT NULL DEFAULT 'SIMULATE_ONLY',
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT copy_subscriptions_sizing_mode_check
    CHECK (sizing_mode IN ('FIXED_AMOUNT', 'FIXED_RATIO', 'EQUITY_RATIO')),
  CONSTRAINT copy_subscriptions_leverage_policy_check
    CHECK (leverage_policy IN ('FOLLOW_LEADER', 'CAP', 'IGNORE', 'RISK_NORMALIZED')),
  CONSTRAINT copy_subscriptions_mode_check
    CHECK (mode = 'SIMULATE_ONLY'),
  CONSTRAINT copy_subscriptions_sizing_params_check
    CHECK (jsonb_typeof(sizing_params) = 'object'),
  CONSTRAINT copy_subscriptions_policy_json_check
    CHECK (jsonb_typeof(policy_json) = 'object'),
  CONSTRAINT copy_subscriptions_policy_version_check
    CHECK (policy_version ~ '^cpl1:[0-9a-f]{64}$'),
  CONSTRAINT copy_subscriptions_identity_unique
    UNIQUE (follower_account, leader_venue, leader_account, leader_symbol)
);

CREATE TABLE IF NOT EXISTS copy_order_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  leader_event_id text NOT NULL,
  follower_intent_id text NOT NULL,
  execution_quality_intent_id text REFERENCES execution_quality_intents(id),
  state text NOT NULL,
  policy_code text,
  observed_deviation_bps numeric,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT copy_order_links_state_check
    CHECK (state IN ('PENDING', 'SENT', 'PARTIAL', 'FILLED', 'FAILED', 'DIVERGED')),
  CONSTRAINT copy_order_links_policy_code_check
    CHECK (policy_code IS NULL OR policy_code IN (
      'HALTED', 'MAX_EVENT_NOTIONAL', 'MAX_DAY_NOTIONAL', 'MAX_SLIPPAGE',
      'MAX_POSITIONS', 'MAX_DAILY_LOSS', 'MAX_LEVERAGE', 'NO_MAPPING'
    )),
  CONSTRAINT copy_order_links_policy_code_state_check
    CHECK (policy_code IS NULL OR state = 'FAILED'),
  CONSTRAINT copy_order_links_event_follower_unique
    UNIQUE (leader_event_id, follower_intent_id),
  CONSTRAINT copy_order_links_follower_intent_unique
    UNIQUE (follower_intent_id)
);

CREATE INDEX IF NOT EXISTS copy_order_links_state_idx
  ON copy_order_links (state);
CREATE INDEX IF NOT EXISTS copy_order_links_leader_event_idx
  ON copy_order_links (leader_event_id);

COMMIT;
