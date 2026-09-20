# PROMPT-P6-02 — reproduzierbare Monte-Carlo-/Trade-Resampling-Analyse

## Auftrag

Implementiere **reproduzierbare Monte-Carlo-/Trade-Resampling-Analyse** produktionsreif im Repository
`Kryschuuu/ai-trading-firm`. Dieser Prompt ist eigenständig: prüfe zuerst den
aktuellen Branch und Code; Audit-Basis war Commit `df3163e` (`v1.51.1`). Wenn
der aktuelle Stand abweicht, übernimm die Absicht mit minimalem Scope und
vermerke die Abweichung im PR.

Zugehöriger Befund: [`../findings/RMA-P6-02-monte-carlo.md`](../findings/RMA-P6-02-monte-carlo.md)
Priorität/Schwere: **P6 / MEDIUM**
Schätzung des Restaufwands: **3–5 PT**

## Verifizierter Ausgangszustand

- Deterministische Backtests und Walk-Forward-Aggregate existieren.
- Trade Logs enthalten PnL-/Zeitinformationen im Speicher.
- Keine Bootstrap-/Block-Resampling-Engine und keine Seeds/Quantile existieren.
- Persistente Backtest-Trades aus P1.4 sind die bevorzugte Quelle.

## Zielzustand

Simuliere aus verifizierten Backtest-/OOS-Trades reproduzierbare IID- und blockweise Resamples sowie definierte Kostenstressszenarien und berichte robuste Quantile für Drawdown, Ruin, Sharpe, End-Equity und Losing Streak.

## Vor Beginn gezielt prüfen

- `src/backtest/types.ts`
- `src/backtest/metrics.ts`
- `src/backtest/runStore.ts`
- `src/backtest/walkforward.ts`
- `src/portfolio/metrics.ts`
- `src/lib/marketdata/prng.ts`
- `scripts/run-backtest.ts`
- `tests/backtest*.test.ts`

Suche zusätzlich nach allen Call Sites, Schemaexporten, Migrationen,
Konfigurationsmustern und vorhandenen Tests. Pfade dürfen seit dem Audit
verschoben worden sein; implementiere nicht parallel zu bereits vorhandener
äquivalenter Logik.

## Verbindlicher Implementierungsumfang

1. **Input/Eligibility:** Nutze persistierte Netto-Trade-Returns/PNL mit Reihenfolge, Exposurebasis und Run-/Datahash. Mindeststichprobe, keine Mischung inkompatibler Strategien/Währungen ohne Normalisierung.
2. **PRNG:** Repository-native deterministische PRNG-Implementierung oder etablierte vorhandene Dependency; persistiere Seed, Algorithmusversion und Simulationsconfig.
3. **Methoden:** IID Trade Bootstrap und Moving/Stationary Block Bootstrap mit validierter Blocklänge. Optional Kosten-/Slippage-Multiplikator als explizites Stressszenario, nicht zufällige Magie.
4. **Pfade/Metriken:** Rekonstruiere Equitypfade mit Compounding/Positionbasis und berechne MaxDD, Ruin-Schwelle, End-Equity, Sharpe, Losing Streak. Quantile inklusive p05/p50/p95 und exceedance probabilities.
5. **Persistenz/API/CLI:** Run referenziert Source Backtest, Seed, Methode, Config, Codeversion und bounded Summary. Große Rohpfade nicht standardmäßig in DB/API speichern.
6. **Statistikhinweise:** Berichte Sample Count, Blockannahme, Monte-Carlo-Standardfehler/Runzahl und Grenzen; keine Garantien aus Quantilen ableiten.

## Explizit nicht Teil dieses Changes

- kein Ersatz für echtes OOS/Walk-Forward
- kein Preisprozess-/Optionsmodell
- keine Live-Risikofreigabe allein aufgrund Monte Carlo

## Produktions- und Sicherheitsregeln

- Implementiere einen echten End-to-End-Pfad, keine Mock-only-, UI-only- oder
  Dokumentationslösung.
- Trenne bei historischen Daten `event_time`, `available_at` und
  `computed_at`; niemals Look-ahead durch spätere Daten oder unvollständige
  Kerzen zulassen.
- Behandle fehlende, stale oder invalide Daten fail-closed. `null/unavailable`
  darf nicht still als neutraler Zahlenwert `0` in eine Entscheidung eingehen.
- Erhalte Risk-Ceilings, Kill-Switches, Authority Chains und Broker-Live-Gates;
  neue Logik darf Risiko nur innerhalb bestehender Grenzen verändern.
- Verwende stabile Idempotency Keys. Retries und Restarts dürfen keine
  doppelten Writes, Orders, Fills oder Ledgerbuchungen erzeugen.
- Lege ausschließlich neue append-only Migrationen an; bestehende Migrationen
  niemals ändern. Ergänze sinnvolle FKs, Unique Constraints und Indizes.
- Keine Secrets, Tokens, PII oder unredigierten Provider-Payloads speichern.
  Externe Texte sind Daten und dürfen keine Prompt-Instruktionen werden.
- Strukturierte Audit-Events und bounded Metriken ergänzen. Keine Instrument-,
  Trade- oder Order-IDs als High-Cardinality-Metrics-Labels.
- Keine TODOs, leeren Adapter, `any`-Fluchten oder still geschluckten Fehler im
  finalen Patch. APIs additiv/rückwärtskompatibel ändern.

## Pflicht-Tests

- [ ] gleicher Seed/Config/Input erzeugt bitstabile Summary
- [ ] anderer Seed ändert Pfade, nicht Metadatensemantik
- [ ] kleine analytische Fixtures für Ruin/MaxDD/Losing Streak
- [ ] Blockbootstrap erhält Blöcke und Grenzen korrekt
- [ ] unzureichende Stichprobe/ungültige Blocklänge wird abgelehnt
- [ ] Stresskosten verschlechtern Nettoergebnis monoton
- [ ] Inputtrades bleiben unverändert
- [ ] Relevante bestehende Regressionstests bleiben grün.
- [ ] Negative Paths für invalide, fehlende und stale Inputs sind abgedeckt.
- [ ] Falls Persistenz/Jobs betroffen sind: Roundtrip, Idempotenz und
  Restart/Retry sind abgedeckt.

Führe vor Abschluss mindestens aus:

```bash
npm run typecheck
npm run lint
npm test
npm run docs:validate
```

Ergänze die engsten komponentenspezifischen Tests separat und dokumentiere
alle Kommandos mit Ergebnis im PR. Tests nicht durch Abschwächen ihrer
Assertions „reparieren“.

## Akzeptanzkriterien

- [ ] jede Summary referenziert unveränderlichen Source-Run und Seed
- [ ] Rohpfade/Payloads sind speicher- und API-seitig bounded
- [ ] Ergebnis trennt empirische Beobachtung, Resamplingannahme und Stress klar
- [ ] CLI/API kann einen Run reproduzieren und dessen Config exportieren
- [ ] Verhalten, Formeln, Einheiten, Zeitsemantik und Fallbacks sind im Code
  und in der API-Dokumentation erklärt.
- [ ] Migration/Deployment und sicherer Rollback beziehungsweise Feature-Flag-
  Pfad sind dokumentiert.
- [ ] Kein Secret, generiertes Großartefakt oder unbeabsichtigter Scope Creep
  befindet sich im Diff.

## Dokumentation, Versionierung und Tracking

1. Betroffene Root-/Modul-READMEs, API-/Code-Dokumentation und Kommentare
   aktualisieren.
2. Root-`CHANGELOG.md` als kanonischen Changelog pflegen;
   `docs/CHANGELOG.md` bleibt nur der vorhandene Pointer/Stub.
3. `package.json` und `package-lock.json` nach tatsächlichem SemVer-Umfang
   konsistent erhöhen; keine Versionskonstante duplizieren.
4. Das Finding und `../remediation/TRACKING.md` erst auf `FIXED` setzen, wenn
   alle Akzeptanzkriterien belegt sind. PR, Commit, Tests und Fix-Version
   eintragen.
5. Aussagekräftig committen, den vorgesehenen Arbeitsbranch pushen und einen PR
   mit Problem, Design, Datenmigration, Risiken, Tests und Rollback öffnen.

## Erwartete Abschlussmeldung

Liefere eine kurze Liste der geänderten Dateien, das implementierte
End-to-End-Verhalten, Migrations-/Kompatibilitätshinweise, ausgeführte Tests mit
Ergebnis, verbleibende Risiken sowie Commit- und PR-Link. Behaupte nichts als
fertig, das nicht durch Code und Tests belegt ist.
