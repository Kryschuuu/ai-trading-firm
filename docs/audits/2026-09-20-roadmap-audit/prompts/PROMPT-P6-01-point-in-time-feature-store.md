# PROMPT-P6-01 — Point-in-Time Feature Store

## Auftrag

Implementiere **Point-in-Time Feature Store** produktionsreif im Repository
`Kryschuuu/ai-trading-firm`. Dieser Prompt ist eigenständig: prüfe zuerst den
aktuellen Branch und Code; Audit-Basis war Commit `df3163e` (`v1.51.1`). Wenn
der aktuelle Stand abweicht, übernimm die Absicht mit minimalem Scope und
vermerke die Abweichung im PR.

Zugehöriger Befund: [`../findings/RMA-P6-01-point-in-time-feature-store.md`](../findings/RMA-P6-01-point-in-time-feature-store.md)
Priorität/Schwere: **P6 / HIGH**
Schätzung des Restaufwands: **7–12 PT**

## Verifizierter Ausgangszustand

- Historical Store speichert Rohkerzen je Instrument/Timeframe mit Provenance.
- Scanner-/Cycle-Artefakte besitzen Versionen.
- Keine Feature Registry, Materialisierung oder As-of-Join-API existiert.
- Rohdatenzeit allein verhindert Feature-Look-ahead nicht.

## Zielzustand

Baue eine schlanke, repository-native Feature Registry und einen persistenten Store, der immutable Featuredefinitionen und Werte nach Entity, Eventzeit und Verfügbarkeitszeit materialisiert und point-in-time korrekt für Backtest und Live abfragt.

## Vor Beginn gezielt prüfen

- `src/lib/marketdata/historicalStore.ts`
- `src/marketdata/quality.ts`
- `src/scanner/factors/`
- `src/scanner/artifacts.ts`
- `src/cycle/artifacts.ts`
- `src/db/schema.ts`
- `drizzle/`
- `scripts/market-sync.ts`

Suche zusätzlich nach allen Call Sites, Schemaexporten, Migrationen,
Konfigurationsmustern und vorhandenen Tests. Pfade dürfen seit dem Audit
verschoben worden sein; implementiere nicht parallel zu bereits vorhandener
äquivalenter Logik.

## Verbindlicher Implementierungsumfang

1. **Registry:** Feature name, semantic version, Outputschema/Dtype, Entity/Timeframe, Lookback, Dependencies, Code-/Config-Hash und Owner. Definitionen immutable; neue Semantik = neue Version.
2. **Wertmodell:** Entity, Feature ID/version, event_time, available_at, computed_at, value/null reason, source data manifest und quality status. Unique Key verhindert Doppelwerte; Indizes für As-of-Queries.
3. **Materialisierung:** Deterministische pure Compute-Funktionen, topologische Dependencyreihenfolge, bounded Batch, Watermark/Cursor, idempotente Retries und Backfill Manifest.
4. **PIT Query:** API liefert je Entity/Feature den neuesten Wert mit event_time <= target und available_at <= as_of. Harte Limits, typed output und explizite Missingness.
5. **Offline/Online-Parität:** Live- und Backtestadapter verwenden dieselbe Registry/Compute-Logik. Vergleichsjob/Tests erkennen Divergenz und Datenrevisionen.
6. **Quality/Operations:** Propagation von Source Quality, Staleness, Lineage, Lag, Coverage, Retention/Compaction und sichere Recompute-Versionierung.
7. **Migration:** Starte mit 1–2 bestehenden deterministischen Scannerfeatures als vertikaler Slice; keine Big-Bang-Migration aller Features.

## Explizit nicht Teil dieses Changes

- kein externer Feature-Store-Dienst ohne Architekturentscheidung
- keine Speicherung beliebiger unbounded JSON-Blobs ohne Schema
- kein stilles Überschreiben historischer Werte bei Datenrevision

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

- [ ] verspätete Quelle ist bei as_of davor unsichtbar und danach sichtbar
- [ ] gleiche Definition/Input schreibt idempotent genau einen Wert
- [ ] Definition-/Configänderung erzeugt neue Version
- [ ] Backfill-Restart setzt am Cursor ohne Lücke/Duplikat fort
- [ ] Offline/Online-Fixture liefert identischen Featurewert
- [ ] Quality/Missingness propagiert korrekt
- [ ] Query-Limits und Indizes werden geprüft
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

- [ ] synthetischer Leakage-Test beweist point-in-time Joinsemantik
- [ ] jeder Wert ist bis Rohdatenmanifest und Definition rückverfolgbar
- [ ] Registry verhindert Mutation bestehender Definitionen
- [ ] Rollout beginnt als kleiner Slice und lässt bestehende Consumer kompatibel
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
