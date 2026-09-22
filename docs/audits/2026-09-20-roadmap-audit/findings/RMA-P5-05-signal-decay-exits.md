# RMA-P5-05: Signal-Decay-Exits

- **Antwort:** Ja
- **Tracking-Status:** `FIXED`
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

- [x] Exitentscheidung ist für identische Snapshots deterministisch
- [x] stale oder inkompatible Signalversion erzwingt keinen unbegründeten Exit
- [x] Signal-Decay konkurriert in dokumentierter Priorität mit SL/TP/Kill-Switch
- [x] Backtest und Runtime teilen dieselbe pure Entscheidungsfunktion

## Review-Evidenz

- Audit-Basis: Commit `df3163e`, Produktversion `v1.51.1`. Umsetzung auf `v1.68.0` → Fix `v1.69.0` (additiv hinter die bestehende `decideExit`-Kette; `src/backtest/simulator.ts` und `event_replay` unangetastet).
- Fix: Commit `56ca2f5`, [PR #167](https://github.com/Kryschuuu/ai-trading-firm/pull/167).
- Tests: `tests/signalDecay.test.ts` (stabil, langsamer Verfall, harte Umkehr, Hysterese, missing/stale/incompatible, Zukunfts-Audit, Kill-Switch, Safety-Priorität, Backtest-Parität), `tests/signalDecay.db.test.ts` (Entry unveränderlich, Retry eine Zeile, Neustart-Store, append-only), `tests/auditView.test.ts` Katalog-Wächter. `npm run typecheck`, `npm run lint`, `npm run docs:validate` grün. Voller `npm test` nicht gelaufen.
- Methode: statische Pfad-/Symbolprüfung, Schema- und Testabgleich; keine reine
  Dokumentationsbehauptung als Implementierungsbeleg.
- Tracking: [`../remediation/TRACKING.md`](../remediation/TRACKING.md)
