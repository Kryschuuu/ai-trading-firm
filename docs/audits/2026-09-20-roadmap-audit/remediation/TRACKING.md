# Remediation-Tracking — Roadmap-Audit 2026-09-20

**Single Source of Truth für den Status dieses Auditzyklus.**
Audit-Basis: `df3163e` / `v1.51.1`
Audit-Paket: [PR #148](https://github.com/Kryschuuu/ai-trading-firm/pull/148), Commit `c8dded3`, Zielversion `v1.51.3`
Letzte Aktualisierung: 2026-09-20

## Statusmodell

- `OPEN`: Roadmap-Komponente fehlt.
- `PARTIAL`: relevante Infrastruktur ist vorhanden, das definierte Delta offen.
- `IN_PROGRESS`: ein verlinkter PR implementiert das Delta.
- `FIXED`: alle Akzeptanzkriterien, Tests und Dokumentationspflichten sind mit
  Evidenz erfüllt.
- `VERIFIED`: bei Audit-Basis vollständig erfüllter Kontrollbefund.
- `WONTFIX`: bewusste Produktentscheidung mit dokumentierter Begründung.

`FIXED` darf nur mit PR, Commit, Fix-Version und Testevidenz gesetzt werden.
`VERIFIED` ist kein Synonym für „nicht geprüft“, sondern besitzt einen
codebasierten Detailbefund.

## TOP-3-Gates

| Rang | Finding | Status | Warum gate-relevant |
|---:|---|---|---|
| 1 | [RMA-P1-05](../findings/RMA-P1-05-lifecycle-drift.md) | OPEN | Keine evidenzbasierte Promotion/Degradation zwischen Backtest, Paper und Live |
| 2 | [RMA-P1-02](../findings/RMA-P1-02-walk-forward-training.md) | PARTIAL | OOS ist Replay, nicht Train-Select-Freeze-Test |
| 3 | [RMA-P1-04](../findings/RMA-P1-04-backtest-trades.md) | PARTIAL | Keine abfragbare Trade-Level-Wahrheitsquelle |

## Roadmap-Status

| ID | Komponente | Status | Prompt | PR | Commit | Fix-Version | Testevidenz |
|---|---|---|---|---|---|---|---|
| RMA-P1-01 | Event-Replay/Friktionen | PARTIAL | [P1-01](../prompts/PROMPT-P1-01-event-replay-frictions.md) | — | — | — | Auditbefund |
| RMA-P1-02 | 90d/30d Walk-Forward | PARTIAL | [P1-02](../prompts/PROMPT-P1-02-walk-forward-training.md) | — | — | — | Auditbefund |
| RMA-P1-03 | Backtest-Kennzahlen | VERIFIED | — | — | `df3163e` + QA-01-Fix | v1.51.3 | Kennzahltests + QA-01-Regression |
| RMA-P1-04 | Persistente Backtest-Trades | PARTIAL | [P1-04](../prompts/PROMPT-P1-04-backtest-trades.md) | — | — | — | Auditbefund |
| RMA-P1-05 | Lifecycle/Drift | OPEN | [P1-05](../prompts/PROMPT-P1-05-lifecycle-drift.md) | — | — | — | Auditbefund |
| RMA-P1-06 | Trade-Attribution | PARTIAL | [P1-06](../prompts/PROMPT-P1-06-trade-attribution.md) | — | — | — | Auditbefund |
| RMA-P2-01 | Regime-Erkennung | PARTIAL | [P2-01](../prompts/PROMPT-P2-01-regime-detection.md) | — | — | — | Auditbefund |
| RMA-P2-02 | Perpetual-Daten | PARTIAL | [P2-02](../prompts/PROMPT-P2-02-perpetual-data.md) | — | — | — | Auditbefund |
| RMA-P2-03 | MTF-Konfluenz | PARTIAL | [P2-03](../prompts/PROMPT-P2-03-multi-timeframe-confluence.md) | — | — | — | Auditbefund |
| RMA-P2-04 | Cross-Sectional Ranking | OPEN | [P2-04](../prompts/PROMPT-P2-04-cross-sectional-ranking.md) | — | — | — | Auditbefund |
| RMA-P2-05 | Sentiment-Outputs | PARTIAL | [P2-05](../prompts/PROMPT-P2-05-structured-sentiment.md) | — | — | — | Auditbefund |
| RMA-P3-01 | Forecast-Kalibrierung | OPEN | [P3-01](../prompts/PROMPT-P3-01-forecast-calibration.md) | — | — | — | Auditbefund |
| RMA-P3-02 | Prompt-Metrikvergleich | PARTIAL | [P3-02](../prompts/PROMPT-P3-02-prompt-performance.md) | — | — | — | Auditbefund |
| RMA-P3-03 | Devil’s Advocate | OPEN | [P3-03](../prompts/PROMPT-P3-03-devils-advocate.md) | — | — | — | Auditbefund |
| RMA-P4-01 | Execution-Benchmarking | PARTIAL | [P4-01](../prompts/PROMPT-P4-01-execution-benchmarking.md) | — | — | — | Auditbefund |
| RMA-P4-02 | Post-Only-Fallback | PARTIAL | [P4-02](../prompts/PROMPT-P4-02-post-only-fallback.md) | — | — | — | Auditbefund |
| RMA-P4-03 | TWAP/Depth | OPEN | [P4-03](../prompts/PROMPT-P4-03-twap-depth.md) | — | — | — | Auditbefund |
| RMA-P5-01 | Volatility Targeting | PARTIAL | [P5-01](../prompts/PROMPT-P5-01-volatility-targeting.md) | — | — | — | Auditbefund |
| RMA-P5-02 | Fractional Kelly | VERIFIED | — | — | `df3163e` | v1.51.1 | `tests/positionSizing.test.ts` |
| RMA-P5-03 | Cluster-Limits | VERIFIED | — | — | `df3163e` | v1.51.1 | Portfolio-Risk-Guard-Tests |
| RMA-P5-04 | Drawdown-Scaling | PARTIAL | [P5-04](../prompts/PROMPT-P5-04-drawdown-scaling.md) | — | — | — | Auditbefund |
| RMA-P5-05 | Signal-Decay-Exits | OPEN | [P5-05](../prompts/PROMPT-P5-05-signal-decay-exits.md) | — | — | — | Auditbefund |
| RMA-P6-01 | Point-in-Time Feature Store | OPEN | [P6-01](../prompts/PROMPT-P6-01-point-in-time-feature-store.md) | — | — | — | Auditbefund |
| RMA-P6-02 | Monte Carlo | OPEN | [P6-02](../prompts/PROMPT-P6-02-monte-carlo.md) | — | — | — | Auditbefund |
| RMA-P6-03 | Data Quality | VERIFIED | — | — | `df3163e` + QA-02-Fix | v1.51.3 | Quality-Tests + QA-02-Roundtrip |

## Sofort-Remediation aus dem Peer-Review

| ID | Fehler | Status | Fix-Version | Evidenz |
|---|---|---|---|---|
| QA-01 | `annualizedVolatility` las nicht existentes Sharpe-Feld und war immer 0 | FIXED | v1.51.3 | `src/backtest/metrics.ts`, `tests/backtest.unit.test.ts` |
| QA-02 | `loadQualityReport()` verlor aggregierte Summen und `crosscheckCompared` | FIXED | v1.51.3 | `src/marketdata/quality.ts`, `test/marketdata/quality.test.ts` |

PR [#148](https://github.com/Kryschuuu/ai-trading-firm/pull/148) und Commit
`c8dded3` sind die übergeordnete Evidenz für das Audit-Paket. Die 21
Roadmap-Deltas bleiben bewusst offen und werden nicht durch die Dokumentation
dieses PRs als umgesetzt markiert.
