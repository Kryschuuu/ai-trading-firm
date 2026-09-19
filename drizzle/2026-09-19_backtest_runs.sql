-- GAP-01 (v1.51.0) — Walk-Forward-Runs vergleichbar persistieren.
-- Append-only: NUR eine neue Tabelle (+ Index), keine Umbauten an
-- bestehenden Tabellen.
--
-- Hintergrund: Die Multi-Asset-Engine (`src/backtest/`) replayt Regeln
-- deterministisch, aber Runs waren nicht vergleichbar persistiert (keine
-- Walk-Forward-Fenster, keine Zeitmasken-Architektur über Zeiträume, Audit
-- 2026-09-18,
-- docs/audits/2026-09-18-feature-gap/findings/GAP-01-backtesting-walk-forward.md).
--
-- `backtest_runs`:
--   Ein Walk-Forward-Lauf = EINE Zeile (insert-only, kein Update-Pfad):
--     - `params_json`:  Regel-Referenz + Regel-Spezifikation + Fenster
--       (IS/OOS-Längen, Fensteranzahl, Truncation) + Kostenprofil
--       (Paper-Ausführung: Fees, Spread-Fallback, Funding-Rate, Seed).
--     - `metrics_json`: Aggregate OOS/IS (Trades, Win-Rate, PnL,
--       Profit-Factor, MaxDD, Sharpe, Sortino, Gebühren, Funding).
--     - `windows_json`: Kennzahlen + Trade-Hash (sha256) je IS/OOS-Fenster.
--     - `code_version`: APP_VERSION des Laufs (Vergleichbarkeit über
--       Releases hinweg).
--   Runs entstehen NUR via CLI (`scripts/run-backtest.ts`); Lesen via
--   `GET /api/firm/backtests` + `GET /api/firm/backtests/[id]` (`firm.read`).
--
-- Erklärt mit `npx drizzle-kit push` aus src/db/schema.ts
-- (`backtestRuns`); diese Datei ist der äquivalente, idempotente SQL-Pfad
-- für Umgebungen ohne drizzle-kit
-- (z. B. `psql "$DATABASE_URL" -f drizzle/2026-09-19_backtest_runs.sql`).

CREATE TABLE IF NOT EXISTS "backtest_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "instrument_id" text NOT NULL,
  "timeframe" text NOT NULL,
  "from_ts" timestamptz NOT NULL,
  "to_ts" timestamptz NOT NULL,
  "params_json" jsonb NOT NULL,
  "metrics_json" jsonb NOT NULL,
  "windows_json" jsonb NOT NULL,
  "code_version" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "backtest_runs_instrument_idx"
  ON "backtest_runs" ("instrument_id", "created_at");
