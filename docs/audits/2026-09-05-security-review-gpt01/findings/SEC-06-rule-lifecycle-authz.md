# SEC-06 — Rule-Lifecycle benötigt keine spezifische Privilegstufe

- **ID:** SEC-06
- **Severity:** MEDIUM
- **Bereich:** AuthZ / Governance
- **Quelle:** Security Review-GPT_01.md, Kapitel SEC-06 — Rule-Lifecycle benötigt keine spezifische Privilegstufe
- **Status:** OPEN
- **Fix-Version:** -
- **Datei(en):** `src/app/api/firm/rules/route.ts`, `src/app/api/firm/rules/[id]/route.ts`, `src/auth/permissions.ts`, `src/lib/ruleService.ts`
- **Peer-Review-Patch:** TBD

## Beschreibung

Die Rollenmatrix enthält:

```text
operator:
  firm.write
  firm.kill
  firm.config
  broker.test

admin zusätzlich:
  broker.credentials
  routing.modes.write
  live.gate
```

Die Rule-APIs verlangen jedoch lediglich `guardWrite(req)` und lassen damit einen Benutzer mit `firm.write` unter anderem:

- Regeln anlegen,
- Regeln aktivieren (`activate` inkl. `POST /api/firm/rules` mit `activate: true`),
- Regeln pausieren,
- Regeln archivieren,
- Regeln zurückrollen,
- Regeln ablehnen.

Das widerspricht zumindest teilweise der im Rule-Service beschriebenen Governance-Idee, wonach Aktivierung eine explizite, auditierte Handlung sein soll.

Echtes Autorisierungsproblem, falls Operator nicht strategische Governance besitzen soll.

## Beweis / PoC

```ts
// src/auth/permissions.ts — Operator hat firm.write, aber keine Rule-spezifische Permission
const OPERATOR_PERMISSIONS = [..., "firm.write", "firm.kill", "firm.config", "broker.test"];

// src/app/api/firm/rules/[id]/route.ts
const denied = guardWrite(req); // nur firm.write
switch (body.action) {
  case "activate":
  case "pause":
  case "archive":
  case "rollback":
  case "reject":
}
```

Erwartet (Governance): activate/rollback/archive nur Admin.  
Tatsächlich: jeder Actor mit `firm.write`.

## Remediation (aus Audit + eigene Bewertung)

Eigene Permissions einführen:

```text
strategy.rules.write
strategy.rules.activate
strategy.rules.rollback
```

Beispiel:

```text
viewer   -> read
operator -> create/edit/pause
admin    -> activate/rollback/archive
```

Noch besser: Aktivierung einer Regel und insbesondere Rollback nur mit einem expliziten Governance-Gate.

## Akzeptanzkriterien / Tests

- [ ] Operator darf Draft anlegen / pausieren, nicht aktivieren/rollback/archivieren
- [ ] Admin darf activate/rollback/archive
- [ ] Viewer: 403 auf alle Rule-Writes
- [ ] Permission-Katalog und Tests (`rbac` / Rule-API) decken die Matrix ab
- [ ] `guardWrite` allein reicht nicht mehr für activate/rollback

## Changelog-Blurb

```
SEC-06 (MEDIUM): Rule-Lifecycle — eigene Permissions für write/activate/rollback statt nur firm.write
```

## Versions-Hinweis

PATCH, vor echter Multi-Role-Nutzung.
