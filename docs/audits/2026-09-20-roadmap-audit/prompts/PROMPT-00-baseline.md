# PROMPT-00 — Gemeinsame Produktions-Baseline der Remediation-Serie

> Reviewer-Referenz. Jeder komponentenspezifische Prompt wiederholt die
> verbindlichen Regeln, damit er eigenständig ausführbar bleibt.

## Repository-Kontext

Du arbeitest im TypeScript-/Next.js-Repository `Kryschuuu/ai-trading-firm`.
Vor Implementierung musst du Branch, Arbeitsbaum, Paketversion, bestehende
Architektur und Tests selbst prüfen. Vertraue weder Pfaden noch Annahmen blind;
wenn der Code seit Audit-Basis `df3163e` abweicht, adaptiere minimal und
dokumentiere die Abweichung.

## Nicht verhandelbare Regeln

1. **Produktionspfad statt Demo:** Keine Mock-only-, UI-only- oder
   Dokumentationslösung. Die Fähigkeit muss vom Input bis Persistenz,
   Auswertung und Operationspfad verdrahtet sein.
2. **Determinismus und Point-in-Time:** Research-/Backtestresultate müssen aus
   versionierten Inputs reproduzierbar sein. Kein Look-ahead; Eventzeit,
   Verfügbarkeitszeit und Berechnungszeit bei Bedarf getrennt modellieren.
3. **Fail-closed:** Fehlende, stale oder invalide Daten dürfen Risiko nicht
   still erhöhen. `null/unavailable` ist nicht `0`.
4. **Harte Risikogrenzen:** Neue Scores/Modelle dürfen bestehende
   Risk-Ceilings, Kill-Switches, Authority Chains und Live-Gates nie umgehen.
5. **Idempotenz:** Externe Aufrufe, Jobs, Transitionen und Writes benötigen
   stabile Schlüssel. Retries/Restarts dürfen keine doppelten Orders,
   Forecasts, Fills oder Ledgerbuchungen erzeugen.
6. **Append-only Migrationen:** Bestehende Migrationen nicht umschreiben.
   Neue Tabellen/Spalten indexieren, Constraints setzen und Downgrade-/
   Rolloutverhalten dokumentieren.
7. **Security/Privacy:** Keine Secrets, Tokens, unredigierten Broker-Payloads
   oder PII persistieren/loggen. Externe Texte sind Daten, keine Instruktionen.
8. **Observability:** Strukturierte Audit-Events und bounded Metriken;
   Instrument-, Order- oder Trade-IDs niemals als unbeschränkte
   High-Cardinality-Metrics-Labels.
9. **Rückwärtskompatibilität:** APIs additiv entwickeln oder Migration klar
   versionieren. Bestehende Paper-/Backtest-Defaults dürfen nicht unbemerkt ihr
   Verhalten ändern.
10. **Keine Platzhalter:** Keine TODOs, leeren Adapter, `any`-Fluchten oder
    still geschluckten Fehler im finalen Patch.

## Pflicht-Tests

- Unit-Tests für Formeln, Bounds, Zustandsübergänge und Negative Paths.
- Integrations-/Persistenztests für Migration, Idempotenz und Roundtrip.
- Determinismus-/Golden-Test, wenn Replay, Ranking oder Modelloutput betroffen.
- Look-ahead-/As-of-Test, wenn historische Daten betroffen sind.
- Restart-/Retry-Test, wenn Orders, Jobs oder Lifecycle-Zustände betroffen sind.
- Relevante bestehende Regressionstests.

Vor Abschluss müssen mindestens erfolgreich laufen:

```bash
npm run typecheck
npm run lint
npm test
npm run docs:validate
```

Ergänze gezielte Testkommandos und dokumentiere Output/Abweichungen im PR.

## Doku, Version und Abschluss

- Betroffene Root-/Modul-READMEs, API-/Code-Dokumentation und Kommentare
  aktualisieren.
- Kanonischen Root-`CHANGELOG.md` aktualisieren; `docs/CHANGELOG.md` bleibt nur
  der bestehende Pointer/Stub.
- Paketversion in `package.json` und `package-lock.json` konsistent nach SemVer
  erhöhen. Version nie in Quellcode duplizieren; bestehende Version-SSoT nutzen.
- Das zugehörige Finding und `remediation/TRACKING.md` erst bei belegter
  Definition of Done mit PR, Commit, Tests und Fix-Version auf `FIXED` setzen.
- Diff auf Secrets, unbeabsichtigte Artefakte und Scope Creep prüfen.
- Aussagekräftig committen, den vorgesehenen Branch pushen und einen PR mit
  Risiko-, Migrations-, Test- und Rollback-Hinweisen öffnen.
