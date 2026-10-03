-- STX-07-03 (Phase 7): Copy engine gates — leader-state code + durable day notional.
-- Additive and idempotent. No new table: `copy_order_links` stays the only
-- idempotency/state table of Phase 7 (STX-07-02 minimality decision).
--
-- Prerequisite: drizzle/2026-10-03_copy_subscriptions.sql.
--
-- 1) `NO_BASELINE` becomes a persistable policy code. The 07-02 CHECK
--    enumerates the pre-submit codes; the 07-03 leader-state gate needs the
--    same value in the domain union (`src/copy/policy.ts`). The engine still
--    writes NO row when there is no baseline — an untrusted leader state must
--    not have a side effect. The widened CHECK keeps the domain type and the
--    database consistent for any future caller.
-- 2) `follower_notional` records the simulated follower notional of one event.
--    It is the durable accumulator behind `maxNotionalPerDay`: a daily limit
--    that a process restart resets would not be a limit. It is a measurement
--    column, never an order or a receipt.
--
-- Apply: psql "$DATABASE_URL" -f drizzle/2026-10-04_copy_engine_gates.sql
-- Rollback after stopping copy readers/writers:
--   ALTER TABLE copy_order_links DROP CONSTRAINT IF EXISTS copy_order_links_policy_code_check;
--   ALTER TABLE copy_order_links ADD CONSTRAINT copy_order_links_policy_code_check
--     CHECK (policy_code IS NULL OR policy_code IN (
--       'HALTED', 'MAX_EVENT_NOTIONAL', 'MAX_DAY_NOTIONAL', 'MAX_SLIPPAGE',
--       'MAX_POSITIONS', 'MAX_DAILY_LOSS', 'MAX_LEVERAGE', 'NO_MAPPING'));
--   ALTER TABLE copy_order_links DROP CONSTRAINT IF EXISTS copy_order_links_follower_notional_check;
--   ALTER TABLE copy_order_links DROP COLUMN IF EXISTS follower_notional;

BEGIN;

ALTER TABLE copy_order_links DROP CONSTRAINT IF EXISTS copy_order_links_policy_code_check;
ALTER TABLE copy_order_links ADD CONSTRAINT copy_order_links_policy_code_check
  CHECK (policy_code IS NULL OR policy_code IN (
    'HALTED', 'MAX_EVENT_NOTIONAL', 'MAX_DAY_NOTIONAL', 'MAX_SLIPPAGE',
    'MAX_POSITIONS', 'MAX_DAILY_LOSS', 'MAX_LEVERAGE', 'NO_MAPPING',
    'NO_BASELINE'
  ));

ALTER TABLE copy_order_links ADD COLUMN IF NOT EXISTS follower_notional numeric;

ALTER TABLE copy_order_links DROP CONSTRAINT IF EXISTS copy_order_links_follower_notional_check;
ALTER TABLE copy_order_links ADD CONSTRAINT copy_order_links_follower_notional_check
  CHECK (follower_notional IS NULL OR (follower_notional >= 0 AND follower_notional <= 1e15));

COMMIT;
