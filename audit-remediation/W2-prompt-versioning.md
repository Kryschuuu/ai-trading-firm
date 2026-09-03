# W2 — Prompt-Änderungen haben keine Versions-/Optimistic-Lock-Kontrolle

- **Severity:** MEDIUM
- **Bereich:** Workshop
- **Status (validiert):** ✅ **Valide.**
- **Datei(en):** `src/app/api/firm/agents/route.ts` (PUT L47), `src/db/schema.ts` (`agents` Tabelle)

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

## Beweis (aktueller Code)

`src/app/api/firm/agents/route.ts` L44‑48:

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

- [ ] `agents.version` existiert und wird bei jedem Update inkrementiert.
- [ ] Falsche `expectedVersion` → 409; korrekte → Erfolg + neue Version im Response.
- [ ] PromptPanel zeigt Konflikt und lädt neu.

## Changelog-Blurb

`W2 (MEDIUM): Prompt-Editor ohne Versionskontrolle — Optimistic Lock (version-Spalte + 409 bei
Konflikt) gegen stilles Überschreiben von Trading-Agent-Prompts.`

## Versions-Hinweis

PATCH (`1.36.3`) — additive DB-Spalte (`agents.version`), abwärtskompatibel.
