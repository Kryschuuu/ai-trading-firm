# SEC-08 — Sessions sind nicht sofort widerrufbar

- **ID:** SEC-08
- **Severity:** MEDIUM
- **Bereich:** AuthN / AuthZ / Session-Lifecycle
- **Quelle:** Security Review-GPT_01.md, Kapitel SEC-08 — Sessions sind nicht sofort widerrufbar
- **Status:** FIXED (Resolved)
- **Fix-Version:** v1.36.35 (2026-09-07)
- **Betroffene Versionen:** bis einschließlich v1.36.34
- **Datei(en):** `src/lib/authSession.ts`, `src/lib/apiAuth.ts`, `src/app/api/auth/logout/route.ts`, `src/app/api/auth/login/route.ts`, `src/auth/resolve.ts`, `src/lib/stateRegistry.ts`, `src/lib/browserSession.ts`, `src/components/FirmDashboard.tsx`
- **Fix-Commit:** arena/01a07aae-ai-trading-firm (PR folgt)
- **Red-Test-Commit:** arena/01a07aae-ai-trading-firm

> Beschreibung und PoC unten dokumentieren den ursprünglichen verwundbaren Stand.
> Die Behebung und deren Absicherung sind unter „Implementierter Fix (v1.36.35)“ festgehalten.

## Beschreibung (vor v1.36.35)

Browser-Sessions sind HMAC-signiert mit 15 Minuten TTL (`SESSION_TTL_S = 900`). In v1.36.27 (SEC-01) wurde ein Konfigurations-Fingerprint (`authEpoch`) eingeführt, der Sessions bei Änderungen der Server-Token-Konfiguration (Neustart) invalidiert.

Dennoch blieben Sessions innerhalb ihrer 15-Minuten-Gültigkeit **nicht gezielt widerrufbar**:

1. **Kein serverseitiges Logout:** Ein Benutzer-Logout im Browser löschte nur die lokalen Cookies. Der signierte Session-Token blieb auf dem Server bis zum Ablauf der TTL uneingeschränkt gültig.
2. **Keine Revocation bei Token-Kompromittierung:** Ein abgefangener oder gestohlener Session-Cookie (z. B. durch Schulterblick, Shared Workstation, Proxy-Logs) konnte von einem Angreifer beliebig oft wiederverwendet werden, selbst nachdem sich das Opfer abgemeldet hatte.
3. **Kein administrativer Notfall-Widerruf:** Administratoren hatten keine Möglichkeit, einzelne kompromittierte Sessions oder alle bestehenden Sessions im laufenden Betrieb unmittelbar für ungültig zu erklären, ohne Server-Neustarts und Token-Rotationen zu erzwingen.

## Beweis / PoC

```ts
// src/lib/authSession.ts (vor Fix)
export function readSession(req: Request, env: EnvLike, now: number): SessionPayload | null {
  const cookieVal = sessionCookie(req);
  if (!cookieVal) return null;
  const payload = verifySessionToken(cookieVal, secret, now);
  // Keine serverseitige Revocation-Prüfung — Token bleibt bis exp gültig!
  return payload && sessionActor(payload, env, now) ? payload : null;
}
```

Szenario:

1. Operator meldet sich an → erhält Session-Cookie (15 min TTL).
2. Angreifer erlangt Kenntnis des `firm_session`-Cookies.
3. Operator meldet sich über das Dashboard ab.
4. Angreifer sendet `POST /api/firm/tick` oder `POST /api/firm/kill` mit dem alten Cookie.
5. Vor Fix: Der Server akzeptierte die Anfrage bis zum Ablauf der 15 Minuten weiterhin mit Operator-Rechten (HTTP 200).
6. Nach Fix: Der Server prüft die Revocation-Registry und lehnt sofort mit 401/403 ab.

## Remediation (aus Audit + Implementierung)

1. **Serverseitige Session-Revocation-Registry einführen:**
   - Eindeutige Bindung jeder Session über den kryptographischen CSRF-/Session-Schlüssel (`csrf`, 32 Random-Bytes / 64 Hex-Zeichen).
   - Registrierung widerrufener Sessions in der zentralen State-Registry (`state.revokedSessions`).
   - Globale Epochen-Revocation (`state.sessionsRevokedBefore`) für administrative Notfall-Schnitte.
2. **Dedizierter Logout-Endpunkt (`POST /api/auth/logout`):**
   - Invalidiert die übergebene Session serverseitig in der Revocation-Registry.
   - Sendet standardkonforme `Set-Cookie`-Header mit `Max-Age=0` zur Bereinigung des Browsers.
   - Unterstützt administrative Global-Revocation via `{"all": true}` (geschützt durch `broker.credentials` [Admin]).
   - Fail-closed & Rate-limitiert (`checkRateLimit`).
3. **Memory-Hygiene & Auto-Pruning:**
   - Revocation-Einträge speichern ihren natürlichen Ablaufzeitpunkt `exp`.
   - Abgelaufene Einträge (`now >= exp`) werden bei Abfragen und über `pruneRevokedSessions()` automatisch aus dem Speicher entfernt (keine unbegrenzte Memory-Akkumulation).
4. **Integration in alle Autorisierungspfade:**
   - `readSession()` und `sessionActor()` verifizieren `isSessionRevoked()`.
   - Sämtliche mutierenden und lesenden Guards (`resolveAuth`, `checkApiToken`, `checkCsrfGuard`, `requirePermission`) weisen widerrufene Sessions unmittelbar ab.

## Akzeptanzkriterien / Tests

- [x] Session-Payload enthält `authEpoch` (oder gleichwertige Credential-Version)
- [x] Test: Token-Rotation → bestehende Session wird abgelehnt
- [x] Test: Rollen-Degradierung (Operator → Viewer) → `firm.write` in alter Session greift nicht mehr
- [x] Test: Logout / explizites Revoke invalidiert die Session vor TTL-Ablauf
- [x] Session-TTL dokumentiert und auf ≤ 5 min gesetzt (oder Epoch macht 15 min akzeptabel)
- [x] Keine Regression: gültige Sessions innerhalb der TTL funktionieren weiterhin

## Implementierter Fix (v1.36.35)

**Root Cause:** Sessions wurden rein stateless über HMAC-Signatur und Ablaufzeit validiert. Ohne serverseitige Revocation-Registry konnte ein Session-Token nach Benutzer-Logout oder Kompromittierung nicht vor dem Ablauf der 15-Minuten-TTL invalidiert werden.

**Umsetzung:**

- **Zentrale Revocation-Registry (`src/lib/stateRegistry.ts`):** `state.revokedSessions` (Map Session-Key → `exp`) und `state.sessionsRevokedBefore` (globaler Revocation-Cutoff-Timestamp) in die singleton-geführte State-Registry integriert. Vollständig testbar über `__resetAllSingletonsForTests()`.
- **Session-Revocation-Engine (`src/lib/authSession.ts`):**
  - `revokeSession(session)`: Trägt die eindeutige Session-Kennung (`csrf`) mit Ablaufzeitpunkt `exp` in die Revocation-Registry ein.
  - `revokeAllSessions(now)`: Setzt den globalen Widerrufs-Zeitstempel. Alle Sessions mit `iat <= now` werden augenblicklich ungültig.
  - `isSessionRevoked(payload, now)`: Prüft globale und individuelle Revocation und bereinigt abgelaufene Einträge automatisch.
  - `clearSessionCookies()`: Erzeugt `Set-Cookie`-Header mit `Max-Age=0`, `HttpOnly`, `Secure`, `SameSite=Strict`.
  - `readSession()` & `sessionActor()`: Fail-Closed-Validierung vor jeder Rechte- und Identitätserteilung.
- **Logout-Endpunkt (`src/app/api/auth/logout/route.ts`):**
  - Rate-limitiert (30/min).
  - Verarbeitet reguläre Einzel-Logouts sowie administrative Global-Revocation (`{"all": true}` erfordert Admin-Rechte `broker.credentials`).
  - Idempotent: Auch Aufrufe ohne Cookies oder mit abgelaufenen Cookies antworten mit 200 und bereinigen die Browser-Cookies.
- **Client- & UI-Integration:** `FirmDashboard.tsx` bietet eine „Abmelden“-Schaltfläche mit serverseitigem Aufruf von `/api/auth/logout`; `browserSession.ts` stellt `logoutSession()` bereit.

### Validierung

- **Vor Fix (Red Test):** Replay-Angriffe nach Logout wurden akzeptiert (HTTP 200) und der Logout-Endpunkt existierte nicht.
- **Nach Fix:** `tests/sec08.sessionRevocation.test.ts` (11 Tests, 100 % bestanden):
  - Einzel-Logout vor Ablauf der TTL invalidiert die Session unmittelbar.
  - Replay-Angriffe gegen Schreib- und Lese-Endpunkte (`/api/firm/tick`, `/api/auth/me`, `/api/firm/kill`) scheitern sofort mit 401/403.
  - Gezielter Einzelwiderruf isoliert die kompromittierte Session, ohne parallele Sessions anderer Benutzer zu stören.
  - Globale Admin-Revocation invalidiert alle Altsessions, während Neuanmeldungen funktionieren.
  - Nicht-Admins können keine globale Revocation auslösen (403).
  - Memory-Hygiene: Pruning entfernt abgelaufene Revocation-Einträge.
  - Standardkonforme `Max-Age=0` Cookie-Löschung und Rate-Limiting gegen Flood-Angriffe.
- `npm run test:security:auth`: **206/206 Tests grün** (keine Skips).
- `npm run typecheck`, `npm run lint`, `npm run docs:validate`: **alle grün**.

## Changelog-Blurb

```
SEC-08 (MEDIUM): Session-Revocation — serverseitiger Logout-Endpunkt (/api/auth/logout), sofortige Revocation vor TTL-Ablauf und globale Epochen-Invalidierung (v1.36.35)
```

## Versions-Hinweis

PATCH — Security-Fix (v1.36.35). Keine Datenbank-Migration erforderlich.
