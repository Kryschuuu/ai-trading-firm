# PROMPT-P2-01 — mehrdimensionale, point-in-time-sichere Regime-Erkennung

## Auftrag

Implementiere **mehrdimensionale, point-in-time-sichere Regime-Erkennung** produktionsreif im Repository
`Kryschuuu/ai-trading-firm`. Dieser Prompt ist eigenständig: prüfe zuerst den
aktuellen Branch und Code; Audit-Basis war Commit `df3163e` (`v1.51.1`). Wenn
der aktuelle Stand abweicht, übernimm die Absicht mit minimalem Scope und
vermerke die Abweichung im PR.

Zugehöriger Befund: [`../findings/RMA-P2-01-regime-detection.md`](../findings/RMA-P2-01-regime-detection.md)
Priorität/Schwere: **P2 / MEDIUM**
Schätzung des Restaufwands: **2–4 PT**

## Verifizierter Ausgangszustand

- OHLCV-basierte fünf Klassen, Hysterese und produktives Regime-Gate existieren.
- Klassifikation ist deterministisch und per Instrument zustandsbehaftet.
- Liquiditäts-, Perp- und Makromerkmale fehlen.
- Output enthält harte Klasse, aber keine belastbare Wahrscheinlichkeits-/Coverage-Dimension.

## Zielzustand

Erweitere das bestehende Regime-System kompatibel um versionierte Preis-, Volatilitäts-, Liquiditäts-, Perp- und optionale Makrofeatures mit Confidence/Coverage, ohne den bewährten Gate-/Hysterese-Pfad oder Point-in-Time-Sicherheit zu brechen.

## Vor Beginn gezielt prüfen

- `src/lib/marketRegime.ts`
- `src/scanner/regime.ts`
- `src/lib/adaptiveRisk.ts`
- `src/marketdata/quality.ts`
- `src/scanner/types.ts`
- `src/lib/marketdata/historicalStore.ts`
- `tests/marketRegime.test.ts`

Suche zusätzlich nach allen Call Sites, Schemaexporten, Migrationen,
Konfigurationsmustern und vorhandenen Tests. Pfade dürfen seit dem Audit
verschoben worden sein; implementiere nicht parallel zu bereits vorhandener
äquivalenter Logik.

## Verbindlicher Implementierungsumfang

1. **Featurevertrag:** Definiere Featurefamilien, Einheiten, Lookbacks, As-of/Available-Time, Staleness und Missingness. Keine automatische Nullsubstitution.
2. **Klassifikation:** Erweitere deterministisch oder mit versioniertem kalibriertem Modell. Liefere Klasse, Confidence/Probability, Coverage, Top-Treiber und Model-/Featureversion.
3. **Fallback:** Bestehende OHLCV-Klassifikation bleibt expliziter Degraded Mode. Bei niedriger Coverage darf Gatefaktor Risiko nicht erhöhen.
4. **Hysterese:** Trenne Rohklassifikation/-wahrscheinlichkeit von bestätigtem Zustand; passe Transitionen so an, dass zusätzliche Features kein Flapping erzeugen.
5. **Historie/Evaluation:** Persistiere bounded Artefakte und evaluiere Stabilität, Transitionen, Coverage sowie OOS-Kennzahlen pro Regime.
6. **Integration:** Scanner, Agentenkontext und Risk Gate konsumieren denselben Snapshot; keine parallelen Regimedefinitionen neu einführen.

## Explizit nicht Teil dieses Changes

- kein unversioniertes Online-Training
- kein Ersatz harter Risk-Ceilings durch Modellwahrscheinlichkeit
- keine Verpflichtung externer Makrodaten, wenn sie nicht verfügbar sind

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

- [ ] Feature-Fixtures ergeben erwartete Klasse/Confidence/Treiber
- [ ] stale oder fehlende Familie senkt Coverage und erhöht Risiko nicht
- [ ] gleiche As-of-Daten ergeben identischen Snapshot
- [ ] Hysterese verhindert Ein-Bar-Flapping
- [ ] alte OHLCV-only-Konfiguration bleibt reproduzierbar
- [ ] Backtest kann keine später verfügbaren Makro-/Perp-Daten sehen
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

- [ ] ein kanonischer Snapshot bedient Live und Backtest
- [ ] jede Featurefamilie ist mit Zeitsemantik und Einheiten dokumentiert
- [ ] Degraded Mode und Coverage sind in API/Audit sichtbar
- [ ] Regimefaktor bleibt innerhalb bestehender Bounds
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
