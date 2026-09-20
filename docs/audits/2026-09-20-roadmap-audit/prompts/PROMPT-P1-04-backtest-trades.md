# PROMPT-P1-04 — persistente Backtest-Trades als Trade-Level-Wahrheitsquelle

## Auftrag

Implementiere **persistente Backtest-Trades als Trade-Level-Wahrheitsquelle** produktionsreif im Repository
`Kryschuuu/ai-trading-firm`. Dieser Prompt ist eigenständig: prüfe zuerst den
aktuellen Branch und Code; Audit-Basis war Commit `df3163e` (`v1.51.1`). Wenn
der aktuelle Stand abweicht, übernimm die Absicht mit minimalem Scope und
vermerke die Abweichung im PR.

Zugehöriger Befund: [`../findings/RMA-P1-04-backtest-trades.md`](../findings/RMA-P1-04-backtest-trades.md)
Priorität/Schwere: **P1 / CRITICAL**
Schätzung des Restaufwands: **2–3 PT**

## Verifizierter Ausgangszustand

- `backtest_runs` persistiert Config, Metriken, Zeitfenster und Trade-Hash.
- `BacktestTradeLog` enthält Laufzeitdaten einzelner Trades.
- Es gibt keine relationale `backtest_trades`-Tabelle.
- Run-List-/Detail-APIs existieren bereits.

## Zielzustand

Jeder persistierte Backtest-Run besitzt atomar geschriebene, normalisierte und paginierbar abrufbare Tradezeilen, aus denen Kernaggregate und Trade-Hash reproduziert werden können.

## Vor Beginn gezielt prüfen

- `src/db/schema.ts`
- `drizzle/`
- `src/backtest/runStore.ts`
- `src/backtest/types.ts`
- `src/app/api/firm/backtests/route.ts`
- `src/app/api/firm/backtests/[id]/route.ts`
- `tests/backtest.engine.test.ts`

Suche zusätzlich nach allen Call Sites, Schemaexporten, Migrationen,
Konfigurationsmustern und vorhandenen Tests. Pfade dürfen seit dem Audit
verschoben worden sein; implementiere nicht parallel zu bereits vorhandener
äquivalenter Logik.

## Verbindlicher Implementierungsumfang

1. **Schema/Migration:** Füge append-only `backtest_trades` mit Run-FK, stabiler Sequence/Trade-ID, Symbol, Side, Mengen, Entry/Exit-Zeit/-Preis, Brutto-/Netto-PnL, Fee, Funding, Slippage, Exit Reason und JSONB-Provenance hinzu. Setze Unique-, Check- und Query-Indizes.
2. **Mapping:** Implementiere eine reine validierende Abbildung von `BacktestTradeLog`; dokumentiere Preis-/PnL-Einheiten, nullbare Felder und Rundung. Keine NaN/Infinity in DB.
3. **Atomarer Write:** Schreibe Run und Trades in einer DB-Transaktion. Nutze stabilen Idempotency Key; ein Retry darf weder doppelten Run noch doppelte Sequenzen erzeugen.
4. **Reconciliation:** Berechne/prüfe Count, Fees, Funding und Netto-PnL gegen Run-Metriken; speichere Reconciliation-Status oder lehne inkonsistente Writes ab.
5. **API:** Erweitere Details additiv um paginierte Trades mit hartem Limit, Cursor und Filter. Run-Listen laden nicht implizit alle Trades.
6. **Retention/Deletion:** Erhalte bestehende Lösch-/FK-Konventionen; dokumentiere erwartetes Volumen und Queryplan.

## Explizit nicht Teil dieses Changes

- kein neues Attributionmodell (P1.6)
- keine Strategie-Lifecycle-Automation (P1.5)
- kein UI-Redesign

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

- [ ] Migration und Schema-Constraints sind getestet
- [ ] Run plus N Trades roundtrippen mit korrekter Reihenfolge
- [ ] simulierter Fehler in Trade N rollt gesamten Run zurück
- [ ] Idempotency-Retry erzeugt exakt einen Run und N Trades
- [ ] Aggregate/Trade-Hash werden aus DB-Zeilen reproduziert
- [ ] API-Limit, Cursor und unbekannte Run-ID sind abgedeckt
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

- [ ] Tradezeilen bilden den vollständigen Run ohne versteckte In-Memory-Daten ab
- [ ] Run-Listen bleiben bounded und rückwärtskompatibel
- [ ] FK/Unique/Check-Constraints verhindern verwaiste oder doppelte Trades
- [ ] Persistenzfehler werden sichtbar und nie als erfolgreicher Run gemeldet
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
