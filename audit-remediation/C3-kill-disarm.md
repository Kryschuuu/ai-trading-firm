# C3 — Kill-Switch kann mit derselben einfachen Operator-Authentisierung disarmt werden

- **Severity:** HIGH
- **Bereich:** Control Panel
- **Status (validiert):** ✅ **Valide.**
- **Datei(en):** `src/app/api/firm/kill/route.ts` (`guardWrite(req)` für Arm **und** Disarm)

## Arena-Prompt (kopierbar)

```
TASK: Require a stronger gate to DISARM the kill-switch than to arm/operate it.

PROBLEM: Both arm and disarm go through guardWrite(req) (operator token). A stolen operator token can
POST {arm:false} and re-enable trading immediately after a kill-switch fired.

DO:
1. Split the guard: arm uses guardWrite (operator ok); disarm requires:
     - ADMIN permission (requirePermission(req, "live.gate") or a dedicated "kill.disarm"), AND
     - an explicit confirmation nonce: the client must first GET a disarm challenge
       (POST /api/firm/kill/challenge returns { nonce, expiresAt }) and echo it back in the disarm
       body; the nonce must be single-use and short-lived (<=60s).
2. On disarm: verify admin permission, verify nonce matches & not expired & not reused, THEN
   killSwitch.disarm(); record a CRITICAL audit entry with actor + nonce id.
3. Optionally (live): require human approval + live-gate re-validation + broker state sync before
   ENABLE (document as future for true live trading).
4. Keep CSRF header requirement from the control-plane guards for the disarm endpoint too.

ACCEPTANCE: Disarm without admin token -> 401/403; disarm without valid nonce -> 403; valid admin +
fresh nonce -> disarmed + audited; reused/expired nonce -> rejected.
```

## Beweis (aktueller Code)

`src/app/api/firm/kill/route.ts` L17‑18 & L42‑48:

```ts
const denied = guardWrite(req);          // arm AND disarm
if (denied) return denied;
...
killSwitch.disarm();                     // no extra gate
await db.insert(killSwitches).values({ reason, triggeredBy: "OPERATOR", armed: false });
```

## Fix-Spezifikation

Disarm: ADMIN-Token + expliziter Confirmation-Nonce + Audit (siehe Audit C3). Arm bleibt Operator.

## Akzeptanzkriterien / Tests

- [ ] Disarm ohne Admin → abgelehnt.
- [ ] Disarm ohne/mit abgelaufenem/wiederverwendetem Nonce → abgelehnt.
- [ ] Erfolgreicher Disarm wird als CRITICAL auditiert.

## Changelog-Blurb

`C3 (HIGH): Kill-Switch-Disarm gleich stark wie Operatorzugriff — jetzt ADMIN + single-use Nonce +
Audit; Rückkehr aus sicherem Zustand strikt getrennt.`

## Versions-Hinweis

PATCH (`1.36.3`) — Sicherheits-Härtung (neuer Challenge-Endpunkt, Nonce-Logik).
