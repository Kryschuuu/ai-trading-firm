# PROMPT-ASA-P1-05 — API-RBAC vervollständigen, offene GET-Routen schließen, zentrales CSRF + Rate-Limit & Error-Redaction

- **Befunde:** [`../findings/ASA-05-unauthenticated-get-routes-dead-rbac-error-leaks.md`](../findings/ASA-05-unauthenticated-get-routes-dead-rbac-error-leaks.md) (`HIGH`) & [`../findings/ASA-07-missing-session-csrf-and-write-rate-limits.md`](../findings/ASA-07-missing-session-csrf-and-write-rate-limits.md) (`HIGH`)
- **Tracking:** [`../remediation/TRACKING.md`](../remediation/TRACKING.md)
- **Hinweis zur Reihenfolge:** Nach `PROMPT-ASA-P0-02` ausführen, damit keine Konflikte an `/api/firm/lifecycle` oder `/api/live/kill` entstehen.

```text
Du arbeitest im Repository `ai-trading-firm` (TypeScript, Next.js App Router unter `src/app/api/**`, Auth/RBAC unter `src/auth/*` und `src/lib/apiAuth.ts`).

AUFGABE: Behebe gemeinsam und konsistent die beiden eng gekoppelten API-Sicherheitsbefunde `ASA-05` (unauthentifizierte sensitive GET-Routen, 7 unbenutzte RBAC-Permissions, rohe `e.message`-Fehlerleaks) und `ASA-07` (fehlender Session-CSRF-Schutz in `guardWrite` und weiteren Schreibrouten sowie fehlende Write-Rate-Limits).

KONTEXT & IST-ZUSTAND (lies diese Dateien zuerst komplett):
1. `docs/audits/2026-10-27-arch-security-audit/findings/ASA-05-unauthenticated-get-routes-dead-rbac-error-leaks.md`
2. `docs/audits/2026-10-27-arch-security-audit/findings/ASA-07-missing-session-csrf-and-write-rate-limits.md`
3. `docs/generated/route-inventory.md` und `scripts/gen-docs-inventories.ts` (zeigt dir auf einen Blick alle 42 Routen und ihre aktuellen Guards!)
4. `src/auth/permissions.ts`, `src/lib/apiAuth.ts`, `src/lib/csrfGuard.ts`, `src/lib/httpError.ts`, `src/lib/apiClient.ts`
5. Bestehende Security-Tests: `tests/sec02.unauthenticatedGetApis.test.ts`, `tests/proposalApprove.auth.test.ts`, `tests/routes.asyncParams.test.ts`

WICHTIGE REPO-MECHANIK:
- Im Browser-Frontend laufen mutierende Aufrufe über `apiFetch` (`src/lib/apiClient.ts`), das den Double-Submit-Header `x-csrf-token` automatisch mitschickt. Prüfe dennoch mit `grep -rn "fetch(" src/components src/app`, ob irgendwo im UI noch ein nacktes `fetch("/api/...")` ohne `apiFetch` verwendet wird, und stelle solche Stellen auf `apiFetch` um, damit im Browser nichts bricht!
- `scripts/gen-docs-inventories.ts` generiert `docs/generated/route-inventory.md` statisch aus `src/app/api/**/route.ts` und erkennt `requirePermission(...)`, `guardWrite(...)`, `checkApiToken(...)` und `checkCsrfGuard(...)`. Wenn `guardWrite` intern `checkCsrfGuard` aufruft, erkennt `collectGuards` in `scripts/gen-docs-inventories.ts` rekursiv `CSRF`!

VERBINDLICHE UMSETZUNGSSCHRITTE:
1. Alle 14 Permissions aus `src/auth/permissions.ts` fachgerecht verdrahten & offene GET-Routen schließen:
   - Einzige unauthentifizierte Public-Endpunkte bleiben explizit:
     - `GET /api/health`
     - `GET /api/auth/status`, `POST /api/auth/login`, `POST /api/auth/refresh`, `POST /api/auth/logout` (Logout mit CSRF + Rate-Limit schützen!)
     - Optional: Prüfe für `GET /api/docs`, ob der Docs-Viewer vor Login erreichbar sein soll oder `firm.read` nutzt (prüfe bestehende `tests/docs*.test.ts` und UI-Verhalten; falls `GET /api/docs` öffentlich bleibt, dokumentiere es explizit in der Allowlist des neuen Guard-Tests).
     - Hinweis: Falls `/api/portfolio/*` noch ungeschützt ist und `PROMPT-ASA-P1-06` noch nicht lief, berücksichtige `REVIEWED_UNGUARDED_WRITES` in `scripts/gen-docs-inventories.ts` sauber oder schütze `/api/portfolio/*` direkt mit `firm.read` + Rate-Limit und bereinige `REVIEWED_UNGUARDED_WRITES` passend.
   - Verdrahte die bisher unbenutzten Permissions an ihren vorgesehenen Routen:
     - `ops.view` -> `GET /api/ops` und `GET /api/ops/toggles`
     - `firm.config` -> `PUT /api/firm/config` (statt bisher `firm.write`! `GET /api/firm/config` -> `firm.read`)
     - `broker.status` -> `GET /api/brokers`, `GET /api/brokers/[venue]/health`, `GET /api/brokers/[venue]/credentials`
     - `broker.test` -> `GET` & `POST /api/brokers/[venue]/test` (statt `broker.credentials`, damit auch Operatoren die Venue-Konnektivität testen dürfen!)
     - `routing.read` -> `GET /api/routing/modes` (und falls weitere Routing-GETs existieren)
     - `routing.modes.write` -> `PUT` / `POST` auf `/api/routing/modes`
     - `firm.kill` -> stelle sicher, dass `POST /api/firm/kill` (und falls P0-02 schon gemergt ist, `POST /api/live/kill` für `arm`) `firm.kill` nutzt (`clear` auf `/api/firm/kill` nur mit gültiger Nonce / Admin prüfen — achte auf Kompatibilität mit bestehenden Kill-Switch-Tests!).
     - Alle übrigen bisher offenen Fach-GET-Routen (`/api/firm/missions`, `/api/firm/macro`, `/api/firm/micro`, `/api/firm/devils-advocate`, `/api/firm/risk/*`, `/api/firm/execution/*`, `/api/firm/backtests`, `/api/firm/montecarlo/[id]`, `/api/live/state`, `/api/live/kill`) -> `requirePermission(req, "firm.read")` + Header `Cache-Control: private, no-store`.

2. Lückenloser CSRF-Schutz & Write-Rate-Limits (`ASA-07`):
   - Erweitere `guardWrite(request)` in `src/lib/apiAuth.ts` um `?? checkCsrfGuard(request)` und stelle sicher, dass **ausnahmslos jeder** mutierende Handler (`POST`, `PUT`, `PATCH`, `DELETE`, außer `POST /api/auth/login`, das bereits Login-spezifisch geschützt ist) sowohl:
     a) Auth/Permission,
     b) `checkCsrfGuard(request)` (für Cookie-Sessions / `local-open`-Browser-Calls; Token-Header-Clients passieren `checkCsrfGuard` weiter nahtlos), als auch
     c) `checkRateLimit(request, ...)`
     durchläuft!
   - Achte bei bestehenden Route-Unit-Tests in `tests/`, die direkt `POST(new Request(...))` im `local-open`-Modus ohne Token aufrufen, darauf, wie `checkCsrfGuard` mit `local-open` interagiert (lies dazu `src/lib/csrfGuard.ts` und `tests/proposalApprove.auth.test.ts` genau!), und passe ggf. betroffene Test-Requests sauber an (kein Abschwächen des Produktions-CSRF-Schutzes!).

3. Fehler-Redaction (`publicErrorMessage`):
   - Durchsuche alle `src/app/api/**/route.ts` nach ungefilterten 500-Fehlerantworten (`e.message`, `String(e)`, `err.message`) und ersetze interne Ausnahmetexte in `status >= 500`-Pfaden durch `publicErrorMessage(e)` aus `src/lib/httpError.ts` (gezielte fachliche 400/404/409/422-Validierungsmeldungen bleiben selbstverständlich verständlich erhalten).

4. Inventare & Audit-Tracking aktualisieren:
   - Führe `npm run docs:inventories` aus und prüfe das Diff von `docs/generated/route-inventory.md`.
   - Setze `ASA-05` und `ASA-07` in ihren Finding-Dateien, `docs/audits/2026-10-27-arch-security-audit/README.md`, `remediation/TRACKING.md` und `docs/security/README.md` auf `FIXED`.

PFLICHT-TESTS & VERIFIKATION:
1. Erstelle `tests/asa05.apiGuardsAndCsrf.test.ts`:
   - Prüft dynamisch über alle `ALL_PERMISSIONS` aus `src/auth/permissions.ts`, dass jede Permission in mindestens einer Route verwendet wird (0 verwaiste Permissions).
   - Prüft über alle `src/app/api/**/route.ts`, dass jede Route außerhalb der expliziten Public-Allowlist einen Auth-Guard besitzt und jede Schreibmethode (`POST`/`PUT`/`PATCH`/`DELETE` außer `/api/auth/login`) CSRF + Rate-Limit erzwingt.
   - Laufzeit-Stichproben: anonymer Aufruf auf `GET /api/ops`, `GET /api/firm/config`, `GET /api/live/state` -> `401` bei gesetztem `FIRM_API_TOKEN`; Operator auf `PUT /api/firm/config` -> `403`; Session-Cookie ohne `x-csrf-token` auf `POST /api/firm/micro` und `PUT /api/routing/modes` -> `403`.
2. Führe aus und halte die gesamte Suite grün:
   - `npx tsx --test tests/asa05.apiGuardsAndCsrf.test.ts tests/sec02.unauthenticatedGetApis.test.ts`
   - `npm run typecheck`
   - `npm run lint`
   - `npm run docs:inventories && npm run docs:inventories:check`
   - `npm run docs:validate`
   - `npm test`
```
