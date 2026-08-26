import { NextResponse } from "next/server";
import { db } from "@/db";
import { agentMessages, agents, auditLog } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import {
  isProtocolTurn,
  normalizeProtocolMessage,
  toTurnLogEntry,
  type ProtocolAgentLookup,
} from "@/lib/protocol";

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

  // Für die Timeline reichen `limit` Zeilen. Für die rückwärtskompatible
  // Turn-Liste lesen wir etwas weiter zurück: zwischen Analysten-/Systemmeldungen
  // sollen im Workshop trotzdem die letzten echten Entscheidungen erscheinen.
  const messageFetchLimit = Math.min(limit * 4, 800);
  const [messageRows, auditRows, agentRows] = await Promise.all([
    db.select().from(agentMessages).orderBy(desc(agentMessages.createdAt)).limit(messageFetchLimit),
    auditQuery,
    db.select({ id: agents.id, name: agents.name, role: agents.role }).from(agents),
  ]);

  const agentMap = new Map<string, ProtocolAgentLookup>(
    agentRows.map((agent): [string, ProtocolAgentLookup] => [agent.id, agent])
  );
  const normalized = messageRows.map((message) => normalizeProtocolMessage(message, agentMap));

  return NextResponse.json({
    ok: true,
    // Vollständige, heterogene Timeline für den Protokoll-Tab. Jede Zeile hat
    // einen expliziten kind statt impliziter (und oft falscher) Entscheidung.
    entries: normalized.slice(0, limit),
    // Bestehende Clients erwarten unter `turns` echte Agentenentscheidungen.
    // Analystenberichte und Markt-Scans werden absichtlich nicht hineingemischt.
    turns: normalized.filter(isProtocolTurn).slice(0, limit).map(toTurnLogEntry),
    audit: auditRows,
    agents: agentRows,
  });
}
