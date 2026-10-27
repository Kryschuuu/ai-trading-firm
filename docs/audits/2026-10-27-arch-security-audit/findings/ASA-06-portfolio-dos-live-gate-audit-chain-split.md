# ASA-06 — Event-Loop-DoS auf `/api/portfolio/optimize` und Prozess-Divergenz in der `LiveGateAudit`-Hash-Kette

- **ID:** ASA-06
- **Severity:** HIGH
- **Bereich:** Performance & Integrität
- **Status:** OPEN
- **Datei(en):** `src/app/api/portfolio/optimize/route.ts:68-193`, `parse.ts` unter `src/app/api/portfolio/` (`110-165`), `src/portfolio/optimize.ts:288-347`, `src/app/api/live/state/route.ts:27-35`, `src/live-gate/service.ts:214-230`, `src/live-gate/audit.ts:169-216`, `scripts/gen-docs-inventories.ts:88-100`
- **Session-Prompt:** [`../prompts/PROMPT-ASA-P1-06-portfolio-dos-and-livegate-audit-sync.md`](../prompts/PROMPT-ASA-P1-06-portfolio-dos-and-livegate-audit-sync.md)

## Beschreibung

Zwei unabhängige Verfügbarkeits- und Integritätsprobleme:
1. `/api/portfolio/{optimize,correlation,metrics}` sind unauthentifiziert, ungedrosselt und erlauben extrem rechenintensive Parameter (`maxIterations = 1_000_000`) plus synchrone Disk-Writes auf `optimize`.
2. `LiveGateAudit` hält den Hash-Ketten-Kopf (`this.head`) nach dem ersten Lesezugriff nur im Prozess-RAM; schreibt ein zweiter Prozess (z. B. CLI `npm run live:kill`) in dieselbe Audit-Datei, erzeugt der Web-Server beim nächsten Event doppelte `seq`-Nummern und einen falschen `prevHash`, was `verifyAuditChain()` dauerhaft bricht.

## Technischer Nachweis

1. **Portfolio-DoS (`src/app/api/portfolio/optimize/route.ts:68-193`):** Zeile 75 akzeptiert `maxIterations` bis `1_000_000`, `maxAdjustmentRounds` bis `50` bei bis zu `200` Assets (`parse.ts` in `src/app/api/portfolio/`) und schreibt in `writePortfolioSnapshot` (Zeile 135–146) synchron per `mkdirSync`/`writeFileSync` — entgegen dem Kommentar in `scripts/gen-docs-inventories.ts:96-99` („keine Persistenz, keine Seiteneffekte“).
2. **Audit-Chain-Split (`src/live-gate/audit.ts:169-216`):** `ensureHeadLoaded()` kehrt sofort zurück, sobald `this.headLoaded === true` ist. Ein externes `npm run live:kill` hängt `seq = N+1` an die Datei an; der weiterlaufende Next.js-Server schreibt beim nächsten Event ebenfalls `seq = N+1` mit dem veralteten `prevHash` von `seq = N`. Danach schlägt `verifyAuditChain()` fehl (`chainValid: false`). Zusätzlich parst und hasht `GET /api/live/state` bei jedem Request die gesamte Datei synchron neu.

## Konkreter Lösungsvorschlag

- Alle drei `/api/portfolio/*`-Routen mit `requirePermission(req, "firm.read")` (bzw. `"firm.write"` bei aktiviertem Snapshot-Write) + CSRF + `checkRateLimit` schützen; `maxIterations` auf `<= 2_000` (Default `400`) und `maxAdjustmentRounds` auf `<= 10` begrenzen; `writePortfolioSnapshot` asynchron mit `node:fs/promises` ausführen; die drei Einträge aus `REVIEWED_UNGUARDED_WRITES` in `scripts/gen-docs-inventories.ts` entfernen und `npm run docs:inventories` neu generieren.
- In `LiveGateAudit.append()` eine kurze exklusive Lock-Datei (`<auditPath>.lock` via `openSync(..., "wx")` mit Stale-Recovery) verwenden, vor jedem Append die Dateigröße prüfen und bei gewachsener Datei den letzten Eintrag neu einlesen, sodass `seq` und `prevHash` über Prozesse hinweg strikt monoton bleiben.
- `verifyAuditChain()` gegen `(stat.size, stat.mtimeMs)` im Speicher cachen.

## Akzeptanzkriterien / Verifikation

- [ ] `POST /api/portfolio/{optimize,correlation,metrics}` verlangen Authentifizierung + Rate-Limit und weisen `maxIterations > 2_000` mit `400` ab.
- [ ] Zwei getrennte `LiveGateAudit`-Instanzen auf derselben Datei können abwechselnd `append()` aufrufen, und `verifyAuditChain()` bleibt durchgehend `{ ok: true }`.
- [ ] `npm run docs:inventories:check` und `tests/asa06.portfolioLimitsAndAuditSync.test.ts` grün.
