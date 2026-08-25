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
  // KORRIGIERT (v1.1.0): Limit robust klemmen — NaN bzw. negative Werte
  // verursachten vorher einen SQL-Fehler (limit(NaN)/negative LIMIT → 500).
  const rawLimit = Number(url.searchParams.get("limit") ?? 60);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(Math.trunc(rawLimit), 1), 200)
    : 60;
  const levelRaw = (url.searchParams.get("level") ?? "").toUpperCase();
  const eventRaw = (url.searchParams.get("event") ?? "").toUpperCase();
  const level = ["INFO", "WARN", "CRITICAL"].includes(levelRaw) ? levelRaw : null;
  const event = /^[A-Z][A-Z0-9_]{0,39}$/.test(eventRaw) ? eventRaw : null;

  let auditQuery = db.select().from(auditLog).orderBy(desc(auditLog.createdAt)).limit(limit).$dynamic();
  if (level) auditQuery = auditQuery.where(eq(auditLog.level, level));
  if (event) auditQuery = auditQuery.where(eq(auditLog.event, event));

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
        content: t.content,
        decision: meta.decision,
        source: meta.source,
        model: meta.model,
        latencyMs: meta.latencyMs,
        prompt: typeof meta.prompt === "string" ? meta.prompt : null,
        rawResponse: typeof meta.rawResponse === "string" ? meta.rawResponse : null,
        provider: typeof meta.provider === "string" ? meta.provider : null,
        usage: meta.usage ?? null,
        costUsd: typeof meta.costUsd === "number" ? meta.costUsd : null,
      };
    }),
    audit: auditRows,
    agents: agentRows,
  });
}
