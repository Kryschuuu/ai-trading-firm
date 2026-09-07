# SEC-05 — Fälschbare Akteurs-/Rollenattribution bei Rule-Änderungen

- **ID:** SEC-05
- **Severity:** MEDIUM
- **Bereich:** AuthZ / Audit-Integrität
- **Quelle:** Security Review-GPT_01.md, Kapitel SEC-05 — Fälschbare Akteurs-/Rollenattribution bei Rule-Änderungen
- **Status:** FIXED (Resolved)
- **Fix-Version:** v1.36.33; Nachprüfung und Ergänzung in v1.36.34 (2026-09-06)
- **Datei(en):** `src/app/api/firm/rules/[id]/route.ts`, `src/app/api/firm/rules/route.ts`, `src/lib/{ruleActor,ruleEngine,ruleService,macroCycle,auditView}.ts`
- **Initialer Fix:** [PR #117](https://github.com/Kryschuuu/ai-trading-firm/pull/117)
- **Nachprüfungs-/Ergänzungs-Commit:** [57fec8f](https://github.com/Kryschuuu/ai-trading-firm/commit/57fec8f08c7de8ac556fe842db04ff2cce978842)

## Beschreibung (vor v1.36.33)

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
- [x] Audit-Attribution stammt ausschließlich aus `resolveAuth` / Session-Actor (`actor.auditId`)
- [x] Test: Operator sendet `"by": "ADMIN"` → Request wird abgewiesen; Attribution bleibt Operator-`auditId`
- [x] `sourceRole` nicht client-steuerbar (Top-Level und verschachtelt in `rule`)
- [x] Keine Regression der Rule-Lifecycle-Aktionen

## Initialer Fix (v1.36.33)

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

## Nachprüfung und Ergänzung (v1.36.34)

Bei der SEC-06-Nachprüfung wurden nicht nur abgewiesene Requests, sondern auch
**erfolgreiche** Mutationen bis zum Audit-Transport getestet. Dabei zeigte sich:
Der initiale Fix schützte die Lifecycle-Attribution, aber `RULE_CREATED` erhielt
noch keinen verifizierten Ersteller. Der allgemeine `actorAuditId`-Helper bot
zudem einen für Rule-Mutationen ungeeigneten Admin-Fallback; die verschachtelte
Attributionsprüfung fehlte im Lifecycle-Handler (dort zuvor ignorierte Felder,
keine zusätzliche Rollenübernahme).

[57fec8f](https://github.com/Kryschuuu/ai-trading-firm/commit/57fec8f08c7de8ac556fe842db04ff2cce978842) schließt diese Restlücken:

- Erstellung und optionale Aktivierung verwenden denselben verifizierten
  Request-Akteur. `upsertRuleSpec` und alle mutierenden Lifecycle-Funktionen
  verlangen einen expliziten `by`-Parameter. Interne Erzeuger übergeben ihren
  Systemakteur; API-Aufrufer ausschließlich `ruleActor(req)`.
- `ruleActor` nutzt `resolveAuth` direkt und bricht bei fehlender Authentifizierung
  vor jeder Mutation ab. Ein fehlender Actor wird niemals zu `admin`.
- API-Erstellung erzwingt sowohl `sourceRole=MANUAL` als auch `sourceMode=MANUAL`.
  `RULE_CREATED` protokolliert `by`, die Audit-Anzeige zeigt ihn getrennt von der
  Herkunftsrolle. Historische Audit-Einträge bleiben unverändert.
- Top-Level und `rule` werden in beiden Rule-POSTs konsistent auf `by`, `actor`
  und `sourceRole` geprüft, einschließlich leerer/falsy Werte.
- `tests/sec06.ruleLifecycleAuthz.test.ts` prüft erfolgreiche Erstellung und alle
  Lifecycle-Aktionen für Header, Bearer und Session bis zur gespeicherten
  Attribution. Die 17 ursprünglichen SEC-05-Tests bleiben bestehen; zusammen mit
  den 72 neuen SEC-06-/Nachprüfungstests laufen sie nun verpflichtend im
  `test:security:auth`-Gate (zuvor nur in der regulären Unit-Suite).

Die neue aktionsbezogene Rechteprüfung und die dokumentierte effektive
Rollenmatrix stehen im [SEC-06-Finding](SEC-06-rule-lifecycle-authz.md).

## Changelog-Blurb

```
SEC-05 (MEDIUM): Rule-Audit — Actor/by ausschließlich serverseitig aus authentifiziertem Credential
```

## Versions-Hinweis

PATCH — initial v1.36.33; vollständige Erstellungsattribution und Nachprüfung in v1.36.34.
