import { NextResponse } from "next/server";
import { db } from "@/db";
import { agents as agentTable, auditLog, missions } from "@/db/schema";
import { eq } from "drizzle-orm";
import { runAgentTurn, runPipeline } from "@/lib/engine";
import { guardWrite } from "@/lib/apiAuth";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Führt einen einzelnen Agenten-Turn aus  → { agentId, missionId }
 * oder die komplette sequenzielle Pipeline → { missionId, pipeline: true }
 */
export async function POST(req: Request) {
  const denied = guardWrite(req);
  if (denied) return denied;
  const body = (await req.json().catch(() => ({}))) as {
    agentId?: string;
    missionId?: string;
    pipeline?: boolean;
  };

  if (!body.missionId) {
    return NextResponse.json({ ok: false, error: "missionId erforderlich" }, { status: 400 });
  }

  const mission = (await db.select().from(missions).where(eq(missions.id, body.missionId)))[0];
  if (!mission) {
    return NextResponse.json({ ok: false, error: "Mission nicht gefunden" }, { status: 404 });
  }
  if (mission.status === "KILLED") {
    return NextResponse.json(
      { ok: false, error: "Mission ist gestoppt — Kill-Switch zuerst entschärfen." },
      { status: 409 }
    );
  }

  // Ganze Pipeline (CEO → Research → Backtest → Risk → Approver → Executor)
  if (body.pipeline) {
    try {
      const results = await runPipeline(body.missionId);
      return NextResponse.json({ ok: true, pipeline: results });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // KORRIGIERT (v1.1.0): laufende Pipeline → 409 statt 500 (kein CRITICAL
      // Audit-Eintrag für einen erwartbaren Konflikt).
      if (message === "PIPELINE_ALREADY_RUNNING") {
        return NextResponse.json(
          { ok: false, error: "Eine Pipeline läuft bereits in diesem Prozess." },
          { status: 409 }
        );
      }
      await db.insert(auditLog).values({
        event: "ERROR",
        level: "CRITICAL",
        detail: { message, scope: "pipeline" },
        missionId: body.missionId,
      });
      return NextResponse.json({ ok: false, error: message }, { status: 500 });
    }
  }

  if (!body.agentId) {
    return NextResponse.json({ ok: false, error: "agentId erforderlich" }, { status: 400 });
  }

  await db
    .update(agentTable)
    .set({ status: "RUNNING", updatedAt: new Date() })
    .where(eq(agentTable.id, body.agentId));

  try {
    const result = await runAgentTurn(body.agentId, body.missionId);
    await db
      .update(agentTable)
      .set({ status: result.status === "BLOCKED" ? "BLOCKED" : "IDLE", updatedAt: new Date() })
      .where(eq(agentTable.id, body.agentId));
    return NextResponse.json({ ok: true, result });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await db.insert(auditLog).values({
      event: "ERROR",
      level: "CRITICAL",
      detail: { message, agentId: body.agentId },
      missionId: body.missionId,
      agentId: body.agentId,
    });
    await db
      .update(agentTable)
      .set({ status: "STOPPED", updatedAt: new Date() })
      .where(eq(agentTable.id, body.agentId));
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
