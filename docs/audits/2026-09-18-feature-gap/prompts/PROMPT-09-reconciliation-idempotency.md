# PROMPT-09 — Reconciliation Broker ↔ DB + idempotente Order-IDs (GAP-09)

> **Finding:** [GAP-09](../findings/GAP-09-reconciliation-idempotency.md) ·
> **Reihenfolge:** Schritt 10 (Live-Readiness) ·
> **Voraussetzungen:** empfohlen: PROMPT-10 (AlertSink); ohne ihn Log-Stubs ·
> **Erwartete Größenordnung:** 1 PR, Minor-Version (feat)

## Session-Prompt

```text
# Mission: Periodischer Reconciliation-Job, Differenz-Klassifikation,
# clientOrderId-Konvention, Paper-Invarianz-Selbsttest (GAP-09)

Du arbeitest als Senior-Engineer im Repository „ai-trading-firm“ (Node.js
20+/TypeScript strict, Next.js 16, Drizzle + PostgreSQL, node:test,
Paper-Trading only — der Live-Pfad bleibt verriegelt; du BAUST hier die
Voraussetzung, ihn EINST aktivieren zu können). Stand: orderIntents-Tabelle
(H2-Fix) und Bitunix-Idempotenz-Tests existieren; ein periodischer,
adapter-übergreifender Abgleich mit Differenz-Klassifikation, Alarm-/Pause-
Pfad und Paper-Invarianz-Selbsttest fehlt.

## Schritt 1 — Ist-Stand verifizieren (Pflicht)

Lies vollständig: src/db/schema.ts (orderIntents, positions,
venue_control_state), src/contracts/broker.ts (Adapter-Vertrag; welche
getAccount/getOrders-Methoden existieren für den Abgleich), src/brokers/
bitunix/execution.ts + tests/bitunix.idempotency.test.ts (bestehendes
Idempotenz-Muster), src/brokers/factory.ts + adapterCatalog.ts (Adapter-
Zugriff), src/lib/monitor.ts (wo periodische Arbeit läuft), src/cycle/
scheduler.ts (Scheduler-Muster), src/lib/broker.ts (Paper-Invarianten:
freeCash, listPositions, accountEquity). Abweichung → Rest-Delta, im PR
dokumentieren.

## Schritt 2 — Delta umsetzen

D1 RECONCILIATION-JOB (neu src/brokers/reconciliation.ts):
   - runReconciliation(adapter, dbStore): Abgleich Broker-Positions/Orders/
     Account-Balance ↔ DB (positions, orderIntents, equity_snapshots).
   - Differenz-Klassifikation (reine Funktion, gut testbar):
     PRICE_DRIFT (innerhalb Toleranz RECON_PRICE_DRIFT_PCT, Default 1,
     Bounds [0.01, 10] — tolerierbar, wird nur reportet), QTY_MISMATCH,
     PHANTOM_POSITION (nur Broker), MISSING_POSITION (nur DB),
     BALANCE_MISMATCH.
   - Report als Objekt + Persistenz (data/reconciliation/last-report.json
     via resolveRuntimePath) + Audit-Zeilen je kritischer Klasse.
   - Scheduler: Intervall RECON_INTERVAL_MINUTES (Default 60, Bounds
     [5, 1440]); Verdrahtung im bestehenden Scheduler-/Monitor-Muster +
     CLI scripts/reconcile.ts für Ad-hoc-Läufe.
D2 PAUSE-PFAD: RECON_PAUSE_ON_MISMATCH (Default false): bei kritischer
   Klasse (QTY_MISMATCH, PHANTOM, MISSING, BALANCE) → bestehenden Kill-
   Switch-Service-Pfad ENGAGE mit Grund „recon:<klasse>“ + Alert über den
   AlertSink (PROMPT-10; falls nicht gemerged: Log-Implementierung als
   dokumentierter Stub). Auto-Flatten ist VERBOTEN — Aufräumen nur durch
   Admin nach manuellem Re-Arm (Disarm-Challenge bleibt unverändert).
D3 CLIENT-ORDER-ID-KONVENTION: Einheitliches, deterministisches Schema
   „atf-<orderIntentId-kurz>“ für alle Order-Submit-Pfade (Bitunix + Alpaca-
   Adapter, wo das Venue es unterstützt — Capabilities respektieren; sonst
   dokumentierte Ausnahme je Venue). Retry nach Timeout WIEDERHOLT dieselbe
   clientOrderId aus demselben orderIntent → Venue-/Mock-Dedupe oder lokale
   Dedupe über orderIntents-Status (Twice-submit → genau eine Order). Test:
   Mock-Timeout NACH Submit, Retry → keine Doppelorder, orderIntent am Ende
   konsistent.
D4 PAPER-INVARIANZ-SELBSTTEST: Reconciliation gegen den PAPER-Adapter prüft
   Ledger-Invarianten: freeCash >= 0, Summe Notional <= equity, fees >= 0,
   keine negative Menge, equity = freeCash + Summe Einstandswerte ±
   unrealizedPnl (genaue Formel aus dem Code übernehmen, nicht erfinden).
   Verletzung → Report-Klasse INVARIANT_VIOLATION + Audit + Alert. Der
   Selbsttest läuft auch im reinen Paper-Betrieb (echter Nutzen ohne Live).

## Grundregeln (Baseline der Serie, verbindlich)

Paper-only (Live-Adapter werden gelesen, der Live-Modus wird NICHT
aktivierbar gemacht; Kill-Switch-/Disarm-Pfade unverändert) · Fail-closed ·
keine neuen Runtime-Dependencies · Schwellen mit Bounds + Default + Eintrag
in .env.example UND CONFIGURATION.md · keine Secrets · Mutationen (ENGAGE,
Dedupe-Status) ins audit_log · append-only, falls Schemaänderung nötig ·
Determinismus (Fake-Clock, Mock-HTTP nach bestehendem Muster der
bitunix-Tests) · Pflicht-Checks: npm run typecheck && npm run lint &&
npm test && npm run docs:validate — 0 Failures (Ausnahme ENV-01) ·
CHANGELOG + Versions-Bump (package.json, Status-Header, docs/README.md) ·
nur dieses Delta; Neben-Bugs in „Offene Punkte“.

## Schritt 3 — Tests (neu tests/reconciliation.test.ts)

- Klassifikation: je Differenztyp ein Fall (Fixture-Mismatch), inkl.
  Toleranz-Grenzfälle (genau RECON_PRICE_DRIFT_PCT → PRICE_DRIFT-only).
- Pause: RECON_PAUSE_ON_MISMATCH=false → nur Report/Audit; true → Kill-
  Switch ENGAGE mit Grund „recon:<klasse>“; Disarm weiterhin nur manuell.
- Idempotenz: Timeout nach Submit (Mock), Retry mit gleicher clientOrderId →
  genau eine Order; zweiter unabhängiger Intent → zweite Order.
- Paper-Invarianz: gesundes Ledger → keine Befunde; manipuliertes Fixture
  (negatives Cash) → INVARIANT_VIOLATION + Audit.
- Scheduler-Intervall mit Fake-Clock; CLI-Run schreibt Report-Datei.

## Schritt 4 — Docs & Meta

- docs/BROKER_ARCHITECTURE.md: Sektion „Reconciliation & Idempotenz“
  (Klassen, Toleranzen, Pause-Politik, clientOrderId-Schema, Venue-Ausnahmen).
- docs/LIVE_TRADING.md: Hinweis, dass GAP-09 die Readiness-Bedingung für
  einen künftigen Live-Start erfüllt (Enforcement unverändert).
- CONFIGURATION.md + .env.example: neue Flags. CHANGELOG (feat, Minor-Bump)
  + Status-Header + docs/README.md. TRACKING.md pflegen; Finding „Umsetzung“
  ergänzen.

## Abnahme (Definition of Done)

[ ] Ist-Stand verifiziert; D1–D4 umgesetzt und je getestet
[ ] Kein Auto-Flatten; Disarm bleibt Challenge-geschützt (Tests grün)
[ ] Doppelorder-Test (Timeout nach Submit) existiert und ist grün
[ ] Flags in .env.example + CONFIGURATION.md
[ ] typecheck + lint + npm test + docs:validate grün (Zahlen im PR)
[ ] CHANGELOG/Version + TRACKING.md + Finding aktualisiert
[ ] PR-Beschreibung vollständig
```
