# PROMPT-05 — Server-seitiges Exit-Management (GAP-05)

> **Finding:** [GAP-05](../findings/GAP-05-server-side-exit-management.md) ·
> **Reihenfolge:** Schritt 2 ·
> **Voraussetzungen:** keine harten (PROMPT-02 empfohlen) ·
> **Erwartete Größenordnung:** 1 PR, Minor-Version (feat)

## Session-Prompt

```text
# Mission: Exit-Management vervollständigen — Trailing, Time-Stop,
# OCO-Exklusivität (GAP-05)

Du arbeitest als Senior-Engineer im Repository „ai-trading-firm“ (Node.js
20+/TypeScript strict, Next.js 16, Drizzle + PostgreSQL, node:test,
Paper-Trading only). Stand: Der Monitor (src/lib/monitor.ts, tick()) prüft
serverseitig SL/TP je offener Position, unabhängig von LLM-Turns — das ist
die Basis, die du erweiterst. Ziel: Trailing-Stop, Time-Stop und die Garantie
„genau ein Exit pro Position auch bei parallelen Ticks“ — crash-safe, nur
mit DB-Zustand, konfigurierbar mit Bounds.

## Schritt 1 — Ist-Stand verifizieren (Pflicht)

Lies vollständig: src/lib/monitor.ts, src/lib/broker.ts (close/flatten-Pfad,
submitAtomic-Muster), src/db/schema.ts (positions: stopLoss/takeProfit/
exitReason, positions_open_idx), src/lib/riskConfigService.ts (Konfig-
Muster), src/lib/engine.ts (Positionseröffnung), tests/monitor*.test.ts
falls vorhanden, tests/broker.test.ts. Erwartet laut Audit 2026-09-18:
SL/TP-Watcher existiert; Trailing/Time-Stop fehlen; OCO-Exklusivität nicht
belegt. Abweichung → nur Rest-Delta, im PR dokumentieren.

## Schritt 2 — Delta umsetzen

D1 TRAILING-STOP:
   - Flags: RISK_TRAILING_ENABLED (Default off — kein Verhaltensbruch),
     RISK_TRAILING_ACTIVATION_PCT (Default 1.0, Bounds [0.1, 20]),
     RISK_TRAILING_RETURN_PCT (Default 0.5, Bounds [0.1, 10]).
   - Logik im Monitor-Tick: Gewinn >= Activation → bewaffnet; Stop = Kurs −
     Rückgabeweg (LONG; SHORT gespiegelt). Stop steigt nur (Ratchet),
     nie sinkt er. Trigger → Close, exitReason = TRAILING_STOP (Taxonomie
     in schema.ts-Kommentar + docs/PAPER_TRADING.md erweitern).
   - Zustand (bewaffnet/Stop-Level) persistiert in positions (append-only
     Spalten trailingStop numeric NULL, trailingArmed boolean NOT NULL
     DEFAULT false) — Prozess-Neustart verliert keine Stops (Test!).
D2 TIME-STOP:
   - Flag RISK_TIME_STOP_HOURS (Default 0 = aus, Bounds [0, 24*30]).
     Position älter als Limit → Close, exitReason = TIME_STOP,
     audit_log-Eintrag. Kein Verhalten bei 0.
D3 OCO-EXKLUSIVITÄT (genau ein Exit):
   - SL/TP/Trailing/Time-Stop sind komplementäre Bedingungen EINER Position.
     Kritischer Pfad: zwei parallele Ticks treffen SL und TP gleichzeitig →
     GENAU ein Close, der zweite Tick behandelt die Position als bereits
     geschlossen (no-op, kein Fehler, kein Doppel-Fill).
   - Umsetzung atomar im DB-Sinn (bedingtes UPDATE … WHERE status = 'OPEN'
     bzw. äquivalentes Muster mit bestehendem submitAtomic/Close-Pfad) —
     kein rein Memory-basiertes Check-then-Act.
   - Jeder Exit revisionssicher ins audit_log („exit:SYMBOL:grund“).
D4 KONFIGURATION: Alle Schwellen über riskConfigService-Muster laden,
   Bounds-Clamp, secure Defaults (alles Default-aus = heutiges Verhalten).
   Stops werden NIEMALS automatisch verengt, nur erweitert geloggt.

## Grundregeln (Baseline der Serie, verbindlich)

Paper-only (src/live-gate/** Enforcement unangetastet; Stop-Auslösung ist
Paper-Logik, kein Order-Mapping an echte Venues in diesem PR) · Fail-closed
· keine neuen Runtime-Dependencies · Schwellen mit Bounds + sicherer Default
+ Eintrag in .env.example UND CONFIGURATION.md · keine Secrets · Mutationen
ins audit_log · append-only-Migration, bestehende Tests brechen nicht ·
Determinismus (Fake-Clock in Tests) · Pflicht-Checks: npm run typecheck &&
npm run lint && npm test && npm run docs:validate — 0 Failures (dokumentierte
Ausnahme ENV-01, siehe remediation/TRACKING.md) · CHANGELOG-Eintrag +
Versions-Bump (package.json, Status-Header, docs/README.md) · nur dieses
Delta; Neben-Bugs in „Offene Punkte“.

## Schritt 3 — Tests (neue Datei tests/monitor.exits.test.ts)

- Trailing-Lifecycle: nicht bewaffnet → bewaffnet bei Activation → Stop-
  Anhebung nur aufwärts (Ratchet) → Auslösung mit exitReason TRAILING_STOP.
- Restart-Persistenz: Ledger aus DB neu hydratisieren → Trailing-Stops
  weiter aktiv (kein Memory-Only-Zustand).
- Time-Stop: Ablauf → Close + Audit; 0 = inaktiv.
- OCO-Race: zwei parallele tick()-Aufrufe (Promise.all) treffen SL und TP →
  genau eine Position geschlossen, zweiter Tick no-op, konsistenter Ledger.
- Defaults: alle Flags aus → Verhalten identisch zum heutigen Stand
  (bestehende Tests grün ohne Anpassung).
- Audit: jeder Exit erzeugt genau einen Audit-Eintrag mit maschinenlesbarem
  Grund.

## Schritt 4 — Docs & Meta

- docs/PAPER_TRADING.md (oder docs/HANDBUCH.md Runbook-Teil): Exit-Management-
  Abschnitt (Trailing/Time-Stop/OCO + Flag-Tabelle + Taxonomie).
- CONFIGURATION.md + .env.example: neue Flags mit Defaults/Bounds.
- CHANGELOG (feat, Minor-Bump) + Status-Header + docs/README.md.
- remediation/TRACKING.md: GAP-05 pflegen; findings/GAP-05-*.md „Umsetzung“-
  Abschnitt ergänzen.

## Abnahme (Definition of Done)

[ ] Ist-Stand verifiziert, Abweichungen dokumentiert
[ ] D1–D4 umgesetzt, je Anforderung mindestens ein Test (Race-Test inklusive)
[ ] Flags in .env.example + CONFIGURATION.md, Defaults verhaltensneutral
[ ] typecheck + lint + npm test + docs:validate grün (Zahlen im PR)
[ ] CHANGELOG/Version + TRACKING.md + Finding aktualisiert
[ ] PR-Beschreibung vollständig (Motivation/Umsetzung/Testbericht/Docs/Offene)
```
