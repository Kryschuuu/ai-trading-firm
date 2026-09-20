-- Parent correlation is now enforced for all NEW writes; legacy imported rows
-- remain readable even if their externally referenced parent was never imported.
BEGIN;
ALTER TABLE execution_quality_intents ADD COLUMN IF NOT EXISTS parent_intent_id text GENERATED ALWAYS AS (payload->>'parentIntentId') STORED;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='execution_quality_parent_fk') THEN
  ALTER TABLE execution_quality_intents ADD CONSTRAINT execution_quality_parent_fk FOREIGN KEY(parent_intent_id) REFERENCES execution_quality_intents(id) NOT VALID;
 END IF;
END $$;
CREATE INDEX IF NOT EXISTS execution_quality_parent_idx ON execution_quality_intents(parent_intent_id);
CREATE INDEX IF NOT EXISTS execution_quality_decision_idx ON execution_quality_intents((payload->>'decisionId'));
CREATE INDEX IF NOT EXISTS execution_quality_scope_idx ON execution_quality_intents(venue,mode,scope,id);
-- DELETE/UPDATE triggers alone do not protect TRUNCATE. Keep audit evidence
-- append-only even for an accidental truncate by the application DB role.
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['execution_quality_intents','execution_quality_events','execution_quality_submissions','execution_quality_receipts','execution_quality_quotes'] LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS execution_quality_no_truncate ON %I',t);
  EXECUTE format('CREATE TRIGGER execution_quality_no_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION execution_quality_immutable()',t);
 END LOOP;
END $$;
COMMIT;
