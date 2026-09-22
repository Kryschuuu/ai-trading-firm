-- RMA-P5-04 (v1.68.0) — Hysteretisches Drawdown-Risk-Scaling.
-- Append-only: EINE neue Tabelle + Indizes/Constraints; keine bestehende
-- Tabelle wird verändert, keine Spalte umgebaut, kein Backfill nötig.
--
-- Äquivalent zu `npx drizzle-kit push` aus `src/db/schema.ts`
-- (`drawdownScalingSnapshots`); diese Datei ist der idempotente SQL-Pfad für
-- Umgebungen ohne drizzle-kit:
--   psql "$DATABASE_URL" -f drizzle/2026-09-22_drawdown_scaling.sql
--
-- ── Semantik ────────────────────────────────────────────────────────────────
-- `drawdown_scaling_snapshots`
--   EINE Zeile je Bewertung der Drawdown-Policy: Equity-Beobachtung
--   (reconciled), cashflow-bereinigte Equity, persistierter High-Water-Mark,
--   Drawdown, Kurven-/angewendeter Faktor, Stufe (inkl. PAUSE), Transition,
--   Policyversion sowie die Zustands-Projektion für die Neustart-Rekonstruktion.
--
--   Der natürliche Schlüssel `snapshot_id` (`dsc1:<sha256>` über
--   Minuten-Fenster|PolicyVersion|DataHash) stellt Idempotenz bei Retries und
--   Restarts sicher (ON CONFLICT DO NOTHING, UNIQUE-Index).
--
-- Zeitsemantik (drei getrennte Zeitachsen — kein Look-ahead):
--   equity_available_at = Verfügbarkeitszeit der Equity (Snapshot-Zeit `ts`);
--                         nie in der Zukunft (Policy-Guard FUTURE_EQUITY).
--   as_of               = Entscheidungszeitpunkt (Monitor-Tick).
--   computed_at         = Berechnungszeit, immer ≥ as_of (CHECK).
--
-- Fail-closed statt falscher Neutralität:
--   `drawdown_pct`/`target_factor` sind NULL, wenn keine gültige Messung
--   möglich war (unbekannt ≠ 0) und `applied_factor` sinkt sofort auf das
--   konfigurierte Minimum (CHECK ≤ 1 — der Faktor kann das Basis-Risikobudget
--   nie überschreiten). `equity`/`hwm` bleiben NULL statt 0.
--
-- Neustart-Rekonstruktion (kein Reset des High-Water-Marks durch Deployment):
--   `last_equity`, `last_observation_at`, `last_trading_pnl`, `last_degrade_at`,
--   `last_transition_at`, `recovery_streak` tragen den Zustand NACH dieser
--   Bewertung; aus der jüngsten Zeile rekonstruiert der Prozess HWM, Faktor,
--   Cashflow-Basis und Hysterese.
--
-- ── Rollback / Feature-Flag ─────────────────────────────────────────────────
--   1. Feature-Flag: `DRAWDOWN_SCALING_MODE=monitor` (Default) oder `=off`
--      deaktiviert die Anwendung sofort (Faktor und PAUSE werden
--      zurückgenommen); bestehende Zeilen bleiben lesbar (Monitoring-Historie),
--      kein Rollback der Daten nötig. Zusätzlich `dsp.enabled=0` in
--      `risk_config` (Master-Schalter).
--   2. Reversible Bereinigung (nur wenn kein v1.68.0-Code mehr läuft):
--      DROP TABLE IF EXISTS "drawdown_scaling_snapshots" CASCADE;
--      DELETE FROM "risk_config" WHERE "key" LIKE 'dsp.%';

-- 1) Append-only Drawdown-Scaling-Snapshot-Historie ---------------------------
CREATE TABLE IF NOT EXISTS "drawdown_scaling_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "snapshot_id" text NOT NULL,
  "mode" text NOT NULL,
  "status" text NOT NULL,
  "reason_code" text NOT NULL,
  "reason" text NOT NULL,
  "as_of" timestamptz NOT NULL,
  "computed_at" timestamptz NOT NULL,
  "equity_available_at" timestamptz,
  "equity" numeric,
  "adjusted_equity" numeric,
  "hwm" numeric,
  "drawdown_pct" numeric,
  "target_factor" numeric,
  "prev_factor" numeric NOT NULL,
  "applied_factor" numeric NOT NULL,
  "stage" text NOT NULL,
  "paused" boolean NOT NULL,
  "transition" text NOT NULL,
  "prev_stage" text,
  "policy_version" text NOT NULL,
  "data_hash" text NOT NULL,
  "cumulative_net_flow" numeric NOT NULL,
  "cashflow_detected" numeric NOT NULL,
  "cashflow_verification" text NOT NULL,
  "reconciliation_at" timestamptz,
  "reconciliation_clean" boolean,
  "reconciliation_age_ms" numeric,
  "equity_source" text,
  "equity_age_ms" numeric,
  "last_equity" numeric,
  "last_observation_at" timestamptz,
  "last_trading_pnl" numeric,
  "last_degrade_at" timestamptz,
  "last_transition_at" timestamptz,
  "recovery_streak" integer NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

-- 2) Idempotente Indizes -----------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS "drawdown_scaling_snapshots_id_unique"
  ON "drawdown_scaling_snapshots" ("snapshot_id");

CREATE INDEX IF NOT EXISTS "drawdown_scaling_snapshots_asof_idx"
  ON "drawdown_scaling_snapshots" ("as_of");

CREATE INDEX IF NOT EXISTS "drawdown_scaling_snapshots_status_idx"
  ON "drawdown_scaling_snapshots" ("status");

CREATE INDEX IF NOT EXISTS "drawdown_scaling_snapshots_stage_idx"
  ON "drawdown_scaling_snapshots" ("stage");

CREATE INDEX IF NOT EXISTS "drawdown_scaling_snapshots_policy_idx"
  ON "drawdown_scaling_snapshots" ("policy_version");

-- 3) Idempotente CHECK-Constraints -------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drawdown_scaling_snapshots_mode_check') THEN
    ALTER TABLE "drawdown_scaling_snapshots" ADD CONSTRAINT "drawdown_scaling_snapshots_mode_check"
      CHECK ("mode" IN ('monitor','active'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drawdown_scaling_snapshots_status_check') THEN
    ALTER TABLE "drawdown_scaling_snapshots" ADD CONSTRAINT "drawdown_scaling_snapshots_status_check"
      CHECK ("status" IN ('BOOTSTRAP','OK','CONSERVATIVE'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drawdown_scaling_snapshots_stage_check') THEN
    ALTER TABLE "drawdown_scaling_snapshots" ADD CONSTRAINT "drawdown_scaling_snapshots_stage_check"
      CHECK ("stage" IN ('NORMAL','SOFT','DEEP','PAUSE'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drawdown_scaling_snapshots_prev_stage_check') THEN
    ALTER TABLE "drawdown_scaling_snapshots" ADD CONSTRAINT "drawdown_scaling_snapshots_prev_stage_check"
      CHECK ("prev_stage" IS NULL OR "prev_stage" IN ('NORMAL','SOFT','DEEP','PAUSE'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drawdown_scaling_snapshots_transition_check') THEN
    ALTER TABLE "drawdown_scaling_snapshots" ADD CONSTRAINT "drawdown_scaling_snapshots_transition_check"
      CHECK ("transition" IN ('NONE','DEGRADE','RECOVER','BOOTSTRAP'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drawdown_scaling_snapshots_cashflow_verification_check') THEN
    ALTER TABLE "drawdown_scaling_snapshots" ADD CONSTRAINT "drawdown_scaling_snapshots_cashflow_verification_check"
      CHECK ("cashflow_verification" IN ('verified','unverified'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drawdown_scaling_snapshots_time_check') THEN
    ALTER TABLE "drawdown_scaling_snapshots" ADD CONSTRAINT "drawdown_scaling_snapshots_time_check"
      CHECK ("computed_at" >= "as_of");
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drawdown_scaling_snapshots_applied_factor_check') THEN
    ALTER TABLE "drawdown_scaling_snapshots" ADD CONSTRAINT "drawdown_scaling_snapshots_applied_factor_check"
      CHECK ("applied_factor" > 0 AND "applied_factor" <= 1);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drawdown_scaling_snapshots_prev_factor_check') THEN
    ALTER TABLE "drawdown_scaling_snapshots" ADD CONSTRAINT "drawdown_scaling_snapshots_prev_factor_check"
      CHECK ("prev_factor" > 0 AND "prev_factor" <= 1);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drawdown_scaling_snapshots_target_factor_check') THEN
    ALTER TABLE "drawdown_scaling_snapshots" ADD CONSTRAINT "drawdown_scaling_snapshots_target_factor_check"
      CHECK ("target_factor" IS NULL OR ("target_factor" >= 0 AND "target_factor" <= 1));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drawdown_scaling_snapshots_drawdown_check') THEN
    ALTER TABLE "drawdown_scaling_snapshots" ADD CONSTRAINT "drawdown_scaling_snapshots_drawdown_check"
      CHECK ("drawdown_pct" IS NULL OR ("drawdown_pct" >= 0 AND "drawdown_pct" <= 1));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drawdown_scaling_snapshots_pause_stage_check') THEN
    ALTER TABLE "drawdown_scaling_snapshots" ADD CONSTRAINT "drawdown_scaling_snapshots_pause_stage_check"
      CHECK ("paused" = ("stage" = 'PAUSE'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drawdown_scaling_snapshots_recovery_streak_check') THEN
    ALTER TABLE "drawdown_scaling_snapshots" ADD CONSTRAINT "drawdown_scaling_snapshots_recovery_streak_check"
      CHECK ("recovery_streak" >= 0);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drawdown_scaling_snapshots_snapshot_id_check') THEN
    ALTER TABLE "drawdown_scaling_snapshots" ADD CONSTRAINT "drawdown_scaling_snapshots_snapshot_id_check"
      CHECK ("snapshot_id" ~ '^dsc1:[0-9a-f]{64}$');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drawdown_scaling_snapshots_policy_version_check') THEN
    ALTER TABLE "drawdown_scaling_snapshots" ADD CONSTRAINT "drawdown_scaling_snapshots_policy_version_check"
      CHECK ("policy_version" ~ '^ddp1:[0-9a-f]{64}$');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drawdown_scaling_snapshots_data_hash_check') THEN
    ALTER TABLE "drawdown_scaling_snapshots" ADD CONSTRAINT "drawdown_scaling_snapshots_data_hash_check"
      CHECK ("data_hash" ~ '^dd1:[0-9a-f]{64}$');
  END IF;
END $$;
