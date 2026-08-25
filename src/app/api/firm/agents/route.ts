import { NextResponse } from "next/server";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { eq } from "drizzle-orm";
import { guardWrite } from "@/lib/apiAuth";
import { validatePromptInput } from "@/lib/workshop";
import { logAudit } from "@/lib/engine";
import { publicErrorMessage } from "@/lib/secrets";

export const dynamic = "force-dynamic";

/**
 * Workshop: system_prompt eines Agenten ohne Terminal ändern (Handbuch 6.3).
 *
 *   PUT /api/firm/agents  { agentId, systemPrompt }
 *
 * Änderungen wirken sofort — Prompts stehen in der Datenbank, kein Neubau.
 * Guardrails (harte Schicht, riskGuard.ts) sind über diesen Endpunkt
 * absichtlich NICHT erreichbar. Validierung via validatePromptInput
 * (geteilt mit Tests); jede Änderung wird ins audit_log geschrieben.
 */
export async function PUT(req: Request) {
  const denied = guardWrite(req);
  if (denied) return denied;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Ungültiges JSON im Request-Body." }, { status: 400 });
  }

  const validated = validatePromptInput(raw);
  if (!validated.ok) {
    return NextResponse.json({ ok: false, error: validated.error }, { status: 400 });
  }
  const { agentId, systemPrompt } = validated.value;

  try {
    const existing = (await db.select().from(agents).where(eq(agents.id, agentId)))[0];
    if (!existing) {
      return NextResponse.json({ ok: false, error: "Agent nicht gefunden." }, { status: 404 });
    }

    const updated = await db
      .update(agents)
      .set({ systemPrompt, updatedAt: new Date() })
      .where(eq(agents.id, agentId))
      .returning();

    try {
      await logAudit("AGENT_PROMPT_UPDATED", "INFO", {
        agent: existing.name,
        role: existing.role,
        oldLength: existing.systemPrompt.length,
        newLength: systemPrompt.length,
        via: "workshop-ui",
      }, undefined, agentId);
    } catch {
      // Audit-Fehler darf die gespeicherte Prompt-Änderung nicht reißen.
    }

    return NextResponse.json({ ok: true, agent: updated[0], warnings: validated.warnings });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `Prompt nicht gespeichert: ${publicErrorMessage(e)}` },
      { status: 503 }
    );
  }
}
