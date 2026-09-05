# W2 — Prompt-Änderungen haben keine Versions-/Optimistic-Lock-Kontrolle

- **Severity:** MEDIUM
- **Bereich:** Workshop
- **Status (validiert):** ✅ **Gefixt v.1.36.24** — siehe `CHANGELOG.md`,
  `docs/AUDIT_REMEDIATION_2026-09.md` und `tests/w2.promptVersioning.test.ts`
  (Validator-Unit, Statik-Greps, DB-gegatete Akzeptanz: Zwei-PUTs-Szenario,
  Folge-Write mit neuer Version, verpasste/fehlende Version).
- **Datei(en):** `src/app/api/firm/agents/route.ts` (PUT), `src/db/schema.ts` (`agents` Tabelle), `src/lib/workshop.ts`, `src/components/workshop/PromptPanel.tsx`

## Arena-Prompt (kopierbar)

```
TASK: Add optimistic concurrency (version column) to agent prompt edits.

PROBLEM: PUT /api/firm/agents does `db.update(agents).set({ systemPrompt, updatedAt: new Date() })`
with no version check. Two browsers editing the same agent silently overwrite each other (last-write-wins).

DO:
1. Add to the `agents` table (src/db/schema.ts):
     version: integer("version").notNull().default(1),
   then `npx drizzle-kit generate` + `npx drizzle-kit push` (additive, no break).
2. In PUT /api/firm/agents, read the current `version`, require the client to send `expectedVersion`,
   and perform an optimistic-lock update:
     const updated = await db.update(agents)
       .set({ systemPrompt, updatedAt: new Date(), version: sql`${agents.version} + 1` })
       .where(and(eq(agents.id, agentId), eq(agents.version, expectedVersion)))
       .returning();
     if (updated.length === 0) return 409 CONFLICT with current version.
3. Return the new version in the response. Update FirmDashboard PromptPanel to track the loaded
   version and, on 409, reload the current prompt + version and show "Konflikt: neu laden".
4. Keep the audit log entry (AGENT_PROMPT_UPDATED) on success.

ACCEPTANCE: Two concurrent PUTs with the same expectedVersion -> exactly one succeeds, one gets 409;
the winning write increments version; UI recovers from 409 by reloading.
```

## Beweis (Code vor v1.36.24)

`src/app/api/firm/agents/route.ts` L44‑48 (vor dem Fix):

```ts
const updated = await db
  .update(agents)
  .set({ systemPrompt, updatedAt: new Date() })
  .where(eq(agents.id, agentId))
  .returning();
```
(`agents` hat keine `version`-Spalte — nur `updatedAt`.)

## Fix-Spezifikation

`UPDATE ... SET system_prompt=$new, version=version+1 WHERE id=$id AND version=$expected;` bei
0 rows → 409 CONFLICT, UI lädt neu (siehe Audit W2).

## Akzeptanzkriterien / Tests

- [x] `agents.version` existiert und wird bei jedem Update inkrementiert.
- [x] Falsche `expectedVersion` → 409; korrekte → Erfolg + neue Version im Response.
- [x] PromptPanel zeigt Konflikt und lädt neu.

## Umsetzung (v1.36.24)

**`src/db/schema.ts`:** `agents` trägt jetzt
`version: integer("version").notNull().default(1)` — additiv, der Default hält
Alt-Installationen abwärtskompatibel bei 1. Migration als idempotente
SQL-Datei `drizzle/2026-09-05_w2_agents_version.sql`
(`ALTER TABLE "agents" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;`),
äquivalent zu `npx drizzle-kit generate` + `push`.

**`src/lib/workshop.ts`:** `PromptInput` erweitert um `expectedVersion`; der
Client MUSS die beim Laden gesehene Version mitsenden (fehlende/0/negative/
Dezimal-Werte ⇒ 400, String-Zahlen werden normalisiert).

**`src/app/api/firm/agents/route.ts`:** Optimistic-Lock-Update
(`SET system_prompt, updated_at, version = version + 1` mit
`WHERE id = agentId AND version = expectedVersion`, `.returning()`).
0 betroffene Zeilen ⇒ **409 CONFLICT** mit `currentVersion` (und `hint`
„Neu laden…“); Erfolg liefert die neue Version als `version` im Body. Der
`AGENT_PROMPT_UPDATED`-Audit bleibt über den S1-Pfad (v1.36.18) erhalten.

**`src/components/workshop/PromptPanel.tsx`:** sendet
`expectedVersion: agent.version ?? 1`, zeigt die Version im Agent-Kopf
(„Modell … · Version n“) und erholt sich bei 409: lokalen Entwurf verwerfen
(`setDraft(null)`), Firmzustand neu laden (`onChanged()`), Meldung
„Konflikt: neu laden — der Prompt wurde inzwischen von jemand anderem
geändert (aktuelle Version n), der fremde Stand wird eingeblendet“. Nach dem
Speichern zeigt die Erfolgsmeldung die neue Versionsnummer.

**Tests:** `tests/w2.promptVersioning.test.ts` — Validator-Unit + Statik-Greps
(Schema/Migration/Route/UI) laufen immer; der DB-Akzeptanztest skippt nach
Repo-Konvention ohne erreichbare PostgreSQL (zwei PUTs mit derselben
`expectedVersion` ⇒ einer 200 mit Version+1, einer 409 inkl. `currentVersion`;
Folge-PUT mit der neuen Version ⇒ 200; verpasste Version ⇒ 409; fehlende ⇒ 400;
zwei Agenten derselben Version ⇒ nur der richtige wird aktualisiert).
`tests/workshop.test.ts` trägt die neue Pflicht und ihre Ablehnungsfälle.

## Changelog-Blurb

`W2 (MEDIUM): Prompt-Editor ohne Versionskontrolle — Optimistic Lock (version-Spalte + 409 bei
Konflikt) gegen stilles Überschreiben von Trading-Agent-Prompts.`

## Versions-Hinweis

PATCH (`1.36.24`) — additive DB-Spalte (`agents.version`), abwärtskompatibel.
