# PROMPT-P2-03 — deterministische Multi-Timeframe-Konfluenz

## Auftrag

Implementiere **deterministische Multi-Timeframe-Konfluenz** produktionsreif im Repository
`Kryschuuu/ai-trading-firm`. Dieser Prompt ist eigenständig: prüfe zuerst den
aktuellen Branch und Code; Audit-Basis war Commit `df3163e` (`v1.51.1`). Wenn
der aktuelle Stand abweicht, übernimm die Absicht mit minimalem Scope und
vermerke die Abweichung im PR.

Zugehöriger Befund: [`../findings/RMA-P2-03-multi-timeframe-confluence.md`](../findings/RMA-P2-03-multi-timeframe-confluence.md)
Priorität/Schwere: **P2 / MEDIUM**
Schätzung des Restaufwands: **3–5 PT**

## Verifizierter Ausgangszustand

- Historical Store hält Candle-Serien je Timeframe.
- Technischer Analyst produziert Multi-Timeframe-Freitext/JSON.
- Tageszyklus und Artefakte sind versioniert.
- Eine gemeinsame as-of-ausgerichtete Konfluenzformel fehlt.

## Zielzustand

Berechne vor dem LLM einen reproduzierbaren, erklärbaren Konfluenzsnapshot über konfigurierbare Timeframes. Der Agent darf ihn erläutern, aber nicht unbemerkt überschreiben.

## Vor Beginn gezielt prüfen

- `src/lib/analysts.ts`
- `src/cycle/steps/technicalStep.ts`
- `src/cycle/schemas.ts`
- `src/lib/marketdata/historicalStore.ts`
- `src/marketdata/quality.ts`
- `src/scanner/factors/`
- `src/scanner/config.ts`

Suche zusätzlich nach allen Call Sites, Schemaexporten, Migrationen,
Konfigurationsmustern und vorhandenen Tests. Pfade dürfen seit dem Audit
verschoben worden sein; implementiere nicht parallel zu bereits vorhandener
äquivalenter Logik.

## Verbindlicher Implementierungsumfang

1. **As-of Alignment:** Schneide jede Reihe am gemeinsamen Entscheidungszeitpunkt; nutze nur geschlossene Bars und prüfe expected-close/available_at/Staleness.
2. **Features:** Definiere pro Timeframe wenige robuste normalisierte Trend-, Momentum- und Volatilitätsmerkmale mit Bounds und Warm-up-Anforderung.
3. **Konfluenz:** Versionierte Gewichtung, Richtungsscore, Strength, Coverage und Conflict. Fehlende Timeframes re-normalisieren nur oberhalb einer Mindestcoverage und dürfen Confidence nicht erhöhen.
4. **Erklärung:** Output enthält Beiträge je Timeframe, verwendete Bar-Endzeiten und Gründe für missing/conflict. Keine bloße einzelne Zahl.
5. **Integration:** Technischer Step bekommt Snapshot als getrennte trusted data; strukturiertes Schema persistiert Version/Score/Coverage. Scanner-/Backtestnutzung teilt dieselbe pure Funktion.
6. **Konfiguration:** Schema-validierte Bounds, maximale Timeframezahl und keine Runtime-Prompt-Manipulation der Gewichte.

## Explizit nicht Teil dieses Changes

- kein neues LLM-Modelltraining
- kein Ersatz der Scanner-Gesamtrangfolge
- keine Nutzung unvollständiger höherer Timeframekerzen

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

- [ ] As-of-Fixture schließt die noch offene HTF-Kerze aus
- [ ] gleichgerichtete, gegensätzliche und missing Timeframes ergeben erwartete Scores
- [ ] Eingabereihenfolge ändert Output nicht
- [ ] unzureichende Coverage liefert abstain/degraded
- [ ] Backtest-/Live-Adapter erzeugen aus gleichem Snapshot identischen Output
- [ ] LLM-Schema kann deterministischen Score nicht überschreiben
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

- [ ] jede Outputzahl ist auf Timeframebeiträge und Barzeiten zurückführbar
- [ ] Konfigurations-/Featureversion wird im Artefakt gespeichert
- [ ] fehlende/stale Daten sind sichtbar und fail-closed
- [ ] bestehender Analystenoutput bleibt additiv kompatibel
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
