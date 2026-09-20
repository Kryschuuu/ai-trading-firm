# RMA-P4-01: Execution-Benchmarking

- **Antwort:** Teilweise
- **Tracking-Status:** `PARTIAL`
- **Severity:** `HIGH`
- **Quick Estimate Restaufwand:** **4–6 PT**
- **Umsetzungs-Prompt:** [`PROMPT-P4-01`](../prompts/PROMPT-P4-01-execution-benchmarking.md)

## Verifizierte Fundstellen

- `src/contracts/broker.ts::BrokerOrderResult` — gemeinsamer Orderresultat-Vertrag.
- `src/brokers/alpaca/execution.ts` und `src/brokers/bitunix/execution.ts` — venue-spezifische Ausführung/Auditierung.
- `src/backtest/types.ts::BacktestTradeLog` — Fees/Slippage im Backtestkontext.
- `src/brokers/reconciliation.ts` — Bestandsabgleich, aber kein Execution-Quality-Aggregat.

## Bewertung und Abgrenzung

Fills, Gebühren und einzelne Ausführungsdaten werden erfasst. Sie sind aber nicht zu einem einheitlichen Benchmark-Datensatz normalisiert, der Venue, Modus und Strategie fair vergleichbar macht.

## Konkretes Delta

- Decision-, Arrival-, Mid-, Limit- und Fill-Preise mit synchronisierten Timestamps
- Implementation Shortfall, VWAP-Slippage, Fill Ratio, Adverse Selection und Latenz
- Parent-/Child- sowie Intent-/Broker-ID-Korrelation
- append-only Persistenz und begrenzte Aggregations-API
- vergleichbare Semantik in Backtest, Paper und Live

## Akzeptanzkriterien für `FIXED`

- [ ] Buy-/Sell-Vorzeichen in Basispunkten sind mathematisch getestet
- [ ] partielle Fills werden mengen- und zeitgewichtet aggregiert
- [ ] fehlende Benchmarks bleiben null mit Reason, nicht 0 bp
- [ ] High-Cardinality-IDs werden nicht als Metrics-Labels exportiert

## Review-Evidenz

- Audit-Basis: Commit `df3163e`, Produktversion `v1.51.1`.
- Methode: statische Pfad-/Symbolprüfung, Schema- und Testabgleich; keine reine
  Dokumentationsbehauptung als Implementierungsbeleg.
- Tracking: [`../remediation/TRACKING.md`](../remediation/TRACKING.md)

## Teilumsetzung 2026-09-20

Auf aktuellem Stand `a09582f` (v1.55.0 statt Audit v1.51.1) wurde ein kanonischer
normalisierter Import-/PostgreSQL-/Read-API-Pfad ergänzt (Zielversion v1.56.0).
Details: `src/executionQuality/README.md`. Die automatische Strategy-/Broker-/
Backtest-Anbindung sowie die dort dokumentierten weiteren Akzeptanzlücken sind
nicht geschlossen. Status bleibt ausdrücklich `PARTIAL`, keine Fix-Version.
Test- und PR-Evidenz wird im Remediation-PR dokumentiert.
