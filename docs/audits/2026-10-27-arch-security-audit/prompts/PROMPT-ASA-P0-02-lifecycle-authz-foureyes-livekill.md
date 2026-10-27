# PROMPT-ASA-P0-02 — Lifecycle-Rollen-Spoofing, Vier-Augen-Prinzip & Live-Kill-AuthZ härten

- **Befund:** [`../findings/ASA-02-lifecycle-role-spoofing-four-eyes-live-kill.md`](../findings/ASA-02-lifecycle-role-spoofing-four-eyes-live-kill.md) (`CRITICAL`)
- **Tracking:** [`../remediation/TRACKING.md`](../remediation/TRACKING.md)
- **Anwendung:** Den folgenden Block vollständig in eine frische Coding-Session kopieren.

```text
Du arbeitest im Repository `ai-trading-firm` (TypeScript, Next.js App Router, RBAC/Auth unter `src/auth/*` und `src/lib/apiAuth.ts`).

AUFGABE: Behebe vollständig den kritischen Sicherheitsbefund `ASA-02` (Admin-Rollen-Spoofing per unvalidiertem `x-admin-token` in `/api/firm/lifecycle`, Ein-Personen-Umgehung des Vier-Augen-Prinzips über Freitextfelder und fehlerhafte Kill-Switch-Autorisierung/Nonce-Prüfung in `/api/live/kill`).

KONTEXT & IST-ZUSTAND (lies diese Dateien zuerst komplett):
1. `docs/audits/2026-10-27-arch-security-audit/findings/ASA-02-lifecycle-role-spoofing-four-eyes-live-kill.md`
2. `src/app/api/firm/lifecycle/route.ts` (insb. `actorRoleFromRequest` Zeilen 162–174 und Promotions-/Vier-Augen-Logik Zeilen 205–340)
3. `src/app/api/live/kill/route.ts` (Zeilen 1–65) und `src/lib/killSwitchNonce.ts` (`issueKillNonce`, `consumeKillNonce`)
4. `src/app/api/live/transition/route.ts` und `src/live-gate/service.ts` (insb. Vier-Augen-Check bei Übergang nach `LIVE`, Zeilen 315–355)
5. `src/lib/apiAuth.ts`, `src/auth/resolver.ts`, `src/auth/permissions.ts`
6. Bestehende Tests zu Lifecycle, Live-Gate und Auth: `tests/strategyLifecycle*.test.ts`, `tests/liveGate*.test.ts`, `tests/auth*.test.ts`

DREI KONKRETE SCHWACHSTELLEN:
1. `src/app/api/firm/lifecycle/route.ts` ruft nur `guardWrite(req)` (Operator-Recht) auf und prüft danach in `actorRoleFromRequest(req)`: `if (req.headers.get("x-admin-token")) return "admin";` — OHNE Token-Validierung! Jeder Operator (oder anonyme Aufrufer in `local-open`) wird mit `x-admin-token: <beliebig>` sofort `admin`.
2. Vier-Augen-Prüfungen in `lifecycle/route.ts` (`approvedBy` vs. `actor`) und `LiveGateService.transition(..., "LIVE")` (`secondApprover` vs. `operator`) vergleichen lediglich ungebundene Strings aus demselben JSON-Body. Eine einzelne Person besteht den Check mit einem einzigen Request.
3. `POST /api/live/kill` verlangt `requirePermission(req, "live.gate")` (nur `admin`) statt `firm.kill` (`operator` + `admin`) — Operatoren können den Not-Aus nicht ziehen! Gleichzeitig ruft `action: "clear"` niemals `consumeKillNonce(body.nonce)` auf, obwohl `GET /api/live/kill` extra eine Einmal-Nonce ausgibt.

VERBINDLICHE UMSETZUNGSSCHRITTE:
1. Echte Rollen- und Identitätsbindung in `src/app/api/firm/lifecycle/route.ts`:
   - Entferne `actorRoleFromRequest` mit dem unvalidierten `req.headers.get("x-admin-token")` restlos.
   - Authentifiziere über `resolveAuth(req)` + `checkCsrfGuard(req)` + `checkRateLimit(...)`. Fordere mindestens die Permission `firm.write` und leite `actorRole` ausschließlich aus `auth.principal.role` (`"admin"` nur wenn `auth.principal.role === "admin"`, sonst `"operator"`; `viewer` wird bereits durch `firm.write` mit `403` abgewiesen) sowie die auditierbare Akteur-Kennung aus `actorAuditId(auth.principal)` ab.
   - Wenn eine Transition laut Lifecycle-Service `admin` erfordert (z. B. `LIVE_CONSTRAINED`, `LIVE_SCALED`, `OVERRIDE`), muss ein Nicht-Admin deterministisch `403 Forbidden` erhalten — selbst wenn er einen gefälschten `x-admin-token`-Header mitschickt.

2. Echtes kryptographisches Vier-Augen-Prinzip (2-Schritt / 2-Principal-Verfahren):
   - Ein einzelner HTTP-Request darf für Vier-Augen-pflichtige Übergänge (Lifecycle-Live-Promotion und `LiveGate`-Übergang nach `LIVE`) nicht mehr Antrag UND Gegenzeichnung gleichzeitig aus demselben Principal liefern.
   - Implementiere eine saubere, zustandsbehaftete Pending-Approval-Mechanik (oder signierte Erstfreigabe-Token/Records mit Ablaufzeit, z. B. 15 Minuten TTL), bei der:
     a) Schritt 1 (`propose` / Erstfreigabe) den kryptographischen Principal-Fingerprint des ersten Freigebers (`actorAuditId(auth.principal)`) speichert,
     b) Schritt 2 (`approve` / Transition-Vollzug) zwingend einen **anderen** authentifizierten Principal (`approverPrincipalId !== proposerPrincipalId`) verlangt,
     c) im `local-open`-Modus (`auth.mode === "local-open"`, kein unterscheidbarer zweiter kryptographischer Principal vorhanden) Vier-Augen-Live-Übergänge Fail-Closed abgelehnt werden (mit klarer Fehlermeldung, dass für Vier-Augen-Live-Freigaben authentifizierte getrennte Principals erforderlich sind).
   - Prüfe bestehende Lifecycle-/Live-Gate-Unit-Tests auf der Service-Schicht und halte interne Service-Signaturen abwärtskompatibel bzw. migriere betroffene Aufrufer sauber.

3. `src/app/api/live/kill/route.ts` reparieren:
   - Parse zuerst den JSON-Body sicher (mit Größen-/Typprüfung) und unterscheide strikt nach `action`:
     - `action === "arm"` (Default im Notfallpfad): `requirePermission(req, "firm.kill") ?? checkCsrfGuard(req)` -> sowohl `operator` als auch `admin` dürfen den Live-Kill-Switch sofort auslösen!
     - `action === "clear"`: `requirePermission(req, "live.gate") ?? checkCsrfGuard(req)` (nur `admin`) UND obligatorische Prüfung einer gültigen, unbenutzten Nonce mittels `consumeKillNonce(body.nonce)` (`400`/`403` bei fehlender, abgelaufener oder bereits verbrauchter Nonce).
   - Binde den Audit-Operator an `actorAuditId(auth.principal)` statt nur an ungeprüften Freitext.

4. Generierte Inventare & Audit-Tracking aktualisieren:
   - Führe `npm run docs:inventories` aus, damit `docs/generated/route-inventory.md` die aktualisierten Guards von `/api/firm/lifecycle` und `/api/live/kill` exakt widerspiegelt.
   - Setze `ASA-02` in `docs/audits/2026-10-27-arch-security-audit/findings/ASA-02-lifecycle-role-spoofing-four-eyes-live-kill.md`, `README.md`, `remediation/TRACKING.md` und `docs/security/README.md` auf `FIXED`.

PFLICHT-TESTS & VERIFIKATION:
1. Erstelle `tests/asa02.lifecycleAndLiveKillAuthz.test.ts` mit Tests für:
   - Operator mit gültigem `FIRM_API_TOKEN` + gefälschtem `x-admin-token: <invalid>` scheitert bei Admin-Lifecycle-Transitionen (`401` oder `403`, niemals `admin`-Rolle).
   - Vier-Augen-Versuch durch denselben Principal (auch mit unterschiedlichen Body-Namen `"alice"` / `"bob"`) wird abgewiesen; zwei verschiedene authentifizierte Principals (z. B. Operator + Admin oder zwei getrennte Credentials/Sessions) bestehen den 2-Schritt-Flow.
   - `POST /api/live/kill` (`arm`): Operator erlaubt (`200`), Viewer verboten (`403`).
   - `POST /api/live/kill` (`clear`): Operator verboten (`403`), Admin ohne Nonce verboten (`400`/`403`), Admin mit gültiger Nonce aus `GET /api/live/kill` erlaubt (`200`), Replay derselben Nonce verboten.
2. Führe aus und halte alles grün:
   - `npx tsx --test tests/asa02.lifecycleAndLiveKillAuthz.test.ts`
   - `npm run typecheck`
   - `npm run lint`
   - `npm run docs:inventories && npm run docs:inventories:check`
   - `npm run docs:validate`
   - `npm test`
```
