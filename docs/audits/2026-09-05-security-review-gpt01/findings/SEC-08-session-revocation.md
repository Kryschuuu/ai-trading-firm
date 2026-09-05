# SEC-08 — Sessions sind nicht sofort widerrufbar

- **ID:** SEC-08
- **Severity:** MEDIUM
- **Bereich:** AuthN / AuthZ / Session-Lifecycle
- **Quelle:** Security Review-GPT_01.md, Kapitel SEC-08 — Sessions sind nicht sofort widerrufbar
- **Status:** OPEN
- **Fix-Version:** -
- **Datei(en):** `src/lib/authSession.ts`, `src/lib/apiAuth.ts`, `src/app/api/auth/login/route.ts`, `src/auth/resolve.ts`
- **Peer-Review-Patch:** TBD — verlinken sobald Patch in `docs/peer-reviews/` existiert

## Implementierungsstand v1.36.27

SEC-01 ergänzt einen credential-gebundenen, keyed Konfigurations-Fingerprint
(`authEpoch`) und entfernt Berechtigungs-Snapshots. Token-/Key-Rotation,
Token-Entfernung/-Neueinrichtung und Rollen-Degradierung invalidieren Sessions,
sobald die neue Konfiguration in allen Prozessen aktiv ist (Neustart).
Die Regressionen liegen in `tests/sec01.sessionSecurity.test.ts`.
**SEC-08 bleibt OPEN:** individuelles Logout/Explizit-Revoke ist nicht implementiert;
TTL bleibt 15 Minuten. Die folgende Beschreibung dokumentiert den ursprünglichen
Stand bis v1.36.26; das Audit-Original bleibt unverändert.

## Beschreibung

Sessions sind stateless, HMAC-signiert und haben 15 Minuten TTL (`SESSION_TTL_S = 900`). Das ist grundsätzlich ein gutes Design.

Der signierte Session-Payload enthält jedoch einen **Berechtigungs-Snapshot**:

```text
role
effectiveRole
elevated
permissions
```

Diese Werte werden bei jeder Anfrage aus der Session übernommen (`sessionActor()`), nicht erneut aus der aktuellen Auth-Konfiguration abgeleitet.

Damit kann eine Session bis zu 15 Minuten weiter gültig bleiben, obwohl:

- ein Token rotiert wurde,
- Berechtigungen geändert wurden,
- eine Rolle reduziert wurde,
- ein Operator degradiert wurde.

Ist ein separates `FIRM_SESSION_SECRET` gesetzt, ist eine Token-Rotation sogar vollständig von laufenden Sessions entkoppelt: das Session-HMAC bleibt gültig, auch wenn `FIRM_ADMIN_TOKEN` / `FIRM_OPERATOR_TOKEN` / `FIRM_VIEWER_TOKEN` bereits rotiert sind.

Es gibt keine `authEpoch`, kein serverseitiges Session-Store und keine unmittelbare Revocation.

## Beweis / PoC

```ts
// src/lib/authSession.ts
export const SESSION_TTL_S = 900; // 15 min

export function sessionActor(payload: SessionPayload): Actor {
  return {
    role: payload.role,
    effectiveRole: payload.effectiveRole,
    elevated: payload.elevated,
    source: "api-session",
    auditId: payload.auditId,
    permissions: payload.permissions, // Snapshot, nicht neu abgeleitet
  };
}
```

Szenario:

1. Operator loggt sich ein → Session mit `firm.write` / `firm.kill` (15 min TTL).
2. Admin rotiert `FIRM_OPERATOR_TOKEN` oder degradiert die Rolle.
3. Innerhalb der restlichen TTL bleibt die alte Session gültig und darf weiter schreiben.

Erwartet nach Rotation/Degradierung: sofort 401/403.  
Tatsächlich: bis zu 15 Minuten weiter autorisiert.

## Remediation (aus Audit + eigene Bewertung)

1. **Serverseitige Session-Revocation-Epoche einführen:**
   ```text
   session.authEpoch = currentAuthEpoch
   ```
   Bei Credential-Rotation / Rollenänderung:
   ```text
   authEpoch++
   ```
   `verifySessionToken()` / `sessionActor()` lehnt Payloads mit veralteter Epoche ab.
2. **Permissions nicht als Session-Autorität behandeln** — Rolle/Permissions serverseitig neu ableiten (siehe auch SEC-01).
3. **TTL verkürzen:** für das Trading-System maximal **5 Minuten** Session-TTL plus Revocation-Epoch.
4. Optional: Sessions vollständig serverseitig speichern (Registry/DB), sodass Logout/Revoke sofort greift.

## Akzeptanzkriterien / Tests

- [x] Session-Payload enthält `authEpoch` (oder gleichwertige Credential-Version)
- [x] Test: Token-Rotation → bestehende Session wird abgelehnt
- [x] Test: Rollen-Degradierung (Operator → Viewer) → `firm.write` in alter Session greift nicht mehr
- [ ] Test: Logout / explizites Revoke invalidiert die Session vor TTL-Ablauf
- [x] Session-TTL dokumentiert und auf ≤ 5 min gesetzt (oder Epoch macht 15 min akzeptabel)
- [x] Keine Regression: gültige Sessions innerhalb der TTL funktionieren weiterhin

## Changelog-Blurb

```
SEC-08 (MEDIUM): Session-Revocation — authEpoch + kürzere TTL, Snapshot-Permissions nicht mehr alleinige Autorität
```

## Versions-Hinweis

PATCH, Security-Fix.
