# VBF-O2 — Walk-Forward ist die Vergleichsmaschine

- **Status:** VERIFIED
- **Audit-Punkt:** O2 „kein Walk-Forward, keine Kosten, kein Ledger“

## Befund

`src/backtest/walkforward.ts`, `backtest_runs` / `backtest_trades`, Funding aus
`perp_funding_rates` und `scripts/run-backtest.ts` sind implementiert
(GAP-01, RMA-P1-04, RMA-P2-02). Das ist nicht der Quick-Backtest der
Regel-Route.

## Entscheidung

Kein neuer Walk-Forward. Die Kostenlücke lag nur am Quick-Pfad (VBF-P1-01).
