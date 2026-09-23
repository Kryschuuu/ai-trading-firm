# RMA-P6-02: Monte-Carlo- und Trade-Resampling

- **Antwort:** Ja (seit v1.72.0)
- **Tracking-Status:** `FIXED`
- **Severity:** `MEDIUM`
- **Quick Estimate Restaufwand:** **3–5 PT**
- **Umsetzungs-Prompt:** [`PROMPT-P6-02`](../prompts/PROMPT-P6-02-monte-carlo.md)
- **Fix:** PR [#170](https://github.com/Kryschuuu/ai-trading-firm/pull/170), Version `v1.72.0`

## Verifizierte Fundstellen (Audit-Basis `df3163e` / v1.51.1)

- `src/backtest/engine.ts::runMultiAssetBacktest()` — deterministischer Basispfad.
- `src/backtest/walkforward.ts::aggregateWindowEvals()` — Fensteraggregate.
- `src/backtest/types.ts::BacktestTradeLog` — resamplingfähige Trade-Ergebnisse im Speicher.
- Keine Seed-/Bootstrap-/Block-Resampling-Engine oder Quantilpersistenz gefunden.

## Bewertung und Abgrenzung

Ein deterministischer Backtest ist notwendiger Input, aber keine Monte-Carlo-Analyse. Walk-Forward variiert Zeitfenster, nicht zufällige beziehungsweise geblockte Reihenfolgen oder Parameterrisiko.

## Umsetzung (v1.72.0)

- **Reine Engine `src/backtest/montecarlo.ts`:** IID-/Moving-/Stationary-Block-Bootstrap über das persistente Netto-Trade-Ledger (`backtest_trades`, RMA-P1-04 — bewusst nicht mehr der In-Memory-Log der Audit-Basis), Renditebasis `r_i = pnlNet_i/E_{i-1}` auf realisierter Quell-Equity, Wipe-/Ruin-Semantik, Nearest-Rank-Quantile p05/p50/p95 für End-Equity/MaxDD/Sharpe/Losing Streak, Exceedance-Wahrscheinlichkeiten + binomialer MCSE, First-Order-Kostenstress (`feeMultiplier`/`slippageMultiplier` ≥ 1, No-Op abgelehnt) mit bewiesener Monotonie.
- **Determinismus:** Repository-PRNG `mulberry32` (`mulberry32-v1`), persistierter Seed, Algorithmusversion `mc1`, abgeleiteter Idempotenz-Key `mcs1:<sha256>` (nicht überschreibbar); gleicher Seed/Config/Input ⇒ byte-identische Summary; persistierte Config + Ledger ⇒ identisches Replay.
- **Eligibility fail-closed:** nur RECONCILED-Ledger (NULL ≠ 0), kontiguierliche `seq`, Mindeststichprobe 30, ein Symbol, positive Quell-Equity, ableitbare Spanne (Annualisierung ∈ [1, 200 000] Trades/Jahr).
- **Produktionspfad:** CLI `scripts/run-montecarlo.ts` (einziger Schreibpfad, Artefakte `data/montecarlo/`), idempotente Persistenz `backtest_monte_carlo_runs` (append-only Migration `drizzle/2026-09-23_monte_carlo.sql`, CHECK-Constraints, FK ohne Cascade, NUR bounded Summary — keine Rohpfade), Read-API `GET /api/firm/montecarlo` + `GET /api/firm/montecarlo/[id]`, bounded Metriken + Audit-Events.
- **Grenzen dokumentiert:** kein Ersatz für OOS/Walk-Forward, kein Preisprozessmodell, keine Live-Risikofreigabe (keine Verdrahtung in Ceilings/Kill-Switches/Live-Gates).

## Akzeptanzkriterien für `FIXED`

- [x] gleicher Seed erzeugt bitstabile Simulationsergebnisse — `tests/backtest.montecarlo.test.ts` (byte-identisches Result; anderer Seed ändert Verteilung, nicht Metadaten)
- [x] bekannte Fixture-Verteilungen liefern analytisch prüfbare Quantile — konstante Verluste ⇒ Ruin-Wahrscheinlichkeit exakt 1, End-Equity ≈ `E₀·0.9³⁰`, MaxDD ≈ `(1−0.9³⁰)·100`, Streak = n; Moving-Block `L=n` ⇒ jeder Pfad = Original-Sequenz
- [x] Originaltrades werden nicht mutiert — Immutabilitätstest (deep-equal + Reihenfolge)
- [x] unzureichende Stichprobe bricht mit verständlichem Ergebnis statt Scheingenauigkeit ab — `mc:insufficient-sample` (< 30 Trades) u. a. Negative Paths
- [x] Persistenz/Jobs: Migration zweifach idempotent, Roundtrip, Idempotenz Retry/Restart (auch neue UUID ⇒ bestehende Zeile), Replay aus persistierter Config — `tests/backtest.montecarlo.db.test.ts` (eingebettete Postgres)

## Review-Evidenz

- Audit-Basis: Commit `df3163e`, Produktversion `v1.51.1`.
- Umsetzung: v1.72.0 auf v1.71.0 (Quelle: seit v1.52.0 persistentes Trade-Ledger statt In-Memory-Trade-Log).
- Methode: statische Pfad-/Symbolprüfung, Schema- und Testabgleich; keine reine
  Dokumentationsbehauptung als Implementierungsbeleg.
- Tests: `tests/backtest.montecarlo.test.ts` (25) + `tests/backtest.montecarlo.db.test.ts` (9) grün; Backtest-Regressionen `tests/backtest*.test.ts` 140 pass / 0 fail / 11 Skip (Umgebungs-DB); typecheck/lint/docs:validate grün.
- Tracking: [`../remediation/TRACKING.md`](../remediation/TRACKING.md)
