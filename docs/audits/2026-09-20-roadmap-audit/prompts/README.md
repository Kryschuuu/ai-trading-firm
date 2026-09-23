# Eigenständige Umsetzungs-Prompts

Dieses Verzeichnis enthält **21 produktionsreife, eigenständig ausführbare
Prompts** für alle Roadmap-Komponenten, die auf der Audit-Basis `PARTIAL`
oder `OPEN` waren. **Stand v1.73.0:** alle 21 Deltas sind `FIXED` (SSoT
[`../remediation/TRACKING.md`](../remediation/TRACKING.md)). Komponenten mit
`VERIFIED` erhalten bewusst keinen künstlichen Implementierungsauftrag; ihre
Kontrollbefunde stehen unter `../findings/`.

Jeder Prompt wiederholt Repository-Kontext, verbindlichen Scope,
Produktions-/Sicherheitsregeln, konkrete Deliverables, Tests,
Akzeptanzkriterien sowie Dokumentations-, SemVer-, Tracking-, Commit- und
PR-Pflichten. [`PROMPT-00-baseline.md`](PROMPT-00-baseline.md) dient zusätzlich
als serienweite Reviewer-Checkliste.

## Benutzung

1. **Genau einen Prompt pro PR** übernehmen, sofern die unten genannten
   Abhängigkeiten nicht ausdrücklich einen gemeinsamen Slice verlangen.
2. Vor der Implementierung den aktuellen Code prüfen. Die verifizierte
   Audit-Basis ist `df3163e` (`v1.51.1`), nicht zwangsläufig der spätere Stand.
3. Das zugehörige Finding nicht vor belegter Definition of Done auf `FIXED`
   setzen.
4. Evidenz (PR, Commit, Tests, Fix-Version) in
   [`../remediation/TRACKING.md`](../remediation/TRACKING.md) ergänzen.
5. Bei Scopeänderungen Finding/Prompt versioniert anpassen, statt still vom
   Akzeptanzvertrag abzuweichen.

## Empfohlene Reihenfolge

| Welle | Prompt | Zweck / Voraussetzung |
|---:|---|---|
| 1 | [P1.4 Backtest-Trades](PROMPT-P1-04-backtest-trades.md) | Trade-Level-SSoT für Attribution, Drift und Monte Carlo |
| 1 | [P6.1 Point-in-Time Feature Store](PROMPT-P6-01-point-in-time-feature-store.md) | Look-ahead-sichere Researchbasis; mit kleinem vertikalem Slice starten |
| 1 | [P2.2 Perpetual-Daten](PROMPT-P2-02-perpetual-data.md) | Historische Funding-/OI-/Liquidationswahrheit |
| 1 | [P3.1 Forecast-Kalibrierung](PROMPT-P3-01-forecast-calibration.md) | Forecast-/Outcome-SSoT für Agentenevaluation |
| 1 | [P4.1 Execution-Benchmarking](PROMPT-P4-01-execution-benchmarking.md) | Execution-SSoT für Fallback, TWAP und Drift |
| 2 | [P1.6 Trade-Attribution](PROMPT-P1-06-trade-attribution.md) | benötigt belastbare Trades; kann Forecast-IDs nutzen |
| 2 | [P1.1 Event-Replay](PROMPT-P1-01-event-replay-frictions.md) | nutzt Perp-Zeitreihen und Fill-/Benchmark-Semantik |
| 2 | [P1.2 Walk-Forward](PROMPT-P1-02-walk-forward-training.md) | echte OOS-Evidenz für Lifecycle |
| 2 | [P2.1 Regime](PROMPT-P2-01-regime-detection.md) | profitiert von Feature Store und Perp-Daten |
| 2 | [P2.3 MTF-Konfluenz](PROMPT-P2-03-multi-timeframe-confluence.md) | profitiert vom Feature Store |
| 2 | [P2.4 Cross-Sectional Ranking](PROMPT-P2-04-cross-sectional-ranking.md) | profitiert vom Feature Store/Universe Snapshots |
| 2 | [P2.5 Sentiment](PROMPT-P2-05-structured-sentiment.md) | liefert Forecast-Envelope für P3.1 |
| 2 | [P3.2 Prompt-Vergleich](PROMPT-P3-02-prompt-performance.md) | benötigt Forecast-/Outcome- und Promptprovenance |
| 2 | [P3.3 Devil’s Advocate](PROMPT-P3-03-devils-advocate.md) | nutzt strukturierten Evaluationspfad |
| 2 | [P5.1 Volatility Targeting](PROMPT-P5-01-volatility-targeting.md) | kontinuierlicher Risk-Faktor |
| 2 | [P5.4 Drawdown-Scaling](PROMPT-P5-04-drawdown-scaling.md) | mit Vol-Targeting in Authority Chain komponieren |
| 2 | [P5.5 Signal-Decay](PROMPT-P5-05-signal-decay-exits.md) | profitiert von versionierten Feature-/Signalsnapshots |
| 3 | [P4.2 Post-Only-Fallback](PROMPT-P4-02-post-only-fallback.md) | sollte P4.1-Messung wiederverwenden |
| 3 | [P4.3 TWAP/Depth](PROMPT-P4-03-twap-depth.md) | baut auf P4.1 und P4.2 auf |
| 3 | [P6.2 Monte Carlo](PROMPT-P6-02-monte-carlo.md) | bevorzugt persistierte P1.4-Tradequelle |
| 4 | [P1.5 Lifecycle/Drift](PROMPT-P1-05-lifecycle-drift.md) | TOP-Gate; integriert Evidenz aus Backtest, Paper, Execution und Risiko |

## Abhängigkeitsregeln

- Wenn eine Voraussetzung noch offen ist, darf ein Folgeprompt eine kleine
  typisierte Schnittstelle vorbereiten, aber **nicht** das vorgelagerte Finding
  im selben PR nebenbei vollständig implementieren.
- P1.5 ist zuletzt gelistet, obwohl es höchste fachliche Dringlichkeit besitzt:
  Ein Lifecycle ohne belastbare Evidenzquellen wäre nur eine Statusmaschine mit
  Scheinsicherheit.
- P4.3 darf P4.2 als Controller verwenden; es soll keine zweite Order-State-
  Machine erfinden.
- P2.3/P2.4/P2.1 sollen eine vorhandene P6.1-Registry nutzen, falls diese bis
  dahin existiert. Andernfalls pure Funktionen so schneiden, dass spätere
  Registrierung ohne Semantikwechsel möglich ist.

## Prompt-Inventar nach Roadmap-Priorität

### P1

- [`PROMPT-P1-01-event-replay-frictions.md`](PROMPT-P1-01-event-replay-frictions.md)
- [`PROMPT-P1-02-walk-forward-training.md`](PROMPT-P1-02-walk-forward-training.md)
- [`PROMPT-P1-04-backtest-trades.md`](PROMPT-P1-04-backtest-trades.md)
- [`PROMPT-P1-05-lifecycle-drift.md`](PROMPT-P1-05-lifecycle-drift.md)
- [`PROMPT-P1-06-trade-attribution.md`](PROMPT-P1-06-trade-attribution.md)

### P2

- [`PROMPT-P2-01-regime-detection.md`](PROMPT-P2-01-regime-detection.md)
- [`PROMPT-P2-02-perpetual-data.md`](PROMPT-P2-02-perpetual-data.md)
- [`PROMPT-P2-03-multi-timeframe-confluence.md`](PROMPT-P2-03-multi-timeframe-confluence.md)
- [`PROMPT-P2-04-cross-sectional-ranking.md`](PROMPT-P2-04-cross-sectional-ranking.md)
- [`PROMPT-P2-05-structured-sentiment.md`](PROMPT-P2-05-structured-sentiment.md)

### P3

- [`PROMPT-P3-01-forecast-calibration.md`](PROMPT-P3-01-forecast-calibration.md)
- [`PROMPT-P3-02-prompt-performance.md`](PROMPT-P3-02-prompt-performance.md)
- [`PROMPT-P3-03-devils-advocate.md`](PROMPT-P3-03-devils-advocate.md)

### P4

- [`PROMPT-P4-01-execution-benchmarking.md`](PROMPT-P4-01-execution-benchmarking.md)
- [`PROMPT-P4-02-post-only-fallback.md`](PROMPT-P4-02-post-only-fallback.md)
- [`PROMPT-P4-03-twap-depth.md`](PROMPT-P4-03-twap-depth.md)

### P5

- [`PROMPT-P5-01-volatility-targeting.md`](PROMPT-P5-01-volatility-targeting.md)
- [`PROMPT-P5-04-drawdown-scaling.md`](PROMPT-P5-04-drawdown-scaling.md)
- [`PROMPT-P5-05-signal-decay-exits.md`](PROMPT-P5-05-signal-decay-exits.md)

### P6

- [`PROMPT-P6-01-point-in-time-feature-store.md`](PROMPT-P6-01-point-in-time-feature-store.md)
- [`PROMPT-P6-02-monte-carlo.md`](PROMPT-P6-02-monte-carlo.md)
