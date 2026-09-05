# SEC-02 — Sensible Daten sind über unauthentifizierte GET-APIs erreichbar

- **ID:** SEC-02
- **Severity:** HIGH
- **Bereich:** Datenexposition / API / AuthZ
- **Quelle:** Security Review-GPT_01.md, Kapitel SEC-02 — Sensible Daten sind über unauthentifizierte GET-APIs erreichbar
- **Status:** OPEN
- **Fix-Version:** -
- **Datei(en):** `src/app/api/firm/route.ts`, `src/app/api/firm/log/route.ts`, `src/app/api/firm/report/route.ts`, `src/app/api/firm/rules/route.ts`, `src/app/api/providers/route.ts`, `src/app/api/routing/route.ts`
- **Peer-Review-Patch:** TBD

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

Das Dashboard bleibt geschützt und greift serverseitig authentifiziert auf diese APIs zu.

## Akzeptanzkriterien / Tests

- [ ] Ohne Token: `GET /api/firm`, `/log`, `/report`, `/rules`, `/api/providers`, `/api/routing` → 401
- [ ] Viewer mit `firm.read` → 200
- [ ] Schreibende Routen unverändert durch `guardWrite` geschützt
- [ ] Dashboard funktioniert mit Session-Cookie
- [ ] Kein neuer sensitiver GET-Endpunkt ohne Guard (CI-Grep)

## Changelog-Blurb

```
SEC-02 (HIGH): Unauthentifizierte GET-APIs — firm.read für Dashboard-/Log-/Report-/Rules-/Routing-Reads
```

## Versions-Hinweis

PATCH, Security-Fix — vor weiterem Live-Ausbau.
