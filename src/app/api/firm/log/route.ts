import { NextResponse } from "next/server";
import { db } from "@/db";
import { agentMessages, agents, auditLog } from "@/db/schema";
import { desc, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

/**
 * Ausführliches Protokoll für das Dashboard:
 *   - Turns: Agenten-Entscheidungen mit vollständigem Trace
 *     (Prompt → Rohergebnis → geparstes JSON → Guardrail-Kette)
 *   - Audit: revisionssichere Ereignisse, filterbar nach Level/Event
 * Query-Parameter: ?limit=50&level=WARN&event=ORDER_REJECTED
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 60), 200);
  const level = url.searchParams.get("level");
  const event = url.searchParams.get("event");

  let auditQuery = db.select().from(auditLog).orderBy(desc(auditLog.createdAt)).limit(limit).$dynamic();
  if (level) auditQuery = auditQuery.where(eq(auditLog.level, level.toUpperCase()));
  if (event) auditQuery = auditQuery.where(eq(auditLog.event, event.toUpperCase()));

  const [turnRows, auditRows, agentRows] = await Promise.all([
    db.select().from(agentMessages).orderBy(desc(agentMessages.createdAt)).limit(limit),
    auditQuery,
    db.select({ id: agents.id, name: agents.name, role: agents.role }).from(agents),
  ]);

  const agentMap = new Map(agentRows.map((a) => [a.id, a]));

  return NextResponse.json({
    ok: true,
    turns: turnRows.map((t) => {
      const meta = (t.meta ?? {}) as Record<string, unknown>;
      return {
        id: t.id,
        at: t.createdAt,
        agent: agentMap.get(t.agentId ?? "")?.name ?? "unbekannt",
        role: agentMap.get(t.agentId ?? "")?.role ?? "?",
        missionId: t.missionId,
        decision: meta.decision,
        source: meta.source,
        model: meta.model,
        latencyMs: meta.latencyMs,
        prompt: typeof meta.prompt === "string" ? meta.prompt : null,
        rawResponse: typeof meta.rawResponse === "string" ? meta.rawResponse : null,
      };
    }),
    audit: auditRows,
    agents: agentRows,
  });
}
