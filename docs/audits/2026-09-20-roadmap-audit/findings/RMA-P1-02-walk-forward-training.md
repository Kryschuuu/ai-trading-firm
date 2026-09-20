# RMA-P1-02: 90d/30d Walk-Forward mit Train-Select-Freeze-Test

- **Antwort:** Teilweise
- **Tracking-Status:** `PARTIAL`
- **Severity:** `CRITICAL`
- **Quick Estimate Restaufwand:** **4–6 PT**
- **Umsetzungs-Prompt:** [`PROMPT-P1-02`](../prompts/PROMPT-P1-02-walk-forward-training.md)

## Verifizierte Fundstellen

- `src/backtest/walkforward.ts::computeWalkForwardWindows()` — konfigurierbare In-Sample-/Out-of-Sample-Fenster mit 90d/30d-Defaults.
- `src/backtest/walkforward.ts::runWalkForward()` — replayt IS und OOS und aggregiert Fenster.
- `src/backtest/walkforward.ts::hashTrades()` — deterministischer Trade-Hash.
- `scripts/run-backtest.ts` — CLI-Verdrahtung für Walk-Forward-Läufe.

## Bewertung und Abgrenzung

Zeitfenster, Warm-up, IS/OOS-Auswertung und deterministische Reports sind vorhanden. Der gleiche Regel-/Setup-Input wird jedoch in beiden Segmenten verwendet; daher validiert der Code zeitliche Stabilität, trainiert oder selektiert aber nichts.

## Konkretes Delta

- expliziter Kandidatenraum für Parameter/Strategieversionen
- nur auf IS ausgeführte, deterministisch tie-breakende Selektion
- unveränderliches Freeze-Artefakt mit Daten-, Code-, Config- und Kandidaten-Hash
- OOS-Ausführung ausschließlich mit der eingefrorenen Auswahl
- finaler unberührter Holdout und Schutz gegen Leakage an Fenstergrenzen

## Akzeptanzkriterien für `FIXED`

- [ ] kein OOS-Wert ist dem Selector zugänglich
- [ ] jede Auswahl ist mit Score-Tabelle und Tie-Break-Regel reproduzierbar
- [ ] mutierte OOS-Daten ändern nicht die IS-Auswahl
- [ ] Holdout wird genau einmal nach abgeschlossener Modellentscheidung ausgewertet

## Review-Evidenz

- Audit-Basis: Commit `df3163e`, Produktversion `v1.51.1`.
- Methode: statische Pfad-/Symbolprüfung, Schema- und Testabgleich; keine reine
  Dokumentationsbehauptung als Implementierungsbeleg.
- Tracking: [`../remediation/TRACKING.md`](../remediation/TRACKING.md)
