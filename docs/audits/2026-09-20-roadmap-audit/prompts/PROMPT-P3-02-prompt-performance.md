# PROMPT-P3-02 — Prompt-Version-Metrikvergleich

## Auftrag

Implementiere **Prompt-Version-Metrikvergleich** produktionsreif im Repository
`Kryschuuu/ai-trading-firm`. Dieser Prompt ist eigenständig: prüfe zuerst den
aktuellen Branch und Code; Audit-Basis war Commit `df3163e` (`v1.51.1`). Wenn
der aktuelle Stand abweicht, übernimm die Absicht mit minimalem Scope und
vermerke die Abweichung im PR.

Zugehöriger Befund: [`../findings/RMA-P3-02-prompt-performance.md`](../findings/RMA-P3-02-prompt-performance.md)
Priorität/Schwere: **P3 / HIGH**
Schätzung des Restaufwands: **3–5 PT**

## Verifizierter Ausgangszustand

- Agentenzeilen besitzen eine Version und Prompts sind im Seed/Editor vorhanden.
- Analysen und Journal-Outcomes werden persistiert.
- Nicht jeder Aufruf referenziert einen immutable Prompt-Hash samt Modellparametern.
- Es gibt keinen fair segmentierten Qualitäts-/Kostenvergleich pro Promptversion.

## Zielzustand

Binde jeden Agentenaufruf unveränderlich an Prompt-, Modell- und Samplingversion und vergleiche Forecastqualität, Kalibrierung, Tradebeitrag, Latenz und Kosten mit Coverage und Unsicherheit zwischen Versionen.

## Vor Beginn gezielt prüfen

- `src/db/schema.ts`
- `src/lib/seed.ts`
- `src/lib/analysts.ts`
- `src/lib/llmProvider.ts`
- `src/lib/journalAnalytics.ts`
- `src/components/workshop/PromptPanel.tsx`
- `src/app/api/firm/agents/route.ts`
- `tests/llmProvider.test.ts`
- `tests/tradeJournal.test.ts`

Suche zusätzlich nach allen Call Sites, Schemaexporten, Migrationen,
Konfigurationsmustern und vorhandenen Tests. Pfade dürfen seit dem Audit
verschoben worden sein; implementiere nicht parallel zu bereits vorhandener
äquivalenter Logik.

## Verbindlicher Implementierungsumfang

1. **Prompt-Artefakt:** Kanonisiere Promptteile deterministisch und speichere immutable Version/Hash, Rolle, Template-Schemaversion sowie sichere Metadaten. Historische Zeilen werden nicht überschrieben.
2. **Run-Provenance:** Jeder Agentenaufruf referenziert Promptartefakt, Provider/Modell, Parameter, Tool-/Schema-Version, Start/Ende, Tokenverbrauch, Kostenstatus und Success/Failure. Geheimnisse und rohe sensitive Payloads ausschließen.
3. **Outcome-Join:** Verbinde Aufrufe über stabile Forecast-/Decision-IDs mit P3.1-Resolutionen und P1.6-Attribution. Fehlende Outcomes bleiben als Coverage-Lücke sichtbar.
4. **Metriken:** Brier/Calibration, directional accuracy, abstention/coverage, attributed PnL/Drawdown, Latenz, Token und Kosten pro Version. Mindeststichprobe, Konfidenzintervalle und Segmentierung nach Zeit/Regime/Horizont.
5. **Vergleich:** API/Artefakt für Baseline-vs-Candidate mit identischen Segmenten; keine naive Rangliste über unterschiedliche Marktphasen. Promotion nur als Empfehlung hinter bestehendem Gate.
6. **Datenschutz/Retention:** Prompttext nur berechtigt abrufbar; Metrics verwenden kurze bounded Versionslabels, nie vollständigen Prompt oder Request-ID.

## Explizit nicht Teil dieses Changes

- keine automatische Live-Promotion ohne P1.5
- kein Anbieterwechsel
- keine rückwirkende exakte Zuordnung, wenn historische Provenance fehlt

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

- [ ] Promptkanonisierung erzeugt stabilen Hash trotz normalisierter Zeilenenden
- [ ] inhaltliche Änderung ändert Hash/Version
- [ ] Run referenziert exakt ein Promptartefakt und Modellparameter
- [ ] Vergleich nutzt identische Filter und berichtet Coverage/Sample Count
- [ ] fehlende Outcomes werden nicht als Verlust oder Erfolg gezählt
- [ ] Secrets/Authorization Header erscheinen nicht in Persistenz oder Logs
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

- [ ] jede neue Analyse ist eindeutig auf reproduzierbaren Prompt-/Modellkontext rückführbar
- [ ] Metrikvergleich zeigt Unsicherheit und Marktsegment statt nur Punktschätzer
- [ ] historische unbekannte Versionen sind sichtbar UNKNOWN, nicht aktuelle Version
- [ ] Kosten-/Latenzwerte sind einheitenklar und API-Abfragen bounded
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
