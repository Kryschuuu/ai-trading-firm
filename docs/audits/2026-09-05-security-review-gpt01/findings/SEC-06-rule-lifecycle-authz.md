# SEC-06 — Rule-Lifecycle benötigt keine spezifische Privilegstufe

- **ID:** SEC-06
- **Severity:** MEDIUM
- **Bereich:** AuthZ / Governance
- **Quelle:** Security Review-GPT_01.md, Kapitel SEC-06 — Rule-Lifecycle benötigt keine spezifische Privilegstufe
- **Status:** FIXED (Resolved)
- **Fix-Version:** v1.36.34 (2026-09-06)
- **Datei(en):** `src/app/api/firm/rules/route.ts`, `src/app/api/firm/rules/[id]/route.ts`, `src/app/api/firm/macro/route.ts`, `src/auth/{types,permissions,index}.ts`, `src/lib/{ruleActor,ruleService,macroCycle,auditView}.ts`
- **Fix-Commit:** [57fec8f](https://github.com/Kryschuuu/ai-trading-firm/commit/57fec8f08c7de8ac556fe842db04ff2cce978842)
- **Red-Test-Commit:** [0c83fbd](https://github.com/Kryschuuu/ai-trading-firm/commit/0c83fbd4f54fb2edf47d789b0e8759fca413dc29)

## Beschreibung (vor v1.36.34)

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

- [x] Operator darf Draft anlegen / pausieren, nicht aktivieren/rollback/archivieren
- [x] Admin darf activate/rollback/archive
- [x] Viewer: 403 auf alle Rule-Writes
- [x] Permission-Katalog und Tests (`rbac` / Rule-API) decken die Matrix ab
- [x] `guardWrite` allein reicht nicht mehr für activate/rollback

## Fix und Nachprüfung (v1.36.34)

**Root Cause:** Allgemeine Firm-Schreibrechte wurden als strategische
Governance-Freigabe behandelt. Die Service-Transaktionen schützen die
Zustandskonsistenz, ersetzen aber keine aktionsbezogene HTTP-Autorisierung.
Das betraf beide Rule-Endpunkte, einschließlich kombinierter Erstellung und
Aktivierung. Die Prüfung aller Aufrufer ergab außerdem einen manuellen
Makro-Einstieg, der Regeln aktivieren kann und deshalb dieselbe Freigabe braucht.

**Umsetzung:**

- Permission-Katalog und Rollenmatrix trennen `strategy.rules.write` von
  `strategy.rules.activate`, `strategy.rules.rollback` und
  `strategy.rules.archive`. Die zentrale `RULE_ACTION_PERMISSIONS`-Zuordnung
  ist vollständig, unbekannte Actions fallen niemals auf ein allgemeines Recht
  zurück. Operator: Drafts anlegen/versionieren, ACTIVE pausieren, DRAFT ablehnen.
  Admin: zusätzlich aktivieren, zurückrollen und archivieren.
- Beide Rule-POSTs nutzen die zentrale `requirePermission`-Auflösung und
  behalten `checkRateLimit`. Header, Bearer und signierte Sessions sind
  gleichwertig; ein echtes Admin-Credential wird nicht vom Legacy-Operator-
  Token-Guard blockiert. Freigaben werden vor Rule-Lookups und vor dem Upsert
  geprüft, auch bei idempotenten Requests und unbekannten IDs.
- Request-Strukturen, Actions und das optionale Boolean `activate` werden
  eindeutig validiert. Fehlerhafte Typen können weder eine andere Aktion
  auswählen noch vor der Ablehnung Daten verändern. Bestehende 404/409-
  Service-Ergebnisse bleiben für berechtigte Requests erhalten.
- `POST /api/firm/macro` verlangt unabhängig vom Human-Approval-Flag
  `strategy.rules.activate`. Backtests und der Mikro-Executor können keine
  Rule-Lifecycle-Mutation auslösen. Der interne Scheduler bleibt ein
  vertrauenswürdiger Systemakteur mit unveränderter serverseitiger
  `REQUIRE_HUMAN_APPROVAL`-Policy; keine neue Trading-Logik.
- SEC-05 erneut geprüft und ergänzt: `RULE_CREATED` trägt den verifizierten
  API-Akteur (auch in der Audit-Anzeige), API-Herkunft ist `MANUAL`.
  Mutierende Service-Funktionen verlangen explizite Attribution;
  `ruleActor` hat keinen Admin-Fallback. Attributionsfelder werden auch im
  verschachtelten Lifecycle-Body abgewiesen. Details im
  [SEC-05-Finding](SEC-05-rule-actor-attribution.md).

**Betriebsgrenze:** Die Matrix bezieht sich auf die effektive Rolle. Echte
Multi-Role-Nutzung erfordert verschiedene Admin-/Operator-Credentials.
Ohne `FIRM_ADMIN_TOKEN` bleibt der Operator gemäß bestehender Architektur
Single-Admin. Bewusstes `local-open` bleibt lokal-administrativ; beide Modi
werden ausdrücklich getestet und sind keine Rollen-Isolation.

**Regressionen und Nachweis:**

- [0c83fbd](https://github.com/Kryschuuu/ai-trading-firm/commit/0c83fbd4f54fb2edf47d789b0e8759fca413dc29) enthält die Tests **vor** dem Produktionsfix: 56 von 66 rot,
  darunter unzulässige Lifecycle-Mutationen mit HTTP 200 statt 403.
- [57fec8f](https://github.com/Kryschuuu/ai-trading-firm/commit/57fec8f08c7de8ac556fe842db04ff2cce978842) behebt die Pfade und erweitert die Suite auf 72 Tests
  (`tests/sec06.ruleLifecycleAuthz.test.ts`). Zusammen mit den 17 bestehenden
  SEC-05-Tests prüfen sie echte Handler und echten Rule-Service, mit ersetzten
  DB-/Audit-Transporten an den vorhandenen Test-Hooks. Kein Skip, keine echte
  LLM-/Broker-/PostgreSQL-Verbindung.
- Abgedeckt: Rollen-/Credential-Matrix, erlaubte Mutation samt Audit,
  verweigerte Mutation ohne jeden DB-Zugriff, Create-and-activate in beiden
  Request-Formaten, Versionierung/Idempotenz, Typ-/Prototyp-/Claim-Manipulation,
  fehlende Credentials, Status-/DB-Fehler, Rate-Limit, Makro-Einstieg und
  Credential-Wechsel nach Single-Admin-Login.
- Beide Security-Suites sind in `npm run test:security:auth` eingebunden und
  laufen damit verbindlich in `security-live-gate` vor dem Suite-Stamp.

### Lokale Validierung (2026-09-06)

- `npm test`: **1.965 bestanden, 0 fehlgeschlagen**; 7 bestehende PostgreSQL-
  Integrationstests gemäß Repo-Konvention ohne Datenbank übersprungen.
- `npm run test:security:auth`: **195 bestanden, 0 Skips**, einschließlich
  aller SEC-05-/SEC-06-Regressionen.
- `npm run security:live-gate`: bestanden, Live-Gate-Zeilen-Coverage
  **95,68 %** (Tor: mindestens 95 %).
- `npm run typecheck`, `npm run lint`, `npm run build`, `npm run docs:validate`:
  bestanden. Build-Warnungen zur dynamischen Dateiverfolgung in unveränderten
  Modulen bleiben bestehen; kein Build-Fehler.
- `npm audit --audit-level=high`: **0 Funde**; `npm ls ws --all`, Frontend-
  Secret-Scan und Live-Gate-Secret-Scan bestanden. Workflow-Spiegel unverändert
  byte-identisch. GitHub-Läufe für den Release-Head sind vor PR-Erstellung
  zusätzlich erforderlich; lokale Ergebnisse ersetzen sie nicht.

## Changelog-Blurb

```
SEC-06 (MEDIUM): Rule-Lifecycle — operative Regelpflege und administrative Governance durch eigene Permissions getrennt (v1.36.34)
```

## Versions-Hinweis

PATCH — behoben in v1.36.34, vor echter Multi-Role-Nutzung ausrollen. Keine neue Abhängigkeit oder Migration.
