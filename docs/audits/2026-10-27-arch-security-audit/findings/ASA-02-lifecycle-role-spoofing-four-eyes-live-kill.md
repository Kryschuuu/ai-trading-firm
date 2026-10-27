# ASA-02 — Rollen-Spoofing per `x-admin-token`, umgehbares Vier-Augen-Prinzip und gebrochene Kill-Switch-Autorisierung

- **ID:** ASA-02
- **Severity:** CRITICAL
- **Bereich:** Sicherheit (Autorisierung & Governance)
- **Status:** **FIXED** (2026-10-27, Remediation-Session `PROMPT-ASA-P0-02`)
- **Datei(en) vor Fix:** `src/app/api/firm/lifecycle/route.ts`, `src/app/api/live/kill/route.ts`, `src/live-gate/service.ts`
- **Session-Prompt:** [`../prompts/PROMPT-ASA-P0-02-lifecycle-authz-foureyes-livekill.md`](../prompts/PROMPT-ASA-P0-02-lifecycle-authz-foureyes-livekill.md)
- **Regression:** `tests/asa02.lifecycleAndLiveKillAuthz.test.ts` (12 Tests, u. a. gegen eingebettetes PostgreSQL), angepasste `tests/liveGate.api.test.ts` und `tests/liveGate.states.test.ts`

## Beschreibung (ursprünglicher Befund)

Die Governance-Endpunkte für Strategie-Live-Promotions und den Live-Kill-Switch wiesen drei kritische Autorisierungsfehler auf: unvalidiertes Admin-Rollen-Spoofing, ein rein stringbasiertes Ein-Request-Vier-Augen-Prinzip sowie vertauschte Permissions und fehlende Nonce-Prüfung beim Live-Kill-Switch.

## Technischer Nachweis (historisch)

1. **Rollen-Spoofing:** Nach dem Operator-Guard prüfte `POST /api/firm/lifecycle` nur `Boolean(req.headers.get("x-admin-token"))`, ohne den Tokenwert jemals gegen `FIRM_ADMIN_TOKEN` zu validieren. Jeder Operator (und im `local-open`-Modus jeder Aufrufer) erhielt mit beliebigem Headerwert volle Admin-Rechte für `LIVE_LIMITED`/`LIVE`/Override.
2. **Ein-Personen-Vier-Augen-Bypass:** `actor`/`operator` und `approvedBy`/`secondApprover` stammten beide als ungeprüfte Strings aus demselben Request-Body (`approvedBy !== actor`). Eine einzelne Person signierte Antrag und Freigabe in einem Aufruf selbst.
3. **Kill-Switch-Fehlverdrahtung:** `POST /api/live/kill` verlangte pauschal `live.gate` (nur `admin`) statt `firm.kill` (`operator` + `admin`), sodass Operatoren im Notfall den Live-Kill-Switch nicht auslösen durften. Beim `clear` wurde keine Challenge-Nonce geprüft, obwohl `GET /api/live/kill` dafür gedacht war.

## Umsetzung (FIXED)

### 1. Rollen- und Identitätsbindung — `src/app/api/firm/lifecycle/route.ts`

- Der Header-Existenzcheck auf `x-admin-token` ist **restlos entfernt**. Er wird an keiner Stelle der Route mehr gelesen.
- `POST` authentifiziert jetzt über `resolveAuth(req)` → `requirePermission(req, "firm.write")` → `checkCsrfGuard(req)` → `checkRateLimit(req)`. Viewer scheitern deterministisch mit `403` an `firm.write`.
- `actorRoleFromAuth(auth)` leitet die Lifecycle-Rolle **ausschließlich** aus `auth.principal.role` ab (`"admin"` nur bei expliziter Admin-Rolle, sonst `"operator"`); `actorAuditId(auth.principal)` liefert den Audit-Akteur (`api:operator` / `api:admin`). Body-Felder wie `actor`, `approvedBy` oder `actionKind` haben keinen Einfluss auf Rolle oder Identität.
- `ADMIN_ONLY_TARGETS` wird aus der kanonischen Tabelle `LIFECYCLE_TRANSITIONS` abgeleitet (alle Kanten mit `roles: ["admin"]`, z. B. `PAPER → LIVE_LIMITED`, `LIVE_LIMITED → LIVE`). Ein Nicht-Admin erhält dafür vor jedem Service-/DB-Zugriff `403 ADMIN_ROLE_REQUIRED` — auch mit gefälschtem `x-admin-token`.

### 2. Kryptographisches 2-Schritt-/2-Principal-Vier-Augen-Prinzip

- Neues gemeinsames Modul [`src/lib/fourEyesApproval.ts`](../../../../src/lib/fourEyesApproval.ts) (`FOUR_EYES_TTL_MS = 15 min`, Single-Use, Intent-Bindung, Lazy-Sweep, Reset-Hook). State liegt in der zentralen `state.fourEyesApprovals`-Registry.
- Neues Auth-Modul [`src/auth/principal.ts`](../../../../src/auth/principal.ts): `AuthSuccess.principal` enthält einen HMAC-Fingerprint der tatsächlich vorgelegten Identität (`FIRM_SESSION_SECRET`-keyed, sonst prozesslokaler Zufallsschlüssel). Getrennte Credentials (Admin-/Operator-Token) und getrennte signierte Browser-Sessions liefern unterschiedliche IDs; Tokens/CSRF-Werte/Cookies werden **niemals im Klartext** gespeichert oder geloggt. `actorAuditId()` akzeptiert jetzt auch `Actor`/`Principal`/`AuthSuccess`.
- **Lifecycle:** Live-Promotions und Overrides erfordern `action: "propose"` (Schritt 1, `202` mit `approvalId` + `expiresAt`) und `action: "approve"` (Schritt 2, `consumeFourEyes`). Der direkte Ein-Request-Pfad mit `approvedBy` antwortet `403 FOUR_EYES_REQUIRED`. `consumeFourEyes` verlangt zwingend `approverPrincipalId !== proposerPrincipalId`; gleiche Principals → `403 FOUR_EYES_SAME_PRINCIPAL`, abgelaufene/falsche Tokens → `403 FOUR_EYES_EXPIRED`/`..._WRONG_APPROVAL_ID`/`..._NO_PROPOSAL`. Der Audit-Reason trägt `proposer`, `approver` und `approvalId`.
- **Live-Gate:** `src/app/api/live/transition/route.ts` reicht `principalId`, `principalDistinct` und `approvalId` an `LiveGateService.transition()` weiter. Dessen Vier-Augen-Block (`LIVE_GATE_FOUR_EYES=true`, Human-Gate **und** finaler `LIVE_ENABLED`-Schritt) speichert Principal-Fingerprint + `approvalId` + 15-Minuten-TTL crash-sicher im Venue-State-File und vergleicht **nicht mehr** `approvedBy`-Strings. Neue Fehlercodes: `FOUR_EYES_PRINCIPALS_REQUIRED` (403), `FOUR_EYES_EXPIRED`, `FOUR_EYES_APPROVAL_MISMATCH`; `FOUR_EYES_PENDING` liefert `approvalId`/`expiresAt` als strukturierte `details`. `four-eyes-second` ergänzt die Audit-Kette. `snapshot()` gibt nur noch `approvedBy`/`at`/`expiresAt` heraus — niemals Fingerprint oder `approvalId`.
- **Fail-Closed in `local-open`:** Ohne Token ist `principal.distinct === false`; Vier-Augen-Freigaben scheitern mit `403 FOUR_EYES_PRINCIPALS_REQUIRED` und dem Hinweis, dass getrennte authentifizierte Principals (Tokens/Sessions) nötig sind. Der finale `LIVE_ENABLED`-Schritt ist im Offen-Betrieb generell gesperrt (nach der Legalitätsprüfung, damit illegale Sprünge weiterhin `409` melden).
- Service-Signaturen bleiben abwärtskompatibel (alle neuen Felder optional). Betroffene Unit-Tests wurden sauber migriert (`tests/liveGate.states.test.ts` übergibt jetzt Principal-IDs und `approvalId`; `tests/liveGate.api.test.ts` holt die Clear-Nonce).

### 3. `GET|POST /api/live/kill` repariert

- Neues Modul [`src/lib/killSwitchNonce.ts`](../../../../src/lib/killSwitchNonce.ts) mit `issueKillNonce()` / `consumeKillNonce()` (60 s TTL, single-use, eigener Nonce-Pool getrennt von `/api/firm/kill`).
- `POST` parst den Body **zuerst sicher** (`Content-Length` + tatsächliche UTF-8-Länge ≤ 8 KiB, `JSON.parse`, flaches Objekt, kein Array/`null`) und unterscheidet strikt `action`:
  - `arm` (Default im Notfallpfad): `requirePermission(req, "firm.kill") ?? checkCsrfGuard(req)` — **Operator und Admin** dürfen sofort ziehen, ohne Nonce.
  - `clear`: `requirePermission(req, "live.gate") ?? checkCsrfGuard(req) ?? checkCredentialRateLimit(req)` (nur Admin) **plus** Pflicht-`consumeKillNonce(body.nonce)` → `400 NONCE_REQUIRED`/`NONCE_EXPIRED`, `403 NONCE_REPLAYED`. Unbekannte `action` → `400 UNKNOWN_ACTION`.
- `GET /api/live/kill` stellt die Einmal-Challenge aus (`live.gate` + CSRF, `Cache-Control: private, no-store`).
- Der Audit-Akteur für `kill`/`clearKill` stammt aus `actorAuditId(auth.principal)` der verifizierten Auflösung (`operator` / `admin`) statt aus ungeprüftem Freitext.
- Client-Contract in `src/lib/liveGate.ts` angepasst (`fetchLiveGateKillChallenge()`, `action`/`nonce`, `approvalId`).

### 4. Inventare & Tracking

- `npm run docs:inventories` aktualisiert `docs/generated/route-inventory.md`: `/api/firm/lifecycle` (`POST`) weist jetzt `requirePermission(firm.write) + … + CSRF` aus, `/api/live/kill` hat `GET` (`live.gate` + CSRF) und `POST` (`live.gate` + `firm.kill` + CSRF).
- Status in dieser Datei, `README.md`, `remediation/TRACKING.md` und `docs/security/README.md` auf `FIXED` gesetzt; Änderungen zusätzlich in `CHANGELOG.md` und `docs/LIVE_TRADING.md` dokumentiert.

## Akzeptanzkriterien / Verifikation

- [x] Ein Operator mit gültigem `FIRM_API_TOKEN` und gefälschtem Header `x-admin-token: <invalid>` erhält bei Admin-Lifecycle-Übergängen `403` und wird im Audit als `api:operator` geführt (nie `admin`).
- [x] Ein Operator kann `POST /api/live/kill` mit `action: "arm"` auslösen (`200`), ein Viewer erhält `403`; `clear` ist für Operatoren `403`; ein Admin erhält ohne oder mit wiederverwendeter Nonce `400`/`403`, mit frischer Nonce aus `GET /api/live/kill` `200`.
- [x] Eine Live-Promotion bzw. `LiveGate`-Transition nach `LIVE` mit identischem authentifiziertem Principal für Antrag und Gegenzeichnung wird abgewiesen — auch bei unterschiedlichen Body-Namen (`alice`/`bob`). Zwei getrennte authentifizierte Principals bestehen den 2-Schritt-Flow (`200`).
- [x] `local-open` scheitert bei Vier-Augen-Live-Freigaben fail-closed mit klarer Fehlermeldung.
- [x] Regressionstest `tests/asa02.lifecycleAndLiveKillAuthz.test.ts` + `npm run typecheck` + `npm run lint` + `npm run docs:inventories:check` + `npm run docs:validate` + `npm test` grün.
