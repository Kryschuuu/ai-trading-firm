# RMA-P5-05: Signal-Decay-Exits

- **Antwort:** Nein
- **Tracking-Status:** `OPEN`
- **Severity:** `MEDIUM`
- **Quick Estimate Restaufwand:** **3–5 PT**
- **Umsetzungs-Prompt:** [`PROMPT-P5-05`](../prompts/PROMPT-P5-05-signal-decay-exits.md)

## Verifizierte Fundstellen

- `src/lib/exits.ts::decideExit()` — Stop Loss, Take Profit, Trailing Stop und Time Stop.
- `src/lib/journal.ts::DecisionSnapshot` — Entry-Kontext könnte als Signalbaseline dienen.
- `src/lib/engine.ts` — periodischer Positions-/Exitpfad.
- Kein ExitReason beziehungsweise Scorevergleich für Signalverfall vorhanden.

## Bewertung und Abgrenzung

Preis- und zeitbasierte Exits sind robust vorhanden. Ein Time Stop approximiert Alpha-Verfall nur über Alter; er prüft nicht, ob das ursprüngliche Signal tatsächlich schwächer, neutral oder gegensätzlich geworden ist.

## Konkretes Delta

- versionierter Entry-Signal-Snapshot und aktueller vergleichbarer Score
- Decay-Funktion/Schwelle pro Strategieklasse und Haltedauer
- Hysterese beziehungsweise Mindestbestätigung gegen Rauschen
- neuer auditierbarer Exit-Grund `SIGNAL_DECAY`
- Missing-/stale-Signal-Policy und Backtest-/Live-Parität

## Akzeptanzkriterien für `FIXED`

- [ ] Exitentscheidung ist für identische Snapshots deterministisch
- [ ] stale oder inkompatible Signalversion erzwingt keinen unbegründeten Exit
- [ ] Signal-Decay konkurriert in dokumentierter Priorität mit SL/TP/Kill-Switch
- [ ] Backtest und Runtime teilen dieselbe pure Entscheidungsfunktion

## Review-Evidenz

- Audit-Basis: Commit `df3163e`, Produktversion `v1.51.1`.
- Methode: statische Pfad-/Symbolprüfung, Schema- und Testabgleich; keine reine
  Dokumentationsbehauptung als Implementierungsbeleg.
- Tracking: [`../remediation/TRACKING.md`](../remediation/TRACKING.md)
