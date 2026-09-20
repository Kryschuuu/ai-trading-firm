# PROMPT-P5-05 — versionierte Signal-Decay-Exits

## Auftrag

Implementiere **versionierte Signal-Decay-Exits** produktionsreif im Repository
`Kryschuuu/ai-trading-firm`. Dieser Prompt ist eigenständig: prüfe zuerst den
aktuellen Branch und Code; Audit-Basis war Commit `df3163e` (`v1.51.1`). Wenn
der aktuelle Stand abweicht, übernimm die Absicht mit minimalem Scope und
vermerke die Abweichung im PR.

Zugehöriger Befund: [`../findings/RMA-P5-05-signal-decay-exits.md`](../findings/RMA-P5-05-signal-decay-exits.md)
Priorität/Schwere: **P5 / MEDIUM**
Schätzung des Restaufwands: **3–5 PT**

## Verifizierter Ausgangszustand

- `decideExit()` unterstützt SL, TP, Trailing und Time Stop.
- Decision Snapshots halten Entry-Kontext.
- Engine ruft Exitentscheidungen periodisch auf.
- Ein vergleichbarer aktueller Signalzustand und ExitReason SIGNAL_DECAY fehlen.

## Zielzustand

Vergleiche einen immutable Entry-Signalsnapshot mit point-in-time aktuellem, versionskompatiblem Signal und schließe nach konfigurierter Decay-/Reversal-Policy deterministisch, ohne Preis-/Kill-Switch-Exits zu beeinträchtigen.

## Vor Beginn gezielt prüfen

- `src/lib/exits.ts`
- `src/lib/engine.ts`
- `src/lib/journal.ts`
- `src/db/schema.ts`
- `src/scanner/types.ts`
- `src/lib/marketRegime.ts`
- `tests/monitor.exits.test.ts`
- `tests/engine.pipeline-approval.test.ts`

Suche zusätzlich nach allen Call Sites, Schemaexporten, Migrationen,
Konfigurationsmustern und vorhandenen Tests. Pfade dürfen seit dem Audit
verschoben worden sein; implementiere nicht parallel zu bereits vorhandener
äquivalenter Logik.

## Verbindlicher Implementierungsumfang

1. **Signalvertrag:** Definiere normalisierten Direction/Strength/Confidence, calculated_as_of, available_at, feature/model/config version und Coverage. Entry Snapshot immutable persistieren.
2. **Kompatibilität:** Aktueller Score muss gleiche Semantik/Version besitzen oder explizit migriert sein. Inkompatibel/stale/missing ist UNKNOWN, nicht automatisch verfallen.
3. **Decay Policy:** Versionierte Schwelle relativ/absolut, Reversal, Mindesthaltedauer, Confirmation Count/Hysterese und optional Halbwertszeit pro Strategieklasse.
4. **Exitfunktion:** Erweitere pure `decideExit()` und ExitReason um SIGNAL_DECAY. Dokumentiere Priorität zu Kill Switch, SL, TP, Trailing und Time Stop; Safety Exits bleiben vorrangig.
5. **Runtime/Backtest:** Bereitstellung aktueller Signale im Enginepfad und identische Pure Function im Backtest. Exit audit enthält Entry/current score, Version, Coverage und Policyreason.
6. **Rollout:** Monitor-only Counterfactual vor Aktivierung; berichte vermiedene/zusätzliche PnL und Triggercoverage.

## Explizit nicht Teil dieses Changes

- kein LLM-Aufruf pro Tick
- kein Exit allein wegen fehlender Daten
- keine Änderung der grundlegenden Entrystrategie

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

- [ ] stabil, langsam verfallen, harter Reversal und noisy Hysterese
- [ ] missing/stale/incompatible signal erzwingt keinen Signal-Exit
- [ ] Safety-Exit-Priorität ist eindeutig getestet
- [ ] Backtest und Runtime-Fixture entscheiden identisch
- [ ] Confirmation State über Restart ist korrekt
- [ ] Audit enthält keine zukünftigen Signaldaten
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

- [ ] SIGNAL_DECAY ist von TIME_STOP und MANUAL eindeutig unterscheidbar
- [ ] Entry/current Signals sind point-in-time und versioniert nachvollziehbar
- [ ] jede Strategieklasse hat bounded/default-off Policy
- [ ] Monitor-only Rollout misst Counterfactual vor Liveaktivierung
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
