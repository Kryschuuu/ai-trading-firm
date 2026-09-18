# PROMPT-02 — Execution-Simulation: Funding-Kosten + Kalibrierung (GAP-02)

> **Finding:** [GAP-02](../findings/GAP-02-execution-simulation.md) ·
> **Reihenfolge:** Schritt 1 (Start der Serie) ·
> **Voraussetzungen:** keine ·
> **Erwartete Größenordnung:** 1 PR, Minor-Version (feat)

## Session-Prompt

```text
# Mission: Execution-Simulation im PaperBroker vervollständigen (GAP-02)

Du arbeitest als Senior-Engineer im Repository „ai-trading-firm“ (Node.js
20+/TypeScript strict, Next.js 16, Drizzle + PostgreSQL, node:test, Paper-
Trading only). Ziel dieser Session: Die Execution-Simulation ist im Kern
vorhanden — du schließt die Lücke „Funding-Raten im PnL“ und machst die
Simulationsparameter kalibrierbar. Ergebnis: Paper-Ergebnisse werden
ehrlich (Perpetual-Funding frisst real Edge — das muss im Paper-PnL
sichtbar sein).

## Schritt 1 — Ist-Stand verifizieren (Pflicht, vor jeder Änderung)

Lies vollständig: src/lib/broker.ts (Fill, LiveQuote, ExecutedFill,
PaperExecutionAdapter, Vorab-Cash-Guard), src/lib/marketdata/production.ts
(createPaperExecution), src/brokers/paper.ts, src/lib/monitor.ts,
src/scanner/factors/funding.ts, tests/broker.test.ts. Erwarteter Stand laut
Audit 2026-09-18: Simulator mit Gebühren/Spread/Slippage/Partial-Fills
existiert; Funding existiert NUR als Scanner-Ranking-Faktor, nicht im
Broker-PnL. Weicht der Stand ab (z. B. Funding inzwischen vorhanden), setze
nur das verbleibende Delta um und dokumentiere die Abweichung im PR.

## Schritt 2 — Delta umsetzen

D1 FUNDING-ACCRUAL: Der PaperBroker führt je offener Perpetual-Position
   kumuliertes Funding. Konkret:
   - Neues Feld fundingPaid (numeric, NOT NULL DEFAULT 0) auf positions —
     append-only Migration nach Konvention drizzle/YYYY-MM-DD_positions_funding.sql,
     Schema in src/db/schema.ts pflegen.
   - Accrual im Monitor-Tick (src/lib/monitor.ts) bei Periodenwechsel
     (Default: 8h-Marke UTC; Flag PAPER_FUNDING_INTERVAL_HOURS, Bounds [1, 24]).
   - Formel: funding = fundingRate * |notional| * direction
     (direction: LONG = +1 zahlt bei positiver Rate, SHORT = −1 erhält).
     Vorzeichenkonvention in der Doku festhalten.
   - Rate-Quelle gestuft: (a) statischer Default über Flag
     PAPER_FUNDING_RATE_PCT_PER_8H, Default 0 (neutral — bestehende Tests
     bleiben unverändert grün), (b) optionales Interface getFundingRate(symbol)
     als Erweiterungspunkt (ohne echte Netzwerkanbindung in diesem PR).
   - Accrual-Ereignis revisionssicher ins audit_log (Muster R6:
     „funding:SYMBOL:+0.42“), Accrual mit injizierbarer Clock (Determinismus).
D2 EQUITY & AUSWEIS: accountEquity/Equity-Berechnung berücksichtigt
   fundingPaid; Positionsausweis (PaperBroker-Objekt + GET /api/firm)
   zeigt funding je Position; Gesamtfunding im Account-Snapshot.
D3 KALIBRIERUNG: Simulationsparameter konfigurierbar mit Bounds + sicheren
   Defaults (= heutige hartcodierte Werte, kein Verhaltensbruch):
   PAPER_MAKER_FEE_PCT, PAPER_TAKER_FEE_PCT, PAPER_SLIPPAGE_BPS,
   PAPER_SPREAD_FALLBACK_BPS. Verdrahtung in createPaperExecution; Parsing
   im Repo-Stil (Muster env.ts), Bounds-Clamp mit Log-Warnung bei Korrektur.
D4 DETERMINISMUS: Gleiche Quote-Folge → identische Fills (Test belegt);
   kein Date.now()/Math.random() in der getesteten Logik ohne injizierte
   Clock (Muster src/cycle/clock.ts).

## Grundregeln (Baseline der Serie, verbindlich)

Paper-only (src/live-gate/** Enforcement unangetastet) · Fail-closed statt
stiller Fallbacks · keine neuen Runtime-Dependencies · Schwellen immer mit
Bounds + sicherem Default + Eintrag in .env.example UND CONFIGURATION.md ·
keine Secrets in Code/Logs/Tests/Docs · Mutationen ins audit_log ·
append-only-Migrationen, bestehende Tests brechen nicht · Determinismus ·
Pflicht-Checks: npm run typecheck && npm run lint && npm test &&
npm run docs:validate — 0 Failures (dokumentierte Ausnahme: ENV-01,
tests/secretStore.test.ts, siehe remediation/TRACKING.md) · Docs-Sync mit
CHANGELOG-Eintrag + Versions-Bump (package.json, Status-Header CHANGELOG.md,
docs/README.md — Konsistenz wird getestet) · nur dieses Delta, Neben-Bugs in
„Offene Punkte“.

## Schritt 3 — Tests (neue Datei tests/paper.funding.test.ts)

- Long zahlt bei positiver Rate, Short erhält (Vorzeichen exakt).
- Accrual nur bei Periodenwechsel (Fake-Clock über Marke hinweg, zweimal
  ticken → genau eine Accrual).
- Equity-Abgleich: equity nach Accrual = vorher + fundingPaid-Summe.
- Bounds: Flag außerhalb Grenzen wird geklemmt (Default-Warnung).
- Default 0 = neutrales Verhalten: alle bestehenden Broker-Tests laufen
  unverändert grün.
- Determinismus: identische Quote-Folge → identische Fills (Hash-Vergleich).

## Schritt 4 — Docs & Meta

- docs/PAPER_TRADING.md: neuer Abschnitt „Gebühren, Slippage, Funding &
  Kalibrierung“ (inkl. Vorzeichenkonvention + Flag-Tabelle).
- CONFIGURATION.md + .env.example: neue Flags mit Defaults/Bounds.
- CHANGELOG.md-Eintrag (feat, Minor-Bump) + Status-Header + docs/README.md.
- docs/audits/2026-09-18-feature-gap/remediation/TRACKING.md: GAP-02 auf
  IN_PROGRESS bzw. nach grünem Lauf FIXED (Version + PR) — im selben PR.
- findings/GAP-02-execution-simulation.md: kurzer „Umsetzung“-Abschnitt.

## Abnahme (Definition of Done)

[ ] Ist-Stand verifiziert, Abweichungen dokumentiert
[ ] D1–D4 umgesetzt, jede Anforderung hat mindestens einen Test
[ ] Neue Flags in .env.example + CONFIGURATION.md mit Bounds/Defaults
[ ] typecheck + lint + npm test + docs:validate grün (Ergebniszahlen im PR)
[ ] CHANGELOG/Version/docs-Sync erledigt, TRACKING.md aktualisiert
[ ] PR-Beschreibung: Motivation (GAP-02), Umsetzung je D-Punkt, Testbericht,
    Docs-Sync-Liste, Offene Punkte
```
