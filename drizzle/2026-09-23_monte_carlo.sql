-- RMA-P6-02 (v1.72.0) — reproduzierbare Monte-Carlo-/Trade-Resampling-Analyse.
-- Append-only: EINE neue Tabelle (`backtest_monte_carlo_runs`); keine
-- bestehende Tabelle wird verändert, keine Spalte umgebaut, kein Backfill.
--
-- Inhalt: EINE Zeile je Analyselauf über einen unveränderlichen Walk-Forward-
-- Quell-Run. Referenziert Quelle (`source_run_id`), Seed, Methode, Scenario,
-- Config (`config_json`) und eine BOUNDED Summary (`summary_json`: Quantile
-- p05/p50/p95 für End-Equity/MaxDD/Sharpe/Losing-Streak, Exceedance-
-- Wahrscheinlichkeiten, Monte-Carlo-Standardfehler, Statistik-Hinweise,
-- Caveats). Rohpfade werden NICHT persistiert — sie sind aus Seed + Config +
-- Ledger deterministisch reproduzierbar (`scripts/run-montecarlo.ts`).
--
-- Idempotenz: `idempotency_key = mcs1:<sha256>` (Quell-Run | Segment | Methode
-- | Seed | PRNG-Version | runs | Blocklänge | Equity-Basis | Ruin-Schwelle |
-- Stress | Algorithmusversion | Eingabe-Hash), UNIQUE-Index. Der Key ist im
-- Code nicht überschreibbar — Retries/Restarts derselben Analyse liefern die
-- bestehende Zeile zurück statt einer Dublette.
--
-- Zeitsemantik: Quell-Trades tragen Ereigniszeiten (`entry_ts`/`exit_ts` der
-- `backtest_trades`); `created_at` hier ist die Berechnungszeit der Analyse.
-- Die Simulation liest ausschließlich den unveränderlichen append-only Ledger
-- — kein Look-ahead möglich.
--
-- Fail-closed in der Anwendungsschicht (hier nur als CHECKs gespiegelt):
-- Alt-Runs ohne RECONCILED-Ledger, leere Segmente, inkonsistente seq-Ordnung,
-- gemischte Symbole, Stichprobe < 30 Trades und nicht ableitbare Spannen
-- werden VOR jedem Write abgelehnt (NULL ≠ 0).
--
-- Forschung, kein Trading-Pfad: KEINE Zeile fließt in Risk-Ceilings,
-- Kill-Switches, Authority Chains oder Live-Gates (RMA-P6-02-Grenze).
--
-- Erklärt mit `npx drizzle-kit push` aus src/db/schema.ts
-- (`backtestMonteCarloRuns`); diese Datei ist der äquivalente, idempotente
-- SQL-Pfad für Umgebungen ohne drizzle-kit:
--   psql "$DATABASE_URL" -f drizzle/2026-09-23_monte_carlo.sql
--
-- Rollback (nur wenn kein v1.72.0-Code mehr läuft): die Tabelle ist rein
-- additiv und wird nur von CLI (`scripts/run-montecarlo.ts`) und Read-API
-- (`/api/firm/montecarlo`) gelesen —
--   DROP TABLE IF EXISTS "backtest_monte_carlo_runs";
-- stellt den v1.71.x-Stand vollständig her. Kein Feature-Flag nötig: Der
-- Analysepfad ist opt-in (CLI-Aufruf) und berührt keinen Live-/Paper-Pfad.

CREATE TABLE IF NOT EXISTS "backtest_monte_carlo_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "source_run_id" uuid NOT NULL REFERENCES "backtest_runs"("id"),
  "idempotency_key" text NOT NULL,
  "method" text NOT NULL,
  "segment" text NOT NULL,
  "scenario" text NOT NULL,
  "seed" bigint NOT NULL,
  "seed_algorithm" text NOT NULL,
  "runs" integer NOT NULL,
  "block_length" integer,
  "sample_trades" integer NOT NULL,
  "input_trades_hash" text NOT NULL,
  "config_json" jsonb NOT NULL,
  "summary_json" jsonb NOT NULL,
  "code_version" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'backtest_monte_carlo_runs_method_check'
  ) THEN
    ALTER TABLE "backtest_monte_carlo_runs" ADD CONSTRAINT "backtest_monte_carlo_runs_method_check"
      CHECK ("method" IN ('iid', 'moving_block', 'stationary_block'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'backtest_monte_carlo_runs_segment_check'
  ) THEN
    ALTER TABLE "backtest_monte_carlo_runs" ADD CONSTRAINT "backtest_monte_carlo_runs_segment_check"
      CHECK ("segment" IN ('IS', 'OOS', 'ALL'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'backtest_monte_carlo_runs_scenario_check'
  ) THEN
    ALTER TABLE "backtest_monte_carlo_runs" ADD CONSTRAINT "backtest_monte_carlo_runs_scenario_check"
      CHECK ("scenario" IN ('baseline', 'stress'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'backtest_monte_carlo_runs_seed_check'
  ) THEN
    ALTER TABLE "backtest_monte_carlo_runs" ADD CONSTRAINT "backtest_monte_carlo_runs_seed_check"
      CHECK ("seed" >= 0 AND "seed" <= 4294967295);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'backtest_monte_carlo_runs_runs_check'
  ) THEN
    ALTER TABLE "backtest_monte_carlo_runs" ADD CONSTRAINT "backtest_monte_carlo_runs_runs_check"
      CHECK ("runs" >= 100 AND "runs" <= 100000);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'backtest_monte_carlo_runs_block_length_check'
  ) THEN
    ALTER TABLE "backtest_monte_carlo_runs" ADD CONSTRAINT "backtest_monte_carlo_runs_block_length_check"
      CHECK ("block_length" IS NULL OR "block_length" >= 2);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'backtest_monte_carlo_runs_sample_trades_check'
  ) THEN
    ALTER TABLE "backtest_monte_carlo_runs" ADD CONSTRAINT "backtest_monte_carlo_runs_sample_trades_check"
      CHECK ("sample_trades" >= 1);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'backtest_monte_carlo_runs_hash_check'
  ) THEN
    ALTER TABLE "backtest_monte_carlo_runs" ADD CONSTRAINT "backtest_monte_carlo_runs_hash_check"
      CHECK ("input_trades_hash" ~ '^[0-9a-f]{64}$');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'backtest_monte_carlo_runs_idempotency_key_check'
  ) THEN
    ALTER TABLE "backtest_monte_carlo_runs" ADD CONSTRAINT "backtest_monte_carlo_runs_idempotency_key_check"
      CHECK ("idempotency_key" ~ '^mcs1:[0-9a-f]{64}$');
  END IF;
END $$;

-- Idempotenz: derselbe Analyselauf (Key) existiert genau einmal.
CREATE UNIQUE INDEX IF NOT EXISTS "backtest_monte_carlo_runs_idempotency_key_unique"
  ON "backtest_monte_carlo_runs" ("idempotency_key");

-- Lese-Pfad: Analysen eines Quell-Runs, jüngste zuerst.
CREATE INDEX IF NOT EXISTS "backtest_monte_carlo_runs_source_idx"
  ON "backtest_monte_carlo_runs" ("source_run_id", "created_at");
