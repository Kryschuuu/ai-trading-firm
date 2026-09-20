# PROMPT-P1-02 — echtes 90d/30d Walk-Forward Train-Select-Freeze-Test

## Auftrag

Implementiere **echtes 90d/30d Walk-Forward Train-Select-Freeze-Test** produktionsreif im Repository
`Kryschuuu/ai-trading-firm`. Dieser Prompt ist eigenständig: prüfe zuerst den
aktuellen Branch und Code; Audit-Basis war Commit `df3163e` (`v1.51.1`). Wenn
der aktuelle Stand abweicht, übernimm die Absicht mit minimalem Scope und
vermerke die Abweichung im PR.

Zugehöriger Befund: [`../findings/RMA-P1-02-walk-forward-training.md`](../findings/RMA-P1-02-walk-forward-training.md)
Priorität/Schwere: **P1 / CRITICAL**
Schätzung des Restaufwands: **4–6 PT**

## Verifizierter Ausgangszustand

- 90d/30d-Defaults, Fensterlayout, Warm-up und IS/OOS-Replay sind implementiert.
- `runWalkForward()` spielt derzeit dieselbe Strategie in IS und OOS ab.
- Trade-Hashes und Fensteraggregate sind vorhanden.
- Ein finaler Holdout sowie ein immutable Freeze-Artefakt fehlen.

## Zielzustand

Jedes Fenster selektiert ausschließlich anhand von In-Sample-Daten eine Kandidatenkonfiguration, friert diese mit vollständiger Provenance ein und evaluiert genau diese Konfiguration auf OOS. Optional folgt ein finaler, bis zur Auswahl unangetasteter Holdout.

## Vor Beginn gezielt prüfen

- `src/backtest/walkforward.ts`
- `src/backtest/engine.ts`
- `src/backtest/runStore.ts`
- `scripts/run-backtest.ts`
- `src/app/api/firm/backtest/route.ts`
- `tests/backtest.engine.test.ts`

Suche zusätzlich nach allen Call Sites, Schemaexporten, Migrationen,
Konfigurationsmustern und vorhandenen Tests. Pfade dürfen seit dem Audit
verschoben worden sein; implementiere nicht parallel zu bereits vorhandener
äquivalenter Logik.

## Verbindlicher Implementierungsumfang

1. **Kandidatenvertrag:** Definiere begrenzte Kandidaten mit stabiler ID, Strategie-/Regelversion und serialisierbarer Config. Validierung verhindert Duplikate, NaN und unbeschränkte Suchräume.
2. **IS-Selector:** Berechne konfigurierbare Zielmetrik plus harte Mindestgates nur aus IS. Implementiere eine dokumentierte, stabile Tie-Break-Reihenfolge; kein Zugriff auf OOS/Final-Holdout im Selector-Typ/API.
3. **Freeze-Artefakt:** Persistiere pro Fenster Auswahl, vollständige Score-Tabelle, Datenmanifest, Code-/Config-/Kandidatenhash, Seed und Cutoffs. Nach Selektion unveränderlich.
4. **OOS/Holdout:** Evaluiere nur die ausgewählte Kandidaten-ID auf OOS. Unterstütze einen finalen Holdout, der erst nach abgeschlossener Gesamtentscheidung ausgeführt wird und nie zurück in Selektion fließt.
5. **Leakage-Schutz:** Schneide Warm-up und Features as-of-sicher; prüfe Embargo/Purge an Grenzen, falls Labels/Horizonte über das Splitende reichen.
6. **CLI/API:** Erweitere Ausgabe und Persistenz additiv um Selection-, Freeze- und Holdout-Summaries mit begrenzten Payloads.

## Explizit nicht Teil dieses Changes

- kein Hyperparameterdienst oder verteiltes Training
- keine Änderung fachfremder Scannergewichte
- keine automatische Live-Promotion; sie gehört zu P1.5

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

- [ ] mutierte OOS-Werte ändern die IS-Auswahl nicht
- [ ] stabile Tie-Breaks sind unabhängig von Kandidaten-Eingabereihenfolge
- [ ] Freeze-Hash ändert sich bei Kandidat, Datenmanifest oder Config
- [ ] ausgewählte Kandidaten-ID ist in OOS exakt dieselbe
- [ ] Leakage-Fixture mit horizonüberlappendem Label wird gepurged/abgelehnt
- [ ] finaler Holdout ist vor Abschluss der Auswahl nicht verfügbar
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

- [ ] Report unterscheidet IS-Auswahl, OOS-Evaluation und finalen Holdout eindeutig
- [ ] jede Auswahl ist aus persistiertem Artefakt reproduzierbar
- [ ] keine unbounded Kombinationsexplosion ist per API/CLI möglich
- [ ] alte Replay-only-Aufrufe bleiben explizit kompatibel oder klar migriert
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
