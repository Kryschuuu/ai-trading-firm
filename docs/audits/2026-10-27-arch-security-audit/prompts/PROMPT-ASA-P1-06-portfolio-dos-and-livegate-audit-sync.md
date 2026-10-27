# PROMPT-ASA-P1-06 — Portfolio-Optimizer-DoS schließen & `LiveGateAudit` prozessübergreifend synchronisieren

- **Befund:** [`../findings/ASA-06-portfolio-dos-live-gate-audit-chain-split.md`](../findings/ASA-06-portfolio-dos-live-gate-audit-chain-split.md) (`HIGH`)
- **Tracking:** [`../remediation/TRACKING.md`](../remediation/TRACKING.md)
- **Anwendung:** Den folgenden Block vollständig in eine frische Coding-Session kopieren.

```text
Du arbeitest im Repository `ai-trading-firm` (TypeScript, Next.js App Router).

AUFGABE: Behebe vollständig den Befund `ASA-06` (Event-Loop-DoS & synchrone Disk-Writes auf `/api/portfolio/*` sowie Hash-Ketten-Divergenz und Voll-Datei-Hashing in `LiveGateAudit` über mehrere Prozesse hinweg).

KONTEXT & IST-ZUSTAND (lies diese Dateien zuerst komplett):
1. `docs/audits/2026-10-27-arch-security-audit/findings/ASA-06-portfolio-dos-live-gate-audit-chain-split.md`
2. `src/app/api/portfolio/optimize/route.ts`, `src/app/api/portfolio/correlation/route.ts`, `src/app/api/portfolio/metrics/route.ts`, den gemeinsamen Parser `parse.ts` in `src/app/api/portfolio/` sowie `src/portfolio/optimize.ts`
3. `scripts/gen-docs-inventories.ts` (insb. `REVIEWED_UNGUARDED_WRITES` um Zeile 85–102!)
4. `src/live-gate/audit.ts` (Zeilen 1–260), `src/live-gate/service.ts` (Zeilen 210–240), `src/app/api/live/state/route.ts`
5. Bestehende Tests: `tests/portfolio*.test.ts`, `tests/liveGate*.test.ts`, `tests/docsInventories.test.ts`

ZWEI KONKRETE PROBLEME:
1. `/api/portfolio/{optimize,correlation,metrics}`:
   - Unauthentifiziert und ohne Rate-Limit.
   - `optimize/route.ts` akzeptiert `maxIterations` bis `1_000_000` und `maxAdjustmentRounds` bis `50` bei bis zu `200` Symbolen -> einzelner Request blockiert den Node.js-Event-Loop für viele Sekunden.
   - `writePortfolioSnapshot()` schreibt in `optimize/route.ts` synchron per `mkdirSync`/`writeFileSync` (obwohl `REVIEWED_UNGUARDED_WRITES` in `scripts/gen-docs-inventories.ts` behauptete: „keine Persistenz, keine Seiteneffekte“).
2. `LiveGateAudit` (`src/live-gate/audit.ts`):
   - `ensureHeadLoaded()` liest `this.head` (`seq`, `prevHash`) nur einmalig im Prozess ein. Hängt ein zweiter Prozess (z. B. CLI `npm run live:kill` oder `micro-executor`) eine Zeile an die Audit-NDJSON an, schreibt der laufende Next.js-Prozess beim nächsten Ereignis dieselbe `seq` mit veraltetem `prevHash` -> `verifyAuditChain()` meldet dauerhaft `chainValid: false`!
   - `GET /api/live/state` berechnet bei jedem Aufruf synchron die SHA-256-Kette über die gesamte Audit-Datei neu.

VERBINDLICHE UMSETZUNGSSCHRITTE:
1. Portfolio-Endpunkte absichern & CPU-/I/O-Last deckeln:
   - Schütze `POST /api/portfolio/correlation` und `POST /api/portfolio/metrics` mit `requirePermission(req, "firm.read") ?? checkCsrfGuard(req)` + `checkRateLimit(req, ...)` und `POST /api/portfolio/optimize` (da Snapshot-Write auf Disk!) mit `requirePermission(req, "firm.write") ?? checkCsrfGuard(req)` + `checkRateLimit(req, ...)` (oder falls `persist === false` explizit reine Berechnung ist, konsistent dokumentiert schützen — am saubersten `firm.read` für reine Berechnung und `firm.write` sobald ein Snapshot persistiert wird).
   - Senke die zulässigen Parameter-Obergrenzen in `optimize/route.ts` auf sichere Werte: `maxIterations <= 2_000` (Default `400`, Werte `> 2_000` mit HTTP `400` abweisen) und `maxAdjustmentRounds <= 10` (Werte `> 10` mit `400` abweisen); prüfe auch die Eingabegrößen in `parse.ts` unter `src/app/api/portfolio/` (z. B. maximale Serienlänge pro Asset sinnvoll begrenzen, z. B. `<= 5_000` Datenpunkte).
   - Stelle `writePortfolioSnapshot` auf asynchrone I/O (`node:fs/promises`: `mkdir`, atomares Temp-File + `rename`) um.
   - WICHTIG: Entferne die nun geschützten `/api/portfolio/*`-Einträge aus `REVIEWED_UNGUARDED_WRITES` in `scripts/gen-docs-inventories.ts` und führe `npm run docs:inventories` aus (sonst schlägt `docs:inventories:check` fehl, weil veraltete Ausnahmen als Fehler gewertet werden!). Passe bestehende `tests/portfolio*.test.ts`-Aufrufe ggf. an die neuen Guards/Caps an.

2. `LiveGateAudit` Cross-Prozess-sicher & schnell machen (`src/live-gate/audit.ts`):
   - Schütze `append()` durch eine leichtgewichtige Dateisperre (`<auditFile>.lock` mit `openSync(..., "wx")`, kurzem Retry-Spin/Backoff und Stale-Lock-Erkennung anhand Lock-Alter/PID).
   - Prüfe innerhalb der Sperre vor jedem `append()` per `statSync` die aktuelle Dateigröße: Ist die Datei seit dem letzten bekannten Offset gewachsen (oder wurde neu erstellt/rotiert), lies die neu hinzugekommenen Zeilen ab dem letzten bekannten Byte-Offset ein (bzw. das Dateiende), verifiziere deren Verkettung und aktualisiere `this.head` (`seq`, `prevHash`, `knownSize`), **bevor** der neue Eintrag berechnet und per `appendFileSync` + `fsync` geschrieben wird.
   - Cache das Ergebnis von `verifyAuditChain()` anhand von `(stat.size, stat.mtimeMs, stat.ino)`, sodass wiederholte Aufrufe von `GET /api/live/state` bei unveränderter Datei in `O(1)` antworten.

3. Audit-Tracking aktualisieren:
   - Setze `ASA-06` in `docs/audits/2026-10-27-arch-security-audit/findings/ASA-06-portfolio-dos-live-gate-audit-chain-split.md`, `README.md`, `remediation/TRACKING.md` und `docs/security/README.md` auf `FIXED`.
   - Falls `docs/PORTFOLIO_ANALYTICS.md` das Limit `maxIterations` dokumentiert, aktualisiere den Zahlenwert dort konsistent.

PFLICHT-TESTS & VERIFIKATION:
1. Erstelle `tests/asa06.portfolioLimitsAndAuditSync.test.ts`:
   - `POST /api/portfolio/optimize` weist unauthentifizierte Aufrufe (bei aktivem Token-Auth) mit `401` und `maxIterations: 50_000` mit `400` ab.
   - Zwei unabhängige `new LiveGateAudit(sameFile)`-Instanzen (Simulation von Web-Server + CLI `live:kill`) rufen abwechselnd 20-mal `append(...)` auf -> Sequenznummern `1..20` sind lückenlos monoton und `verifyAuditChain()` liefert `{ ok: true, count: 20 }`.
   - Manipuliert ein Test nachträglich die Datei zwischen zwei `verifyAuditChain()`-Aufrufen, invalidiert die `(size, mtimeMs)`-Änderung den Cache zuverlässig und erkennt die Manipulation (`ok: false`).
2. Führe aus und halte alles grün:
   - `npx tsx --test tests/asa06.portfolioLimitsAndAuditSync.test.ts tests/portfolio*.test.ts tests/liveGate*.test.ts`
   - `npm run typecheck`
   - `npm run lint`
   - `npm run docs:inventories && npm run docs:inventories:check`
   - `npm run docs:validate`
   - `npm test`
```
