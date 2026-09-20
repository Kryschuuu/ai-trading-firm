# PROMPT-P4-02 — Post-Only-, Timeout- und Market-Fallback-State-Machine

## Auftrag

Implementiere **Post-Only-, Timeout- und Market-Fallback-State-Machine** produktionsreif im Repository
`Kryschuuu/ai-trading-firm`. Dieser Prompt ist eigenständig: prüfe zuerst den
aktuellen Branch und Code; Audit-Basis war Commit `df3163e` (`v1.51.1`). Wenn
der aktuelle Stand abweicht, übernimm die Absicht mit minimalem Scope und
vermerke die Abweichung im PR.

Zugehöriger Befund: [`../findings/RMA-P4-02-post-only-fallback.md`](../findings/RMA-P4-02-post-only-fallback.md)
Priorität/Schwere: **P4 / HIGH**
Schätzung des Restaufwands: **3–5 PT**

## Verifizierter Ausgangszustand

- Brokervertrag unterstützt Limit-/Marketorder-Grundtypen.
- Alpaca- und Bitunix-Serializer sind venue-spezifisch vorhanden.
- Executionmodule platzieren Einzelorders.
- Gemeinsame TTL/Cancel/Replace/Fallback-Policy und persistenter Zustand fehlen.

## Zielzustand

Ein versionierter Execution-Policy-Controller versucht bounded Post-Only/Limits, verarbeitet Rejects und Partial Fills, cancelt nach TTL sicher und darf nur die bestätigte Restmenge unter harten Spread-/Slippage-/Risk-Gates als Market fallbacken.

## Vor Beginn gezielt prüfen

- `src/contracts/broker.ts`
- `src/brokers/alpaca/orders.ts`
- `src/brokers/alpaca/execution.ts`
- `src/brokers/bitunix/orders.ts`
- `src/brokers/bitunix/execution.ts`
- `src/brokers/paper.ts`
- `src/lib/riskGuard.ts`
- `src/db/schema.ts`

Suche zusätzlich nach allen Call Sites, Schemaexporten, Migrationen,
Konfigurationsmustern und vorhandenen Tests. Pfade dürfen seit dem Audit
verschoben worden sein; implementiere nicht parallel zu bereits vorhandener
äquivalenter Logik.

## Verbindlicher Implementierungsumfang

1. **Policy:** Schema für postOnly, TTL, maxReprices, price offset, fallback allowed, max spread/slippage/notional/age. Bounds zentral validieren und versionieren.
2. **Capabilities:** Brokeradapter melden Post-Only-/CancelReplace-Fähigkeiten typisiert. Unsupported failt oder nutzt explizit konfigurierte sichere Alternative; kein stilles Flag-Dropping.
3. **State Machine:** NEW→SUBMITTED→ACK/PARTIAL→CANCEL_PENDING→CANCELLED→FALLBACK_SUBMITTED→DONE sowie REJECT/FAILED. Erlaubte Übergänge und optimistische Version zentral.
4. **Restmenge:** Fills jederzeit menge-/feegenau reconciliieren; Fallbackmenge = Ziel minus bestätigte Fills, nach Venue-Step gerundet und nie negativ.
5. **Race/Retry:** Client Order IDs/Idempotency Keys, Cancel-Bestätigung beziehungsweise atomisches Replace. Restart rekonstruiert Zustand vor externer Aktion.
6. **Safety/Audit:** Vor jedem Submit/Reprice/Fallback aktuelle Kill-Switch-, Lifecycle-, Risk-, Staleness-, Spread- und Notional-Gates. Jeder Schritt mit Reason/Policyversion auditieren.

## Explizit nicht Teil dieses Changes

- kein TWAP-/Child-Scheduler (P4.3)
- kein aggressiver Fallback bei unklarem Cancelstatus
- keine Umgehung venue-spezifischer Minimum-/Tickregeln

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

- [ ] Post-Only success, maker reject, timeout, partial fill und fallback
- [ ] Fill während CANCEL_PENDING verursacht keine Überfüllung
- [ ] unklarer Cancelstatus blockiert Market-Fallback
- [ ] Restart/Retry dupliziert keine Order
- [ ] Kill Switch oder stale Quote vor Fallback stoppt Ablauf
- [ ] unsupported Post-Only Capability ist explizit
- [ ] Restmengenrundung hält Venue-Step und Notionalgrenzen
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

- [ ] maximale Gesamtfillmenge überschreitet Ziel nie
- [ ] Market-Fallback ist opt-in und durch harte aktuelle Gates geschützt
- [ ] Zustand und externe IDs sind nach Restart vollständig rekonstruierbar
- [ ] Paperadapter simuliert dieselbe State-Machine deterministisch
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
