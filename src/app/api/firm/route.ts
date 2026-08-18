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
  riskConfig,
} from "@/db/schema";
import { desc } from "drizzle-orm";
import { getOllamaStatus } from "@/lib/ollama";
import { getBroker } from "@/lib/engine";
import { RISK_LIMITS, killSwitch } from "@/lib/riskGuard";
import { BROKER_REGISTRY } from "@/lib/broker";

export const dynamic = "force-dynamic";

export async function GET() {
  const broker = await getBroker();

  const [agentRows, missionRows, positionRows, proposalRows, auditRows, cfgRows, ksRows, msgRows] =
    await Promise.all([
      db.select().from(agents),
      db.select().from(missions).orderBy(desc(missions.createdAt)),
      db.select().from(positions).orderBy(desc(positions.createdAt)).limit(50),
      db.select().from(proposals).orderBy(desc(proposals.createdAt)).limit(20),
      db.select().from(auditLog).orderBy(desc(auditLog.createdAt)).limit(40),
      db.select().from(riskConfig),
      db.select().from(killSwitches).orderBy(desc(killSwitches.createdAt)).limit(8),
      db.select().from(agentMessages).orderBy(desc(agentMessages.createdAt)).limit(20),
    ]);

  const ollama = await getOllamaStatus();

  const cfg: Record<string, string> = {};
  for (const r of cfgRows) cfg[r.key] = r.value;

  return NextResponse.json({
    agents: agentRows,
    missions: missionRows,
    positions: positionRows,
    proposals: proposalRows,
    auditLog: auditRows,
    messages: msgRows,
    riskLimits: RISK_LIMITS,
    riskConfig: cfg,
    killSwitchArmed: killSwitch.isArmed(),
    killSwitches: ksRows,
    ollama,
    brokers: BROKER_REGISTRY,
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
