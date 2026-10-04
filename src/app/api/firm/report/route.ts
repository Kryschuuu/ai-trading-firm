/**
 * API-Route `GET /api/firm/report` — Firmen-Report (Lese-API).
 *
 * Teil der Firm-API (Next.js App Router). Autorisierung: requirePermission("firm.read") — Auth-Modell und RBAC: docs/security/README.md.
 */

import { NextResponse } from "next/server";
import { requirePermission } from "@/auth";
import { db } from "@/db";
import { agentMessages, agents, auditLog, positions } from "@/db/schema";
import { and, desc, gte } from "drizzle-orm";
import { isPeriod, periodStart, type Period } from "@/lib/time";
import { BLOCK_EXPLANATIONS } from "@/lib/engine";
import { readEquitySeriesWindow } from "@/lib/equity";
import { drawdownEpisodes, timeWeightedReturn } from "@/lib/equityAnalytics";
import { readStartingEquity } from "@/lib/startingEquity";

export const dynamic = "force-dynamic";

type SymbolStat = {
  symbol: string;
  trades: number;
  wins: number;
  pnl: number;
};

/**
 * Menschen lesbarer Report für Führungsperspektive.
 *   ?period=day|week|month|quarter|halfyear|year  (Standard: day, Grenzen in Europe/Berlin)
 *
 * Enthält: KPIs (inkl. **echtem Equity-Drawdown** Peak-to-Trough aus den
 * Snapshots — siehe docs/EQUITY_CURVE.md), Symbol-Breakdown,
 * Entscheidungs-/Blockstatistik, SL/TP-/Kill-/Config-Ereignisse, laufende
 * Empfehlungen des Hauses und eine regelbasierte Boss-Zusammenfassung.
 */
export async function GET(req: Request) {
  // SEC-02: performance, drawdown and recommendations require an authenticated reader.
  const denied = requirePermission(req, "firm.read");
  if (denied) return denied;

  const url = new URL(req.url);
  const periodRaw = (url.searchParams.get("period") ?? "day").toLowerCase();
  const period: Period = isPeriod(periodRaw) ? periodRaw : "day";
  const since = periodStart(period);
  const until = new Date();

  const [closedRows, auditRows, msgRows, agentRows, equityWindow] = await Promise.all([
    db
      .select()
      .from(positions)
      .where(and(gte(positions.updatedAt, since)))
      .orderBy(desc(positions.updatedAt)),
    db.select().from(auditLog).where(gte(auditLog.createdAt, since)).orderBy(desc(auditLog.createdAt)),
    db.select().from(agentMessages).where(gte(agentMessages.createdAt, since)).orderBy(desc(agentMessages.createdAt)).limit(400),
    db.select({ id: agents.id, name: agents.name, role: agents.role }).from(agents),
    // Equity-Kurve des Zeitraums: Basis für den echten Drawdown (Peak-to-Trough)
    // inklusive Referenz-Höchststand aus der Zeit VOR dem Zeitraum. Der
    // Drawdown wurde vorher aus der Summe der realisierten P&L gerechnet und
    // stand dadurch fast immer auf 0 % (Peak ≤ 0 → keine Berechnung).
    readEquitySeriesWindow({ since, until, maxPoints: 2000, startEquity: readStartingEquity() }),
  ]);

  // ── KPIs aus geschlossenen Trades des Zeitraums ──────────────────────────
  const closed = closedRows.filter((p) => p.status === "CLOSED");
  const pnls = closed.map((p) => Number(p.realizedPnl ?? 0));
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p <= 0);
  const grossProfit = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  // ── Drawdown aus der Equity-Kurve (Peak-to-Trough), nicht aus der P&L-Summe ─
  const equityStats = equityWindow.stats;
  const maxDrawdownPct = equityStats.maxDrawdownPct;
  // Zeitgewichtete Rendite (verkettete Tagesrenditen) und die fünf tiefsten
  // Drawdown-Phasen — dieselbe reine Mathematik wie im Chart/Endpoint.
  const twr = timeWeightedReturn(equityWindow.points);
  const episodes = drawdownEpisodes(equityWindow.points, { topN: 5, minPct: 0.05 });

  // ── Trade-Statistik (Gewinner/Verlierer, Serien, Haltedauer) ────────────
  const profitValues = wins.reduce((a, b) => a + b, 0);
  const lossValues = Math.abs(losses.reduce((a, b) => a + b, 0));
  const avgWin = wins.length ? profitValues / wins.length : null;
  const avgLoss = losses.length ? lossValues / losses.length : null;
  const expectancy = closed.length ? pnls.reduce((a, b) => a + b, 0) / closed.length : null;
  let maxWinStreak = 0;
  let maxLossStreak = 0;
  let winStreak = 0;
  let lossStreak = 0;
  for (const p of [...closed].reverse()) {
    if (Number(p.realizedPnl ?? 0) > 0) {
      winStreak += 1;
      lossStreak = 0;
      maxWinStreak = Math.max(maxWinStreak, winStreak);
    } else {
      lossStreak += 1;
      winStreak = 0;
      maxLossStreak = Math.max(maxLossStreak, lossStreak);
    }
  }
  const holdHours = closed
    .map((p) => (p.createdAt && p.updatedAt ? (p.updatedAt.getTime() - p.createdAt.getTime()) / 3_600_000 : null))
    .filter((h): h is number => h !== null && Number.isFinite(h) && h >= 0);
  const avgHoldHours = holdHours.length
    ? Number((holdHours.reduce((a, b) => a + b, 0) / holdHours.length).toFixed(2))
    : null;

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
    maxDrawdownPct,
    /** Drawdown-Details (Peak → Trough, Erholung) aus der Equity-Kurve. */
    maxDrawdownAbs: equityStats.maxDrawdownAbs,
    currentDrawdownPct: equityStats.currentDrawdownPct,
    maxDrawdownFrom: equityStats.maxDrawdownFrom,
    maxDrawdownTo: equityStats.maxDrawdownTo,
    recoveredAt: equityStats.recoveredAt,
    grossProfit: Number(profitValues.toFixed(2)),
    grossLoss: Number(lossValues.toFixed(2)),
    avgWin: avgWin !== null ? Number(avgWin.toFixed(2)) : null,
    avgLoss: avgLoss !== null ? Number(avgLoss.toFixed(2)) : null,
    /** Erwartungswert je Trade (realisiertes P&L / Anzahl). */
    expectancy: expectancy !== null ? Number(expectancy.toFixed(2)) : null,
    /** Gewinn-/Verlust-Verhältnis der Durchschnitte (null, wenn kein Verlust). */
    payoffRatio: avgWin !== null && avgLoss !== null && avgLoss > 0 ? Number((avgWin / avgLoss).toFixed(2)) : null,
    maxWinStreak,
    maxLossStreak,
    avgHoldHours,
    /**
     * Zeitgewichtete Rendite im Zeitraum (verkettete Tagesrenditen). `flows`
     * ist `false`, solange das Paper-Konto keine Cashflow-Spur führt — dann
     * entspricht sie der Kettenrendite ohne Bereinigung (dokumentiert).
     */
    twrPct: twr.twrPct,
    twrSimplePct: twr.simplePct,
    twrDays: twr.days,
    twrCashflowApplied: twr.flows.applied,
    /** Die tiefsten Drawdown-Phasen (Peak → Tief → Erholung). */
    drawdownEpisodes: episodes.length,
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
  if (kpis.maxDrawdownPct > 0) {
    const dd =
      `Max. Drawdown (Equity, Peak-to-Trough) ${kpis.maxDrawdownPct} %` +
      (kpis.currentDrawdownPct > 0
        ? `, aktuell ${kpis.currentDrawdownPct} % unter dem Höchststand`
        : ", aktuell auf dem Höchststand");
    bullets.push(`${dd}${kpis.maxDrawdownPct > 10 ? " — Positionsgrößen prüfen." : "."}`);
  }
  if (recommendations.length > 0) {
    bullets.push(`${recommendations.length} Empfehlung(en) aktiv, u. a. ${recommendations.slice(0, 3).map((r) => r.symbol).join(", ")}.`);
  }

  return NextResponse.json({
    ok: true,
    period,
    since: since.toISOString(),
    until: until.toISOString(),
    /** Equity-Kurve des Zeitraums (verdichtet) + Kennzahlen für das Chart. */
    equity: {
      series: equityWindow.points,
      stats: equityStats,
      resolution: equityWindow.resolution,
      bucketSeconds: equityWindow.bucketSeconds,
      startingEquity: equityStats.startEquity,
      historyStart: equityWindow.meta.earliestTs,
    },
    kpis,
    /** Kennzahlen-Objekt für die Liste der Drawdown-Episoden (Top 5). */
    drawdownEpisodes: episodes,
    twr,
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
  }, { headers: { "Cache-Control": "private, no-store" } });
}
