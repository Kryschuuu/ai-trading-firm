# ASA-02 — Rollen-Spoofing per `x-admin-token`, umgehbares Vier-Augen-Prinzip und gebrochene Kill-Switch-Autorisierung

- **ID:** ASA-02
- **Severity:** CRITICAL
- **Bereich:** Sicherheit (Autorisierung & Governance)
- **Status:** OPEN
- **Datei(en):** `src/app/api/firm/lifecycle/route.ts:165-174`, `src/app/api/firm/lifecycle/route.ts:290-323`, `src/app/api/live/kill/route.ts:27-45`, `src/live-gate/service.ts:318-347`, `src/auth/permissions.ts:21-24`
- **Session-Prompt:** [`../prompts/PROMPT-ASA-P0-02-lifecycle-authz-foureyes-livekill.md`](../prompts/PROMPT-ASA-P0-02-lifecycle-authz-foureyes-livekill.md)

## Beschreibung

Die Governance-Endpunkte für Strategie-Live-Promotions und den Live-Kill-Switch weisen drei kritische Autorisierungsfehler auf: unvalidiertes Admin-Rollen-Spoofing, ein rein stringbasiertes Ein-Request-Vier-Augen-Prinzip sowie vertauschte Permissions und fehlende Nonce-Prüfung beim Live-Kill-Switch.

## Technischer Nachweis

1. **Rollen-Spoofing (`src/app/api/firm/lifecycle/route.ts:165-174`):** Nach `guardWrite(req)` (Operator-Level) prüft `actorRoleFromRequest(req)` lediglich `if (req.headers.get("x-admin-token")) return "admin";`, ohne den Tokenwert jemals gegen `ADMIN_API_TOKEN` zu validieren. Jeder Operator (und im `local-open`-Modus jeder Aufrufer) erhält mit beliebigem Headerwert volle Admin-Rechte für `LIVE_CONSTRAINED`, `LIVE_SCALED` und `OVERRIDE`.
2. **Ein-Personen-Vier-Augen-Bypass (`lifecycle/route.ts:290-323`, `src/live-gate/service.ts:318-347`):** `actor`/`operator` und `approvedBy`/`secondApprover` stammen beide als ungeprüfte Strings aus demselben Request-Body (`approvedBy !== actor`). Eine einzelne Person signiert Antrag und Freigabe in einem Aufruf selbst.
3. **Kill-Switch-Fehlverdrahtung (`src/app/api/live/kill/route.ts:27-45`):**
   - `POST /api/live/kill` verlangt pauschal `live.gate` (nur `admin`) statt `firm.kill` (`operator` + `admin`), sodass Operatoren im Notfall den Live-Kill-Switch nicht auslösen dürfen (`403`).
   - Beim `clear` wird `consumeKillNonce` (`src/lib/killSwitchNonce.ts`) überhaupt nicht aufgerufen, obwohl `GET /api/live/kill` extra eine Einmal-Nonce ausstellt.

## Konkreter Lösungsvorschlag

```diff
--- a/src/app/api/firm/lifecycle/route.ts
+++ b/src/app/api/firm/lifecycle/route.ts
@@ -162,15 +162,11 @@ function parseRole(raw: unknown): LifecycleActorRole | null {
   return null;
 }

-function actorRoleFromRequest(req: Request, bodyRole: unknown): LifecycleActorRole {
-  const explicit = parseRole(bodyRole);
-  if (explicit === "system") return "operator";
-  if (req.headers.get("x-admin-token")) return "admin";
-  if (explicit === "operator") return "operator";
-  return "operator";
+function actorRoleFromAuth(auth: AuthSuccess): LifecycleActorRole {
+  return auth.principal.role === "admin" ? "admin" : "operator";
 }
```

- `resolveAuth(req)` als einzige Quelle für Rolle und kryptographische Akteur-ID (`actorAuditId(auth.principal)`) verwenden; niemals Rollen aus Body oder ungeprüften Headern ableiten.
- In `POST /api/live/kill`: für `action === "arm"` `requirePermission(req, "firm.kill")` verwenden; für `action === "clear"` `requirePermission(req, "live.gate")` **und** `consumeKillNonce(body.nonce)` erzwingen.
- Vier-Augen-Freigaben über zwei getrennte Requests zweier unterschiedlicher authentifizierter Principals (`proposerPrincipalId !== approverPrincipalId`; im `local-open`-Modus explizit blockiert oder an getrennte Admin-/Operator-Tokens gebunden) abbilden.

## Akzeptanzkriterien / Verifikation

- [ ] Ein Operator mit gültigem `FIRM_API_TOKEN` und gefälschtem Header `x-admin-token: <invalid>` erhält bei Admin-Lifecycle-Übergängen (`LIVE_CONSTRAINED`, `LIVE_SCALED`, `OVERRIDE`) `401`/`403`.
- [ ] Ein Operator kann `POST /api/live/kill` mit `action: "arm"` erfolgreich auslösen (`200`), erhält bei `action: "clear"` jedoch `403`; ein Admin erhält bei `action: "clear"` ohne oder mit wiederverwendeter Nonce `400`/`403`.
- [ ] Eine Live-Promotion bzw. `LiveGate`-Transition nach `LIVE` mit identischem authentifiziertem Principal für Antrag und Gegenzeichnung wird abgewiesen.
- [ ] Regressionstest `tests/asa02.lifecycleAndLiveKillAuthz.test.ts` + `npm run docs:inventories:check` + `npm run docs:validate` grün.
