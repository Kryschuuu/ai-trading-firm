-- TASK 07: invalidate process-local RuleCaches after committed trade_rules mutations.
-- Apply AFTER the Drizzle schema has created public.trade_rules. Drizzle Kit does
-- not model PostgreSQL triggers/functions; this file must be applied explicitly.
-- The fixed, tiny payload avoids leaking rule identifiers or user data through NOTIFY.

CREATE OR REPLACE FUNCTION public.notify_trade_rules_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_notify('trade_rules', 'changed');
  RETURN NULL; -- statement-level trigger; return value is ignored
END;
$$;

DROP TRIGGER IF EXISTS trade_rules_notify_change ON public.trade_rules;
CREATE TRIGGER trade_rules_notify_change
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.trade_rules
FOR EACH STATEMENT
EXECUTE FUNCTION public.notify_trade_rules_change();
