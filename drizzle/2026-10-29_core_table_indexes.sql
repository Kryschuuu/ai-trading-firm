-- ASA-11: idempotent indexes on columns present in the actual core schema.
CREATE INDEX IF NOT EXISTS positions_status_created_idx ON positions (status, created_at);
CREATE INDEX IF NOT EXISTS positions_updated_idx ON positions (updated_at);
CREATE INDEX IF NOT EXISTS agent_messages_mission_created_idx ON agent_messages (mission_id, created_at);
CREATE INDEX IF NOT EXISTS agent_messages_created_idx ON agent_messages (created_at);
CREATE INDEX IF NOT EXISTS equity_snapshots_ts_idx ON equity_snapshots (ts);
CREATE INDEX IF NOT EXISTS audit_log_created_idx ON audit_log (created_at);
CREATE INDEX IF NOT EXISTS audit_log_event_created_idx ON audit_log (event, created_at);
CREATE INDEX IF NOT EXISTS missions_status_created_idx ON missions (status, created_at);
CREATE INDEX IF NOT EXISTS trade_rules_status_symbol_idx ON trade_rules (status, symbol);
