# RMA-P1-01: Event-Replay mit realistischen Friktionen

- **Antwort:** Teilweise
- **Tracking-Status:** `PARTIAL`
- **Severity:** `HIGH`
- **Quick Estimate Restaufwand:** **5–8 PT**
- **Umsetzungs-Prompt:** [`PROMPT-P1-01`](../prompts/PROMPT-P1-01-event-replay-frictions.md)

## Verifizierte Fundstellen

- `src/backtest/engine.ts::runMultiAssetBacktest()` — deterministische, chronologisch sortierte Multi-Asset-Bar-Events.
- `src/backtest/paperExecution.ts::createPaperExecutionRuntime()` mit `PaperExecutionRuntime.fillEntry()`/`fillExit()` — Spread-, Slippage-, Partial-Fill- und Gebührenmodell im Paper-Ausführungspfad.
- `src/backtest/types.ts::BacktestEngineConfig` — auswählbares Slippage-/Execution-Modell.
- `src/lib/funding.ts::FundingAccrualEngine.dueAccruals()` und `runFundingAccrual()` — Funding-Buchung für den laufenden Paper-Ledger, nicht historische Replay-Zeitreihen.

## Bewertung und Abgrenzung

Der Backtest ist bereits ereignisorientiert und verwendet auf Wunsch denselben Paper-Fill-Pfad. Spread, Slippage, Gebühren und simulatorseitige Partial Fills werden reproduzierbar berechnet; bei Entry wird `filledQty` übernommen. Das ist ausdrücklich mehr als ein barweiser Return-Rechner. Der Engine-Lifecycle bildet eine partielle Exit-Restmenge jedoch nicht ab: Auch ein als `PARTIAL` gemeldeter Exit-Fill wird derzeit wie ein vollständiger Positionsschluss behandelt.

## Konkretes Delta

- punktgenaue historische Funding-Rates pro Instrument und Funding-Intervall
- Latenz als explizite Order-/Marktdatenereignisse statt nur statischer Kostenannahme
- vollständiger Partial-Fill-Lifecycle mit Exit-Restmenge, Open-Order-Zustand und Cancel/Replace im Replay
- Orderbuchtiefe beziehungsweise Size-abhängiger Impact mit deterministischem Fallback
- Persistenz der verwendeten Friktionsdaten und Modellversion je Fill

## Akzeptanzkriterien für `FIXED`

- [ ] identischer Seed und identische Eingangsdaten erzeugen byte-stabile Trades/Metriken
- [ ] Funding wird nur an tatsächlich erreichten Funding-Zeitpunkten gebucht
- [ ] fehlende Depth-/Funding-Daten werden sichtbar markiert und nicht still als Null interpretiert
- [ ] Partial-Fill-, Latenz- und Gebührenpfade sind durch Golden Tests belegt

## Review-Evidenz

- Audit-Basis: Commit `df3163e`, Produktversion `v1.51.1`.
- Methode: statische Pfad-/Symbolprüfung, Schema- und Testabgleich; keine reine
  Dokumentationsbehauptung als Implementierungsbeleg.
- Tracking: [`../remediation/TRACKING.md`](../remediation/TRACKING.md)
