# RMA-P1-04: Persistente `backtest_runs` und `backtest_trades`

- **Antwort:** Ja (seit v1.52.0)
- **Tracking-Status:** `FIXED`
- **Severity:** `CRITICAL`
- **Quick Estimate Restaufwand:** **0 PT** (Audit-Schätzung war 2–3 PT)
- **Umsetzungs-Prompt:** [`PROMPT-P1-04`](../prompts/PROMPT-P1-04-backtest-trades.md)
- **Fix:** PR [#149](https://github.com/Kryschuuu/ai-trading-firm/pull/149), Commit `88161dc`, Fix-Version **v1.52.0**, Branch `arena/01a0bf70-ai-trading-firm`

## Verifizierte Fundstellen

- `src/db/schema.ts::backtestRuns` — persistiert Run-Metadaten, Zeitfenster, Konfiguration und Metriken.
- `src/backtest/runStore.ts::insertBacktestRun()` — schreibt Runs.
- `src/app/api/firm/backtests/route.ts` und `src/app/api/firm/backtests/[id]/route.ts` — List-/Detailzugriff.
- `src/backtest/types.ts::BacktestTradeLog` — Trade-Daten existieren nur im Laufzeitergebnis.

## Bewertung und Abgrenzung

Run-Level-Persistenz und ein Hash des Trade-Ergebnisses sind vorhanden. Damit kann ein Lauf identifiziert und verglichen werden. Ein Hash ist aber weder abfragbar noch ausreichend für Attribution, Drift oder Debugging einzelner Fills.

## Konkretes Delta

- append-only Tabelle `backtest_trades` mit FK zum Run
- stabile Trade-ID/Sequenz sowie Instrument, Richtung, Entry/Exit, Mengen und Timestamps
- Fees, Funding, Slippage, Exit-Grund, Signal-/Regel-/Prompt-Referenzen
- atomare Run-plus-Trades-Persistenz und idempotente Wiederholung
- paginierter, begrenzter API-Zugriff ohne unbeschränkte Payloads

## Akzeptanzkriterien für `FIXED`

- [x] Run und Trades werden in einer Transaktion oder gar nicht geschrieben —
  `persistBacktestRun()` (`src/backtest/runStore.ts`): Run-Zeile + Trade-Chunks +
  Read-back-Abgleich in EINER `db.transaction`; Tests „Fehler bei Trade N
  (DB-Constraint bzw. Exception) rollt Run UND Trades zurück“ und
  „Read-back-Abgleich fail-closed“.
- [x] Trade-Zeilen rekonstruieren exakt die Run-Aggregate —
  `reconcileTradeLedger()` (`src/backtest/tradeLedger.ts`): Anzahl/Gewinner/
  Netto-PnL exakt, Gebühren/Slippage/Funding innerhalb dokumentierter
  Rundungstoleranzen, Trade-Hash je Fenster/Segment aus den Zeilen == gespeicherter
  Hash; Evidenz in `backtest_runs.reconciliation_json`. Tests „Trade-Hash je
  Fenster/Segment aus den Zeilen == Report-Hash“, „Roundtrip … Aggregate + Hash aus
  DB-Zeilen reproduziert“, „manipulierte Aggregate/Zeilen ⇒ Abweisung“.
- [x] identische Run-ID/Idempotency-Key erzeugt keine Duplikate —
  `backtest_runs.idempotency_key` (partiell UNIQUE) + `UNIQUE (run_id, seq)`;
  Tests „Idempotenz: Retry (sequentiell) ⇒ exakt 1 Run + N Trades“ und
  „Idempotenz unter Parallelität“ (3 gleichzeitige Writer ⇒ 1 Run, N Trades,
  gleiche UUID).
- [x] bestehende Run-API bleibt rückwärtskompatibel — `GET /api/firm/backtests`
  unverändert (keine Trades), `GET /api/firm/backtests/[id]` liefert `run` wie
  bisher und additiv `ledger`/`trades`/`links`; neue Route
  `GET /api/firm/backtests/[id]/trades` (Limit 1..500, Cursor, Filter). Tests
  „Detail additiv …, Liste ohne Trades“, „Alt-Run ohne Ledger ⇒ UNAVAILABLE“,
  bestehende `tests/backtest.engine.test.ts` grün.

## Umsetzung (v1.52.0)

- Schema/Migration: `src/db/schema.ts::backtestTrades` + Zusatzspalten an
  `backtestRuns`; `drizzle/2026-09-20_backtest_trades.sql` (append-only,
  idempotent, FK ohne Cascade, 12 CHECKs, Keyset-/Filter-Indizes).
- Reine Abbildung + Abgleich + Cursor/Query-Validatoren:
  `src/backtest/tradeLedger.ts`.
- Atomarer, idempotenter Write + Read-API-Zugriff: `src/backtest/runStore.ts`
  (`persistBacktestRun`, `listBacktestTrades`, `runLedgerView`).
- Routen: `src/app/api/firm/backtests/[id]/route.ts` (additiv),
  `src/app/api/firm/backtests/[id]/trades/route.ts` (neu).
- Report/CLI: `src/backtest/walkforward.ts` (`netPnl`, `slippage`, `trades[]`),
  `scripts/run-backtest.ts` (`--idempotency-key`, Artefakte unter persistierter
  UUID, Exit 1 ohne DB-Zeile bei Ablehnung).
- Audit/Metrik: `BACKTEST_RUN_PERSISTED` / `BACKTEST_RUN_PERSIST_FAILED`
  (Katalog `src/lib/auditView.ts`), `backtest_run_persist_total{result,reason}`.
- Doku: [`docs/BACKTESTING.md`](../../../BACKTESTING.md) §5.1/§5.2 (Schema,
  Einheiten, Zeitsemantik, Rundung, Abgleich, Idempotenz, Volumen + gemessene
  Query-Pläne, Retention/Rollback, API-Vertrag).
- Testevidenz: `tests/backtest.tradeLedger.test.ts` (26 Tests, davon 9
  DB-gegated mit ping → skip; mit lokaler PostgreSQL 17: 26/26 grün).
- Bewusst nicht enthalten (Prompt-Nicht-Ziele): Attributionsmodell (P1.6),
  Strategie-Lifecycle (P1.5), UI-Redesign, Retention-Job.

## Review-Evidenz

- Audit-Basis: Commit `df3163e`, Produktversion `v1.51.1`.
- Methode: statische Pfad-/Symbolprüfung, Schema- und Testabgleich; keine reine
  Dokumentationsbehauptung als Implementierungsbeleg.
- Tracking: [`../remediation/TRACKING.md`](../remediation/TRACKING.md)
