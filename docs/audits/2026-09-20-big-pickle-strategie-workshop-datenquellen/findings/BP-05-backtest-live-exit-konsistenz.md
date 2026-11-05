# BP-05: Backtest und Live-Exit-Management driften auseinander

- **Antwort:** Offen
- **Tracking-Status:** `OPEN`
- **Severity:** `HIGH`
- **Quick Estimate Restaufwand:** **4–6 PT**
- **Umsetzungs-Prompt:** [`PROMPT-BP-05`](../prompts/PROMPT-BP-05-backtest-live-exit-konsistenz.md)

## Verifizierte Fundstellen

- `src/lib/exits.ts` — `decideExit()` (Trailing-Stop mit Ratchet, Time-Stop,
  OCO/Bracket-Semantik), rein deterministisch, env-basiert
  (`RISK_*`-Konfiguration, `DEFAULT_EXIT_CONFIG` verhaltensneutral).
- `src/lib/monitor.ts:23,204` — einziger Verfügungsort von `decideExit` (Live-
  Advisor); keine andere Datei importiert `exits.ts`.
- `src/backtest/simulator.ts:105-183` — `evaluateExit()` kennt nur SL/TP; der
  `maxHoldingBars`-Zweig ist ein Kommentar-Leerlauf.
- `src/backtest/paperExecution.ts:191-208` — `detectExitTrigger()` kennt ebenfalls
  nur SL/TP; Fill zum exakten Stop-/TP-Preis (kein Gap-/Slip-Fall).

## Bewertung und Abgrenzung

Aktiviert man Trailing- oder Time-Stops, weicht das Live-Verhalten (Monitor)
sofort vom Replay ab — simulierte Ergebnisse sind dann keine gültige Vorhersage.
Dieser Befund ist bewusst **schmaler** als RMA-P1-01 (Event-Replay mit
Friktionen) und nutzt die vorhandene `decideExit()`-Logik als gemeinsame Wahrheit
statt eine zweite Exit-Maschine zu bauen. Der Worst-Case-SL (Gap über den Stop)
wird in *keinem* Pfad modelliert.

## Konkretes Delta

- Replay beider Backtest-Pfade nutzt je Kerze `decideExit(input, config)` —
  `DEFAULT_EXIT_CONFIG`, explizite Config, sonst verhaltensneutral.
- Stop-/TP-Fills mit dokumentiertem Tie-Break und Gap-Behandlung
  (Lücke überspringt Stop → Fill zum Gap-/Open-Preis, nie besser).
- Golden-/Determinismus-Tests für Trailing-Ratchet, Time-Stop, Gap, Kollision.

## Akzeptanzkriterien für `FIXED`

- [ ] identische Inputs/Config ergeben byte-stabile Trades/Metriken.
- [ ] aktivierte Trailing-/Time-Stops verändern Live- und Replay identisch
      (eine Entscheidungsfunktion).
- [ ] Gap-SL-Fall füllt zum dokumentierten worst-case-Preis, nicht zum Stop.
- [ ] Legacy-Default (`legacy`-Modus) bleibt verhaltensgleich (Tests).
- [ ] Pflichtgates grün; `tests/backtest.*` erweitert.

## Review-Evidenz

- Audit-Basis: Commit `7d8b07b`, Produktversion `v1.51.3`.
- Methode: Import-Graph-Prüfung (`exits.ts` → nur `monitor.ts`) und
  Evaluator-Vergleich.