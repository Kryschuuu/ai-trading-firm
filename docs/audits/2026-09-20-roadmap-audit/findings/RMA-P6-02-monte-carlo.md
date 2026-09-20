# RMA-P6-02: Monte-Carlo- und Trade-Resampling

- **Antwort:** Nein
- **Tracking-Status:** `OPEN`
- **Severity:** `MEDIUM`
- **Quick Estimate Restaufwand:** **3–5 PT**
- **Umsetzungs-Prompt:** [`PROMPT-P6-02`](../prompts/PROMPT-P6-02-monte-carlo.md)

## Verifizierte Fundstellen

- `src/backtest/engine.ts::runMultiAssetBacktest()` — deterministischer Basispfad.
- `src/backtest/walkforward.ts::aggregateWindowEvals()` — Fensteraggregate.
- `src/backtest/types.ts::BacktestTradeLog` — resamplingfähige Trade-Ergebnisse im Speicher.
- Keine Seed-/Bootstrap-/Block-Resampling-Engine oder Quantilpersistenz gefunden.

## Bewertung und Abgrenzung

Ein deterministischer Backtest ist notwendiger Input, aber keine Monte-Carlo-Analyse. Walk-Forward variiert Zeitfenster, nicht zufällige beziehungsweise geblockte Reihenfolgen oder Parameterrisiko.

## Konkretes Delta

- reproduzierbarer PRNG mit persistiertem Seed und Algorithmusversion
- IID-Trade-Bootstrap und blockweises Resampling zum Erhalt serieller Abhängigkeit
- Kosten-/Slippage-/Parameter-Stressszenarien
- Verteilungen und Quantile für MaxDD, Ruin, Sharpe, End-Equity und Losing Streak
- Stichprobengates und Warnungen gegen falsche Präzision

## Akzeptanzkriterien für `FIXED`

- [ ] gleicher Seed erzeugt bitstabile Simulationsergebnisse
- [ ] bekannte Fixture-Verteilungen liefern plausible/analytisch prüfbare Quantile
- [ ] Originaltrades werden nicht mutiert
- [ ] unzureichende Stichprobe bricht mit verständlichem Ergebnis statt Scheingenauigkeit ab

## Review-Evidenz

- Audit-Basis: Commit `df3163e`, Produktversion `v1.51.1`.
- Methode: statische Pfad-/Symbolprüfung, Schema- und Testabgleich; keine reine
  Dokumentationsbehauptung als Implementierungsbeleg.
- Tracking: [`../remediation/TRACKING.md`](../remediation/TRACKING.md)
