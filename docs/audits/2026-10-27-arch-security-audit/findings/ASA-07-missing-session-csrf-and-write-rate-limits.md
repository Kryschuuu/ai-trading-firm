# ASA-07 — Fehlender CSRF-Schutz auf zentralen mutierenden Endpunkten (`guardWrite`) sowie fehlende Write-Rate-Limits

- **ID:** ASA-07
- **Severity:** HIGH
- **Bereich:** Sicherheit (CSRF & Brute-Force / DoS)
- **Status:** FIXED — 2026-10-28
- **Datei(en):** `src/lib/apiAuth.ts:174-182`, `src/app/api/firm/route.ts:95-115`, `src/app/api/firm/micro/route.ts:45-90`, `src/app/api/firm/missions/route.ts:55-95`, `src/app/api/firm/lifecycle/route.ts:206`, `src/app/api/ops/toggles/route.ts:28-55`, `src/app/api/routing/modes/route.ts:40-65`, `src/app/api/firm/execution/policy/route.ts:48-75`, `src/app/api/firm/execution/twap/route.ts:50-85`, `src/app/api/auth/logout/route.ts:22-35`
- **Session-Prompt:** [`../prompts/PROMPT-ASA-P1-05-api-rbac-sec02-csrf-error-redaction.md`](../prompts/PROMPT-ASA-P1-05-api-rbac-sec02-csrf-error-redaction.md)

## Beschreibung

Obwohl Browser-Sessions über Cookies (`atf_session`) authentifiziert werden und `checkCsrfGuard(req)` sowie `apiFetch()` (automatischer `x-csrf-token`-Header) bereits existieren, rufen `guardWrite(req)` und zahlreiche kritische `POST`/`PUT`/`PATCH`/`DELETE`-Routen `checkCsrfGuard(req)` nicht auf. Da Browser `SameSite=Strict`-Cookies über verschiedene Ports derselben Host-/Domain-Site (z. B. `localhost:<fremder-port>`) sowie über Schwester-Subdomains regulär mitsenden, bleibt Cross-Origin-Request-Forgery innerhalb derselben Site möglich. Zusätzlich fehlen Rate-Limits auf mehreren Schreibrouten.

## Technischer Nachweis

1. `guardWrite(req)` (`src/lib/apiAuth.ts:174-176`) ruft nur `requirePermission(req, "firm.write")` auf — ohne `checkCsrfGuard(req)`.
2. Damit akzeptieren u. a. `POST /api/firm` (Pipeline-Run), `POST/PATCH/DELETE /api/firm/micro` (Trade-Regeln anlegen/löschen), `POST /api/firm/missions`, `POST /api/firm/lifecycle`, `POST /api/ops/toggles`, `PUT /api/routing/modes`, `PUT /api/firm/execution/policy`, `POST /api/firm/execution/twap` und `POST /api/firm/forecasts/resolve` Cookie-authentifizierte Schreibzugriffe ohne gültiges Double-Submit-CSRF-Token.
3. `execution/policy`, `execution/twap`, `forecasts/resolve`, `ops/toggles`, `routing/modes` und `auth/logout` besitzen keinen `checkRateLimit`-Aufruf.

## Konkreter Lösungsvorschlag

```diff
--- a/src/lib/apiAuth.ts
+++ b/src/lib/apiAuth.ts
@@ -171,6 +171,7 @@ export function checkRateLimit(
 }

 export function guardWrite(request: Request): NextResponse | null {
-  return requirePermission(request, "firm.write");
+  return requirePermission(request, "firm.write") ?? checkCsrfGuard(request);
 }
```

- Einen zentralen Helper `guardMutation(request, permission, rateLimitOpts)` in `src/lib/apiAuth.ts` bereitstellen, der `requirePermission` + `checkCsrfGuard` + `checkRateLimit` in konsistenter Reihenfolge prüft, und alle mutierenden Handler (außer `POST /api/auth/login`, das eigene Login-Rate-Limits hat) darüber absichern.
- Hinweis: Bearer-/Header-Token-Clients (`Authorization: Bearer ...`, `x-api-token`, `x-admin-token`) passieren `checkCsrfGuard` weiterhin unverändert, da CSRF nur für Cookie-Sessions bzw. `local-open`-Browser-Aufrufe greift.

## Akzeptanzkriterien / Verifikation

- [x] Jede mutierende Route (`POST`, `PUT`, `PATCH`, `DELETE`, exkl. `/api/auth/login`) weist Requests mit gültigem `atf_session`-Cookie, aber fehlendem oder falschem `x-csrf-token`-Header mit `403` ab.
- [x] Jede mutierende Route ist durch ein Rate-Limit geschützt (`429` bei Überschreitung).
- [x] `docs/generated/route-inventory.md` weist nach `npm run docs:inventories` für alle geschützten Schreibrouten den CSRF-Guard aus.

## Umsetzung (2026-10-28)

- `guardWrite` erzwingt nun Auth → session/local-open CSRF → `checkRateLimit`; `guardMutation` stellt dieselbe Reihenfolge für fachliche Permissions bereit. Credential-/Live-Gate-Limits bleiben als dedizierte, stärkere Limits erhalten. Logout ist CSRF- und rate-limited; Refresh prüft sessiongebundenes CSRF in `renewSession` (local-open zusätzlich im Handler). Token-Header-Clients bleiben CSRF-frei, weil sie keine ambienten Browser-Credentials verwenden.
- Die UI-Aufrufe auf `/api/**` verwenden durchgehend `apiFetch`.
- `/api/firm/micro` ist in diesem Checkout ausschließlich GET (kein POST-Handler); die Laufzeitregression deckt `guardWrite` über `POST /api/firm/missions` und zusätzlich `PUT /api/routing/modes` ab.
- Regression: `tests/asa05.apiGuardsAndCsrf.test.ts`, `tests/proposalApprove.auth.test.ts`, Session-/Logout-Tests.
