# W1 — API-Token wird im Browser in localStorage gespeichert

- **Severity:** HIGH
- **Bereich:** Workshop
- **Status (validiert):** ✅ **Gefixt v.1.36.23** — siehe `CHANGELOG.md`,
  `docs/AUDIT_REMEDIATION_2026-09.md` und `tests/w1.sessionCookie.test.ts`
  (Cookie-Flags, Signatur/Manipulation/Ablauf, resolveAuth/checkApiToken/
  checkCsrfGuard, Login-Route inkl. HTTPS-Enforcement, Statik-Greps).
- **Datei(en):** `src/components/FirmDashboard.tsx` (`saveToken` L143), Token-Verwendung in Fetch-Aufrufen

## Arena-Prompt (kopierbar)

```
TASK: Remove the API token from localStorage; use an HttpOnly+Secure+SameSite session cookie.

PROBLEM: saveToken() does window.localStorage.setItem("firmToken", ...). Any XSS in the origin can
read it via localStorage.getItem("firmToken") and gain API access. Long-lived secrets in localStorage
are not acceptable.

DO:
1. Add a server endpoint POST /api/auth/login (or reuse an existing session route) that verifies the
   token server-side and responds with `Set-Cookie: firm_session=<short-lived-jwt-or-opaque>;
   HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=900`. Do NOT return the raw FIRM_API_TOKEN.
2. In FirmDashboard, replace saveToken() localStorage usage: call /api/auth/login, then discard the
   input. Remove all localStorage.getItem("firmToken") reads.
3. For same-origin fetch calls, the cookie is sent automatically (credentials: "same-origin"). If a
   header is still needed for non-cookie flows, store ONLY a short-lived session id in memory
   (React state/ref), never localStorage.
4. Add `Secure`/`SameSite` enforcement server-side; ensure cookies are not set over plain HTTP in prod.

ACCEPTANCE: grep -rn "localStorage" src/components shows no firmToken storage; /api/auth/login sets
an HttpOnly cookie; an XSS PoC reading localStorage finds no token. If a local single-user install is
desired, use a short-TTL session token (<=15 min) instead of a permanent secret.
```

## Beweis (Code vor v1.36.23)

`src/components/FirmDashboard.tsx` L143 (vor dem Fix):

```ts
function saveToken() {
  window.localStorage.setItem("firmToken", tokenDraft.trim());
  ...
}
```

## Fix-Spezifikation

Keine langfristigen API-Secrets in `localStorage`; serverseitige Session + HttpOnly/Secure/SameSite
Cookie (oder kurzlebiges In-Memory-Session-Token) (siehe Audit W1).

## Akzeptanzkriterien / Tests

- [x] Kein `localStorage.setItem("firmToken", …)` mehr im Code.
- [x] Login setzt HttpOnly+Secure+SameSite-Cookie mit kurzer TTL.
- [x] XSS kann das Secret nicht mehr aus `localStorage` auslesen.

## Umsetzung (v1.36.23)

Neu **`POST /api/auth/login`** (`src/app/api/auth/login/route.ts`): verifiziert
den Token serverseitig über die RBAC-Auflösung (`resolveAuth`) und antwortet
ausschließlich mit `Set-Cookie` — `firm_session` (HttpOnly, Secure,
SameSite=Strict, Path=/, Max-Age=900) und `firm_csrf` (nicht-HttpOnly für
Double-Submit-CSRF). Der rohe Token wird **nie** zurückgegeben und nie im
Browser gespeichert.

**`src/lib/authSession.ts`** (neu) stellt stateless, HMAC-SHA256-signierte
Sessions: Payload = aufgelöster Actor (Rolle/Elevation/Permissions) + CSRF +
`exp`; Schlüssel `FIRM_SESSION_SECRET` (optional) oder deterministisch aus den
konfigurierten Tokens abgeleitet — überlebt Neustarts, keine In-Memory-Sessions.
Produktion über plain-HTTP ⇒ fail-closed `400 SESSION_HTTPS_REQUIRED`
(Secure-Cookie nie über HTTP in Prod); `Secure` gilt ohnehin immer.

Server-Guards lesen die Cookie: `resolveAuth` (`src/auth/resolve.ts`) führt
`source="api-session"` als neue `ActorSource` (`src/auth/types.ts`),
`checkApiToken` (`src/lib/apiAuth.ts`) lässt Operator-/Admin-Sessions schreiben,
`checkCsrfGuard` (`src/brokers/control-plane/guard.ts`) prüft per Double-Submit
gegen den session-gebundenen CSRF-Wert (Legacy-Token-Pfad für curl/CLI bleibt).

Client liest nirgends mehr `firmToken` aus `localStorage`:
`src/lib/apiClient.ts` (Cookie automatisch, `x-csrf-token` bei Mutationen),
`src/lib/controlPlane.ts`, `src/lib/liveGate.ts` (Double-Submit statt
Token-Header), `src/components/FirmDashboard.tsx` (`saveToken` → Login-Aufruf,
Disarm-Pfad CSRF-only, `credentials: "same-origin"`). `src/lib/browserSession.ts`
(neu) entfernt Altbestand (`firmToken`) und liefert den CSRF-Header-Wert.

## Changelog-Blurb

`W1 (HIGH): API-Token in localStorage — ersetzt durch HttpOnly/Secure/SameSite-Session-Cookie;
XSS-Lateral-Movement auf API-Zugriff entschärft.`

## Versions-Hinweis

PATCH (`1.36.23`) — Sicherheits-Härtung (neue Cookie-Setzung, kein localStorage-Secret).
