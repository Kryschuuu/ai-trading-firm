# W1 — API-Token wird im Browser in localStorage gespeichert

- **Severity:** HIGH
- **Bereich:** Workshop
- **Status (validiert):** ✅ **Valide.**
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

## Beweis (aktueller Code)

`src/components/FirmDashboard.tsx` L143:

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

- [ ] Kein `localStorage.setItem("firmToken", …)` mehr im Code.
- [ ] Login setzt HttpOnly+Secure+SameSite-Cookie mit kurzer TTL.
- [ ] XSS kann das Secret nicht mehr aus `localStorage` auslesen.

## Changelog-Blurb

`W1 (HIGH): API-Token in localStorage — ersetzt durch HttpOnly/Secure/SameSite-Session-Cookie;
XSS-Lateral-Movement auf API-Zugriff entschärft.`

## Versions-Hinweis

PATCH (`1.36.3`) — Sicherheits-Härtung (neue Cookie-Setzung, kein localStorage-Secret).
