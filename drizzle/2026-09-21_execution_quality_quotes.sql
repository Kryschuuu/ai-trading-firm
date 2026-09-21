-- Minimal L1 evidence for fixed-horizon markouts. Never raw provider payloads.
BEGIN;
CREATE TABLE IF NOT EXISTS execution_quality_quotes (
 id text PRIMARY KEY,
 venue text NOT NULL,
 mode text NOT NULL CHECK (mode IN ('backtest','paper','testnet','live')),
 scope text NOT NULL,
 instrument text NOT NULL,
 mid numeric NOT NULL CHECK (mid > 0 AND mid <= 1000000000000000),
 event_at timestamptz NOT NULL,
 available_at timestamptz NOT NULL,
 CHECK(event_at <= available_at)
);
CREATE INDEX IF NOT EXISTS execution_quality_quotes_asof_idx ON execution_quality_quotes(venue,mode,scope,instrument,event_at DESC,available_at);
DROP TRIGGER IF EXISTS execution_quality_quotes_immutable ON execution_quality_quotes;
CREATE TRIGGER execution_quality_quotes_immutable BEFORE UPDATE OR DELETE ON execution_quality_quotes FOR EACH ROW EXECUTE FUNCTION execution_quality_immutable();
COMMIT;
