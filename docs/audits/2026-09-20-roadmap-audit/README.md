# Roadmap-Audit 2026-09-20 — Trading-Qualität, Agenten-Evaluation und Execution

**Quelle:** Interner, codebasierter Peer-Review gegen 25 Roadmap-Komponenten
**Reviewer:** Arena-Agent
**Audit-Basis:** `df3163e` (`main`, Produktversion `v1.51.1`)
**Audit-PR:** [#148](https://github.com/Kryschuuu/ai-trading-firm/pull/148) vom Branch `arena/01a0bba7-ai-trading-firm`
**Scope:** Backtesting, Research-Signale, Agenten-Evaluation, Execution, Risiko und Datenfundament
**Status:** OPEN — 21 konkrete Deltas sind über eigenständige Umsetzungs-Prompts geplant; vier Komponenten sind bereits verifiziert erfüllt.

> Dieses Audit ersetzt das abgeschlossene Audit
> [`2026-09-18-feature-gap`](../2026-09-18-feature-gap/README.md) nicht. Es prüft
> einen breiteren, präziseren Roadmap-Sollzustand gegen den nach dessen
> Remediation tatsächlich vorhandenen Code. Ähnliche Infrastruktur wird nicht
> als vollständige Erfüllung gewertet.

## Status-Zusammenfassung

| Komponente | Status | Aufwand | Finding | Umsetzungs-Prompt |
|---|---|---:|---|---|
| P1.1 Event-Replay mit realistischen Friktionen | PARTIAL | 5–8 PT | [RMA-P1-01](findings/RMA-P1-01-event-replay-frictions.md) | [PROMPT-P1-01](prompts/PROMPT-P1-01-event-replay-frictions.md) |
| P1.2 90d/30d Walk-Forward | PARTIAL | 4–6 PT | [RMA-P1-02](findings/RMA-P1-02-walk-forward-training.md) | [PROMPT-P1-02](prompts/PROMPT-P1-02-walk-forward-training.md) |
| P1.3 Backtest-Kennzahlen | VERIFIED | 0 PT | [RMA-P1-03](findings/RMA-P1-03-backtest-metrics.md) | — |
| P1.4 `backtest_runs` / `backtest_trades` | PARTIAL | 2–3 PT | [RMA-P1-04](findings/RMA-P1-04-backtest-trades.md) | [PROMPT-P1-04](prompts/PROMPT-P1-04-backtest-trades.md) |
| P1.5 Backtest↔Paper↔Live-Drift und Strategy-Lifecycle | OPEN | 8–12 PT | [RMA-P1-05](findings/RMA-P1-05-lifecycle-drift.md) | [PROMPT-P1-05](prompts/PROMPT-P1-05-lifecycle-drift.md) |
| P1.6 Trade-Attribution | PARTIAL | 3–5 PT | [RMA-P1-06](findings/RMA-P1-06-trade-attribution.md) | [PROMPT-P1-06](prompts/PROMPT-P1-06-trade-attribution.md) |
| P2.1 Regime-Erkennung | PARTIAL | 2–4 PT | [RMA-P2-01](findings/RMA-P2-01-regime-detection.md) | [PROMPT-P2-01](prompts/PROMPT-P2-01-regime-detection.md) |
| P2.2 Perpetual-Daten | PARTIAL | 5–8 PT | [RMA-P2-02](findings/RMA-P2-02-perpetual-data.md) | [PROMPT-P2-02](prompts/PROMPT-P2-02-perpetual-data.md) |
| P2.3 Multi-Timeframe-Konfluenz | PARTIAL | 3–5 PT | [RMA-P2-03](findings/RMA-P2-03-multi-timeframe-confluence.md) | [PROMPT-P2-03](prompts/PROMPT-P2-03-multi-timeframe-confluence.md) |
| P2.4 Cross-Sectional Ranking | OPEN | 3–5 PT | [RMA-P2-04](findings/RMA-P2-04-cross-sectional-ranking.md) | [PROMPT-P2-04](prompts/PROMPT-P2-04-cross-sectional-ranking.md) |
| P2.5 Strukturierte Sentiment-Outputs | PARTIAL | 2–3 PT | [RMA-P2-05](findings/RMA-P2-05-structured-sentiment.md) | [PROMPT-P2-05](prompts/PROMPT-P2-05-structured-sentiment.md) |
| P3.1 Brier Score / Kalibrierung | OPEN | 5–8 PT | [RMA-P3-01](findings/RMA-P3-01-forecast-calibration.md) | [PROMPT-P3-01](prompts/PROMPT-P3-01-forecast-calibration.md) |
| P3.2 Prompt-Version-Metrikvergleich | PARTIAL | 3–5 PT | [RMA-P3-02](findings/RMA-P3-02-prompt-performance.md) | [PROMPT-P3-02](prompts/PROMPT-P3-02-prompt-performance.md) |
| P3.3 Devil’s Advocate | OPEN | 2–4 PT | [RMA-P3-03](findings/RMA-P3-03-devils-advocate.md) | [PROMPT-P3-03](prompts/PROMPT-P3-03-devils-advocate.md) |
| P4.1 Execution-Benchmarking | PARTIAL | 4–6 PT | [RMA-P4-01](findings/RMA-P4-01-execution-benchmarking.md) | [PROMPT-P4-01](prompts/PROMPT-P4-01-execution-benchmarking.md) |
| P4.2 Post-Only + Timeout + Market-Fallback | PARTIAL | 3–5 PT | [RMA-P4-02](findings/RMA-P4-02-post-only-fallback.md) | [PROMPT-P4-02](prompts/PROMPT-P4-02-post-only-fallback.md) |
| P4.3 TWAP / Depth-Ausführung | OPEN | 5–8 PT | [RMA-P4-03](findings/RMA-P4-03-twap-depth.md) | [PROMPT-P4-03](prompts/PROMPT-P4-03-twap-depth.md) |
| P5.1 Volatility Targeting | PARTIAL | 2–4 PT | [RMA-P5-01](findings/RMA-P5-01-volatility-targeting.md) | [PROMPT-P5-01](prompts/PROMPT-P5-01-volatility-targeting.md) |
| P5.2 Fractional Kelly | VERIFIED | 0 PT | [RMA-P5-02](findings/RMA-P5-02-fractional-kelly.md) | — |
| P5.3 Korrelations-/Cluster-Limits | VERIFIED | 0 PT | [RMA-P5-03](findings/RMA-P5-03-cluster-limits.md) | — |
| P5.4 Drawdown-Scaling | PARTIAL | 2–3 PT | [RMA-P5-04](findings/RMA-P5-04-drawdown-scaling.md) | [PROMPT-P5-04](prompts/PROMPT-P5-04-drawdown-scaling.md) |
| P5.5 Signal-Decay-Exits | OPEN | 3–5 PT | [RMA-P5-05](findings/RMA-P5-05-signal-decay-exits.md) | [PROMPT-P5-05](prompts/PROMPT-P5-05-signal-decay-exits.md) |
| P6.1 Point-in-Time Feature Store | OPEN | 7–12 PT | [RMA-P6-01](findings/RMA-P6-01-point-in-time-feature-store.md) | [PROMPT-P6-01](prompts/PROMPT-P6-01-point-in-time-feature-store.md) |
| P6.2 Monte-Carlo-Simulation | OPEN | 3–5 PT | [RMA-P6-02](findings/RMA-P6-02-monte-carlo.md) | [PROMPT-P6-02](prompts/PROMPT-P6-02-monte-carlo.md) |
| P6.3 Data-Quality-Checks | VERIFIED | 0 PT | [RMA-P6-03](findings/RMA-P6-03-data-quality.md) | — |

**Verteilung:** 4 VERIFIED · 13 PARTIAL · 8 OPEN.
**Schätzung:** 76–124 PT für alle verbleibenden Deltas bei sequenzieller Umsetzung.

## TOP-3-Gating-Faktoren

1. **RMA-P1-05 — Strategy-Lifecycle und Drift:** Keine kontrollierte Promotion
   oder automatische Degradation zwischen Backtest, Paper und Live.
2. **RMA-P1-02 — echtes Walk-Forward-Training:** Vorhanden ist ein sauberer
   Split-and-Replay, aber keine IS-Selektion mit eingefrorenem OOS-Test und
   finalem Holdout.
3. **RMA-P1-04 — persistente Backtest-Trades:** Run-Aggregate und Trade-Hashes
   reichen nicht für Drift, Attribution und Trade-Level-Reproduzierbarkeit.

## Sofort behobene Peer-Review-Bugs

Neben den Roadmap-Deltas wurden zwei klar abgegrenzte Bestandsfehler gefunden
und in diesem Audit-PR behoben:

- **QA-01:** `computeBacktestMetrics()` gab für `annualizedVolatility` immer
  `0` zurück, weil ein nicht existentes Feld von `sharpeRatio()` gelesen wurde.
- **QA-02:** `loadQualityReport()` verwarf beim Einlesen die aggregierten
  Quality-Zähler und `crosscheckCompared`.

Details und Regressionstests stehen in [`report.md`](report.md).

## Artefakte

- [`report.md`](report.md) — vollständiger Auditbericht, Methodik und Befunde.
- [`findings/`](findings/) — ein verifizierter Befund pro Roadmap-Komponente.
- [`prompts/README.md`](prompts/README.md) — Reihenfolge, Abhängigkeiten und
  Benutzung der 21 vollständigen Umsetzungs-Prompts.
- [`prompts/PROMPT-00-baseline.md`](prompts/PROMPT-00-baseline.md) — gemeinsame
  Architektur- und Qualitätsregeln als Reviewer-Referenz.
- [`remediation/TRACKING.md`](remediation/TRACKING.md) — Status-SSoT.

## Statusmodell

- `OPEN`: geforderte Funktion fehlt.
- `PARTIAL`: ähnliche bzw. wesentliche Infrastruktur existiert, das konkrete
  Roadmap-Ziel ist aber nicht vollständig erfüllt.
- `VERIFIED`: Roadmap-Komponente ist im Code belegt; optionale Härtung ist kein
  blockerndes Delta.
- `IN_PROGRESS`, `FIXED`, `WONTFIX`: Remediation-Status nach Start eines Prompts.
