# PROMPT-BP-05 — Backtest/Live-Exit-Konsistenz über `decideExit()`

## Auftrag

Vereinheitliche die Exit-Auswertung in den Backtest-Pfaden des Repositories
`Kryschuuu/ai-trading-firm` mit der Live-Exit-Logik `decideExit()`, sodass
Trailing-/Time-Stops und Gap-Behandlung im Replay identisch zum Live-Monitor
entscheiden. Der Prompt ist eigenständig; Audit-Basis war `7d8b07b`
(`v1.51.3`). Bei Abweichung adaptiere minimal und dokumentiere sie.

Zugehöriger Befund: [`../findings/BP-05-backtest-live-exit-konsistenz.md`](../findings/BP-05-backtest-live-exit-konsistenz.md)
Priorität/Schwere: **HIGH**
Schätzung des Restaufwands: **4–6 PT**
Abgrenzung: bewusst **schmaler** als RMA-P1-01 (Event-Replay). Keine zweite
Exit-Entscheidungslogik — einzige Quelle bleibt `decideExit()`.

## Verifizierter Ausgangszustand

- `src/lib/exits.ts` — `decideExit()` (Trailing-Stop mit Ratchet, Time-Stop,
  OCO/Bracket-Semantik), rein deterministisch; `DEFAULT_EXIT_CONFIG`
  verhaltensneutral (alles „aus“); Konfiguration env-basiert mit Bounds.
- `src/lib/monitor.ts:23,204` — einziger Importeur von `exits.ts` (Live).
- `src/backtest/simulator.ts:105-183` — `evaluateExit()`: nur SL/TP;
  `maxHoldingBars`-Zweig ist Kommentar-Leerlauf.
- `src/backtest/paperExecution.ts:191-208` — `detectExitTrigger()`: nur SL/TP,
  Fill exakt zum Stop-/TP-Preis (kein Gap-/Slip-Fall).

## Zielzustand

Beide Replay-Pfade werten je offener Position und je Kerze `decideExit(input,
config)` aus — identische Entscheidungsfunktion wie der Live-Monitor. Gap über
den Stop füllt zum dokumentierten worst-case-Preis (Gap-/Open-Preis), nie
besser; SL/TP-Kollision mit dokumentiertem Tie-Break; Legacy-Default bleibt
verhaltensgleich.

## Vor Beginn gezielt prüfen

- `src/lib/exits.ts`, `src/lib/monitor.ts` (Auswertungsaufruf)
- `src/backtest/simulator.ts`, `src/backtest/paperExecution.ts`
- `src/backtest/engine.ts` (Positions-Zyklus je Kerze)
- `src/backtest/types.ts` (`BacktestOpenPosition`, Exits)
- `tests/backtest.unit.test.ts`, `tests/backtest.engine.test.ts`,
  `tests/backtest.multiAsset.test.ts`, Exits-Tests

## Verbindlicher Implementierungsumfang

1. **Eine Entscheidungsfunktion:** `evaluateExit`/`detectExitTrigger` rufen je
   Kerze `decideExit(input, config)` auf (Trailing-Zustand positionslokal
   mitführen); Config-Auflösung: explizite Config bevorzugt,
   `DEFAULT_EXIT_CONFIG` sonst — verhaltensneutral.
2. **Gap-/Worst-Case-SL:** Springt eine Kerze (open gänzlich unter SL bzw. über
   TP), füllt der Exit zum dokumentierten worst-case-Preis (Gap-/Open-Wert),
   nie besser als real möglich; in Formeln/Kommentar dokumentieren.
3. **Tie-Break:** Kollision SL/TP in derselben Kerze mit fester, dokumentierter
   Regel (SL-Vorrang, wie im Live-Monitor definiert).
4. **Status/Trace:** Exit-Grund (`STOP_LOSS | TAKE_PROFIT | TRAILING_STOP |
   TIME_STOP`) im Trade-Log; Trailing-Ratchet-Historie nicht überloggen.
5. **Kompatibilität:** `legacy`-Modus bleibt als Default erhalten; neue
   Semantik nur dort aktiv, wo Trailing-/Time-Konfiguration vorliegt — sonst
   byte-gleiches Verhalten.

## Explizit nicht Teil dieses Changes

- kein vollständiges Event-Replay mit Orderbuch/TWAP (RMA-P1-01/P4.3)
- keine Änderungen an `exits.ts`-Semantik selbst
- kein Umbau der portfolio-level Positionslogik

## Produktions- und Sicherheitsregeln

- Echter End-to-End-Pfad mit Golden-/Determinismus-Tests; kein Mock-only.
- Identische Inputs/Config ⇒ identische Trades/Metriken (Determinismus).
- Gap-Fill darf nie besser als der reale worst-case-Preis sein (fail-closed
  gegen Look-ahead-Vorteil).
- Risk-Ceilings/Kill-Switches unangetastet.
- Keine TODOs, `any`-Fluchten, still geschluckten Fehler.

## Pflicht-Tests

- [ ] Trailing-Ratchet: aktivierter Trailing stoppt beim Retracement
- [ ] Time-Stop: Haltedauer überschritten ⇒ TIME_STOP-Exit
- [ ] Gap unter SL ⇒ Fill zum Gap-/Open-Preis, nicht zum SL-Preis
- [ ] SL/TP-Kollision ⇒ dokumentierter Tie-Break
- [ ] Legacy-Default ohne Exit-Config byte-gleich (Regression)
- [ ] Determinismus-Hash über gleiche Inputs stabil
- [ ] bestehende Backtest-Tests grün

Führe vor Abschluss mindestens aus:

```bash
npm run typecheck
npm run lint
npm test
npm run docs:validate
```

## Akzeptanzkriterien

- [ ] Live- und Replay verwenden exakt eine Exit-Entscheidungsfunktion
      (Architektur-Test: `exits.ts` wird von Monitor und Backtest importiert).
- [ ] Gap- und Tie-Break-Verhalten ist dokumentiert und durch Golden-Tests
      belegt.
- [ ] Legacy-Modus ohne Konfig unverändert (kein Verhaltensbruch).

## Dokumentation, Versionierung und Tracking

1. `docs/BACKTESTING.md`/Exit-Doku um Konsistenz, Gap- und Tie-Break-Regeln
   ergänzen.
2. Root-`CHANGELOG.md` pflegen.
3. `package.json`/`package-lock.json` nach SemVer konsistent erhöhen.
4. Finding + `../remediation/TRACKING.md` erst bei belegter DoD auf `FIXED`.
5. Aussagekräftig committen, `arena/*`-Branch pushen, PR öffnen.

## Erwartete Abschlussmeldung

Geänderte Dateien, implementierte Exit-Konsistenz, Migrations-/Kompatibilitäts-
hinweise, ausgeführte Tests mit Ergebnis, verbleibende Risiken sowie
Commit-/PR-Link.