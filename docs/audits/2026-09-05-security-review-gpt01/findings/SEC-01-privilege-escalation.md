# SEC-01 — Privilege Escalation über signierte Session

- **ID:** SEC-01
- **Severity:** CRITICAL
- **Bereich:** AuthN / AuthZ / Session
- **Quelle:** Security Review-GPT_01.md, Kapitel SEC-01 — Privilege Escalation über signierte Session
- **Status:** OPEN
- **Fix-Version:** -
- **Datei(en):** `src/lib/authSession.ts`, `src/app/api/auth/login/route.ts`, `src/auth/resolve.ts`, `src/lib/apiAuth.ts`
- **Peer-Review-Patch:** TBD — verlinken sobald Patch in `docs/peer-reviews/` existiert

## Beschreibung

Der kritischste Befund steckt in `authSession.ts`.

Der Session-Signaturschlüssel ist optional unabhängig konfigurierbar (`FIRM_SESSION_SECRET`). Fehlt dieser, wird der HMAC-Schlüssel **deterministisch aus den konfigurierten Auth-Tokens** abgeleitet (Tokens aneinandergereiht, SHA-256).

`verifySessionToken()` prüft HMAC, Payload-Schema, Ablauf und dass Permissions aus der erlaubten Permission-Liste stammen — **aber nicht**, dass die `permissions` zur behaupteten Rolle gehören. `effectiveRole` wird nicht erneut aus der aktuellen Auth-Konfiguration abgeleitet.

`sessionActor()` übernimmt Rolle, Elevation und Permissions 1:1 aus dem Cookie-Payload.

Die Login-Route akzeptiert ausdrücklich auch Viewer-Credentials und stellt daraus eine signierte Session aus. Kennt der Viewer sein eigenes Token **und** fehlt `FIRM_SESSION_SECRET`, kennt er das Material für `sessionSecret()`.

Ein gültig signiertes, aber vom Viewer selbst erzeugtes Admin-Payload wird als Autorität akzeptiert.

## Beweis / PoC

Angenommen:

```env
FIRM_VIEWER_TOKEN=<redacted>
FIRM_SESSION_SECRET=
FIRM_ADMIN_TOKEN=
FIRM_API_TOKEN=
```

Der Viewer kennt den HMAC-Schlüssel. Ein Payload der Form

```json
{
  "role": "admin",
  "effectiveRole": "admin",
  "permissions": [
    "firm.read",
    "firm.write",
    "firm.kill",
    "firm.config",
    "broker.credentials",
    "routing.modes.write",
    "live.gate"
  ]
}
```

wird akzeptiert, sofern HMAC und Schema stimmen. Es fehlt die Relation: `role=admin` muss von einem tatsächlich adminberechtigten Credential stammen.

```ts
// src/lib/authSession.ts — sessionSecret() fällt auf Token-Material zurück
const override = (env.FIRM_SESSION_SECRET ?? "").trim();
if (override) return override;
const material = [env[ADMIN_TOKEN_FLAG], env[OPERATOR_TOKEN_FLAG], env[VIEWER_TOKEN_FLAG]]
  .filter((s): s is string => typeof s === "string" && s.length > 0)
  .join("\x00");

// sessionActor() vertraut dem Cookie
permissions: payload.permissions
```

Auswirkungen bei dieser Konfiguration: Viewer kann potentiell `firm.write`, `firm.kill`, `firm.config`, `broker.credentials`, `routing.modes.write`, `live.gate` erlangen.

## Remediation (aus Audit + eigene Bewertung)

1. In Produktion `FIRM_SESSION_SECRET` **verpflichtend** machen und als unabhängiges Secret behandeln.
2. `sessionActor()` darf keine frei im Cookie gespeicherten Permissions als Autorität betrachten. Beim Verifizieren:
   ```ts
   const expectedPermissions = permissionsForRole(payload.effectiveRole);
   if (!samePermissionSet(payload.permissions, expectedPermissions)) {
     return null;
   }
   ```
3. Noch robuster: `role`, `effectiveRole`, `elevated`, Permissions serverseitig neu ableiten — nicht als Session-Autorität behandeln.
4. Session sollte `authEpoch` / Credential-Version enthalten, damit Rotation/Revocation greift (siehe SEC-08).

## Akzeptanzkriterien / Tests

- [ ] Pflicht-Test: nur `FIRM_VIEWER_TOKEN` gesetzt → Viewer darf niemals eine gültige Session mit `firm.write` oder `live.gate` erzeugen
- [ ] `verifySessionToken` / `sessionActor` lehnt Permissions ab, die nicht zur Rolle gehören
- [ ] Produktion ohne `FIRM_SESSION_SECRET` startet nicht bzw. stellt keine Sessions aus
- [ ] `FIRM_SESSION_SECRET` ist unabhängig von Viewer-/Operator-/Admin-Tokens
- [ ] Regression: gültige Admin-/Operator-Sessions funktionieren weiterhin

## Changelog-Blurb

```
SEC-01 (CRITICAL): Privilege Escalation — Session-HMAC unabhängig vom Viewer-Token; Permissions serverseitig neu ableiten
```

## Versions-Hinweis

PATCH, Security-Fix — vor Live-Trading zwingend.
