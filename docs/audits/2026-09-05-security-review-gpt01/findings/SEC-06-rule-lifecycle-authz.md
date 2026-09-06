# SEC-06 — Rule-Lifecycle benötigt keine spezifische Privilegstufe

- **ID:** SEC-06
- **Severity:** MEDIUM
- **Bereich:** AuthZ / Governance
- **Quelle:** Security Review-GPT_01.md, Kapitel SEC-06 — Rule-Lifecycle benötigt keine spezifische Privilegstufe
- **Status:** Fixed / Resolved
- **Fix-Version:** 1.36.33
- **Fix-Commit / PR:** `arena/01a078d8-ai-trading-firm` — Fix: Neue Governance-Permissions (`strategy.rules.*`) + explizite `requirePermission`-Prüfung in Rule-APIs
- **Datei(en):** `src/auth/types.ts`, `src/auth/permissions.ts`, `src/app/api/firm/rules/route.ts`, `src/app/api/firm/rules/[id]/route.ts`, `tests/rbac.test.ts`, `tests/sec06.ruleLifecycleAuthz.test.ts`
- **Peer-Review-Patch:** Implementiert und validiert (Tests: `tests/sec06.ruleLifecycleAuthz.test.ts`: 7/7 grün; `tests/rbac.test.ts`: 4 neue SEC-06-Tests grün; `npm run test:security:auth`: 106 Pass)

## Root Cause (zusammengefasst vor Fix)

Die Regel-APIs (`POST /api/firm/rules` und `POST /api/firm/rules/[id]`) verwendeten ausschließlich `guardWrite(req)`, das nur auf `firm.write` prüft. Es fehlte jede feingranulare Autorisierung für Governance-Aktionen (`activate`, `rollback`, `archive`). Dadurch konnte ein Operator (`firm.write`) strategische Governance-Aktionen durchführen, die laut Architektur nur der Admin-Rolle vorbehalten sein sollten.

## Behobene Schwachstelle

- Neue Permissions `strategy.rules.write`, `strategy.rules.activate`, `strategy.rules.rollback`, `strategy.rules.archive` als Admin-only-Permissions eingeführt.
- `POST /api/firm/rules` prüft zusätzlich `requirePermission(req, "strategy.rules.activate")` wenn `body.activate` gesetzt ist.
- `POST /api/firm/rules/[id]` prüft explizit für jede Aktion (`activate` → `strategy.rules.activate`, `rollback` → `strategy.rules.rollback`, `archive` → `strategy.rules.archive`, `pause`/`reject` → `firm.write`).
- `guardWrite(req)` bleibt als Basisschutz erhalten (verhindert unauthentifizierte Zugriffe + Rate-Limit), reicht aber allein nicht mehr für Governance-Aktionen.

## Akzeptanzkriterien / Tests (Status: alle erfüllt)

- [x] Operator darf Draft anlegen / pausieren, nicht aktivieren/rollback/archivieren
- [x] Admin darf activate/rollback/archive
- [x] Viewer: 403 auf alle Rule-Writes und Governance-Aktionen
- [x] Permission-Katalog (`rbac` / Rule-API) deckt die Matrix ab (`tests/rbac.test.ts`: neue Permissions nur bei Admin; `tests/sec06.ruleLifecycleAuthz.test.ts`: Matrix, Operator-403, Admin-Null, Viewer-403)
- [x] `guardWrite` allein reicht nicht mehr für activate/rollback (`tests/sec06.ruleLifecycleAuthz.test.ts`: Operator `body.activate` → 403)

## Changelog-Blurb

```
SEC-06 (MEDIUM): Rule-Lifecycle — eigene Permissions (strategy.rules.write/.activate/.rollback/.archive) für Governance-Aktionen; Operator (firm.write) kann nicht mehr aktivieren/rollbacken/archivieren; Admin behält Governance vor; Tests und RBAC-Matrix abgedeckt (v1.36.33).
```

## Versions-Hinweis

PATCH (v1.36.33). Keine neuen Pflicht-Variablen, kein Schema-Bruch, kein Breaking Change. Upgrade: `git pull` → `npm ci` → `npm run build` → Dienst neu starten.
