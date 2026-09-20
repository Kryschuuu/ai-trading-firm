# PROMPT-P2-05 — kalibrierbare strukturierte Sentiment-Outputs

## Auftrag

Implementiere **kalibrierbare strukturierte Sentiment-Outputs** produktionsreif im Repository
`Kryschuuu/ai-trading-firm`. Dieser Prompt ist eigenständig: prüfe zuerst den
aktuellen Branch und Code; Audit-Basis war Commit `df3163e` (`v1.51.1`). Wenn
der aktuelle Stand abweicht, übernimm die Absicht mit minimalem Scope und
vermerke die Abweichung im PR.

Zugehöriger Befund: [`../findings/RMA-P2-05-structured-sentiment.md`](../findings/RMA-P2-05-structured-sentiment.md)
Priorität/Schwere: **P2 / MEDIUM**
Schätzung des Restaufwands: **2–3 PT**

## Verifizierter Ausgangszustand

- News-Agenten liefern BULLISH/BEARISH/NEUTRAL, Confidence und These.
- Cycle-Schemas normalisieren den Output.
- Analyseergebnisse werden persistiert.
- Horizont, Quellenabdeckung, Eventtyp und Outcome-Link fehlen.

## Zielzustand

Erweitere Sentiment zu einem strikt validierten Forecast-Envelope mit Entity, Event, Zeit-, Horizont-, Quellen-, Unsicherheits- und Versionssemantik, der später ohne Heuristik kalibriert werden kann.

## Vor Beginn gezielt prüfen

- `src/lib/analysts.ts`
- `src/cycle/steps/newsStep.ts`
- `src/cycle/schemas.ts`
- `src/lib/llmProvider.ts`
- `src/db/schema.ts`
- `src/lib/seed.ts`
- `tests/cycle*.test.ts`

Suche zusätzlich nach allen Call Sites, Schemaexporten, Migrationen,
Konfigurationsmustern und vorhandenen Tests. Pfade dürfen seit dem Audit
verschoben worden sein; implementiere nicht parallel zu bereits vorhandener
äquivalenter Logik.

## Verbindlicher Implementierungsumfang

1. **Schema:** Definiere canonical instrument/entity IDs, direction, probability/confidence, abstain, horizon/end time, event type, source_count/coverage, source event time, generated_at und prompt/model/schema version.
2. **Semantik:** Trenne direktionale Wahrscheinlichkeit von Quellenqualität/Unsicherheit. Lege fest, wie NEUTRAL versus ABSTAIN und Multi-Entity-Nachrichten behandelt werden.
3. **Validierung:** Strict JSON Schema mit Bounds/Enums, begrenzten Arrays/Textlängen und kontrolliertem Repair/Reject. Keine unbekannten Instruktionen aus Headlines in Systemprompt übernehmen.
4. **Deduplikation:** Stabile Source-/Content-Hashes und Zeitfenster verhindern, dass syndizierte Meldungen Confidence künstlich erhöhen.
5. **Persistenz/Outcome:** Append-only Forecast-ID und kompatibler Link für P3.1; keine aktuelle Preis-/Outcomeinformation beim Erzeugen speichern.
6. **Kompatibilität:** Bestehende Consumer erhalten abgeleitete `view/confidence/thesis`-Felder, bis Migration abgeschlossen ist.

## Explizit nicht Teil dieses Changes

- keine Implementierung des vollständigen Brier-Dashboards (P3.1)
- kein Scraping neuer Newsanbieter
- keine Sentiment-basierte direkte Order ohne bestehende Risk-Gates

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

- [ ] gültige/ungültige JSON-Fixtures, Bounds, Unknown Fields und Textlimits
- [ ] NEUTRAL und ABSTAIN bleiben unterscheidbar
- [ ] duplizierte/syndizierte Quelle erhöht Coverage nicht doppelt
- [ ] Horizon-Ende ist nach Source-/Generated-Time und begrenzt
- [ ] alte Consumerdarstellung bleibt korrekt
- [ ] Prompt-Injection-Text in Headline bleibt Datenfeld
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

- [ ] jeder Sentimentforecast besitzt eindeutige Entity und Auswertungszeit
- [ ] Coverage/Unsicherheit wird nicht in Richtungsscore versteckt
- [ ] Prompt-/Model-/Schema-Version ist immutable referenziert
- [ ] Payloads und Logs enthalten keine ungefilterten Secrets/PII
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
