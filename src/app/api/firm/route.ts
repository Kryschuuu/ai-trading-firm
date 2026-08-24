import { NextResponse } from "next/server";
import { db } from "@/db";
import {
  agents,
  agentMessages,
  auditLog,
  killSwitches,
  missions,
  positions,
  proposals,
} from "@/db/schema";
import { desc } from "drizzle-orm";
import { getOllamaStatus } from "@/lib/ollama";
import { getBroker } from "@/lib/engine";
import { getLimits, LIMIT_CEILINGS, DEFAULT_LIMITS, killSwitch } from "@/lib/riskGuard";
import { effectiveConfigView, refreshRuntimeLimits } from "@/lib/riskConfigService";
import { BROKER_REGISTRY } from "@/lib/broker";
import { lastTickAt } from "@/lib/monitor";
import { getQuoteSync } from "@/lib/marketData";
import type { RiskLimits } from "@/lib/riskGuard";

export const dynamic = "force-dynamic";

export async function GET() {
  await refreshRuntimeLimits();
  const broker = await getBroker();

  const [agentRows, missionRows, positionRows, proposalRows, auditRows, ksRows, msgRows] =
    await Promise.all([
      db.select().from(agents),
      db.select().from(missions).orderBy(desc(missions.createdAt)),
      db.select().from(positions).orderBy(desc(positions.createdAt)).limit(50),
      db.select().from(proposals).orderBy(desc(proposals.createdAt)).limit(20),
      db.select().from(auditLog).orderBy(desc(auditLog.createdAt)).limit(40),
      db.select().from(killSwitches).orderBy(desc(killSwitches.createdAt)).limit(8),
      db.select().from(agentMessages).orderBy(desc(agentMessages.createdAt)).limit(20),
    ]);

  const ollama = await getOllamaStatus();

  // Offene Positionen um Live-Kurs und unrealisiertes PnL anreichern.
  const enrichedPositions = positionRows.map((p) => {
    const live = p.status === "OPEN" ? getQuoteSync(p.symbol) : Number(p.exitPrice ?? p.currentPrice ?? p.entryPrice);
    const qty = Number(p.qty);
    const entry = Number(p.entryPrice);
    const dir = p.side === "SHORT" ? -1 : 1;
    return {
      ...p,
      lastPrice: live,
      unrealizedPnl:
        p.status === "OPEN" && live != null
          ? Number((dir * qty * (live - entry)).toFixed(2))
          : Number(p.realizedPnl ?? 0),
    };
  });

  return NextResponse.json({
    agents: agentRows,
    missions: missionRows,
    positions: enrichedPositions,
    proposals: proposalRows,
    auditLog: auditRows,
    messages: msgRows,
    riskLimits: getLimits(),
    riskDefaults: DEFAULT_LIMITS,
    riskCeilings: LIMIT_CEILINGS,
    riskConfig: effectiveConfigView(),
    killSwitchArmed: killSwitch.isArmed(),
    killSwitches: ksRows,
    ollama,
    brokers: BROKER_REGISTRY,
    scheduler: { enabled: process.env.SCHEDULER_ENABLED !== "false", lastTickAt: lastTickAt() },
    account: {
      equity: Number(broker.accountEquity.toFixed(2)),
      startingEquity: broker.startingEquity,
      freeCash: Number(broker.freeCash.toFixed(2)),
      drawdownPct: Number((broker.drawdownPct * 100).toFixed(2)),
      openPositions: broker.openPositions,
      broker: broker.name,
      paperMode: true,
      livePositions: broker.listPositions(),
    },
    requireHumanApproval: process.env.REQUIRE_HUMAN_APPROVAL === "true",
    timestamp: new Date().toISOString(),
  });
}

export type FirmLimitsSnapshot = Record<string, unknown> & { limits?: RiskLimits };
