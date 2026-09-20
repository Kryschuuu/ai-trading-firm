# RMA-P1-03: Backtest-Kennzahlen

- **Antwort:** Ja
- **Tracking-Status:** `VERIFIED`
- **Severity:** `INFO`
- **Quick Estimate Restaufwand:** **0 PT**
- **Umsetzungs-Prompt:** keiner — Kontrollbefund ohne blockerndes Delta

## Verifizierte Fundstellen

- `src/backtest/metrics.ts::computeBacktestMetrics()` — aggregiert Return-, Risiko- und Trade-Metriken.
- `src/portfolio/metrics.ts::sharpeRatio()` und `sortinoRatio()` — dokumentierte Log-Return-Formeln.
- `src/portfolio/metrics.ts::maxDrawdown()` — Peak-to-Trough-Drawdown.
- `tests/backtest.unit.test.ts` und `tests/portfolio.metrics.test.ts` — deterministische Kennzahltests.

## Bewertung und Abgrenzung

Trade-Anzahl, Win Rate, Profit Factor, Expectancy, Sharpe, Sortino, Max Drawdown, annualisierte Rendite und Volatilität sind vorhanden. Formeln, Annualisierung und Edge Cases sind in der Portfolio-Bibliothek dokumentiert. QA-01 dieses PRs korrigiert die fehlerhafte Verdrahtung der bereits vorgesehenen Volatilitätskennzahl.

## Konkretes Delta

- Kein blockerndes Roadmap-Delta. Optionale Metriken wie Omega oder Tail Ratio wären Scope-Erweiterungen und keine Voraussetzung dieses Befunds.

## Akzeptanzkriterien für `FIXED`

- [ ] Kontrollbefund bleibt durch Unit-Tests und dokumentierte Formeln abgesichert

## Review-Evidenz

- Audit-Basis: Commit `df3163e`, Produktversion `v1.51.1`.
- Methode: statische Pfad-/Symbolprüfung, Schema- und Testabgleich; keine reine
  Dokumentationsbehauptung als Implementierungsbeleg.
- Tracking: [`../remediation/TRACKING.md`](../remediation/TRACKING.md)
