# SEC-01 — Privilege Escalation

- **ID:** SEC-01
- **Severity:** CRITICAL
- **Bereich:** Auth / RBAC / Control Plane
- **Quelle:** Security Review-GPT_01.pdf, Kapitel Privilege Escalation (aus Aufgabenstellung)
- **Status:** OPEN
- **Fix-Version:** -
- **Datei(en):** `src/lib/apiAuth.ts`, `src/lib/controlPlane.ts`, `src/app/api/firm/kill/route.ts`, `src/app/api/brokers/*/credentials/route.ts`
- **Peer-Review-Patch:** TBD — verlinken sobald Patch in `docs/peer-reviews/` existiert

## Beschreibung

Kritisches Finding aus Security-Audit 2026-09-05: Privilege Escalation — ein niedriger privilegierter Akteur (z. B. Operator oder Viewer) kann Aktionen ausführen, die Admin-Rechte erfordern (z. B. Kill-Switch disarmen, Credentials speichern, Live-Gate öffnen).

Mögliche Vektoren (aus Aufgabenstellung + Code-Review):
- `guardWrite` vs. `requirePermission` nicht konsistent
- Disarm des Kill-Switch erfordert ADMIN, aber andere kritische Endpunkte prüfen nur Operator
- Credential-Endpoints ohne strikte Permission-Prüfung

## Beweis / PoC

```http
# Beispiel-PoC (aus PDF extrahieren und hier dokumentieren)
POST /api/firm/kill
Authorization: Bearer <operator-token>
{ "arm": false, "nonce": "..." }
# Erwartet: 403 FORBIDDEN (nur ADMIN)
# Tatsächlich (falls verwundbar): 200 OK
```

Code-Auszug prüfen:

```ts
// src/app/api/firm/kill/route.ts
// Arm: guardWrite (Operator ok)
// Disarm: requirePermission(req, "live.gate") (ADMIN) + CSRF + Nonce
// → Ist das überall so? Andere Endpunkte prüfen?
```

## Remediation (aus Audit + eigene Bewertung)

1. **Alle schreibenden Endpunkte auditieren:** `grep -R "guardWrite\|requirePermission" src/app/api/`
2. **Matrix erstellen:** Endpunkt → erforderliche Permission (viewer/operator/admin)
3. **Fix:** Wo `guardWrite` steht aber `live.gate` oder `broker.credentials` nötig wäre, auf `requirePermission(req, "live.gate")` bzw. `"broker.credentials"` umstellen
4. **Tests:** `tests/rbac.test.ts` erweitern — Operator darf nicht disarmen, Viewer darf nicht schreiben

Referenz: Fix für C3 in `docs/audits/2026-09-03-peer-review/findings/C3-kill-disarm.md` (Disarm stärker als Arm) — gleiches Prinzip auf andere Endpunkte anwenden.

## Akzeptanzkriterien / Tests

- [ ] Alle kritischen Endpunkte (`/kill`, `/brokers/*/credentials`, `/live/*`, `/firm/agents`) prüfen Permission explizit
- [ ] Test: Operator-Token → `POST /api/firm/kill {arm:false}` → 403
- [ ] Test: Viewer-Token → `POST /api/brokers/[venue]/credentials` → 403
- [ ] `rbac.test.ts` deckt neue Matrix ab
- [ ] Keine Regression: Operator darf weiterhin arming, aber nicht disarming

## Changelog-Blurb

```
SEC-01 (CRITICAL): Privilege Escalation — RBAC für kritische Endpunkte gehärtet
```

## Versions-Hinweis

PATCH, Security-Fix → `v1.36.26` (Beispiel).
