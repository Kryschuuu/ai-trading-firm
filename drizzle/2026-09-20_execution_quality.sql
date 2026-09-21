-- Additive execution-quality ledger. Apply before enabling ingestion.
-- Rollback: stop ingestion/readers, retain tables for audit; old code ignores them.
BEGIN;
CREATE TABLE IF NOT EXISTS execution_quality_intents (
  id text PRIMARY KEY,
  venue text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('backtest','paper','testnet','live')),
  scope text NOT NULL,
  client_order_id text NOT NULL,
  submit_at timestamptz NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  UNIQUE (venue, mode, scope, client_order_id)
);
CREATE INDEX IF NOT EXISTS execution_quality_intents_time_idx ON execution_quality_intents(submit_at, id);
CREATE TABLE IF NOT EXISTS execution_quality_events (
  id text PRIMARY KEY,
  intent_id text NOT NULL REFERENCES execution_quality_intents(id),
  external_key text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('ack','fill','benchmark')),
  available_at timestamptz NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object')
);
CREATE INDEX IF NOT EXISTS execution_quality_events_intent_idx ON execution_quality_events(intent_id, available_at);
-- Enforced append-only, including accidental ORM updates/deletes.
CREATE OR REPLACE FUNCTION execution_quality_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'execution quality is append-only'; END $$;
DROP TRIGGER IF EXISTS execution_quality_intents_immutable ON execution_quality_intents;
CREATE TRIGGER execution_quality_intents_immutable BEFORE UPDATE OR DELETE ON execution_quality_intents
FOR EACH ROW EXECUTE FUNCTION execution_quality_immutable();
DROP TRIGGER IF EXISTS execution_quality_events_immutable ON execution_quality_events;
CREATE TRIGGER execution_quality_events_immutable BEFORE UPDATE OR DELETE ON execution_quality_events
FOR EACH ROW EXECUTE FUNCTION execution_quality_immutable();
COMMIT;
