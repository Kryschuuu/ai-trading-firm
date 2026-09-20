# PROMPT-P2-02 — historische Perpetual-Datenpipeline

## Auftrag

Implementiere **historische Perpetual-Datenpipeline** produktionsreif im Repository
`Kryschuuu/ai-trading-firm`. Dieser Prompt ist eigenständig: prüfe zuerst den
aktuellen Branch und Code; Audit-Basis war Commit `df3163e` (`v1.51.1`). Wenn
der aktuelle Stand abweicht, übernimm die Absicht mit minimalem Scope und
vermerke die Abweichung im PR.

Zugehöriger Befund: [`../findings/RMA-P2-02-perpetual-data.md`](../findings/RMA-P2-02-perpetual-data.md)
Priorität/Schwere: **P2 / HIGH**
Schätzung des Restaufwands: **5–8 PT**

## Verifizierter Ausgangszustand

- Scanner hat Funding-/Open-Interest-Faktoren und neutralen Missing-Fallback.
- Paper-Ledger kann Funding verbuchen.
- Broker-/Marketdata-Ports liefern keine kanonische historische Perp-Zeitreihe.
- Liquidationsereignisse und As-of-Abfragen fehlen.

## Zielzustand

Ingestiere, normalisiere, qualitätsprüfe und persistiere Funding, Open Interest und Liquidationen je Venue/Instrument point-in-time, sodass Scanner, Backtest und Agenten denselben as-of-sicheren Datensatz verwenden.

## Vor Beginn gezielt prüfen

- `src/scanner/types.ts`
- `src/scanner/factors/funding.ts`
- `src/scanner/factors/openInterest.ts`
- `src/lib/funding.ts`
- `src/contracts/broker.ts`
- `src/marketdata/sync.ts`
- `src/marketdata/quality.ts`
- `src/brokers/bitunix/`
- `src/brokers/alpaca/`
- `src/db/schema.ts`

Suche zusätzlich nach allen Call Sites, Schemaexporten, Migrationen,
Konfigurationsmustern und vorhandenen Tests. Pfade dürfen seit dem Audit
verschoben worden sein; implementiere nicht parallel zu bereits vorhandener
äquivalenter Logik.

## Verbindlicher Implementierungsumfang

1. **Kanonisches Schema:** Definiere Funding Rate plus Intervall/Next Time, OI in Contracts/Base/Quote und Liquidation Side/Qty/Price/Notional. Immer Venue, canonical Instrument, event_time, available_at, fetched_at, Source-ID und Schema-Version.
2. **Adapter/Capability:** Erweitere Ports capability-aware. Unsupported ist typisiert und nicht leere Liste/0. Implementiere mindestens den tatsächlich unterstützten Perp-Venue-Adapter plus Fixture-Adapter.
3. **Persistenz/Sync:** Append-only/upsert-idempotent mit natürlichen Unique Keys, Backfill-Cursor, inkrementellem Sync, Rate-Limit/Retry und bounded Batchgrößen.
4. **Quality:** Gaps, Staleness, negative/inkonsistente OI, Rate Bounds, Duplicate Events und optionale Cross-Venue-Checks. Strict/log analog Candle-Quality.
5. **Query:** As-of API nach Venue/Instrument/Range mit Limits; liefere neuesten verfügbaren Snapshot ohne zukünftige `available_at`-Werte.
6. **Konsumenten:** Verdrahte `DerivativeContext`, Funding-Replay und Analystensnapshot auf die kanonische Quelle. Missing/stale bleibt unavailable mit Reason.

## Explizit nicht Teil dieses Changes

- keine Unterstützung fiktiver Perp-Daten bei Spot-only-Venues
- keine Speicherung kompletter unredigierter Providerantworten
- kein Cross-Sectional-Ranking außerhalb der vorhandenen Faktoren

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

- [ ] Einheiten-/Vorzeichennormalisierung je Provider-Fixture
- [ ] Backfill und inkrementeller Retry sind duplikatfrei
- [ ] As-of-Abfrage blendet später verfügbare Daten aus
- [ ] Staleness/Gaps/invalid OI und Rate Bounds sind abgedeckt
- [ ] Unsupported Capability ist von temporärem Providerfehler unterscheidbar
- [ ] Funding-Replay bucht nur fällige Intervalle für offene Positionen
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

- [ ] Scanner, Agent und Backtest lesen dieselbe kanonische Datenform
- [ ] jede Zahl hat dokumentierte Einheit und Venue-/Instrument-Provenance
- [ ] Data Quality kann fehlerhafte Perp-Daten fail-closed blockieren
- [ ] Sync ist observierbar, rate-limited und restartfähig
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
