import { NextResponse } from "next/server";
import { db } from "@/db";
import { agentMessages, agents, auditLog, positions } from "@/db/schema";
import { and, desc, gte } from "drizzle-orm";
import { periodStart, type Period } from "@/lib/time";
import { BLOCK_EXPLANATIONS } from "@/lib/engine";

export const dynamic = "force-dynamic";

type SymbolStat = {
  symbol: string;
  trades: number;
  wins: number;
  pnl: number;
};

/**
 * Menschen lesbarer Report für Führungsperspektive.
 *   ?period=day|week|month   (Standard: day, Grenzen in Europe/Berlin)
 *
 * Enthält: KPIs, Symbol-Breakdown, Entscheidungs-/Blockstatistik,
 * SL/TP-/Kill-/Config-Ereignisse, laufende Empfehlungen des Hauses
 * und eine regelbasierte Boss-Zusammenfassung.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const periodRaw = (url.searchParams.get("period") ?? "day").toLowerCase();
  const period: Period = (["day", "week", "month"] as const).includes(periodRaw as Period)
    ? (periodRaw as Period)
    : "day";
  const since = periodStart(period);

  const [closedRows, auditRows, msgRows, agentRows] = await Promise.all([
    db
      .select()
      .from(positions)
      .where(and(gte(positions.updatedAt, since)))
      .orderBy(desc(positions.updatedAt)),
    db.select().from(auditLog).where(gte(auditLog.createdAt, since)).orderBy(desc(auditLog.createdAt)),
    db.select().from(agentMessages).where(gte(agentMessages.createdAt, since)).orderBy(desc(agentMessages.createdAt)).limit(400),
    db.select({ id: agents.id, name: agents.name, role: agents.role }).from(agents),
  ]);

  // ── KPIs aus geschlossenen Trades des Zeitraums ──────────────────────────
  const closed = closedRows.filter((p) => p.status === "CLOSED");
  const pnls = closed.map((p) => Number(p.realizedPnl ?? 0));
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p <= 0);
  const grossProfit = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  let peak = Number.NEGATIVE_INFINITY;
  let maxDrawdownPct = 0;
  let running = 0;
  for (const p of [...closed].reverse()) {
    running += Number(p.realizedPnl ?? 0);
    peak = Math.max(peak, running);
    if (peak > 0) maxDrawdownPct = Math.max(maxDrawdownPct, ((running - peak) / peak) * 100);
  }

  const kpis = {
    trades: closed.length,
    realizedPnl: Number(pnls.reduce((a, b) => a + b, 0).toFixed(2)),
    winRate: pnls.length ? Number(((wins.length / pnls.length) * 100).toFixed(1)) : null,
    profitFactor: grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(2)) : grossProfit > 0 ? Infinity : null,
    bestTrade:
      pnls.length > 0
        ? (() => {
            const idx = pnls.indexOf(Math.max(...pnls));
            return { symbol: closed[idx].symbol, pnl: pnls[idx] };
          })()
        : null,
    worstTrade:
      pnls.length > 0
        ? (() => {
            const idx = pnls.indexOf(Math.min(...pnls));
            return { symbol: closed[idx].symbol, pnl: pnls[idx] };
          })()
        : null,
    maxDrawdownPct: Number(maxDrawdownPct.toFixed(2)),
    stopLossHits: closed.filter((p) => p.exitReason === "STOP_LOSS").length,
    takeProfitHits: closed.filter((p) => p.exitReason === "TAKE_PROFIT").length,
  };

  // ── Symbol-Breakdown ─────────────────────────────────────────────────────
  const bySymbol = new Map<string, SymbolStat>();
  for (const p of closed) {
    const s = bySymbol.get(p.symbol) ?? { symbol: p.symbol, trades: 0, wins: 0, pnl: 0 };
    s.trades += 1;
    if (Number(p.realizedPnl ?? 0) > 0) s.wins += 1;
    s.pnl += Number(p.realizedPnl ?? 0);
    bySymbol.set(p.symbol, s);
  }
  const symbols = [...bySymbol.values()].sort((a, b) => b.pnl - a.pnl);

  // ── Entscheidungen & Blocks ──────────────────────────────────────────────
  const agentMap = new Map(agentRows.map((a) => [a.id, a]));
  const turnsByRole: Record<string, number> = {};
  const decisionsByType: Record<string, number> = {};
  for (const m of msgRows) {
    const role = agentMap.get(m.agentId ?? "")?.role ?? "?";
    turnsByRole[role] = (turnsByRole[role] ?? 0) + 1;
    const d = (m.meta as any)?.decision?.type;
    if (d) decisionsByType[d] = (decisionsByType[d] ?? 0) + 1;
  }
  const blockCounts: Record<string, number> = {};
  for (const a of auditRows) {
    if (a.event !== "ORDER_REJECTED") continue;
    const reason = String((a.detail as any)?.reason ?? "UNKNOWN");
    blockCounts[reason] = (blockCounts[reason] ?? 0) + 1;
  }
  const blocks = Object.entries(blockCounts)
    .map(([reason, count]) => ({
      reason,
      count,
      explanation: BLOCK_EXPLANATIONS[reason] ?? null,
    }))
    .sort((a, b) => b.count - a.count);

  const notableEvents = auditRows.filter((a) =>
    ["STOP_LOSS_HIT", "TAKE_PROFIT_HIT", "KILL_SWITCH", "CONFIG_CHANGED", "FLATTEN_ALL", "DAILY_LOSS_LIMIT"].includes(a.event)
  ).slice(0, 25);

  // ── Empfehlungen des Hauses (letzte je Rolle+Symbol, 7-Tage-Fenster) ────
  const recSince = new Date(Date.now() - 7 * 86_400_000);
  const recRows = await db
    .select()
    .from(agentMessages)
    .where(gte(agentMessages.createdAt, recSince))
    .orderBy(desc(agentMessages.createdAt))
    .limit(200);
  type Rec = {
    at: string; role: string; symbol: string; side: string;
    horizon?: string; thesis?: string; confidence?: number; entryZone?: string;
    stopLoss?: string; target?: string; riskFlags?: string[]; fresh?: boolean;
  };
  const seenRec = new Set<string>();
  const recommendations: Rec[] = [];
  for (const m of recRows) {
    const meta = (m.meta ?? {}) as any;
    if (meta?.kind !== "RECOMMENDATION") continue;
    const role = agentMap.get(m.agentId ?? "")?.role ?? "?";
    const key = `${role}:${meta.symbol}`;
    if (seenRec.has(key)) continue; // nur die neueste pro Rolle+Symbol
    seenRec.add(key);
    recommendations.push({
      at: m.createdAt.toISOString(),
      role,
      symbol: String(meta.symbol ?? "?"),
      side: String(meta.side ?? "LONG"),
      horizon: meta.horizon,
      thesis: String(m.content ?? "").slice(0, 300),
      confidence: typeof meta.confidence === "number" ? meta.confidence : undefined,
      entryZone: meta.entryZone,
      stopLoss: meta.stopLoss,
      target: meta.target,
      riskFlags: Array.isArray(meta.riskFlags) ? meta.riskFlags.slice(0, 5) : [],
      // Serverseitig berechnet, damit der Client kein Date.now() im Render braucht.
      fresh: Date.now() - m.createdAt.getTime() < 24 * 3600_000,
    });
    if (recommendations.length >= 12) break;
  }

  // ── Regelbasierte Boss-Zusammenfassung ──────────────────────────────────
  const bullets: string[] = [];
  if (kpis.trades === 0) {
    bullets.push("Keine abgeschlossenen Trades im Zeitraum — entweder HOLD-Dominanz oder Blockaden. Protokoll prüfen.");
  } else {
    bullets.push(
      `${kpis.trades} Trades geschlossen, realisiertes P&L ${kpis.realizedPnl >= 0 ? "+" : ""}${kpis.realizedPnl.toFixed(2)} — Trefferquote ${kpis.winRate ?? "?"} %.`
    );
  }
  if (kpis.stopLossHits > 0 && kpis.takeProfitHits === 0) {
    bullets.push("Nur Stop-Loss-Auslösungen ohne Take-Profit: Setup-Qualität bzw. Marktlage hinterfragen.");
  }
  if (kpis.takeProfitHits >= kpis.stopLossHits && kpis.takeProfitHits > 0) {
    bullets.push("Take-Profit-Auslösungen dominieren — aktuelles Regime passt zum Setup-Katalog.");
  }
  const topBlock = blocks[0];
  if (topBlock) {
    bullets.push(`Häufigster Block: ${topBlock.reason} (${topBlock.count}×).`);
  }
  if (kpis.maxDrawdownPct > 10) {
    bullets.push(`Max. Drawdown im Zeitraum ${kpis.maxDrawdownPct} % — Positionsgrößen prüfen.`);
  }
  if (recommendations.length > 0) {
    bullets.push(`${recommendations.length} Empfehlung(en) aktiv, u. a. ${recommendations.slice(0, 3).map((r) => r.symbol).join(", ")}.`);
  }

  return NextResponse.json({
    ok: true,
    period,
    since: since.toISOString(),
    until: new Date().toISOString(),
    kpis,
    symbols,
    turnsByRole,
    decisionsByType,
    blocks,
    notableEvents: notableEvents.map((a) => ({
      at: a.createdAt.toISOString(),
      event: a.event,
      level: a.level,
      detail: a.detail,
    })),
    recommendations,
    summary: bullets,
  });
}
