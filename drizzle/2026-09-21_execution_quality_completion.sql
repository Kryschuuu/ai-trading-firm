-- One immutable completion marker per terminal, fully marked-out intent.
-- Read workers exclude these rows; historical report cohorts remain unchanged.
BEGIN;
CREATE TABLE IF NOT EXISTS execution_quality_completed (
 intent_id text PRIMARY KEY REFERENCES execution_quality_intents(id),
 completed_at timestamptz NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS execution_quality_completed_immutable ON execution_quality_completed;
CREATE TRIGGER execution_quality_completed_immutable BEFORE UPDATE OR DELETE ON execution_quality_completed FOR EACH ROW EXECUTE FUNCTION execution_quality_immutable();
DROP TRIGGER IF EXISTS execution_quality_completed_no_truncate ON execution_quality_completed;
CREATE TRIGGER execution_quality_completed_no_truncate BEFORE TRUNCATE ON execution_quality_completed FOR EACH STATEMENT EXECUTE FUNCTION execution_quality_immutable();
COMMIT;
