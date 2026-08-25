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
  equitySnapshots,
  killSwitches,
  missions,
  positions,
  proposals,
} from "@/db/schema";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { RISK_LIMITS, getLimits, killSwitch, riskAdjustedSize, type RiskLimits } from "./riskGuard";
import { PaperBroker } from "./broker";
import { localReason } from "./ollama";
import { getCandles, getQuote, sanitizeSymbol } from "./marketData";
import { snapshot, snapshotLine, type MarketSnapshot } from "./indicators";
import { refreshRuntimeLimits } from "./riskConfigService";
import { getHouseView } from "./analysts";
import { writeEquitySnapshot } from "./equity";
import { startOfBerlinDay } from "./time";

const G = globalThis as typeof globalThis & {
  __firmBroker?: PaperBroker;
  __firmHydrated?: boolean;
};

/**
 * Liefert den Paper-Broker und stellt beim ersten Zugriff nach einem Prozessstart
 * den Zustand aus PostgreSQL wieder her (offene Positionen + Kill-Switch-Status).
 * Nötig, weil systemd den Dienst neu starten kann, die Buchhaltung aber persistent ist.
 *
 * FEHLERBEHANDLUNG: Fehlen die Tabellen (relation does not exist), weil
 * `drizzle-kit push` noch nicht lief, startet der Broker trotzdem mit leerem
 * Zustand. Der Fehler wird im Audit-Log protokolliert und die App zeigt eine
 * Setup-Warnung — sie stürzt nicht ab.
 */
export async function getBroker(): Promise<PaperBroker> {
  G.__firmBroker ??= new PaperBroker(Number(process.env.STARTING_EQUITY || 10000));

  if (!G.__firmHydrated) {
    try {
      const openRows = await db
        .select()
        .from(positions)
        .where(eq(positions.status, "OPEN"));

      // KORRIGIERT (v1.1.0): Cash aus dem letzten persistenten Equity-Snapshot
      // übernehmen, statt ihn aus startEquity − Einstiegs-Notional zu rechnen.
      // Sonst gehen realisierte P&L und alle Gewinne/Verluste geschlossener
      // Trades bei einem Neustart (systemd, Deploy, Stromausfall) verloren.
      let cashHint: number | undefined;
      try {
        const latestSnap = await db
          .select({ cash: equitySnapshots.cash })
          .from(equitySnapshots)
          .orderBy(desc(equitySnapshots.ts))
          .limit(1);
        const cashNum = Number(latestSnap[0]?.cash);
        if (latestSnap[0] && Number.isFinite(cashNum) && cashNum >= 0) cashHint = cashNum;
      } catch {
        /* Snapshot-Tabelle fehlt/leer → Fallback auf alte Berechnung */
      }

      G.__firmBroker.hydrate(
        openRows.map((r) => ({
          symbol: r.symbol,
          side: r.side === "SHORT" ? ("SHORT" as const) : ("LONG" as const),
          qty: Number(r.qty),
          entryPrice: Number(r.entryPrice),
        })),
        { cashHint }
      );

      const lastKill = await db
        .select()
        .from(killSwitches)
        .orderBy(desc(killSwitches.createdAt))
        .limit(1);
      if (lastKill[0]?.armed) killSwitch.pull(`restored:${lastKill[0].reason}`);
      else killSwitch.disarm();

      G.__firmHydrated = true;
    } catch (e) {
      // Tabellen fehlen noch → `npx drizzle-kit push` muss noch ausgeführt werden.
      // Der Broker startet trotzdem mit leerem Zustand und vollem Startkapital.
      // Der Fehler wird beim nächsten Zugriff erneut versucht (kein true setzen).
      const msg = e instanceof Error ? e.message : String(e);
      const missingTable = msg.includes("relation") && msg.includes("does not exist");
      if (missingTable) {
        console.error(
          "[getBroker] Tabellen fehlen — bitte `npx drizzle-kit push` ausführen.\n" +
          "  Die Anwendung startet mit leerem Zustand, bis das Schema angelegt ist."
        );
        G.__firmHydrated = false; // erneut versuchen beim nächsten Request
      } else {
        console.error("[getBroker] Hydration fehlgeschlagen:", msg);
        G.__firmHydrated = false;
      }
    }
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

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Extrahiert das erste JSON-Objekt aus Modell-Prosa (Fences, umschließender Text).
 * Kopiert nur eigene, ungefährliche Schlüssel — kein Object-Spread untrusted JSON
 * (Prototype-Pollution, Extra-Felder in Orders/DB).
 * Analysten nutzen diese Funktion, weil ihre Payloads (view/thesis/…) über
 * AgentDecision hinausgehen.
 */
export function extractJsonObject(raw: string): Record<string, unknown> | null {
  const text = (raw ?? "").trim();
  const candidates: string[] = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) candidates.push(fenced[1]);
  const braced = text.match(/\{[\s\S]*\}/);
  if (braced) candidates.push(braced[0]);
  candidates.push(text);

  for (const c of candidates) {
    try {
      const parsed: unknown = JSON.parse(c);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(parsed as object)) {
        if (DANGEROUS_KEYS.has(key)) continue;
        out[key] = (parsed as Record<string, unknown>)[key];
      }
      return out;
    } catch {
      /* nächsten Kandidaten probieren */
    }
  }
  return null;
}

/** Robustes Parsen: kleine Modelle liefern gern Prosa um das JSON herum. */
export function parseDecision(raw: string): AgentDecision {
  const parsed = extractJsonObject(raw);
  if (!parsed) {
    return { type: "HOLD", reason: "Antwort des Modells war kein gültiges JSON." };
  }
  const typeRaw = String(parsed.type ?? "").toUpperCase();
  const known: AgentDecision["type"][] = [
    "TRADE", "KILL", "HOLD", "REPORT", "APPROVE", "REJECT",
  ];
  const symbol = typeof parsed.symbol === "string" ? parsed.symbol : undefined;
  const side =
    parsed.side === "SHORT" || parsed.side === "LONG"
      ? parsed.side
      : undefined;
  const type: AgentDecision["type"] = known.includes(typeRaw as AgentDecision["type"])
    ? (typeRaw as AgentDecision["type"])
    : symbol && side
      ? "TRADE"
      : "HOLD";
  const stopLossPct = Number(parsed.stopLossPct);
  const riskScore = Number(parsed.riskScore);
  const decision: AgentDecision = { type };
  if (symbol) decision.symbol = symbol;
  if (side) decision.side = side;
  if (Number.isFinite(stopLossPct)) decision.stopLossPct = stopLossPct;
  if (typeof parsed.reason === "string") decision.reason = parsed.reason;
  if (Number.isFinite(riskScore)) decision.riskScore = riskScore;
  return decision;
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
  /** Vollständige Entscheidungskette für das Protokoll (Schicht für Schicht). */
  trace?: TraceStep[];
};

export type TraceStep = {
  layer: string;
  ok: boolean;
  detail: string;
};

function step(layer: string, ok: boolean, detail: string): TraceStep {
  return { layer, ok, detail };
}

/** Menschlich lesbare Erklärung für Block-Gründe (Dashboard/Protokoll). */
export const BLOCK_EXPLANATIONS: Record<string, string> = {
  KILL_SWITCH_ARMED:
    "Der Not-Halt ist aktiv. Keine Orders möglich, bis ein Mensch ihn entschärft.",
  ROLE_NOT_ALLOWED_TO_TRADE:
    "Diese Rolle darf per Mandat keine Orders geben — nur Research und Executor. Der Vorschlag wird protokolliert und verworfen; die Pipeline delegiert die Ausführung an die zuständige Rolle.",
  NO_QUOTE:
    "Für dieses Symbol existiert kein Kurs (weder live noch Fallback). Order sicherheitshalber abgelehnt statt geraten.",
  POSITION_ALREADY_OPEN:
    "Es ist bereits eine Position in diesem Symbol offen. Nachkauf ist gesperrt, damit wiederholte Läufe nicht unbemerkt Kapital häufen.",
  INSUFFICIENT_CASH:
    "Das freie Kapital reicht für die Ordergröße nicht aus (Hebel > 1 ist verboten).",
  DAILY_LOSS_LIMIT:
    "Das Tagesverlust-Limit ist erreicht. Für den Rest des Tages sind keine Neueröffnungen mehr erlaubt.",
  COOLDOWN_AFTER_LOSSES:
    "Verlustserie erreicht — Cooldown aktiv. Das System macht Pause, statt Verlusten hinterherzuhandeln.",
  APPROVAL_REQUIRED:
    "REQUIRE_HUMAN_APPROVAL=true: Der Vorschlag wartet auf menschliche Freigabe.",
  INVALID_SYMBOL:
    "Das vom Modell gelieferte Symbol entspricht nicht dem erlaubten Format (A–Z, 0–9, max. 12 Zeichen, optional .XYZ bzw. =X). Abgelehnt statt geraten.",
};

/** Führt genau einen Agenten-Turn gegen eine Mission aus. */
export async function runAgentTurn(agentId: string, missionId: string): Promise<TurnResult> {
  const agent = (await db.select().from(agentTable).where(eq(agentTable.id, agentId)))[0];
  const mission = (await db.select().from(missions).where(eq(missions.id, missionId)))[0];
  if (!agent) throw new Error("Agent nicht gefunden");
  if (!mission) throw new Error("Mission nicht gefunden");

  // Laufzeit-Limits frisch aus der DB (geklemmt auf Code-Ceilings).
  await refreshRuntimeLimits(true);
  const limits: RiskLimits = getLimits();
  const trace: TraceStep[] = [step("CONFIG", true, `Limits geladen (maxPos=${(limits.maxPositionPct * 100).toFixed(0)}%, dailyLoss=${(limits.dailyLossLimitPct * 100).toFixed(1)}%, shorts=${limits.allowShort ? "an" : "aus"})`)];

  const broker = await getBroker();

  // Automatischer Not-Halt bei Drawdown — vor jeder Modellabfrage geprüft.
  if (broker.drawdownPct > limits.maxEquityDrawdownPct && !killSwitch.isArmed()) {
    killSwitch.pull(`DRAWDOWN ${(broker.drawdownPct * 100).toFixed(1)}% > ${(limits.maxEquityDrawdownPct * 100).toFixed(1)}%`);
    await db.insert(killSwitches).values({
      reason: `AUTO_DRAWDOWN_${(broker.drawdownPct * 100).toFixed(1)}%`,
      triggeredBy: "RISK_ENGINE",
      armed: true,
    });
    await logAudit("KILL_SWITCH", "CRITICAL", { drawdownPct: broker.drawdownPct }, missionId, agentId);
  }

  const symbolHint = sanitizeSymbol(mission.symbol ?? "SPY") ?? "SPY";

  // --- Markt-Kontext: Indikatoren für das Missionssymbol + Multi-Market-Blick ---
  let marketContext = "";
  let snap: MarketSnapshot | null = null;
  try {
    const candles = await getCandles(symbolHint, "15m", 120);
    snap = snapshot(symbolHint, candles);
    if (snap) {
      trace.push(step("MARKET_DATA", true, `Kurs ${snap.price}, RSI ${snap.rsi14}, Trend ${snap.trend}${snap.atrPercent != null ? `, ATR ${snap.atrPercent}%` : ""}`));
      marketContext += `\nMARKTDATEN ${symbolHint}: ${snapshotLine(snap)}\n`;
    } else {
      marketContext += `\nMARKTDATEN ${symbolHint}: keine Kerzendaten verfügbar.\n`;
    }
  } catch (e) {
    trace.push(step("MARKET_DATA", false, `Kein Marktkontext: ${e instanceof Error ? e.message : e}`));
  }
  marketContext += `(Regel: RSI>70 überkauft, RSI<30 überverkauft, EMA9>EMA21=Aufwärtstrend)\n`;

  // --- Performance-Kontext: KPIs abgeschlossener Trades dieser Mission ---
  const closedRows = await db
    .select()
    .from(positions)
    .where(and(eq(positions.status, "CLOSED"), eq(positions.missionId, missionId)))
    .orderBy(desc(positions.updatedAt))
    .limit(50);
  const pnls = closedRows.map((r) => Number(r.realizedPnl ?? 0));
  const wins = pnls.filter((p) => p > 0);
  const lossesArr = pnls.filter((p) => p <= 0);
  const winRate = pnls.length ? wins.length / pnls.length : null;
  const grossProfit = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(lossesArr.reduce((a, b) => a + b, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : null;
  const totalPnl = pnls.reduce((a, b) => a + b, 0);

  // --- Tagesverlust & Verlustserie-Cooldowen ---
  // KORRIGIERT (v1.1.0): Berliner Tagesgrenze statt Server-Localtime — konsistent
  // zu monitor.tick() und equity.realizedPnlToday() (systemd läuft oft mit UTC).
  const todayStart = startOfBerlinDay();
  const todaysClosed = await db
    .select()
    .from(positions)
    .where(and(eq(positions.status, "CLOSED"), gte(positions.updatedAt, todayStart)));
  const dayPnl = todaysClosed.reduce((a, r) => a + Number(r.realizedPnl ?? 0), 0);
  const dailyLossHit =
    broker.startingEquity > 0 && -dayPnl / broker.startingEquity >= limits.dailyLossLimitPct;

  const recentSorted = [...closedRows].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
  let consecLosses = 0;
  for (const r of recentSorted) {
    if (Number(r.realizedPnl ?? 0) < 0) consecLosses++;
    else break;
  }
  const COOLDOWN_AFTER_N_LOSSES = 3;
  const inCooldown = consecLosses >= COOLDOWN_AFTER_N_LOSSES;

  const HOUSE_VIEW_ROLES = ["CEO", "RESEARCH", "RISK_MANAGER", "APPROVER"];
  let houseContext = "";
  if (HOUSE_VIEW_ROLES.includes(agent.role)) {
    try {
      houseContext = await getHouseView(3, 12);
    } catch {
      /* Analysten-Kontext ist optional */
    }
  }

  const kpiContext = [
    `\nPERFORMANCE (diese Mission, letzte ${pnls.length} Trades):`,
    `Gesamt-PnL ${totalPnl.toFixed(2)}, Win-Rate ${winRate != null ? (winRate * 100).toFixed(0) + "%" : "n/a"}, Profit-Faktor ${profitFactor != null ? profitFactor.toFixed(2) : "n/a"}.`,
    `Heute: PnL ${dayPnl.toFixed(2)} (Tageslimit -${(limits.dailyLossLimitPct * 100).toFixed(1)}% des Kapitals).`,
    inCooldown ? `ACHTUNG: ${consecLosses} Verluste in Folge — Cooldown aktiv, empfiehlt HOLD.` : "",
  ].filter(Boolean).join("\n");

  const userPrompt = [
    `MISSION: ${mission.objective}`,
    `SYMBOL=${symbolHint}`,
    `KONTO: Equity ${broker.accountEquity.toFixed(2)}, freies Cash ${broker.freeCash.toFixed(2)}, offene Positionen ${broker.openPositions}/${limits.maxConcurrentPositions}.`,
    `RISIKOBUDGET: max ${(Number(mission.riskBudget) * 100).toFixed(1)} % Risiko pro Trade, max ${(Number(mission.maxPositionPct) * 100).toFixed(0)} % Positionsgröße.`,
    `HARTE REGELN (werden ohnehin im Code erzwungen): Stop-Loss verpflichtend, kein Hebel${limits.allowShort ? ", Long und Short erlaubt" : ", nur Long"}.`,
    marketContext,
    kpiContext,
    houseContext,
    ``,
    `Antworte AUSSCHLIESSLICH mit einem JSON-Objekt:`,
    `{"type":"TRADE|HOLD|REPORT|APPROVE|REJECT","symbol":"${symbolHint}","side":"${limits.allowShort ? "LONG|SHORT" : "LONG"}","stopLossPct":${snap?.atrPercent != null ? Math.max(1, Math.min(20, snap.atrPercent * limits.atrStopMultiplier)).toFixed(1) : 5},"reason":"kurze Begründung","riskScore":0.4}`,
  ].join("\n");

  const brain = await localReason(agent.model, agent.systemPrompt, userPrompt, agent.role);
  const decision = parseDecision(brain.raw);

  await db.insert(agentMessages).values({
    agentId,
    missionId,
    type: "REPORT",
    content: decision.reason ?? brain.raw.slice(0, 500),
    meta: {
      decision,
      source: brain.source,
      model: brain.model,
      latencyMs: brain.latencyMs,
      prompt: userPrompt,
      rawResponse: brain.raw.slice(0, 2000),
      provider: brain.provider,
      usage: brain.usage,
      costUsd: brain.costUsd,
    },
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
        trace.push(step("KILL-SWITCH", false, "Not-Halt aktiv"));
        return { ...base, status: "BLOCKED", guardrail: "KILL_SWITCH_ARMED", trace };
      }
      trace.push(step("KILL-SWITCH", true, "Nicht aktiv"));

      if (agent.role !== "EXECUTOR" && agent.role !== "RESEARCH") {
        await logAudit("ORDER_REJECTED", "WARN", { reason: "ROLE_NOT_ALLOWED_TO_TRADE", role: agent.role }, missionId, agentId);
        trace.push(step("ROLLEN-PRÜFUNG", false, `${agent.role} darf keine Orders geben (nur EXECUTOR/RESEARCH)`));
        return { ...base, status: "BLOCKED", guardrail: `Rolle ${agent.role} darf keine Orders auslösen`, trace };
      }
      trace.push(step("ROLLEN-PRÜFUNG", true, `${agent.role} ist handelsberechtigt`));

      const side = decision.side === "SHORT" ? ("SHORT" as const) : ("LONG" as const);
      if (side === "SHORT" && !limits.allowShort) {
        await logAudit("ORDER_REJECTED", "WARN", { reason: "SHORT_DISABLED" }, missionId, agentId);
        trace.push(step("SHORT-SPERRE", false, "Shorts sind in der Konfiguration deaktiviert"));
        return { ...base, status: "BLOCKED", guardrail: "side:short-trading-disabled", trace };
      }

      if (dailyLossHit) {
        await logAudit("ORDER_REJECTED", "WARN", { reason: "DAILY_LOSS_LIMIT", dayPnl }, missionId, agentId);
        trace.push(step("TAGESVERLUSS", false, `Heute ${dayPnl.toFixed(2)} — Limit erreicht`));
        return { ...base, status: "BLOCKED", guardrail: "DAILY_LOSS_LIMIT", trace };
      }
      if (inCooldown) {
        await logAudit("ORDER_REJECTED", "WARN", { reason: "COOLDOWN_AFTER_LOSSES", consecLosses }, missionId, agentId);
        trace.push(step("COOLDOWN", false, `${consecLosses} Verluste in Folge`));
        return { ...base, status: "BLOCKED", guardrail: "COOLDOWN_AFTER_LOSSES", trace };
      }
      trace.push(step("TAGESVERLUSS/COOLDOWN", true, `Tag ${dayPnl.toFixed(2)}, Serie ${consecLosses}`));

      // KORRIGIERT (v1.1.0): Symbol-Whitelist — Modell-Output darf keine
      // Sonderzeichen (URL/Query/SQL/Prompt-Injection) einschleusen.
      const symbol = sanitizeSymbol(decision.symbol ?? symbolHint);
      if (!symbol) {
        await logAudit("ORDER_REJECTED", "WARN", { reason: "INVALID_SYMBOL", raw: String(decision.symbol).slice(0, 40) }, missionId, agentId);
        trace.push(step("SYMBOL-PRÜFUNG", false, `Ungültiges Symbol: ${String(decision.symbol).slice(0, 40)}`));
        return { ...base, status: "BLOCKED", guardrail: "INVALID_SYMBOL", trace };
      }
      trace.push(step("SYMBOL-PRÜFUNG", true, symbol));

      let price = broker.quote(symbol);
      if (price === null) {
        try {
          price = (await getQuote(symbol)).price;
          trace.push(step("KURS", true, `Live-Kurs geholt: ${price}`));
        } catch {
          price = null;
        }
      }
      if (price === null) {
        await logAudit("ORDER_REJECTED", "WARN", { reason: "NO_QUOTE", symbol }, missionId, agentId);
        trace.push(step("KURS", false, `Kein Kurs für ${symbol}`));
        return { ...base, status: "BLOCKED", guardrail: `Kein Kurs für ${symbol}`, trace };
      }
      trace.push(step("KURS", true, `${symbol} @ ${price}`));

      // Stop-Loss: Agent-Angabe → sonst dynamisch aus ATR (Volatilitäts-basiert).
      // KORRIGIERT (v1.1.0): nicht-zahlfähige Werte (NaN/„abc") gelten als
      // „keine Angabe" → ATR-/Default-Fallback statt kaputter NaN-Order.
      const rawModelStop = Number(decision.stopLossPct);
      const modelStopPct = Number.isFinite(rawModelStop)
        ? clamp(rawModelStop, 0.5, 50)
        : null;
      const atrStop = snap?.atrPercent != null ? snap.atrPercent * limits.atrStopMultiplier : null;
      const stopPctPrelim = modelStopPct ?? atrStop ?? limits.defaultStopLossPct * 100;
      const stopPct = clamp(stopPctPrelim, 0.5, 50) / 100;

      const missionRisk = Number(mission.riskBudget) || limits.maxRiskPerTrade;
      const notional = riskAdjustedSize(broker.accountEquity, stopPct, Math.min(missionRisk, limits.maxRiskPerTrade));
      const qty = Number((notional / price).toFixed(6));
      const stopLossPrice =
        side === "LONG"
          ? Number((price * (1 - stopPct)).toFixed(price > 100 ? 2 : 6))
          : Number((price * (1 + stopPct)).toFixed(price > 100 ? 2 : 6));
      const tpDist = stopPct * limits.takeProfitRR;
      const takeProfitPrice =
        side === "LONG"
          ? Number((price * (1 + tpDist)).toFixed(price > 100 ? 2 : 6))
          : Number((price * (1 - tpDist)).toFixed(price > 100 ? 2 : 6));

      trace.push(
        step("POSITION-SIZING", true,
          `Stop ${(stopPct * 100).toFixed(1)}% (${modelStopPct != null ? "Agent" : atrStop != null ? "ATR×" + limits.atrStopMultiplier : "Default"}) → Notional ${notional.toFixed(2)}, TP bei ${takeProfitPrice}`)
      );

      const order = {
        symbol,
        side,
        qty,
        riskNotional: notional,
        stopLoss: stopLossPrice,
        takeProfit: takeProfitPrice,
      };

      // --- Approver-Stufe: erst ein Vorschlag, dann (ggf.) die Ausführung ---
      const requireApproval = process.env.REQUIRE_HUMAN_APPROVAL === "true";
      // KORRIGIERT (v1.1.0): riskScore auf [0,1] normalisieren — Strings oder
      // Objekte aus dem Modell-Output sprechen sonst die numeric-Spalte.
      const rawRisk = Number(decision.riskScore);
      const riskScore = Number.isFinite(rawRisk)
        ? Math.min(Math.max(rawRisk, 0), 1)
        : 0.5;
      const [proposal] = await db
        .insert(proposals)
        .values({
          missionId,
          agentId,
          action: "OPEN",
          proposedDetail: { ...order, stopLossPct: stopPct, reason: decision.reason ?? "" },
          riskScore: String(riskScore),
          status: requireApproval ? "PENDING" : "APPROVED",
          reviewedAt: requireApproval ? null : new Date(),
        })
        .returning();

      if (requireApproval) {
        await logAudit("APPROVAL_REQUIRED", "WARN", { proposalId: proposal.id, order }, missionId, agentId);
        trace.push(step("APPROVAL", false, "Wartet auf menschliche Freigabe"));
        return { ...base, status: "BLOCKED", guardrail: "Wartet auf menschliche Freigabe (REQUIRE_HUMAN_APPROVAL=true)", trace };
      }
      trace.push(step("APPROVAL", true, "Automatisch freigegeben (REQUIRE_HUMAN_APPROVAL=false)"));

      // --- Schicht 3–5: Guardrails + Broker-Schleuse ---
      const fill = broker.submit(order);
      await logAudit(fill.status === "FILLED" ? "ORDER_SENT" : "ORDER_REJECTED",
        fill.status === "FILLED" ? "INFO" : "WARN", { order, fill }, missionId, agentId);

      if (fill.status !== "FILLED") {
        await db.update(proposals).set({ status: "AUTO_REJECTED", reason: fill.reason }).where(eq(proposals.id, proposal.id));
        trace.push(step("GUARDRAILS/BROKER", false, fill.reason ?? "abgelehnt"));
        return { ...base, status: "BLOCKED", fill, guardrail: fill.reason, trace };
      }
      trace.push(step("GUARDRAILS/BROKER", true, `Gefüllt @ ${fill.fillPrice}, SL ${fill.stopLoss}, TP ${fill.takeProfit}`));

      await db.insert(positions).values({
        symbol: fill.symbol,
        side: fill.side,
        qty: String(fill.qty),
        entryPrice: String(fill.fillPrice),
        currentPrice: String(fill.fillPrice),
        stopLoss: fill.stopLoss === null ? null : String(fill.stopLoss),
        takeProfit: fill.takeProfit === null ? null : String(fill.takeProfit),
        broker: broker.name,
        missionId,
        status: "OPEN",
      });
      await db.update(missions).set({ status: "ACTIVE", updatedAt: new Date() }).where(eq(missions.id, missionId));
      try {
        await writeEquitySnapshot(broker.accountEquity, broker.freeCash, broker.openPositions, "TRADE");
      } catch {
        /* Kurvenpunkt ist optional — das Orderbuch ist bereits sicher */
      }

      return { ...base, status: "EXECUTED", fill, trace };
    }

    case "HOLD":
    default:
      return { ...base, status: "HOLD", trace };
  }
}

/** Alle offenen Positionen glattstellen (Notfall-Runbook). */
export async function flattenAll(reason: string) {
  const broker = await getBroker();
  const fills = broker.closeAll(reason === "MANUAL_FLATTEN" ? "MANUAL_FLATTEN" : reason);
  for (const f of fills) {
    await db
      .update(positions)
      .set({
        status: "CLOSED",
        exitPrice: String(f.fillPrice),
        realizedPnl: String(f.realizedPnl),
        exitReason: reason,
        updatedAt: new Date(),
      })
      .where(and(eq(positions.status, "OPEN"), eq(positions.symbol, f.symbol)));
  }
  await logAudit("FLATTEN_ALL", "CRITICAL", { reason, closed: fills.length, fills });
  try {
    await writeEquitySnapshot(broker.accountEquity, broker.freeCash, broker.openPositions, "FLATTEN");
  } catch {
    /* Kurvenpunkt optional */
  }
  return fills;
}

const PIPELINE_G = globalThis as typeof globalThis & { __pipelineBusy?: boolean };

/**
 * Führt alle Agenten einer Mission in fester Reihenfolge aus (sequenzielle Pipeline).
 *
 * KORRIGIERT (v1.1.0): Single-Flight-Schutz — zwei gleichzeitig eintreffende
 * Pipeline-Requests (Doppelklick im Dashboard, Cron + manuell) liefen vorher
 * parallel und erzeugten doppelte Vorschläge/Audit-Einträge. Der zweite Aufruf
 * wirft jetzt PIPELINE_ALREADY_RUNNING (API → HTTP 409).
 */
export async function runPipeline(missionId: string) {
  if (PIPELINE_G.__pipelineBusy) {
    throw new Error("PIPELINE_ALREADY_RUNNING");
  }
  PIPELINE_G.__pipelineBusy = true;
  try {
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
  } finally {
    PIPELINE_G.__pipelineBusy = false;
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export const _internal = { and, sql };
