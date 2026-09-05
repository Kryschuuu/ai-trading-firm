# SEC-05 — Fälschbare Akteurs-/Rollenattribution bei Rule-Änderungen

- **ID:** SEC-05
- **Severity:** MEDIUM
- **Bereich:** AuthZ / Audit-Integrität
- **Quelle:** Security Review-GPT_01.md, Kapitel SEC-05 — Fälschbare Akteurs-/Rollenattribution bei Rule-Änderungen
- **Status:** OPEN
- **Fix-Version:** -
- **Datei(en):** `src/app/api/firm/rules/[id]/route.ts`, `src/app/api/firm/rules/route.ts`, `src/lib/ruleService.ts`
- **Peer-Review-Patch:** TBD

## Beschreibung

Bei `POST /api/firm/rules/[id]` wird die Authentifizierung nur über `guardWrite(req)` durchgeführt. Danach wird ein vom Client gelieferter Wert `by?: string` übernommen und an die Rule-Service-Funktionen weitergereicht:

```text
activateRule(id, body.by ?? "API")
pauseRule(id, body.by ?? "API")
archiveRule(id, body.by ?? "API")
rollbackRule(id, body.by ?? "API")
rejectRule(id, ..., body.by ?? "API")
```

Das Service-Modul schreibt diesen `by`-Wert anschließend als Audit-Attribution.

Damit kann ein Operator im Request `"by": "ADMIN"` angeben. Die tatsächliche Authentizität des Requests bleibt davon unberührt.

Zusätzlich übernimmt `POST /api/firm/rules` `sourceRole` aus dem Client (`CEO` | `RESEARCH` | `MANUAL`).

Der Angreifer erhält keine zusätzlichen Rechte, aber der Audit-Trail wird semantisch unzuverlässig, forensisch schwächer und für Incident Response manipulierbar. Bei einem Trading-System ist später nicht mehr eindeutig feststellbar, **wer eine Strategieänderung wirklich ausgelöst hat**.

## Beweis / PoC

```http
POST /api/firm/rules/<id>
Authorization: Bearer <operator-token>
{ "action": "activate", "by": "ADMIN" }
```

```ts
// src/app/api/firm/rules/[id]/route.ts
const denied = guardWrite(req);
const body = await req.json() as { action?: string; by?: string; reason?: string };
outcome = await activateRule(id, body.by ?? "API");
```

Erwartet: Audit-`by` = serverseitiger Actor (`auditId` aus Session/Token).  
Tatsächlich: beliebiger Client-String.

## Remediation (aus Audit + eigene Bewertung)

`by` vollständig aus dem externen API-Contract entfernen.

```ts
const actor = resolveAuth(req).actor;
const actorId = actor.auditId;
await activateRule(id, actorId);
```

Auch `sourceRole` nicht aus dem Client übernehmen.

## Akzeptanzkriterien / Tests

- [ ] Request-Feld `by` wird ignoriert bzw. abgelehnt
- [ ] Audit-Attribution stammt ausschließlich aus `resolveAuth` / Session-Actor
- [ ] Test: Operator sendet `"by": "ADMIN"` → Log zeigt Operator-`auditId`
- [ ] `sourceRole` nicht client-steuerbar
- [ ] Keine Regression der Rule-Lifecycle-Aktionen

## Changelog-Blurb

```
SEC-05 (MEDIUM): Rule-Audit — Actor/by ausschließlich serverseitig aus authentifiziertem Credential
```

## Versions-Hinweis

PATCH, vor echter Multi-Role-Nutzung.
