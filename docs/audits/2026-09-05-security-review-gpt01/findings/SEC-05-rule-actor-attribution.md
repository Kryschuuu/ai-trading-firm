# SEC-05 — Fälschbare Akteurs-/Rollenattribution bei Rule-Änderungen

- **ID:** SEC-05
- **Severity:** MEDIUM
- **Bereich:** AuthZ / Audit-Integrität
- **Quelle:** Security Review-GPT_01.md, Kapitel SEC-05 — Fälschbare Akteurs-/Rollenattribution bei Rule-Änderungen
- **Status:** FIXED (Resolved)
- **Fix-Version:** v1.36.33 (2026-09-06)
- **Datei(en):** `src/app/api/firm/rules/[id]/route.ts`, `src/app/api/firm/rules/route.ts`, `src/lib/ruleActor.ts` (neu), `src/lib/ruleEngine.ts`
- **Peer-Review-Patch:** Branch `arena/01a078c8-ai-trading-firm` (PR gegen `main`)

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

- [x] Request-Feld `by` wird abgelehnt (fail-closed, `400 ACTOR_NOT_CLIENT_CONTROLLED`)
- [x] Audit-Attribution stammt ausschließlich aus `resolveAuth` / Session-Actor (`actorAuditId`)
- [x] Test: Operator sendet `"by": "ADMIN"` → Request wird abgewiesen; Attribution bleibt Operator-`auditId`
- [x] `sourceRole` nicht client-steuerbar (Top-Level und verschachtelt in `rule`)
- [x] Keine Regression der Rule-Lifecycle-Aktionen

## Fix (v1.36.33)

**Root Cause:** Die Route hat eine *Behauptung* des Clients (`body.by`,
`body.sourceRole`) als Identitätsaussage in den Audit-Trail übernommen. Die
Authentifizierung (`guardWrite`) belegte lediglich *dass* jemand schreiben darf,
nicht *wer* schreibt — Authentifizierungsergebnis und Audit-Attribution waren
entkoppelt.

**Umsetzung:**

- Neues Modul `src/lib/ruleActor.ts` als Single Source of Truth:
  `ruleActor(req)` leitet die Attribution ausschließlich aus dem
  authentifizierten Credential ab (`actorAuditId` → `resolveAuth`).
- `rejectClientActorFields()` weist `by`, `actor` und `sourceRole` fail-closed
  mit `400 ACTOR_NOT_CLIENT_CONTROLLED` ab — auf Top-Level und verschachtelt in
  `rule`, vor jedem Datenbankzugriff. Geerbte Prototyp-Felder lösen bewusst
  keinen Fehlalarm aus (`Object.hasOwn`).
- `sanitizeRuleSpec(..., { forceSourceRole: true })` erzwingt für API-erzeugte
  Regeln `MANUAL`; interne Erzeuger (Makro-Zyklus: `RESEARCH`/`CEO`) bleiben
  unverändert.
- Regressionstests: `tests/sec05.ruleActorAttribution.test.ts` (17 Fälle,
  inkl. Angriffsvektoren und Quell-Drift-Check gegen einen Rückfall auf
  `body.by`).

## Changelog-Blurb

```
SEC-05 (MEDIUM): Rule-Audit — Actor/by ausschließlich serverseitig aus authentifiziertem Credential
```

## Versions-Hinweis

PATCH — ausgeliefert als v1.36.33.
