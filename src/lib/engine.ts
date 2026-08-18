/**
 * Orchestrierungs-Engine der autonomen Trading-Firma.
 *
 * Ablauf pro Agenten-Turn: Agent erzeugt eine Entscheidung → die Entscheidung läuft
 * durch eine im Code verankerte Validierungskette (Engine → Guardrails → Kill-Switch
 * → Approver) → erst danach darf eine Order den Broker erreichen. Der Broker prüft
 * anschließend nochmals selbst.
 *
 * Verteidigung in der Tiefe (keine Schicht ist durch Modell-Output umgehbar):
 *   1. Prompt-/Instruktionsschicht  (weich  — Agenten werden angewiesen)
 *   2. Engine-Validierung           (hart   — diese Datei)
 *   3. Order-Guardrails             (hart   — src/lib/riskGuard.ts)
 *   4. Kill-Switch-Circuit-Breaker  (hart   — riskGuard + DB-Persistenz)
 *   5. Broker-Ausführungsschleuse   (hart   — src/lib/broker.ts)
 */
import { db } from "@/db";
import {
  agentMessages,
  agents as agentTable,
  auditLog,
  killSwitches,
  missions,
  positions,
  proposals,
  riskConfig,
} from "@/db/schema";
import { and, desc, eq, sql } from "drizzle-orm";
import { RISK_LIMITS, killSwitch, riskAdjustedSize } from "./riskGuard";
import { PaperBroker } from "./broker";
import { localReason } from "./ollama";

const G = globalThis as typeof globalThis & {
  __firmBroker?: PaperBroker;
  __firmHydrated?: boolean;
};

/**
 * Liefert den Paper-Broker und stellt beim ersten Zugriff nach einem Prozessstart
 * den Zustand aus PostgreSQL wieder her (offene Positionen + Kill-Switch-Status).
 * Nötig, weil systemd den Dienst neu starten kann, die Buchhaltung aber persistent ist.
 */
export async function getBroker(): Promise<PaperBroker> {
  G.__firmBroker ??= new PaperBroker(Number(process.env.STARTING_EQUITY || 10000));

  if (!G.__firmHydrated) {
    const openRows = await db
      .select()
      .from(positions)
      .where(eq(positions.status, "OPEN"));
    G.__firmBroker.hydrate(
      openRows.map((r) => ({
        symbol: r.symbol,
        side: r.side === "SHORT" ? ("SHORT" as const) : ("LONG" as const),
        qty: Number(r.qty),
        entryPrice: Number(r.entryPrice),
      }))
    );

    const lastKill = await db
      .select()
      .from(killSwitches)
      .orderBy(desc(killSwitches.createdAt))
      .limit(1);
    if (lastKill[0]?.armed) killSwitch.pull(`restored:${lastKill[0].reason}`);
    else killSwitch.disarm();

    G.__firmHydrated = true;
  }

  return G.__firmBroker;
}

/** Erzwingt beim nächsten Zugriff ein erneutes Laden aus der DB. */
export function invalidateBrokerCache() {
  G.__firmHydrated = false;
}

export type AgentDecision = {
  type: "TRADE" | "KILL" | "HOLD" | "REPORT" | "APPROVE" | "REJECT";
  symbol?: string;
  side?: "LONG" | "SHORT";
  stopLossPct?: number;
  reason?: string;
  riskScore?: number;
};

/** Robustes Parsen: kleine Modelle liefern gern Prosa um das JSON herum. */
export function parseDecision(raw: string): AgentDecision {
  const text = (raw ?? "").trim();
  const candidates: string[] = [];

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) candidates.push(fenced[1]);
  const braced = text.match(/\{[\s\S]*\}/);
  if (braced) candidates.push(braced[0]);
  candidates.push(text);

  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c) as Partial<AgentDecision>;
      if (parsed && typeof parsed === "object") {
        const type = String(parsed.type ?? "").toUpperCase();
        const known: AgentDecision["type"][] = [
          "TRADE", "KILL", "HOLD", "REPORT", "APPROVE", "REJECT",
        ];
        return {
          ...parsed,
          type: (known as string[]).includes(type)
            ? (type as AgentDecision["type"])
            : parsed.symbol && parsed.side
              ? "TRADE"
              : "HOLD",
        } as AgentDecision;
      }
    } catch {
      /* nächsten Kandidaten probieren */
    }
  }
  // Nicht parsebar = keine Aktion. Niemals raten, wenn Geld im Spiel ist.
  return { type: "HOLD", reason: "Antwort des Modells war kein gültiges JSON." };
}

export async function getConfiguredLimit(key: string, fallback: number): Promise<number> {
  const rows = await db.select().from(riskConfig).where(eq(riskConfig.key, key));
  return rows.length ? Number(rows[0].value) : fallback;
}

export async function logAudit(
  event: string,
  level: "INFO" | "WARN" | "CRITICAL",
  detail: unknown,
  missionId?: string,
  agentId?: string
) {
  await db.insert(auditLog).values({
    event,
    level,
    detail: detail as object,
    missionId,
    agentId,
  });
}

export type TurnResult = {
  status: "EXECUTED" | "BLOCKED" | "HOLD" | "KILLED" | "REPORT" | "NOOP";
  decision: AgentDecision;
  source: "ollama" | "fallback";
  model: string;
  latencyMs: number;
  fill?: unknown;
  guardrail?: string;
};

/** Führt genau einen Agenten-Turn gegen eine Mission aus. */
export async function runAgentTurn(agentId: string, missionId: string): Promise<TurnResult> {
  const agent = (await db.select().from(agentTable).where(eq(agentTable.id, agentId)))[0];
  const mission = (await db.select().from(missions).where(eq(missions.id, missionId)))[0];
  if (!agent) throw new Error("Agent nicht gefunden");
  if (!mission) throw new Error("Mission nicht gefunden");

  const broker = await getBroker();

  // Automatischer Not-Halt bei Drawdown — vor jeder Modellabfrage geprüft.
  const maxDd = await getConfiguredLimit("maxEquityDrawdownPct", RISK_LIMITS.maxEquityDrawdownPct);
  if (broker.drawdownPct > maxDd && !killSwitch.isArmed()) {
    killSwitch.pull(`DRAWDOWN ${(broker.drawdownPct * 100).toFixed(1)}% > ${(maxDd * 100).toFixed(1)}%`);
    await db.insert(killSwitches).values({
      reason: `AUTO_DRAWDOWN_${(broker.drawdownPct * 100).toFixed(1)}%`,
      triggeredBy: "RISK_ENGINE",
      armed: true,
    });
    await logAudit("KILL_SWITCH", "CRITICAL", { drawdownPct: broker.drawdownPct }, missionId, agentId);
  }

  const symbolHint = (mission.symbol ?? "SPY").toUpperCase();
  const userPrompt = [
    `MISSION: ${mission.objective}`,
    `SYMBOL=${symbolHint}`,
    `KONTO: Equity ${broker.accountEquity.toFixed(2)}, freies Cash ${broker.freeCash.toFixed(2)}, offene Positionen ${broker.openPositions}/${RISK_LIMITS.maxConcurrentPositions}.`,
    `RISIKOBUDGET: max ${(Number(mission.riskBudget) * 100).toFixed(1)} % Risiko pro Trade, max ${(Number(mission.maxPositionPct) * 100).toFixed(0)} % Positionsgröße.`,
    `HARTE REGELN (werden ohnehin im Code erzwungen): nur LONG, Stop-Loss verpflichtend, kein Hebel.`,
    ``,
    `Antworte AUSSCHLIESSLICH mit einem JSON-Objekt:`,
    `{"type":"TRADE|HOLD|REPORT|APPROVE|REJECT","symbol":"${symbolHint}","side":"LONG","stopLossPct":5,"reason":"kurze Begründung","riskScore":0.4}`,
  ].join("\n");

  const brain = await localReason(agent.model, agent.systemPrompt, userPrompt, agent.role);
  const decision = parseDecision(brain.raw);

  await db.insert(agentMessages).values({
    agentId,
    missionId,
    type: "REPORT",
    content: decision.reason ?? brain.raw.slice(0, 500),
    meta: { decision, source: brain.source, model: brain.model, latencyMs: brain.latencyMs },
  });
  await logAudit(
    "AGENT_DECISION",
    "INFO",
    { role: agent.role, decision, source: brain.source, model: brain.model, latencyMs: brain.latencyMs },
    missionId,
    agentId
  );

  const base = { decision, source: brain.source, model: brain.model, latencyMs: brain.latencyMs };

  switch (decision.type) {
    case "KILL": {
      killSwitch.pull(decision.reason ?? "Agent hat Not-Halt angefordert");
      await db.insert(killSwitches).values({
        reason: decision.reason ?? "AGENT_REQUESTED",
        triggeredBy: agent.name,
        armed: true,
      });
      await db.update(missions).set({ status: "KILLED", updatedAt: new Date() }).where(eq(missions.id, missionId));
      await logAudit("KILL_SWITCH", "CRITICAL", { by: agent.name }, missionId, agentId);
      return { ...base, status: "KILLED" };
    }

    case "REPORT":
    case "APPROVE":
    case "REJECT":
      return { ...base, status: "REPORT" };

    case "TRADE": {
      // --- Engine-Validierung (Schicht 2), bevor überhaupt eine Order entsteht ---
      if (killSwitch.isArmed()) {
        await logAudit("ORDER_REJECTED", "WARN", { reason: "KILL_SWITCH_ARMED" }, missionId, agentId);
        return { ...base, status: "BLOCKED", guardrail: "KILL_SWITCH_ARMED" };
      }
      if (agent.role !== "EXECUTOR" && agent.role !== "RESEARCH") {
        await logAudit("ORDER_REJECTED", "WARN", { reason: "ROLE_NOT_ALLOWED_TO_TRADE", role: agent.role }, missionId, agentId);
        return { ...base, status: "BLOCKED", guardrail: `Rolle ${agent.role} darf keine Orders auslösen` };
      }

      const symbol = (decision.symbol ?? symbolHint).toUpperCase();
      const price = broker.quote(symbol);
      if (price === null) {
        await logAudit("ORDER_REJECTED", "WARN", { reason: "NO_QUOTE", symbol }, missionId, agentId);
        return { ...base, status: "BLOCKED", guardrail: `Kein Kurs für ${symbol}` };
      }

      const stopPct = clamp(decision.stopLossPct ?? RISK_LIMITS.defaultStopLossPct * 100, 0.5, 50) / 100;
      const missionRisk = Number(mission.riskBudget) || RISK_LIMITS.maxRiskPerTrade;
      const notional = riskAdjustedSize(broker.accountEquity, stopPct, missionRisk);
      const qty = Number((notional / price).toFixed(6));
      const stopLossPrice = Number((price * (1 - stopPct)).toFixed(2));

      const order = {
        symbol,
        side: "LONG" as const,
        qty,
        riskNotional: notional,
        stopLoss: stopLossPrice,
      };

      // --- Approver-Stufe: erst ein Vorschlag, dann (ggf.) die Ausführung ---
      const requireApproval = process.env.REQUIRE_HUMAN_APPROVAL === "true";
      const [proposal] = await db
        .insert(proposals)
        .values({
          missionId,
          agentId,
          action: "OPEN",
          proposedDetail: { ...order, stopLossPct: stopPct, reason: decision.reason ?? "" },
          riskScore: String(decision.riskScore ?? 0.5),
          status: requireApproval ? "PENDING" : "APPROVED",
          reviewedAt: requireApproval ? null : new Date(),
        })
        .returning();

      if (requireApproval) {
        await logAudit("APPROVAL_REQUIRED", "WARN", { proposalId: proposal.id, order }, missionId, agentId);
        return { ...base, status: "BLOCKED", guardrail: "Wartet auf menschliche Freigabe (REQUIRE_HUMAN_APPROVAL=true)" };
      }

      // --- Schicht 3–5: Guardrails + Broker-Schleuse ---
      const fill = broker.submit(order);
      await logAudit(fill.status === "FILLED" ? "ORDER_SENT" : "ORDER_REJECTED",
        fill.status === "FILLED" ? "INFO" : "WARN", { order, fill }, missionId, agentId);

      if (fill.status !== "FILLED") {
        await db.update(proposals).set({ status: "AUTO_REJECTED", reason: fill.reason }).where(eq(proposals.id, proposal.id));
        return { ...base, status: "BLOCKED", fill, guardrail: fill.reason };
      }

      await db.insert(positions).values({
        symbol: fill.symbol,
        side: fill.side,
        qty: String(fill.qty),
        entryPrice: String(fill.fillPrice),
        currentPrice: String(fill.fillPrice),
        stopLoss: fill.stopLoss === null ? null : String(fill.stopLoss),
        broker: broker.name,
        missionId,
        status: "OPEN",
      });
      await db.update(missions).set({ status: "ACTIVE", updatedAt: new Date() }).where(eq(missions.id, missionId));

      return { ...base, status: "EXECUTED", fill };
    }

    case "HOLD":
    default:
      return { ...base, status: "HOLD" };
  }
}

/** Alle offenen Positionen glattstellen (Notfall-Runbook). */
export async function flattenAll(reason: string) {
  const broker = await getBroker();
  const fills = broker.closeAll();
  await db
    .update(positions)
    .set({ status: "CLOSED", updatedAt: new Date() })
    .where(eq(positions.status, "OPEN"));
  await logAudit("FLATTEN_ALL", "CRITICAL", { reason, closed: fills.length });
  return fills;
}

/** Führt alle Agenten einer Mission in fester Reihenfolge aus (sequenzielle Pipeline). */
export async function runPipeline(missionId: string) {
  const order = ["CEO", "RESEARCH", "BACKTEST", "RISK_MANAGER", "APPROVER", "EXECUTOR"];
  const team = await db.select().from(agentTable);
  const sorted = team
    .filter((a) => order.includes(a.role))
    .sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role));

  const results: { agent: string; role: string; result: TurnResult }[] = [];
  for (const agent of sorted) {
    // Nach einem Not-Halt bricht die Pipeline sofort ab.
    if (killSwitch.isArmed()) break;
    const result = await runAgentTurn(agent.id, missionId);
    results.push({ agent: agent.name, role: agent.role, result });
    if (result.status === "EXECUTED" || result.status === "KILLED") break;
  }
  return results;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export const _internal = { and, sql };
