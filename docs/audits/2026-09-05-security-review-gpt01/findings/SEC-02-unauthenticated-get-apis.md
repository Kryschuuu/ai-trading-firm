# SEC-02 — Sensible Daten sind über unauthentifizierte GET-APIs erreichbar

- **ID:** SEC-02
- **Severity:** HIGH
- **Bereich:** Datenexposition / API / AuthZ
- **Quelle:** Security Review-GPT_01.md, Kapitel SEC-02 — Sensible Daten sind über unauthentifizierte GET-APIs erreichbar
- **Status:** FIXED (2026-09-06)
- **Fix-Version:** 1.36.31
- **Betroffene Versionen:** bis einschließlich 1.36.30
- **Datei(en):** `src/app/api/firm/route.ts`, `src/app/api/firm/log/route.ts`, `src/app/api/firm/report/route.ts`, `src/app/api/firm/rules/route.ts`, `src/app/api/providers/route.ts`, `src/app/api/routing/route.ts`, `src/lib/apiAuth.ts`, `tests/sec02.unauthenticatedGetApis.test.ts`; zugehörige Release-/Betriebsdokumentation
- **Fix-Commit:** [d900a71](https://github.com/Kryschuuu/ai-trading-firm/commit/d900a715d26213508aa7240f1acb65441118ecc1)
- **Red-Test-Commit:** [a148b0b](https://github.com/Kryschuuu/ai-trading-firm/commit/a148b0bc31101ab105f95d309fb391b6486d0d61)

> Beschreibung und PoC unten dokumentieren den ursprünglichen verwundbaren Stand.
> Die Behebung, Tests und verbleibenden Grenzen stehen unter „Implementierter Fix“.

## Beschreibung

Mehrere API-Routen dokumentieren selbst, dass **kein Token für Lesezugriffe erforderlich** ist. Die Anwendung selbst hat keinen konzeptionellen „nur localhost“-Schutz: `next start` läuft auf Port `3369` als Netzwerkdienst.

Besonders problematisch ist `GET /api/firm`. Die Route liefert unter anderem Agents, Missions, Positionen, P&L, Proposals, Audit-Log, Kill-Switch-Historie, Agent-Messages, Risk Limits, Runtime-Konfiguration, adaptive Risk-Daten, Broker Registry, Scheduler State, Account-/Equity-Daten.

Noch problematischer:

- `GET /api/firm/log` — rohe Agent-Messages (`content`, `meta`, `missionId`, `agentId`) und Audit-Details
- `GET /api/firm/report` — realisiertes P&L, Drawdown, Symbolstatistiken, Entscheidungsverteilungen, Audit-Ereignisse, Recommendations (Thesis, Entry Zone, Stop Loss, Target, Risk Flags)
- `GET /api/firm/rules` — komplettes Regelwerk, aktive Regeln, Feedback, Execution-Daten
- `GET /api/providers` und `GET /api/routing` — Modell-, Routing-, Budget-, Provider-, Health- und Entscheidungsinformationen

Ein Remote-Angreifer kann damit Handelsstrategie rekonstruieren, Positionen und P&L beobachten, Risiko-Grenzen kennenlernen, Entscheidungslogik und Rules rekonstruieren, Agenten-Kommunikation analysieren und Betriebszustände überwachen. Bei späterer Live-Broker-Integration noch wesentlich sensibler.

## Beweis / PoC

```bash
# Ohne Token
curl -s http://localhost:3369/api/firm | jq '.positions, .auditLog, .riskLimits, .account'
curl -s http://localhost:3369/api/firm/log | jq '.entries[0].raw, .audit[0]'
curl -s http://localhost:3369/api/firm/report
curl -s http://localhost:3369/api/firm/rules | jq '.rules, .active'
curl -s http://localhost:3369/api/providers
curl -s http://localhost:3369/api/routing
# Erwartet: 401/403 ohne firm.read
# Tatsächlich: 200 mit vollständigen Datensätzen
```

```ts
// src/app/api/firm/route.ts
export async function GET() { /* kein requirePermission */ }

// src/app/api/providers/route.ts
// SICHERHEIT: Rein lesend ⇒ kein API-Token erforderlich

// src/app/api/routing/route.ts
// Rein lesend (kein Token nötig)
```

## Remediation (aus Audit + eigene Bewertung)

Für alle sensitiven READ-Endpunkte eine explizite Permission verlangen:

```ts
const denied = requirePermission(req, "firm.read");
if (denied) return denied;
```

Für besonders sensible Ressourcen differenzieren: `firm.read`, `ops.view`, `strategy.read`, `audit.read`, `portfolio.read`, `broker.status`.

Mindestens nicht öffentlich:

- `/api/firm`
- `/api/firm/log`
- `/api/firm/report`
- `/api/firm/rules`
- `/api/providers`
- `/api/routing`

Das Dashboard bleibt durch die bestehende Browser-Session geschützt; der Browser
sendet deren HttpOnly-Cookie bei Same-Origin-Reads automatisch mit. Direkte Clients
verwenden ein vorhandenes Viewer-, Operator- oder Admin-Credential.

## Implementierter Fix (v1.36.31)

- Jede der sechs erfassten Routen ruft am Beginn ihres GET-Handlers den gemeinsamen
  RBAC-Guard `requirePermission(req, "firm.read")` auf. Die Prüfung liegt vor
  Datenbankabfragen, Broker-/Runtime-Zugriffen, Router-Snapshots und dem optionalen
  Provider-Refresh. Damit erzeugt ein abgewiesener Request keinen sensitiven
  Antwort-Payload und triggert keine externe Health-Prüfung.
- `firm.read` ist bereits den Rollen Viewer, Operator und Admin zugeordnet. Header-
  Credentials und signierte `firm_session`-Cookies werden über denselben
  serverseitigen Actor/Permission-Pfad aufgelöst; es gibt keinen separaten
  Dashboard-Bypass. Der explizite lokale `AUTH_MODE=local-open` bleibt als bewusster
  Single-User-Modus unverändert.
- Erfolgreiche Antworten tragen zusätzlich `Cache-Control: private, no-store`.
  Das verhindert, dass ein Shared Cache eine autorisierte Strategie- oder
  Betriebsantwort einem späteren Aufrufer bereitstellt.
- Der bisherige Kommentar am Schreib-Guard wurde präzisiert: Das HTTP-Verb GET ist
  keine Freigabeentscheidung; sensitive Lesezugriffe müssen ihren eigenen
  Permission-Guard verwenden.

## Regressionen und Validierung

- **Rot vor Fix:** Die neu angelegte SEC-02-Suite scheiterte auf dem Ausgangsstand:
  anonyme Requests erreichten Backend-Pfade statt einer Autorisierungsablehnung;
  außerdem fehlte die verbindliche Guard-Verdrahtung in den Quellrouten.
- **Grün nach Fix:** `tests/sec02.unauthenticatedGetApis.test.ts` prüft alle sechs
  Handler für anonyme sowie manipulierte Bearer-/Header-/Proxy-/Cookie-Eingaben,
  Viewer mit `firm.read`, die signierte Viewer-Session, private No-Store-Antworten
  und einen gezielten CI-Drift-Check für die Guard-Reihenfolge.
- Die Suite ist in `npm run test:security:auth` eingebunden und läuft damit im
  merge-blockierenden Security-Workflow vor dem Live-Gate. Bestehende
  `guardWrite`-Schreibpfade wurden nicht verändert.

## Akzeptanzkriterien / Tests

- [x] Anonyme `GET /api/firm`, `/log`, `/report`, `/rules`, `/api/providers` und `/api/routing` → 401 bei Operator-/Viewer-Token-Konfiguration (bei ausschließlich konfiguriertem Admin-Credential kann der bestehende allgemeine Auth-Vertrag 403 liefern)
- [x] Viewer mit `firm.read` → 200 für Provider-/Routing-Dashboard-Reads; alle sechs Handler verwenden denselben Permission-Guard
- [x] Schreibende Routen unverändert durch `guardWrite` geschützt
- [x] Dashboard funktioniert mit signiertem Session-Cookie
- [x] Kein Entfernen des Guards aus den sechs sensitiven GET-Endpunkten ohne fehlenden CI-Regressionstest

## Changelog-Blurb

```
SEC-02 (HIGH): Unauthentifizierte GET-APIs — firm.read für Dashboard-/Log-/Report-/Rules-/Routing-Reads
```

## Versions-Hinweis

PATCH, Security-Fix — v1.36.31 auf allen Instanzen ausrollen.
