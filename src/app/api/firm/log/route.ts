import { NextResponse } from "next/server";
import { requirePermission } from "@/auth";
import { db } from "@/db";
import { agentMessages, agents, auditLog } from "@/db/schema";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  isProtocolTurn,
  normalizeProtocolMessage,
  toTurnLogEntry,
  type ProtocolAgentLookup,
} from "@/lib/protocol";
import { MAX_PAGE_SIZE, pageCount } from "@/lib/paging";
import type { AuditLogRowDto, ListPageMetaDto, ProtocolRawRowDto } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Ausführliches Protokoll + Audit-Trail für das Dashboard.
 *
 *   - entries: heterogene Timeline (Agenten-Turns, Analystenberichte,
 *     Systemmeldungen) — jede Zeile mit explizitem `kind` und der originalen
 *     DB-Zeile unter `raw` (für den „Rohdaten"-Reiter).
 *   - audit:   revisionssichere Ereignisse, filterbar nach Level/Event.
 *   - meta:    Paging-Informationen (Seite, Seitengröße, Gesamtzahlen), damit
 *     die UI echtes Server-Paging fahren kann (20/50/100/200 pro Seite).
 *
 * Query-Parameter:
 *   ?limit=20&page=2&level=WARN&event=ORDER_REJECTED
 *   `offset` wird ebenfalls akzeptiert (hat Vorrang vor `page`).
 */
export async function GET(req: Request) {
  // SEC-02: raw agent messages and audit details are strategy-sensitive.
  const denied = requirePermission(req, "firm.read");
  if (denied) return denied;

  const url = new URL(req.url);

  // KORRIGIERT (v1.1.0): Limit robust klemmen — NaN bzw. negative Werte
  // verursachten vorher einen SQL-Fehler (limit(NaN)/negative LIMIT → 500).
  const rawLimit = Number(url.searchParams.get("limit") ?? url.searchParams.get("pageSize") ?? 20);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(Math.trunc(rawLimit), 1), MAX_PAGE_SIZE)
    : 20;

  const rawPage = Number(url.searchParams.get("page") ?? 1);
  const page = Number.isFinite(rawPage) ? Math.max(1, Math.trunc(rawPage)) : 1;
  const rawOffset = Number(url.searchParams.get("offset") ?? Number.NaN);
  const offset = Number.isFinite(rawOffset)
    ? Math.max(0, Math.trunc(rawOffset))
    : (page - 1) * limit;

  const levelRaw = (url.searchParams.get("level") ?? "").toUpperCase();
  const eventRaw = (url.searchParams.get("event") ?? "").toUpperCase();
  const level = ["INFO", "WARN", "CRITICAL"].includes(levelRaw) ? levelRaw : null;
  const event = /^[A-Z][A-Z0-9_]{0,39}$/.test(eventRaw) ? eventRaw : null;

  const auditFilters = [
    level ? eq(auditLog.level, level) : null,
    event ? eq(auditLog.event, event) : null,
  ].filter((condition): condition is ReturnType<typeof eq> => condition !== null);

  const [messageRows, auditRows, agentRows, auditCountRows, entryCountRows, legacyRows] = await Promise.all([
    db
      .select()
      .from(agentMessages)
      .orderBy(desc(agentMessages.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select()
      .from(auditLog)
      .where(auditFilters.length > 0 ? and(...auditFilters) : undefined)
      .orderBy(desc(auditLog.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ id: agents.id, name: agents.name, role: agents.role }).from(agents),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(auditLog)
      .where(auditFilters.length > 0 ? and(...auditFilters) : undefined),
    db.select({ total: sql<number>`count(*)::int` }).from(agentMessages),
    // Rückwärtskompatible `turns`-Liste: Der Workshop erwartet die letzten
    // echten Entscheidungen. Dafür lesen wir etwas weiter zurück, damit zwischen
    // Analysten-/Systemmeldungen trotzdem Agenten-Turns erscheinen.
    db
      .select()
      .from(agentMessages)
      .orderBy(desc(agentMessages.createdAt))
      .limit(Math.min(Math.max(limit * 4, 12), 800)),
  ]);

  const agentMap = new Map<string, ProtocolAgentLookup>(
    agentRows.map((agent): [string, ProtocolAgentLookup] => [agent.id, agent])
  );

  const rawForRow = (row: (typeof messageRows)[number]): ProtocolRawRowDto => ({
    id: row.id,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : (row.createdAt ?? null),
    agentId: row.agentId,
    missionId: row.missionId,
    type: row.type,
    content: row.content,
    meta: row.meta ?? null,
  });

  const entries = messageRows.map((message) => ({
    ...normalizeProtocolMessage(message, agentMap),
    raw: rawForRow(message),
  }));

  const legacyEntries = legacyRows.map((message) => normalizeProtocolMessage(message, agentMap));

  const auditTotal = Number(auditCountRows[0]?.total ?? 0);
  const entryTotal = Number(entryCountRows[0]?.total ?? 0);

  const audit: AuditLogRowDto[] = auditRows.map((row) => ({
    id: row.id,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    event: row.event,
    level: row.level,
    detail: row.detail ?? null,
    missionId: row.missionId,
    agentId: row.agentId,
  }));

  const meta: ListPageMetaDto = {
    // Aus dem tatsächlichen Offset ableiten: bei ?offset=40&limit=20 ist die
    // Antwort Seite 3 — auch wenn kein `page`-Parameter mitgegeben wurde.
    page: Math.floor(offset / limit) + 1,
    pageSize: limit,
    pages: Math.max(pageCount(auditTotal, limit), pageCount(entryTotal, limit)),
    auditTotal,
    entryTotal,
  };

  return NextResponse.json({
    ok: true,
    entries,
    // Bestehende Clients erwarten unter `turns` echte Agentenentscheidungen.
    // Analystenberichte und Markt-Scans werden absichtlich nicht hineingemischt.
    turns: legacyEntries.filter(isProtocolTurn).slice(0, limit).map(toTurnLogEntry),
    audit,
    meta,
    agents: agentRows,
  });
}
