import { NextResponse } from "next/server";
import { db } from "@/db";
import { agents as agentTable, missions } from "@/db/schema";
import { eq } from "drizzle-orm";
import { logAudit, runAgentTurn, runPipeline } from "@/lib/engine";
import { guardWrite } from "@/lib/apiAuth";
import { publicErrorMessage } from "@/lib/secrets";

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
      // S1 (v1.36.18): über die klassifizierte Senke — ein fehlgeschlagener
      // Audit-Insert durfte hier nicht die eigentliche Pipeline-Fehlermeldung
      // ersetzen (500 mit Audit-Fehler statt Ursache). Sicherheitsklasse: der
      // Beleg kommt in den Spool und wird nachgezogen.
      await logAudit("ERROR", "CRITICAL", { message, scope: "pipeline" }, body.missionId);
      // FIX (v1.5.1): raw error → redacted. Verhindert Leak von DB-Strings.
      return NextResponse.json(
        { ok: false, error: publicErrorMessage(e) },
        { status: 500 }
      );
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
    // S1: wie oben — `agentId` ist ein FK auf `agents.id`; der Client-Wert
    // bleibt im `detail` (nachvollziehbar), ein ungültiger Fremdschlüssel darf
    // nicht den CRITICAL-Beleg eines Laufabbruchs kosten.
    await logAudit("ERROR", "CRITICAL", { message, agentId: body.agentId }, body.missionId);
    await db
      .update(agentTable)
      .set({ status: "STOPPED", updatedAt: new Date() })
      .where(eq(agentTable.id, body.agentId));
    // FIX (v1.5.1): raw error → redacted.
    return NextResponse.json(
      { ok: false, error: publicErrorMessage(e) },
      { status: 500 }
    );
  }
}
