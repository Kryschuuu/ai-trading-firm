import { NextResponse } from "next/server";
import { requirePermission } from "@/auth";
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
import { desc, sql } from "drizzle-orm";
import { getOllamaStatus } from "@/lib/ollama";
import { getBroker } from "@/lib/engine";
import { getLimits, LIMIT_CEILINGS, DEFAULT_LIMITS, killSwitch } from "@/lib/riskGuard";
import { effectiveConfigView, refreshRuntimeLimits } from "@/lib/riskConfigService";
import { getAdaptiveRiskStatus } from "@/lib/adaptiveRisk";
import { BROKER_REGISTRY } from "@/lib/broker";
import { lastTickAt } from "@/lib/monitor";
import { getQuoteSync } from "@/lib/marketData";
import type { RiskLimits } from "@/lib/riskGuard";
import { APP_VERSION } from "@/lib/version";
import { publicErrorMessage } from "@/lib/secrets";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  // SEC-02: "read-only" does not make portfolio, audit and strategy data public.
  // Authorize before any DB, broker or runtime-state access.
  const denied = requirePermission(req, "firm.read");
  if (denied) return denied;

  try {
    await refreshRuntimeLimits();
    const broker = await getBroker();

    const [agentRows, missionRows, positionRows, proposalRows, auditRows, ksRows, msgRows, fundingRows] =
      await Promise.all([
        db.select().from(agents),
        db.select().from(missions).orderBy(desc(missions.createdAt)),
        db.select().from(positions).orderBy(desc(positions.createdAt)).limit(50),
        db.select().from(proposals).orderBy(desc(proposals.createdAt)).limit(20),
        db.select().from(auditLog).orderBy(desc(auditLog.createdAt)).limit(40),
        db.select().from(killSwitches).orderBy(desc(killSwitches.createdAt)).limit(8),
        db.select().from(agentMessages).orderBy(desc(agentMessages.createdAt)).limit(20),
        // GAP-02 (v1.42.0): Gesamtfunding über ALLE Positionen (offen UND
        // geschlossen — funding_paid bleibt nach Schließen stehen). Kontosicht:
        // negativ = insgesamt gezahlt, positiv = erhalten.
        db
          .select({ total: sql<string | null>`coalesce(sum(${positions.fundingPaid}), 0)` })
          .from(positions),
      ]);

    const ollama = await getOllamaStatus();

    // Offene Positionen um Live-Kurs und unrealisiertes PnL anreichern.
    const enrichedPositions = positionRows.map((p) => {
      const live = p.status === "OPEN" ? getQuoteSync(p.symbol) : Number(p.exitPrice ?? p.currentPrice ?? p.entryPrice);
      const qty = Number(p.qty);
      const entry = Number(p.entryPrice);
      const dir = p.side === "SHORT" ? -1 : 1;
      // GAP-02: kumuliertes Funding je Position ausweisen (Kontosicht:
      // negativ = gezahlt). numeric kommt als String → Number, kaputte Werte → 0.
      const fundingPaidNum = Number(p.fundingPaid);
      return {
        ...p,
        lastPrice: live,
        unrealizedPnl:
          p.status === "OPEN" && live != null
            ? Number((dir * qty * (live - entry)).toFixed(2))
            : Number(p.realizedPnl ?? 0),
        fundingPaid: Number.isFinite(fundingPaidNum) ? fundingPaidNum : 0,
      };
    });

    return NextResponse.json({
      version: APP_VERSION,
      agents: agentRows,
      missions: missionRows,
      positions: enrichedPositions,
      proposals: proposalRows,
      auditLog: auditRows,
      messages: msgRows,
      riskLimits: getLimits(),
      riskDefaults: DEFAULT_LIMITS,
      riskCeilings: LIMIT_CEILINGS,
      riskConfig: effectiveConfigView().limits,
      volatilityConfig: effectiveConfigView().volatility,
      // RMA-P5-04 (v1.68.0): dritter Namensraum des Dashboards — die
      // drawdown-Parameter (`dsp.*`) mit Code-Bounds und Defaults. Rein
      // additiv; die bestehenden Sektionen bleiben unverändert.
      drawdownConfig: effectiveConfigView().drawdown,
      // Adaptives Risk-Limit-System: Regime, wirksames maxRiskPerTrade,
      // Indikatorwerte + Trigger-Event-Historie (Details:
      // GET /api/firm/risk/volatility).
      adaptiveRisk: getAdaptiveRiskStatus(),
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
        // GAP-02 (v1.42.0): Gesamtfunding im Account-Snapshot.
        // fundingPaid (DB-Summe über alle Positionen, Lifetime) vs.
        // fundingPaidOpen (Ledger, aktuell offene Positionen).
        fundingPaid: Number(Number(fundingRows[0]?.total ?? 0).toFixed(8)),
        fundingPaidOpen: Number(broker.totalFundingPaid.toFixed(8)),
      },
      requireHumanApproval: process.env.REQUIRE_HUMAN_APPROVAL === "true",
      timestamp: new Date().toISOString(),
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    // FIX (v1.5.1): DB-Fehler abfangen statt 500 mit rohem Stack-Trace.
    return NextResponse.json(
      {
        ok: false,
        error: `Dashboard-Daten nicht verfügbar: ${publicErrorMessage(e)}`,
        fix: "PostgreSQL läuft? DATABASE_URL korrekt? `npx drizzle-kit push` ausgeführt?",
      },
      { status: 503 }
    );
  }
}

export type FirmLimitsSnapshot = Record<string, unknown> & { limits?: RiskLimits };
