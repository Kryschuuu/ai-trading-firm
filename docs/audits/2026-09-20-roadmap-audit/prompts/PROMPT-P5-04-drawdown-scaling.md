# PROMPT-P5-04 — hysteretisches Drawdown-Risk-Scaling

## Auftrag

Implementiere **hysteretisches Drawdown-Risk-Scaling** produktionsreif im Repository
`Kryschuuu/ai-trading-firm`. Dieser Prompt ist eigenständig: prüfe zuerst den
aktuellen Branch und Code; Audit-Basis war Commit `df3163e` (`v1.51.1`). Wenn
der aktuelle Stand abweicht, übernimm die Absicht mit minimalem Scope und
vermerke die Abweichung im PR.

Zugehöriger Befund: [`../findings/RMA-P5-04-drawdown-scaling.md`](../findings/RMA-P5-04-drawdown-scaling.md)
Priorität/Schwere: **P5 / HIGH**
Schätzung des Restaufwands: **2–3 PT**

## Verifizierter Ausgangszustand

- Max Drawdown und Equity Snapshots existieren.
- Risk Guard besitzt Daily-Loss- und harte Risikogrenzen.
- Adaptive Risk zeigt ein Muster für persistierte Faktoren.
- Kein kontinuierlicher Faktor aus High-Water-Mark-Drawdown existiert.

## Zielzustand

Leite aus reconcilter Equity und persistiertem High-Water-Mark eine monotone, bounded Risikoreduktion mit Hysterese/Cooldown ab und kombiniere sie fail-closed mit bestehenden Risikofaktoren.

## Vor Beginn gezielt prüfen

- `src/db/schema.ts`
- `src/portfolio/metrics.ts`
- `src/lib/riskGuard.ts`
- `src/lib/adaptiveRisk.ts`
- `src/cycle/steps/riskStep.ts`
- `src/lib/broker.ts`
- `src/brokers/reconciliation.ts`

Suche zusätzlich nach allen Call Sites, Schemaexporten, Migrationen,
Konfigurationsmustern und vorhandenen Tests. Pfade dürfen seit dem Audit
verschoben worden sein; implementiere nicht parallel zu bereits vorhandener
äquivalenter Logik.

## Verbindlicher Implementierungsumfang

1. **Equityquelle:** Definiere autoritative reconciled Equity, Snapshotfrequenz, Freshness und Umgang mit Ein-/Auszahlungen. High-Water-Mark darf Cashflows nicht als Performance verwechseln.
2. **Policy:** Versionierte stückweise monotone Kurve aus Drawdown zu Faktor mit soft/hard thresholds, min factor und optional PAUSE. Werte/Bereich validieren.
3. **State/Hysterese:** Persistiere High-Water-Mark, Drawdown, Faktor, Policyversion und letzte Transition. Degradation sofort/gebounded; Recovery nur nach Cooldown und bestätigter Erholung.
4. **Komposition:** Multiplikativ/min-konservativ mit Volatilitätsfaktor und bestehenden Limits; Authority Chain stellt sicher, dass spätere Stufe nicht wieder aufweitet.
5. **Audit/Operations:** Jeder Faktorwechsel mit Equitysnapshot, Reason und alter/neuer Stufe. Status-API und bounded Metriken.
6. **Bootstrap:** Bestehende Konten sicher initialisieren; fehlende/stale/reconciliation-failed Equity führt zu konservativem Zustand.

## Explizit nicht Teil dieses Changes

- kein automatischer Kapitaltransfer
- kein Reset des High-Water-Marks durch Deployment
- kein Ersatz für Daily-Loss-Kill-Switch

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

- [ ] wachsende Drawdowns erhöhen Faktor nie
- [ ] Recovery folgt Hysterese/Cooldown statt sofortigem Flapping
- [ ] Deposit/Withdrawal-Fixture verfälscht Drawdown nicht
- [ ] Restart rekonstruiert identischen High-Water-Mark/Faktor
- [ ] stale oder unreconciled Equity reduziert Risiko
- [ ] Komposition kann Ceiling nie überschreiten
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

- [ ] jede Sizingentscheidung kann angewandten Drawdownfaktor referenzieren
- [ ] Policyänderung erzeugt neue Version statt historische Uminterpretation
- [ ] Recovery ist mindestens so konservativ wie dokumentiert
- [ ] Bootstrap/Rollback sind ohne unkontrollierte Risikoerhöhung möglich
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
