# PROMPT-10 — Observability & automatische Circuit-Breaker (GAP-10)

> **Finding:** [GAP-10](../findings/GAP-10-observability-circuit-breaker.md) ·
> **Reihenfolge:** Schritt 3 ·
> **Voraussetzungen:** keine harten (PROMPT-05 empfohlen) ·
> **Erwartete Größenordnung:** 1 PR, Minor-Version (feat)

## Session-Prompt

```text
# Mission: Firmen-Metriken, Auto-Circuit-Breaker, Alerting, Heartbeat
# (GAP-10)

Du arbeitest als Senior-Engineer im Repository „ai-trading-firm“ (Node.js
20+/TypeScript strict, Next.js 16, Drizzle + PostgreSQL, node:test,
Paper-Trading only). Stand: Telemetrie (src/lib/telemetry.ts,
prometheusMetrics()) deckt nur Marktdaten-Fehler ab; das Ops-Center
(/api/ops) aggregiert 10 Sektionen; riskGuard kennt maxEquityDrawdownPct/
dailyLossLimitPct als Grenzen des Order-Pfads; der Kill-Switch ist rein
manuell (Disarm per Challenge-Nonce). Ziel: Beobachtbarkeit der Firma als
Ganzes + ein automatischer Brecher, der bei Limit-Bruch die bestehende
Kill-Switch-Infrastruktur ENGAGEt — Re-Arm bleibt ausschließlich manuell.

## Schritt 1 — Ist-Stand verifizieren (Pflicht)

Lies vollständig: src/lib/telemetry.ts, src/app/api/health/route.ts,
src/lib/riskGuard.ts, src/lib/engine.ts (Equity/Drawdown-Berechnung),
src/lib/liveGate.ts + Kill-Switch-Service-Pfad (Engage-API, Challenge-Flow,
src/app/api/firm/kill/*), src/lib/monitor.ts (lastTickAt), src/lib/logger.ts,
src/app/api/ops/route.ts, tests/telemetry* + tests/liveGate.*. Erwartet laut
Audit 2026-09-18: keine Firmen-Metriken, kein Auto-Breaker, kein Alerting,
kein Heartbeat-Stale-Signal. Abweichung → Rest-Delta, im PR dokumentieren.

## Schritt 2 — Delta umsetzen

D1 METRIKEN: prometheusMetrics() um Firmen-Metriken erweitern — NUR aus
   bestehenden Stores gelesen (DB, PaperBroker, telemetry-Counter):
   equity, drawdownPct, offene Positionen, Fills/Rejects je Grund,
   LLM-Latenz je Provider (Counter in der Routing-Schicht ergänzen, wo die
   Latenz ohnehin anfällt — keine neue Messlogik erfinden). DB nicht
   erreichbar → Metrik weglassen + HELP-Kommentar „degraded“, nie hängen
   oder werfen. Keine Secrets/Symbole mit personenbezogenen Daten in Labels.
D2 AUTO-CIRCUIT-BREAKER:
   - Auslöser (geprüft im Tick nach Equity-Berechnung):
     (a) drawdownPct >= maxEquityDrawdownPct, (b) Tagesverlust >=
     dailyLossLimitPct, (c) N Verlust-Closes in Folge
     (RISK_MAX_CONSECUTIVE_LOSSES, Default 5, Bounds [2, 50]).
   - Aktion: bestehenden Kill-Switch-Service-Pfad ENGAGE mit maschinen-
     lesbarem Grund „auto-circuit-breaker:<metrik>:<wert>“, Audit-Eintrag,
     Alert (D3). KEINE Auto-Re-Arm-Logik — Re-Arm bleibt der manuelle
     Disarm-Pfad mit Challenge-Nonce (unangetastet!).
   - Flag AUTO_CIRCUIT_BREAKER (Default on, Bounds nur on/off) — ON ist
     Konsistenz mit „harte Grenzen im Code“; Verhaltensänderung im
     CHANGELOG klar benennen.
   - Schutz gegen Flattern: Brecher ist LATCHING (einmal ENGAGE bleibt
     ENGAGE bis manuell disarmed); Hysterese nicht nötig, aber der
     Auslösewert wird im Audit fixiert.
D3 ALERT-ADAPTER:
   - Interface AlertSink { send(alert: {code, severity, message, meta}) } +
     Implementierungen LogAlertSink (strukturiert, Muster logger.ts) und
     FileAlertSink (data/alerts.ndjson via resolveRuntimePath — Pfad-Muster
     wie syncStatus.ts, damit CLI/Server dieselbe Datei sehen).
   - Debounce: identischer alert.code max. einmal pro
     ALERT_DEBOUNCE_MINUTES (Default 30, Bounds [1, 1440]) — Alert-Fatigue-
     Schutz, getestet.
   - Optionaler Webhook-Sink NUR mit Credential aus dem Secret-Store
     (ALERT_WEBHOOK_URL_SECRET_NAME); Default aus. Kein Klartext-Token in
     .env.example-Werten (nur Platzhalter/Kommentar).
D4 HEARTBEAT: /api/health erweitert um monitorLastTickAt + stale:bool
   (Schwelle HEALTH_STALE_AFTER_MS, Default 300000, Bounds [30000, 3600000];
   Quelle lastTickAt()). Neues Skript scripts/watchdog.ts (alarm-first):
   prüft /api/health bzw. lastTickAt, schickt Alert über AlertSink — KEIN
   Auto-Restart, kein neuer Daemon-Zwang; npm-Script „watchdog“ ergänzen.

## Grundregeln (Baseline der Serie, verbindlich)

Paper-only (Kill-Switch-/Live-Gate-Enforcement wird genutzt, nicht umgebaut;
Disarm-Challenge bleibt unverändert) · Fail-closed · keine neuen Runtime-
Dependencies · Schwellen mit Bounds + Default + Eintrag in .env.example UND
CONFIGURATION.md · keine Secrets in Code/Logs/Tests/Docs · Mutationen (ENGAGE!)
revisionssicher ins audit_log · Determinismus · Pflicht-Checks: npm run
typecheck && npm run lint && npm test && npm run docs:validate — 0 Failures
(dokumentierte Ausnahme ENV-01) · CHANGELOG-Eintrag + Versions-Bump
(package.json, Status-Header, docs/README.md) · nur dieses Delta; Neben-Bugs
in „Offene Punkte“.

## Schritt 3 — Tests

- tests/telemetry.firm.test.ts: Snapshot enthält Firmen-Metriken; DB-Fehler →
  degradiert statt Exception; keine Secrets in Output.
- tests/circuitBreaker.test.ts: (a) simulierter Drawdown-Bruch → Kill-Switch
  ENGAGE + Audit mit Grund + Alert; (b) Konsekutiv-Verluste-Trigger;
  (c) AUTO_CIRCUIT_BREAKER=off → kein Engage; (d) Latching: erneuter Tick
  ändert Zustand nicht; (e) Disarm weiterhin NUR mit Challenge-Nonce
  (bestehenden LiveGate-Tests nicht schwächen).
- tests/alertSink.test.ts: Debounce (zweites identisches Event innerhalb
  Fenster → unterdrückt), FileAlertSink schreibt NDJSON über
  resolveRuntimePath, Webhook-Sink liest Credential aus Secret-Store-Mock.
- Health-Test: stale-Erkennung mit Fake-Clock (Grenzwerte).

## Schritt 4 — Docs & Meta

- docs/OBSERVABILITY.md: Sektion „Firmen-Metriken & Auto-Circuit-Breaker“
  (Metrik-Liste, Auslöser, Latching, Re-Arm-Politik).
- docs/OPERATIONS.md: Runbook „Auto-Breaker hat ausgelöst“ (Diagnose,
  bewusster manuellen Re-Arm).
- CONFIGURATION.md + .env.example: neue Flags. CHANGELOG (feat, Minor-Bump,
  Verhaltensänderung deutlich benennen) + Status-Header + docs/README.md.
- remediation/TRACKING.md pflegen; findings/GAP-10-*.md „Umsetzung“ ergänzen.

## Abnahme (Definition of Done)

[ ] Ist-Stand verifiziert; D1–D4 umgesetzt und je getestet
[ ] Re-Arm-Pfad unverändert manuell (Challenge-Nonce-Tests weiterhin grün)
[ ] Flags in .env.example + CONFIGURATION.md; Defaults dokumentiert
[ ] typecheck + lint + npm test + docs:validate grün (Zahlen im PR)
[ ] CHANGELOG/Version + TRACKING.md + Finding aktualisiert
[ ] PR-Beschreibung vollständig
```
