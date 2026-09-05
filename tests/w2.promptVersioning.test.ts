/**
 * W2 (v1.36.24) — Optimistic Lock für Prompt-Änderungen (agents.version).
 *
 * Befund: PUT /api/firm/agents aktualisierte den system_prompt ohne
 * Versionskontrolle — zwei Browser-Edits überschrieben sich still
 * (last-write-wins). Abdeckung:
 *
 *   1. Unit: validatePromptInput erfordert `expectedVersion` (positive
 *      ganze Zahl), normalisiert String-Zahlen.
 *   2. Statik: Schema/Migration/Route/UI tragen die W2-Elemente
 *      (version-Spalte, WHERE version=$expected, 409, expectedVersion im
 *      Body der UI, „Konflikt: neu laden“).
 *   3. DB-gegatet (Repo-Konvention, skippt ohne erreichbare PostgreSQL):
 *      - Zwei PUTs mit derselben expectedVersion ⇒ genau einer gewinnt (200,
 *        Version inkrementiert), der andere erhält 409 inkl. currentVersion.
 *      - Anschließender PUT mit der NEUEN Version ⇒ Erfolg (200).
 *      - Verpasste/falsche Version ⇒ 409; fehlende expectedVersion ⇒ 400.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { db } from "../src/db";
import { agents, auditLog } from "../src/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { validatePromptInput } from "../src/lib/workshop";
import { PUT } from "../src/app/api/firm/agents/route";
import { __resetAllSingletonsForTests } from "../src/lib/stateRegistry";

const UUID = "9b2f0d5a-1111-4222-8333-444455556666";
const PROMPT =
  'Du bist Marktanalystin. Antworte AUSSCHLIESSLICH mit diesem JSON:\n{"type":"TRADE","symbol":"ETH","side":"LONG","stopLossPct":5,"reason":"trend intakt","riskScore":0.4}';

beforeEach(() => {
  __resetAllSingletonsForTests();
});

// ── 1. Unit — Validator ──────────────────────────────────────────────────────

test("validatePromptInput: W2 — expectedVersion ist Pflicht und muss positiv ganzzahlig sein", () => {
  const base = { agentId: UUID, systemPrompt: PROMPT };
  const missing = validatePromptInput(base);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.error, /expectedVersion/);
  for (const bad of [0, -1, 1.5, "x", "", null, undefined]) {
    const res = validatePromptInput({ ...base, expectedVersion: bad });
    assert.equal(res.ok, false, `expectedVersion=${JSON.stringify(bad)} wird abgelehnt`);
    if (!res.ok) assert.match(res.error, /expectedVersion/);
  }
  const str = validatePromptInput({ ...base, expectedVersion: "3" });
  assert.equal(str.ok, true);
  if (str.ok) assert.equal(str.value.expectedVersion, 3, "String-Zahl wird normalisiert");
  const num = validatePromptInput({ ...base, expectedVersion: 7 });
  assert.equal(num.ok, true);
  if (num.ok) assert.equal(num.value.expectedVersion, 7);
  if (num.ok) assert.equal(num.value.systemPrompt, PROMPT);
});

// ── 2. Statik-Akzeptanz ──────────────────────────────────────────────────────

function readSource(rel: string): string {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

test("Akzeptanz: agents.version existiert in Schema (Default 1) + idempotente Migration", () => {
  const schema = readSource("src/db/schema.ts");
  const table = schema.slice(schema.indexOf("export const agents"), schema.indexOf("});", schema.indexOf("export const agents")));
  assert.match(table, /version: integer\("version"\)\.notNull\(\)\.default\(1\)/, "version-Spalte mit Default 1");
  const migration = readSource("drizzle/2026-09-05_w2_agents_version.sql");
  assert.match(migration, /ALTER TABLE "agents" ADD COLUMN "version" integer DEFAULT 1 NOT NULL/);
  assert.match(migration, /idempotente|additiv|kein Bruch/i);
});

test("Akzeptanz: Route macht Optimistic-Lock-Update mit 409 inkl. currentVersion", () => {
  const route = readSource("src/app/api/firm/agents/route.ts");
  assert.match(route, /eq\(agents\.version,\s*expectedVersion\)/, "WHERE enthält Version");
  assert.match(route, /version:\s*sql`\$\{agents\.version\} \+ 1`/, "UPDATE inkrementiert atomar");
  assert.match(route, /status: 409/, "409 bei 0 betroffenen Zeilen");
  assert.match(route, /currentVersion/, "aktuelle Version im 409-Body");
  assert.match(route, /version:\s*updated\[0\]\.version/, "neue Version im Erfolgs-Body");
});

test("Akzeptanz: PromptPanel sendet expectedVersion und erholt sich per Reload", () => {
  const ui = readSource("src/components/workshop/PromptPanel.tsx");
  assert.match(ui, /expectedVersion:\s*agent\.version\s*\?\?\s*1/, "geladene Version wird mitgesendet");
  assert.match(ui, /res\.status === 409/, "409 wird behandelt");
  assert.match(ui, /Konflikt:\s*neu laden/, "Hinweis 'Konflikt: neu laden'");
  assert.match(ui, /setDraft\(null\)/, "eigener Entwurf wird beim Konflikt verworfen");
  assert.match(ui, /onChanged\(\)/, "Firmzustand wird neu geladen");
  const types = readSource("src/lib/types.ts");
  const agentRow = types.slice(types.indexOf("export interface AgentRow"), types.indexOf("}", types.indexOf("export interface AgentRow")) + 1);
  assert.match(agentRow, /version:\s*number/, "AgentRow trägt die Version");
});

// ── 3. DB-gegateter Akzeptanztest ────────────────────────────────────────────

async function dbReachable(): Promise<boolean> {
  try {
    await db.execute(sql`SELECT 1 FROM agents LIMIT 1`);
    return true;
  } catch {
    return false;
  }
}

function putAgent(agentId: string, systemPrompt: string, expectedVersion: unknown): Promise<Response> {
  return PUT(
    new Request("http://localhost/api/firm/agents", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId, systemPrompt, expectedVersion }),
    })
  );
}

test("W2 DB: zwei PUTs mit derselben expectedVersion → einer gewinnt (200), einer erhält 409", async (t) => {
  if (!(await dbReachable())) {
    t.skip("Keine PostgreSQL erreichbar (w2) — DB-Test übersprungen (Repo-Konvention)");
    return;
  }
  const agentId = randomUUID();
  const name = `w2-${randomUUID()}`;
  await db.insert(agents).values({ id: agentId, name, role: "RESEARCH", model: "w2-test", systemPrompt: PROMPT });

  try {
    const body = (r: Response) => r.json() as Promise<Record<string, unknown>>;

    // #1 gewinnt: expectedVersion 1 → 200, Version wird 2.
    const first = await body(await putAgent(agentId, `${PROMPT}\n#1`, 1));
    assert.equal(first.ok, true);
    assert.equal(first.version, 2, "Gewinner-Update inkrementiert auf 2");
    assert.equal((first.agent as { version?: number } | undefined)?.version, 2, "agent im Body trägt neue Version");

    // #2 verliert: er sah noch Version 1 → 409 inkl. currentVersion 2.
    const secondRes = await putAgent(agentId, `${PROMPT}\n#2`, 1);
    const second = await body(secondRes);
    assert.equal(secondRes.status, 409, "zweiter Editor erhält 409");
    assert.equal(second.currentVersion, 2, "409 nennt die aktuelle Version zum Neuladen");
    assert.match(String(second.error ?? ""), /Konflikt/);

    // #3 darf mit der aktuellen Version 2 speichern → 200, Version 3.
    const third = await body(await putAgent(agentId, `${PROMPT}\n#3`, 2));
    assert.equal(third.ok, true);
    assert.equal(third.version, 3, "Version steigt bei jedem Erfolg");

    // Verpasste Version → 409; fehlende Version → 400.
    const stale = await putAgent(agentId, `${PROMPT}\n#4`, 2);
    assert.equal(stale.status, 409, "veraltete expectedVersion → 409");
    const missing = await putAgent(agentId, `${PROMPT}\n#5`, undefined);
    assert.equal(missing.status, 400, "fehlende expectedVersion → 400");

    // DB-Wahrheit: Version steht in der Tabelle.
    const row = (await db.select().from(agents).where(eq(agents.id, agentId)))[0];
    assert.equal(row?.version, 3);
    assert.equal(row?.systemPrompt, `${PROMPT}\n#3`);
  } finally {
    for (const fn of [
      () => db.delete(auditLog).where(eq(auditLog.agentId, agentId)),
      () => db.delete(agents).where(eq(agents.id, agentId)),
    ]) {
      try {
        await fn();
      } catch {
        /* Test-DB darf Toleranz haben */
      }
    }
  }
});

test("W2 DB: gleiche expectedVersion auf zwei Agenten — nur der richtige wird aktualisiert", async (t) => {
  if (!(await dbReachable())) {
    t.skip("Keine PostgreSQL erreichbar (w2) — DB-Test übersprungen (Repo-Konvention)");
    return;
  }
  const a = randomUUID();
  const b = randomUUID();
  const nameA = `w2-a-${randomUUID()}`;
  const nameB = `w2-b-${randomUUID()}`;
  await db.insert(agents).values([
    { id: a, name: nameA, role: "RESEARCH", model: "w2-test", systemPrompt: PROMPT },
    { id: b, name: nameB, role: "RESEARCH", model: "w2-test", systemPrompt: PROMPT },
  ]);

  try {
    // Beide stehen auf Version 1. Nur Agent a darf mit expectedVersion 1 schreiben —
    // Agent b bleibt unverändert (die Version-Spalte ist pro Zeile, nicht global).
    const res = await putAgent(a, `${PROMPT}\nA-edit`, 1);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(res.status, 200);
    assert.equal(body.version, 2);
    const rowB = (await db.select().from(agents).where(eq(agents.id, b)))[0];
    assert.equal(rowB?.version, 1, "b unbeeinflusst");
    assert.equal(rowB?.systemPrompt, PROMPT, "b unbeeinflusst (nur id+version im WHERE)");
  } finally {
    for (const fn of [
      () => db.delete(auditLog).where(eq(auditLog.agentId, a)),
      () => db.delete(auditLog).where(eq(auditLog.agentId, b)),
      () => db.delete(agents).where(eq(agents.id, a)),
      () => db.delete(agents).where(eq(agents.id, b)),
    ]) {
      try {
        await fn();
      } catch {
        /* Test-DB darf Toleranz haben */
      }
    }
  }
});