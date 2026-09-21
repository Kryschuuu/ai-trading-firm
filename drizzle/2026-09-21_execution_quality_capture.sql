-- Additive production capture claims/receipts. No changes to the original migration.
-- Claim is committed BEFORE external order submission. A missing receipt is an
-- uncertain outcome, never permission to submit again. Recovery is read-only.
BEGIN;
CREATE TABLE IF NOT EXISTS execution_quality_submissions (
 intent_id text PRIMARY KEY REFERENCES execution_quality_intents(id),
 request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS execution_quality_receipts (
 intent_id text PRIMARY KEY REFERENCES execution_quality_submissions(intent_id),
 result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
 observed_at timestamptz NOT NULL,
 elapsed_ms numeric CHECK (elapsed_ms >= 0),
 created_at timestamptz NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS execution_quality_submissions_immutable ON execution_quality_submissions;
CREATE TRIGGER execution_quality_submissions_immutable BEFORE UPDATE OR DELETE ON execution_quality_submissions
FOR EACH ROW EXECUTE FUNCTION execution_quality_immutable();
DROP TRIGGER IF EXISTS execution_quality_receipts_immutable ON execution_quality_receipts;
CREATE TRIGGER execution_quality_receipts_immutable BEFORE UPDATE OR DELETE ON execution_quality_receipts
FOR EACH ROW EXECUTE FUNCTION execution_quality_immutable();
COMMIT;
