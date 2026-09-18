-- GAP-03 (v1.43.0) — Trade-Journal mit Agenten-Attribution + begrenzter
-- Gewichts-Rückführung (append-only: NUR neue Tabellen, keine Umbauten an
-- bestehenden Tabellen).
--
-- Hintergrund: Die Rohdaten existierten (positions trägt missionId/ruleId/
-- exitReason; dazu proposals, agent_messages, audit_log, equity_snapshots),
-- aber es fehlte die VERKNÜPFUNG (Position ↔ Entscheidungskette der Agenten)
-- und die AUSWERTUNG ("wer hat wann recht?") samt begrenzter Rückführung in
-- Gewichte (Audit 2026-09-18,
-- docs/audits/2026-09-18-feature-gap/findings/GAP-03-trade-journal-attribution.md).
--
-- `trade_journal`:
--   Eine Zeile pro Position (UNIQUE position_id), append-only in der
--   Lebenszyklus-Semantik:
--     1. Bei Eröffnung (Engine-/Mikro-Executor-Pfad) entsteht die Zeile mit
--        decisionSnapshot (Agenten-Stimmen {name, role, vote, confidence,
--        riskScore}, Regime, rationaleHash). Fehlt die Attribution, trägt der
--        Snapshot attribution:"UNKNOWN" — Lücke sichtbar, nie geraten.
--     2. Beim Close (Monitor/Flatten) werden die Metriken ergänzt
--        (closed_at, pnl, mae_pct, mfe_pct, holding_minutes, exit_reason,
--        quality). Kerzenlücken → Metriken null + quality-Flag (nicht schätzen).
--
-- `journal_agent_weights`:
--   Begrenzte Feedback-Gewichte je (Agentenrolle, Regime). Geschrieben NUR im
--   Modus JOURNAL_FEEDBACK_MODE=enforce (Default "off" = reine Auswertung),
--   immer mit Bounds [JOURNAL_WEIGHT_MIN, JOURNAL_WEIGHT_MAX]
--   (Default [0.5, 1.5]), maximaler Änderung je Zyklus
--   JOURNAL_MAX_WEIGHT_DELTA (Default 0.1) und revisionssicherem audit_log-
--   Eintrag ("journal-weight:AGENT:REGIME:x→y").
--
-- Erklärt mit `npx drizzle-kit push` aus src/db/schema.ts
-- (`tradeJournal`, `journalAgentWeights`); diese Datei ist der äquivalente,
-- idempotente SQL-Pfad für Umgebungen ohne drizzle-kit
-- (z. B. `psql "$DATABASE_URL" -f drizzle/2026-09-18_trade_journal.sql`).

CREATE TABLE IF NOT EXISTS "trade_journal" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "position_id" uuid NOT NULL REFERENCES "positions"("id"),
  "symbol" text NOT NULL,
  "side" text NOT NULL,
  "opened_at" timestamptz NOT NULL,
  "closed_at" timestamptz,
  "mission_id" uuid REFERENCES "missions"("id"),
  "rule_id" uuid REFERENCES "trade_rules"("id"),
  "decision_snapshot" jsonb NOT NULL,
  "regime" text NOT NULL DEFAULT 'UNKNOWN',
  "pnl" numeric,
  "mae_pct" numeric,
  "mfe_pct" numeric,
  "holding_minutes" integer,
  "exit_reason" text,
  "quality" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

-- Eine Journal-Zeile pro Position: idempotente Closes, keine Duplikate.
CREATE UNIQUE INDEX IF NOT EXISTS "trade_journal_position_unique"
  ON "trade_journal" ("position_id");

CREATE INDEX IF NOT EXISTS "trade_journal_regime_idx"
  ON "trade_journal" ("regime", "closed_at");

CREATE TABLE IF NOT EXISTS "journal_agent_weights" (
  "agent_role" text NOT NULL,
  "regime" text NOT NULL,
  "weight" numeric NOT NULL,
  "trades" integer NOT NULL DEFAULT 0,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("agent_role", "regime")
);
