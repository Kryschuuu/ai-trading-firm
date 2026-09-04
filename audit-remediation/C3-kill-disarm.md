# C3 — Kill-Switch kann mit derselben einfachen Operator-Authentisierung disarmt werden

- **Severity:** HIGH
- **Bereich:** Control Panel
- **Status (validiert):** ✅ **gefixt v.1.36.15** (ADMIN + single-use Nonce + CSRF).
- **Datei(en):** `src/app/api/firm/kill/route.ts`, `src/app/api/firm/kill/challenge/route.ts` (neu),
  `src/lib/disarmChallenge.ts` (neu), `src/lib/auditView.ts`, `src/components/FirmDashboard.tsx`

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

## Befund (vor v1.36.15)

`src/app/api/firm/kill/route.ts` ließ Arm **und** Disarm durch denselben
`guardWrite(req)` — der Disarm war damit exakt so schwach wie das Ziehen selbst:

```ts
const denied = guardWrite(req);          // arm AND disarm
if (denied) return denied;
...
killSwitch.disarm();                     // no extra gate
await db.insert(killSwitches).values({ reason, triggeredBy: "OPERATOR", armed: false });
```

Ein einziges, gestohlenes Operator-Token konnte `POST {arm:false}` senden und
Trading unmittelbar nach einem ausgelösten Not-Halt wieder freischalten.

## Fix (v1.36.15) — Guard-Split

**Arm** (`{arm:true}`): bleibt bei `guardWrite(req)` (Operator-Token genügt —
Scharfschalten in den sicheren Zustand ist keine Eskalation).

**Disarm** (`{arm:false, nonce}`): strikt stärkere Kette in
`src/app/api/firm/kill/route.ts`, erst danach `killSwitch.disarm()`:

1. `requirePermission(req, "live.gate")` — ADMIN (Operator ohne Admin-Elevation hat `live.gate` nicht).
2. `checkCsrfGuard(req)` — CSRF-Header `x-csrf-token` wie in der Control Plane.
3. `consumeDisarmNonce(nonce)` aus `src/lib/disarmChallenge.ts` — Nonce aus
   `GET /api/firm/kill/challenge` (`{ ok, nonce, expiresAt }`), single-use, ≤ 60 s.
   - unbekannt/fehlend → 403 `NONCE_REQUIRED`
   - abgelaufen → 403 `NONCE_EXPIRED`
   - wiederverwendet → 403 `NONCE_REUSED`

Danach: `killSwitch.disarm()`, `killSwitches`-Zeile `armed:false`, gestoppte
Missionen → `PENDING`, `invalidateBrokerCache()` und **CRITICAL**-Audit
`KILL_SWITCH_DISARMED` mit `{ reason, actor, nonceId }` (vorher `WARN`, ohne Actor).
`src/lib/auditView.ts` erwartet dafür jetzt `CRITICAL` und zeigt Actor +
Nonce-Präfix. Die Challenge selbst ist ebenfalls ADMIN-gated + CSRF-geschützt.
`src/components/FirmDashboard.tsx` holt vor einem Disarm automatisch die Challenge
und echot den Nonce. (Punkt 3 des Prompts — human approval / live-gate
re-validation vor ENABLE — betrifft das echte Live-Gate (Task 11) und bleibt
dort dokumentierter Zukunftspfad; für den Firm-Not-Halt greift Punkt 1/2/4.)

## Akzeptanzkriterien / Tests

- [x] Disarm ohne Admin → 401/403 (`requirePermission`/`checkCsrfGuard`).
- [x] Disarm ohne/mit abgelaufenem/wiederverwendetem Nonce → 403
      (`tests/disarmChallenge.test.ts`: missing/expired/reused).
- [x] Erfolgreicher Disarm (Admin + frischer Nonce) wird als CRITICAL auditiert
      (Actor + Nonce).
- [x] CSRF-Header für Disarm erzwungen.
- [x] Nonce single-use + ≤ 60 s (`DISARM_NONCE_TTL_MS = 60_000`).

## Changelog-Blurb

`C3 (HIGH): Kill-Switch-Disarm gleich stark wie Operatorzugriff — jetzt ADMIN +
single-use Nonce (≤ 60 s) + CSRF; Rückkehr aus sicherem Zustand strikt getrennt.
Disarm wird als CRITICAL auditiert (Actor + Nonce).`

## Versions-Hinweis

PATCH **1.36.15** — Sicherheits-Härtung (neuer Challenge-Endpoint
`GET /api/firm/kill/challenge`, Nonce-Logik). Details: `CHANGELOG.md`,
`docs/CHANGELOG.md`, `docs/AUDIT_REMEDIATION_2026-09.md`.
