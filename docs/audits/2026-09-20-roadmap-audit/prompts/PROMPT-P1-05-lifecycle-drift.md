# PROMPT-P1-05 — Strategy-Lifecycle mit Backtest↔Paper↔Live-Driftgates

## Auftrag

Implementiere **Strategy-Lifecycle mit Backtest↔Paper↔Live-Driftgates** produktionsreif im Repository
`Kryschuuu/ai-trading-firm`. Dieser Prompt ist eigenständig: prüfe zuerst den
aktuellen Branch und Code; Audit-Basis war Commit `df3163e` (`v1.51.1`). Wenn
der aktuelle Stand abweicht, übernimm die Absicht mit minimalem Scope und
vermerke die Abweichung im PR.

Zugehöriger Befund: [`../findings/RMA-P1-05-lifecycle-drift.md`](../findings/RMA-P1-05-lifecycle-drift.md)
Priorität/Schwere: **P1 / CRITICAL**
Schätzung des Restaufwands: **8–12 PT**

## Verifizierter Ausgangszustand

- Immutable Regelversionen und manuelle Zustände DRAFT/ACTIVE/PAUSED/ARCHIVED existieren.
- Broker-Control-Plane und Live-Gates existieren getrennt.
- Es gibt keine evidenzbasierte Strategy-Lifecycle-State-Machine.
- Automatische Drift-Degradation zwischen Backtest, Paper und Live fehlt.

## Zielzustand

Eine persistente, auditierte State Machine promotet eine konkrete Strategieversion nur über belegte Backtest- und Paper-Gates nach Live und degradiert sie bei Performance-, Risiko-, Daten- oder Execution-Drift fail-closed.

## Vor Beginn gezielt prüfen

- `src/lib/ruleService.ts`
- `src/db/schema.ts`
- `src/brokers/control-plane/`
- `src/lib/riskGuard.ts`
- `src/backtest/runStore.ts`
- `src/lib/journal.ts`
- `src/brokers/reconciliation.ts`
- `src/lib/auditSink.ts`
- `src/lib/telemetry.ts`

Suche zusätzlich nach allen Call Sites, Schemaexporten, Migrationen,
Konfigurationsmustern und vorhandenen Tests. Pfade dürfen seit dem Audit
verschoben worden sein; implementiere nicht parallel zu bereits vorhandener
äquivalenter Logik.

## Verbindlicher Implementierungsumfang

1. **Domäne/State Machine:** Definiere mindestens DRAFT, BACKTEST_PENDING, BACKTEST_PASSED, PAPER, LIVE_LIMITED, LIVE, DEGRADED, PAUSED, REJECTED. Lege erlaubte Übergänge, Rollen, Preconditions und idempotente Transition Keys zentral fest.
2. **Evidenzmodell:** Persistiere immutable Evidence-Referenzen auf Strategie-/Prompt-/Code-/Datenversion, Backtest/WF-Run, Paperfenster, Stichprobe, Policyversion und Ergebnis. Keine lose JSON-Behauptung ohne FK/Hash.
3. **Promotion-Gates:** Implementiere versionierte Policies für Mindesttrades/-dauer, OOS-Kennzahlen, Drawdown, Datenqualität, Paper-Reconciliation und Execution Quality. Fehlende/stale Evidenz blockiert Promotion.
4. **Drift:** Definiere vergleichbare Backtest/Paper/Live-Metriken, Baselinefenster, Mindeststichprobe, absolute/relative Toleranzen und Confidence. Segmentiere mindestens Performance, Risiko, Execution und Data Quality.
5. **Degradation:** Automatisiere abgestufte Reaktion: Risk-Scale-down, LIVE_LIMITED/DEGRADED, PAUSE. Keine automatische Wieder-Promotion; Recovery benötigt Cooldown, neue Evidenz und Audit.
6. **Integration:** Vor Live-Order autorisiert der Lifecycle zusätzlich zum Broker-/Risk-Gate. Race Conditions zwischen Degradation und Orderintent durch transaktionalen/optimistischen State Check verhindern.
7. **Operations:** Read API/Status, begrenzte Metriken und Audit-Timeline; Operator-Override mit Reason, Actor, TTL und Vier-Augen-/Rollenprüfung gemäß vorhandener Auth-Architektur.

## Explizit nicht Teil dieses Changes

- keine Abschaffung des bestehenden Rule-Lifecycle
- kein selbstlernendes Online-Modell
- keine Lockerung von Broker-/Kill-Switch-Gates

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

- [ ] Transitionstabelle testet jeden erlaubten und verbotenen Übergang
- [ ] DRAFT→LIVE und Promotion ohne Evidenz werden abgelehnt
- [ ] stale/zu kleine Stichprobe blockiert Promotion
- [ ] Drift überschreitet Schwelle und degradiert idempotent
- [ ] parallel eintreffende Transitionen erzeugen genau einen Zustand/Audit-Event
- [ ] Order-Gate verhindert Liveorder nach atomarer Degradation
- [ ] Recovery benötigt neue Evidenz und Cooldown
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

- [ ] jede Liveorder referenziert autorisierte Strategieversion und Lifecyclezustand
- [ ] jede Transition ist mit Policy/Evidenz/Actor/Reason reproduzierbar
- [ ] Drift-Ausfall oder fehlende Daten kann Risiko niemals erhöhen
- [ ] Rollout startet feature-geflaggt in Monitor/Paper und dokumentiert Backfill/Bootstrap
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
