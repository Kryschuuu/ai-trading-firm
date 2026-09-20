-- RMA-P1-04 (v1.52.0) — persistente Backtest-Trades als
-- Trade-Level-Wahrheitsquelle. Append-only: EINE neue Tabelle
-- (`backtest_trades`) + vier NULL-bare Zusatzspalten an `backtest_runs`;
-- keine bestehende Migration wird verändert, keine Spalte umgebaut.
--
-- Hintergrund: `backtest_runs` (GAP-01) persistierte Config, Aggregate und
-- je Fenster nur einen sha256-Trade-Hash. Ein Hash ist weder abfragbar noch
-- ausreichend für Attribution, Drift-Analyse oder Fill-Debugging
-- (Roadmap-Audit 2026-09-20,
-- docs/audits/2026-09-20-roadmap-audit/findings/RMA-P1-04-backtest-trades.md).
--
-- `backtest_runs` (Zusatzspalten, alle NULL für Alt-Runs — NULL bedeutet
-- „kein Trade-Ledger persistiert“, bewusst NICHT 0):
--   - `idempotency_key`       stabiler Lauf-Schlüssel (`wf1:<sha256>`);
--                             partieller UNIQUE-Index ⇒ Retry liefert den
--                             bestehenden Run statt eines Duplikats.
--   - `trade_count`           Anzahl persistierter Trade-Zeilen.
--   - `reconciliation_status` `RECONCILED` — inkonsistente Läufe werden
--                             NICHT geschrieben (Transaktion rollt zurück).
--   - `reconciliation_json`   Abgleich-Evidenz (Checks, Deltas, Toleranzen,
--                             Fenster-Hashes).
--
-- `backtest_trades`:
--   Eine Zeile je abgeschlossenem Trade eines Evaluations-Laufs (Fenster ×
--   Segment IS/OOS). Entsteht NUR atomar mit dem Run
--   (`persistBacktestRun`, eine Transaktion; Read-back + Hash-Abgleich vor
--   COMMIT). `seq` = kanonische Reihenfolge (Fenster ↑, IS vor OOS, darin
--   Engine-Schließreihenfolge). Einheiten: Preise/Notional/PnL/Gebühren/
--   Funding/Slippage in Kontowährung, `qty` in Basiseinheiten, `pnl_pct` in
--   Prozent des Notionals; `pnl_net = pnl_gross − fees + funding`
--   (Kontosicht: Funding negativ = gezahlt). `funding` NULL = nicht
--   ausgewiesen (nicht 0). Zeiten = Ereigniszeit (Open-Zeitstempel der Kerze,
--   deren Schlusskurs den Fill referenziert); Berechnungszeit des Laufs =
--   `backtest_runs.created_at`.
--
--   FK ohne ON DELETE CASCADE (Repo-Konvention, fail-closed gegen stilles
--   Mitlöschen): ein Run mit Trades ist erst löschbar, wenn seine Trades
--   explizit gelöscht wurden. Es gibt keinen Code-Löschpfad (append-only).
--
--   Erwartetes Volumen: Fenster × (IS-Trades + OOS-Trades), typisch
--   10^3–10^4 Zeilen je Run (2 Jahre, 90/30 Tage ⇒ ~21 Fenster). Lesepfad:
--   Keyset-Paging über (`run_id`, `seq`) — Index-Range-Scan, kein OFFSET;
--   Filter (Segment/Fenster/Symbol) laufen über die zusätzlichen
--   Composite-Indizes bzw. als Heap-Filter innerhalb eines Runs.
--
-- Erklärt mit `npx drizzle-kit push` aus src/db/schema.ts (`backtestRuns`,
-- `backtestTrades`); diese Datei ist der äquivalente, idempotente SQL-Pfad
-- für Umgebungen ohne drizzle-kit
-- (z. B. `psql "$DATABASE_URL" -f drizzle/2026-09-20_backtest_trades.sql`).
--
-- Rollback (nur wenn KEIN v1.52.0-Code mehr läuft): die Zusatzspalten und
-- die Tabelle sind additiv — `DROP TABLE backtest_trades;` und
-- `ALTER TABLE backtest_runs DROP COLUMN …` für die vier Spalten stellen
-- den v1.51.x-Stand her; `backtest_runs`-Zeilen bleiben erhalten.

ALTER TABLE "backtest_runs" ADD COLUMN IF NOT EXISTS "idempotency_key" text;
ALTER TABLE "backtest_runs" ADD COLUMN IF NOT EXISTS "trade_count" integer;
ALTER TABLE "backtest_runs" ADD COLUMN IF NOT EXISTS "reconciliation_status" text;
ALTER TABLE "backtest_runs" ADD COLUMN IF NOT EXISTS "reconciliation_json" jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS "backtest_runs_idempotency_key_unique"
  ON "backtest_runs" ("idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'backtest_runs_trade_count_check'
  ) THEN
    ALTER TABLE "backtest_runs" ADD CONSTRAINT "backtest_runs_trade_count_check"
      CHECK ("trade_count" IS NULL OR "trade_count" >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'backtest_runs_reconciliation_status_check'
  ) THEN
    ALTER TABLE "backtest_runs" ADD CONSTRAINT "backtest_runs_reconciliation_status_check"
      CHECK ("reconciliation_status" IS NULL OR "reconciliation_status" IN ('RECONCILED'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "backtest_trades" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "run_id" uuid NOT NULL REFERENCES "backtest_runs"("id"),
  "seq" integer NOT NULL,
  "window_index" integer NOT NULL,
  "segment" text NOT NULL,
  "trade_ref" text NOT NULL,
  "strategy_id" text NOT NULL,
  "symbol" text NOT NULL,
  "side" text NOT NULL,
  "qty" numeric NOT NULL,
  "notional" numeric NOT NULL,
  "entry_ts" timestamptz NOT NULL,
  "exit_ts" timestamptz NOT NULL,
  "entry_price" numeric NOT NULL,
  "exit_price" numeric NOT NULL,
  "pnl_gross" numeric NOT NULL,
  "pnl_net" numeric NOT NULL,
  "pnl_pct" numeric NOT NULL,
  "fees" numeric NOT NULL,
  "funding" numeric,
  "slippage" numeric NOT NULL,
  "exit_reason" text NOT NULL,
  "duration_bars" integer NOT NULL,
  "provenance_json" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "backtest_trades_seq_check" CHECK ("seq" >= 1),
  CONSTRAINT "backtest_trades_window_index_check" CHECK ("window_index" >= 0),
  CONSTRAINT "backtest_trades_segment_check" CHECK ("segment" IN ('IS', 'OOS')),
  CONSTRAINT "backtest_trades_side_check" CHECK ("side" IN ('LONG', 'SHORT')),
  CONSTRAINT "backtest_trades_qty_check" CHECK ("qty" > 0),
  CONSTRAINT "backtest_trades_notional_check" CHECK ("notional" >= 0),
  CONSTRAINT "backtest_trades_prices_check" CHECK ("entry_price" > 0 AND "exit_price" > 0),
  CONSTRAINT "backtest_trades_time_check" CHECK ("exit_ts" >= "entry_ts"),
  CONSTRAINT "backtest_trades_fees_check" CHECK ("fees" >= 0),
  CONSTRAINT "backtest_trades_slippage_check" CHECK ("slippage" >= 0),
  CONSTRAINT "backtest_trades_duration_check" CHECK ("duration_bars" >= 1),
  CONSTRAINT "backtest_trades_exit_reason_check" CHECK (
    "exit_reason" IN ('STOP_LOSS', 'TAKE_PROFIT', 'SIGNAL_EXIT', 'MAX_HOLDING', 'RISK_STOP', 'END_OF_DATA')
  )
);

-- Stabile Sequenz je Run (Idempotenz: kein doppelter seq) + Keyset-Paging.
CREATE UNIQUE INDEX IF NOT EXISTS "backtest_trades_run_seq_unique"
  ON "backtest_trades" ("run_id", "seq");

-- Engine-Trade-ID ist je Evaluations-Lauf (Fenster × Segment) eindeutig.
CREATE UNIQUE INDEX IF NOT EXISTS "backtest_trades_run_window_ref_unique"
  ON "backtest_trades" ("run_id", "window_index", "segment", "trade_ref");

-- Filter-Pfade der Read-API (Segment/Fenster bzw. Symbol) innerhalb eines Runs.
CREATE INDEX IF NOT EXISTS "backtest_trades_run_window_idx"
  ON "backtest_trades" ("run_id", "window_index", "segment", "seq");

CREATE INDEX IF NOT EXISTS "backtest_trades_run_symbol_idx"
  ON "backtest_trades" ("run_id", "symbol", "seq");
