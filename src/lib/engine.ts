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
  equitySnapshots,
  killSwitches,
  missions,
  positions,
  proposals,
} from "@/db/schema";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import {
  writeAuditRecord,
  flagMissedAudit,
  type AuditClass,
  type AuditWriteOutcome,
} from "./auditSink";
import { RISK_LIMITS, getLimits, killSwitch, missionSizedNotional, type RiskLimits } from "./riskGuard";
import { PaperBroker } from "./broker";
import { getBroker as createBroker } from "../brokers/factory";
import { VENUE_CAPABILITIES } from "../brokers/capabilities";
import { platformLiveFromEnv, venueEnabledFromEnv, venueLiveFlagFromEnv } from "../live-gate/config";
import type { EmergencyBroker, EmergencyCloseFill } from "../contracts/broker";
import { localReason } from "./ollama";
import { getCandles, getQuote, sanitizeSymbol } from "./marketData";
import { getProductionMarketDataManager, wirePaperExecution } from "./marketdata/production";
import { snapshot, snapshotLine, type MarketSnapshot } from "./indicators";
import { refreshRuntimeLimits } from "./riskConfigService";
import { ensureAdaptiveRiskFresh, getAdaptiveRiskStatus } from "./adaptiveRisk";
import { getHouseView } from "./analysts";
import { isSymbolInMissionScope, missionUniverseContext } from "./missionUniverse";
import { writeEquitySnapshot } from "./equity";
import { startOfBerlinDay } from "./time";

const G = globalThis as typeof globalThis & {
  __firmHydrated?: boolean;
};

/**
 * Liefert den Paper-Broker und stellt beim ersten Zugriff nach einem Prozessstart
 * den Zustand aus PostgreSQL wieder her (offene Positionen + Kill-Switch-Status).
 * Nötig, weil systemd den Dienst neu starten kann, die Buchhaltung aber persistent ist.
 *
 * TASK 02 (Broker-Capability-Modell): Die Engine erzeugt keinen Broker mehr
 * selbst — der Adapter kommt ausschließlich aus der Broker-Factory
 * (`getBroker("PAPER", "paper")` in src/brokers/factory.ts). Der Ledger ist
 * dort ein Prozess-Singleton; die Hydration aus PostgreSQL bleibt in der
 * Engine (DB-Wahrheit). Das Rückgabetyp bleibt `PaperBroker` — alle
 * bestehenden Aufrufer (Monitor, API, runAgentTurn, flattenAll) sind
 * bytekompatibel.
 *
 * FEHLERBEHANDLUNG: Fehlen die Tabellen (relation does not exist), weil
 * `drizzle-kit push` noch nicht lief, startet der Broker trotzdem mit leerem
 * Zustand. Der Fehler wird im Audit-Log protokolliert und die App zeigt eine
 * Setup-Warnung — sie stürzt nicht ab.
 */
export async function getBroker(): Promise<PaperBroker> {
  const adapter = await createBroker("PAPER", "paper");
  // Duck-Type statt instanceof: prüft, ob das PAPER-spezifische Feld
  // vorhanden ist. Robuster gegen Build-Cache-Drift und Next.js-
  // Modul-Recompilierung (klassisches Problem: nach v1.36.0 lieferte die
  // Factory manchmal einen anderen Klassenmodul-Identifier, sodass
  // instanceof false wurde — obwohl der Adapter technisch ein
  // PaperBrokerAdapter war).
  const adapterAny = adapter as unknown as { paperBroker?: PaperBroker };
  if (!adapterAny || typeof adapterAny.paperBroker === "undefined") {
    throw new Error("UNEXPECTED_BROKER_ADAPTER: PAPER-Adapter erwartet (paperBroker fehlt)");
  }
  const broker = adapterAny.paperBroker;
  // TASK 03: Modus-B-Ausführungs-Adapter (echte Kurse + deterministischer
  // Fill-Simulator) einmal in den Ledger injizieren. Idempotent.
  wirePaperExecution(broker);

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

      broker.hydrate(
        openRows.map((r) => ({
          symbol: r.symbol,
          side: r.side === "SHORT" ? ("SHORT" as const) : ("LONG" as const),
          qty: Number(r.qty),
          entryPrice: Number(r.entryPrice),
          // KORRIGIERT (v1.5.2): SL/TP mithydratieren — sonst zeigt das
          // Dashboard nach einem Neustart „kein Stop-Loss", obwohl die
          // Schutzebenen (Monitor) weiterhin aus der DB prüfen. Der Broker-
          // Zustand soll dieselbe Wahrheit zeigen wie die Datenbank.
          stopLoss:
            r.stopLoss != null && Number.isFinite(Number(r.stopLoss))
              ? Number(r.stopLoss)
              : null,
          takeProfit:
            r.takeProfit != null && Number.isFinite(Number(r.takeProfit))
              ? Number(r.takeProfit)
              : null,
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

  return broker;
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

/**
 * Audit-Schreibvorgang (S1, v1.36.18).
 *
 * Neu im Vergleich zu „`db.insert` und hoffen“:
 *   - jede Zeile läuft durch die klassifizierte Senke (`src/lib/auditSink.ts`),
 *   - `security`-Audits (Default) retryen mit Backoff und landen bei DB-Ausfall
 *     im persistenten Spool (at-least-once) statt in einem leeren `catch`,
 *   - das Ergebnis wird zurückgegeben, damit Aufrufer eine Lücke melden können.
 *
 * `failClosed` (nur für Audits **vor** einer Mutation sinnvoll) lässt den
 * Aufrufer scheitern, wenn kein Auditbeleg durable ist — die Mutation bleibt
 * aus. Für Audits nach einer bereits vollzogenen Mutation wäre ein Wurf
 * kontraproduktiv (die Tat ist geschehen); dort wird gemeldet, nicht abgebrochen.
 */
export interface LogAuditOptions {
  /** Default `security` — keine stille Telemetrie für sicherheitsrelevante Events. */
  auditClass?: AuditClass;
  /** Abort der Operation, wenn das Audit nicht durable wird. */
  failClosed?: boolean;
  /** Spool-Fallback abschalten (nur Tests/Drills). */
  spool?: boolean;
}

export async function logAudit(
  event: string,
  level: "INFO" | "WARN" | "CRITICAL",
  detail: unknown,
  missionId?: string,
  agentId?: string,
  opts: LogAuditOptions = {}
): Promise<AuditWriteOutcome> {
  return writeAuditRecord({
    event,
    level,
    detail,
    missionId,
    agentId,
    auditClass: opts.auditClass ?? "security",
    failClosed: opts.failClosed,
    spool: opts.spool,
  });
}

export type TurnResult = {
  status: "EXECUTED" | "PROPOSED" | "BLOCKED" | "HOLD" | "KILLED" | "REPORT" | "NOOP";
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
export async function runAgentTurn(
  agentId: string,
  missionId: string,
  options: { proposalOnly?: boolean } = {}
): Promise<TurnResult> {
  const agent = (await db.select().from(agentTable).where(eq(agentTable.id, agentId)))[0];
  const mission = (await db.select().from(missions).where(eq(missions.id, missionId)))[0];
  if (!agent) throw new Error("Agent nicht gefunden");
  if (!mission) throw new Error("Mission nicht gefunden");

  // Laufzeit-Limits frisch aus der DB (geklemmt auf Code-Ceilings).
  await refreshRuntimeLimits(true);

  // Adaptives Risk-Limit (v1.7.0): Volatilitäts-Bewertung frische halten.
  // Normalerweise hat der Monitor-Tick (60 s) sie gerade aktualisiert; bei
  // Staleness/Erststart folgt hier eine sofortige Neubewertung (Single-Flight,
  // Fehler bleiben lokal — letzter Zustand bleibt wirksam).
  let adaptiveState: ReturnType<typeof getAdaptiveRiskStatus>;
  try {
    await ensureAdaptiveRiskFresh();
    adaptiveState = getAdaptiveRiskStatus();
  } catch (e) {
    adaptiveState = getAdaptiveRiskStatus();
    console.warn("[engine] Adaptives-Risiko-Update fehlgeschlagen:", e instanceof Error ? e.message : e);
  }

  const limits: RiskLimits = getLimits();
  const trace: TraceStep[] = [
    step("CONFIG", true, `Limits geladen (maxPos=${(limits.maxPositionPct * 100).toFixed(0)}%, dailyLoss=${(limits.dailyLossLimitPct * 100).toFixed(1)}%, shorts=${limits.allowShort ? "an" : "aus"})`),
    step(
      "ADAPTIVES-RISIKO",
      adaptiveState ? adaptiveState.regime !== "EXTREME" : true,
      adaptiveState
        ? `Regime ${adaptiveState.regime} → maxRiskPerTrade ${(adaptiveState.effectiveMaxRiskPerTrade * 100).toFixed(2)} % (Basis ${(adaptiveState.baseMaxRiskPerTrade * 100).toFixed(2)} % × ${adaptiveState.factor}) — ${adaptiveState.reason}`
        : "Keine Bewertung vorhanden — Basis-Limit aktiv (Fail-Open)"
    ),
  ];

  const broker = await getBroker();

  // Automatischer Not-Halt bei Drawdown — vor jeder Modellabfrage geprüft.
  if (broker.drawdownPct > limits.maxEquityDrawdownPct && !killSwitch.isArmed()) {
    killSwitch.pull(`DRAWDOWN ${(broker.drawdownPct * 100).toFixed(1)}% > ${(limits.maxEquityDrawdownPct * 100).toFixed(1)}%`);
    await db.insert(killSwitches).values({
      reason: `AUTO_DRAWDOWN_${(broker.drawdownPct * 100).toFixed(1)}%`,
      triggeredBy: "RISK_ENGINE",
      armed: true,
    });
    // S1: Der Not-Halt ist bereits gesetzt (sichere Richtung) — die Auditzeile
    // darf den Lauf nicht abbrechen, aber eine Lücke wird gemeldet, nicht
    // verschluckt: CRITICAL-Zeile + Missed-Audit-Zähler + Eintrag im Protokoll.
    const audited = await logAudit("KILL_SWITCH", "CRITICAL", { drawdownPct: broker.drawdownPct }, missionId, agentId);
    if (!audited.durable) {
      flagMissedAudit("KILL_SWITCH", {
        reason: audited.error ?? "audit nicht durable",
        trigger: "AUTO_DRAWDOWN",
        via: "engine",
      });
      trace.push(step("AUDIT", false, "Not-Halt-Audit war nicht durable — Nachzug/Alarm aktiv"));
    }
  }

  // ── Missions-Universum (v1.35.0) ─────────────────────────────────────────
  // SINGLE_SYMBOL-Missionen verhalten sich wie bisher (mission.symbol ?? "SPY").
  // SCAN_UNIVERSE-Missionen bekommen ihre Kandidaten aus der Instrument-
  // Registry (src/lib/missionUniverse.ts): Das Mandat lautet dann „nur dieses
  // Segment“, und die Engine blockt Trades außerhalb der Kandidatenliste.
  const universe = await missionUniverseContext(
    { symbol: mission.symbol, scope: mission.scope, segment: mission.segment },
    { fallbackSymbol: "SPY" }
  );
  const symbolHint = universe.focusSymbol;
  if (universe.warning) {
    trace.push(step("MISSIONS-UNIVERSUM", false, universe.warning));
  }

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
    // Scan-Missionen: Kandidatenliste + Segment-Regel, Zeile für Zeile
    // (bei SINGLE_SYMBOL ist das Array leer → der Prompt bleibt unverändert).
    ...universe.promptLines,
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
      // Audit-Snapshot: das Protokoll bleibt lesbar, auch wenn ein Agent später
      // umbenannt oder aus der Stammdatentabelle entfernt wird.
      actor: { name: agent.name, role: agent.role },
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
      // S1: Scharfschalten ist die SICHERE Richtung — ein Auditfehler darf den
      // Not-Halt niemals verhindern (das wäre fail-open im einzigen Moment, in
      // dem Schutz zählt). Die Lücke wird stattdessen gemeldet: CRITICAL +
      // Missed-Audit-Zähler + Protokollschritt.
      const audited = await logAudit("KILL_SWITCH", "CRITICAL", { by: agent.name }, missionId, agentId);
      if (!audited.durable) {
        flagMissedAudit("KILL_SWITCH", {
          reason: audited.error ?? "audit nicht durable",
          by: agent.name,
          via: "agent-decision",
        });
        trace.push(step("AUDIT", false, "Not-Halt-Audit war nicht durable — Nachzug/Alarm aktiv"));
      }
      return { ...base, status: "KILLED", trace };
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

      // H6 FIX: EXECUTOR darf niemals eine neue Modellentscheidung ausführen.
      if (agent.role === "EXECUTOR" && !options.proposalOnly) {
        const [approved] = await db.select().from(proposals)
          .where(and(eq(proposals.missionId, missionId), eq(proposals.status, "APPROVED")))
          .orderBy(desc(proposals.createdAt)).limit(1);
        if (!approved) {
          await logAudit("ORDER_REJECTED", "WARN", { reason: "NO_APPROVED_PROPOSAL", missionId, agentId }, missionId, agentId);
          trace.push(step("EXECUTOR", false, "Keine genehmigte Proposal für Ausführung"));
          return { ...base, status: "BLOCKED", guardrail: "NO_APPROVED_PROPOSAL", trace };
        }
        const execResult = await executeApprovedProposal(approved.id, agent.id);
        return { ...execResult, trace: [...trace, step("EXECUTOR", true, `Genehmigte Proposal ${approved.id} ausgeführt`)] };
      }

      const maySubmit = agent.role === "EXECUTOR" && !options.proposalOnly;
      trace.push(step(
        "ROLLEN-PRÜFUNG",
        true,
        maySubmit ? "EXECUTOR darf eine genehmigte Order ausführen" : `${agent.role} erzeugt ausschließlich einen Vorschlag`
      ));

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

      // ── Missions-Mandat (v1.35.0): Der Trade muss zum Auftrag passen ──────
      // Einzel-Symbol-Mission: genau dieses Symbol. Scan-Mission: ein Symbol
      // aus der aufgelösten Kandidatenliste. Eine leere Kandidatenliste bei
      // einer Scan-Mission blockt (fail-closed) — das Mandat „nur Indizes“
      // ist nicht erfüllt, indem stattdessen irgendetwas anderes gekauft wird.
      if (!isSymbolInMissionScope(universe, symbol)) {
        const reason =
          universe.scope === "SCAN_UNIVERSE" && universe.candidates.length === 0
            ? "MISSION_SCOPE_EMPTY"
            : "MISSION_SCOPE_VIOLATION";
        await logAudit(
          "ORDER_REJECTED",
          "WARN",
          {
            reason,
            symbol,
            scope: universe.scope,
            segment: universe.segmentId,
            candidates: universe.candidates.slice(0, 12),
          },
          missionId,
          agentId
        );
        trace.push(
          step(
            "MISSIONS-MANDAT",
            false,
            reason === "MISSION_SCOPE_EMPTY"
              ? `Segment „${universe.segmentLabel}“ liefert keine Kandidaten — kein Trade`
              : `${symbol} liegt außerhalb des Mandats (${universe.scopeLabel}${
                  universe.segmentId ? `: ${universe.segmentLabel}` : ""
                })`
          )
        );
        return { ...base, status: "BLOCKED", guardrail: reason, trace };
      }
      trace.push(
        step(
          "MISSIONS-MANDAT",
          true,
          universe.scope === "SCAN_UNIVERSE"
            ? `${symbol} ist Kandidat des Segments „${universe.segmentLabel}“`
            : `${symbol} entspricht dem Missionssymbol`
        )
      );

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

      // KORRIGIERT (v1.5.3): missionsspezifisches maxPositionPct wird jetzt
      // HART durchgesetzt (vorher stand es nur im Prompt; die PENNY-Mission
      // „max 5 %“ konnte real 25 % des Kapitals binden). Die Mission kann die
      // Code-Ceilings nie überschreiten (Sandbox-Prinzip).
      const missionRisk = Number(mission.riskBudget) || limits.maxRiskPerTrade;
      const missionMaxPos = Number(mission.maxPositionPct);
      const effectiveMissionCapPct =
        Number.isFinite(missionMaxPos) && missionMaxPos > 0
          ? Math.min(missionMaxPos, limits.maxPositionPct)
          : limits.maxPositionPct;
      const notional = missionSizedNotional(
        broker.accountEquity,
        stopPct,
        Math.min(missionRisk, limits.maxRiskPerTrade),
        missionMaxPos,
        limits.maxPositionPct
      );
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
          `Stop ${(stopPct * 100).toFixed(1)}% (${modelStopPct != null ? "Agent" : atrStop != null ? "ATR×" + limits.atrStopMultiplier : "Default"}) → Notional ${notional.toFixed(2)} (Cap ${(effectiveMissionCapPct * 100).toFixed(0)}%), TP bei ${takeProfitPrice}`)
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

      if (!maySubmit) {
        await logAudit("PROPOSAL_CREATED", "INFO", { proposalId: proposal.id, role: agent.role, status: proposal.status }, missionId, agentId);
        trace.push(step("PROPOSAL", true, requireApproval ? "Wartet auf menschliche Freigabe" : "Automatisch freigegeben"));
        return { ...base, status: "PROPOSED", trace };
      }

      if (requireApproval) {
        await logAudit("APPROVAL_REQUIRED", "WARN", { proposalId: proposal.id, order }, missionId, agentId);
        trace.push(step("APPROVAL", false, "Wartet auf menschliche Freigabe"));
        return { ...base, status: "BLOCKED", guardrail: "Wartet auf menschliche Freigabe (REQUIRE_HUMAN_APPROVAL=true)", trace };
      }
      trace.push(step("APPROVAL", true, "Automatisch freigegeben (REQUIRE_HUMAN_APPROVAL=false)"));

      // Defense in depth: kein Nicht-EXECUTOR darf jemals die Broker-Schleuse erreichen.
      if (agent.role !== "EXECUTOR") {
        await logAudit("ORDER_REJECTED", "CRITICAL", { reason: "ROLE_NOT_ALLOWED_TO_TRADE", role: agent.role }, missionId, agentId);
        return { ...base, status: "BLOCKED", guardrail: "ROLE_NOT_ALLOWED_TO_TRADE", trace };
      }

      // --- Schicht 3–5: Guardrails + Broker-Schleuse ---
      // TASK 03: Modus-B-Kurs vor dem Fill warmlaufen lassen (Snapshot-Cache
      // des MarketDataManagers), damit der deterministische Simulator einen
      // echten Kurs nutzt. Best-effort — fehlt der Kurs, lehnt der Broker ab.
      try {
        await getProductionMarketDataManager().getSnapshot(symbol);
      } catch {
        /* kein Kurs verfügbar → Broker verwirft die Order (NO_QUOTE) */
      }
      // H2 FIX (CRITICAL, v1.36.19): submitAtomic() statt submit() — Guard,
      // Fill UND Positions-Insert laufen in EINER exklusiv gesperrten
      // Postgres-Transaktion (pg_advisory_xact_lock + order_intents-
      // Reservierung). Zwei Next.js-Worker, die gleichzeitig für dieselbe
      // Mission/dasselbe Konto einreichen, können nie mehr beide dieselbe
      // Position eröffnen oder gemeinsam das Cash überziehen — die DB ist
      // die einzige Quelle der Wahrheit, nicht der Prozessspeicher.
      const fill = await broker.submitAtomic(order, {
        persistPosition: async (tx, f) => {
          await tx.insert(positions).values({
            symbol: f.symbol,
            side: f.side,
            qty: String(f.qty),
            entryPrice: String(f.fillPrice),
            currentPrice: String(f.fillPrice),
            stopLoss: f.stopLoss === null ? null : String(f.stopLoss),
            takeProfit: f.takeProfit === null ? null : String(f.takeProfit),
            broker: broker.name,
            missionId,
            status: "OPEN",
          });
          await tx.update(missions).set({ status: "ACTIVE", updatedAt: new Date() }).where(eq(missions.id, missionId));
        },
      });
      // H3: Schalter über den vollständigen Order-Status. Nur ein echter
      // FILLED-Fill mit belegtem Preis (>0) darf eine Position einbuchen;
      // alles andere (REJECTED/NEW/UNKNOWN/…) blockiert die Order.
      const filled = fill.status === "FILLED" && Number.isFinite(fill.fillPrice) && fill.fillPrice > 0;
      await logAudit(filled ? "ORDER_SENT" : "ORDER_REJECTED", filled ? "INFO" : "WARN", { order, fill }, missionId, agentId);

      if (!filled) {
        const why = fill.reason ?? fill.status ?? "abgelehnt";
        await db.update(proposals).set({ status: "AUTO_REJECTED", reason: why }).where(eq(proposals.id, proposal.id));
        trace.push(step("GUARDRAILS/BROKER", false, why));
        return { ...base, status: "BLOCKED", fill, guardrail: why, trace };
      }
      trace.push(step("GUARDRAILS/BROKER", true, `Gefüllt @ ${fill.fillPrice}, SL ${fill.stopLoss}, TP ${fill.takeProfit}`));

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

/** H7 (v1.36.20): Ergebnis eines Kill-Flatten (cancel → close → verify). */
export type FlattenOutcome = {
  /** "paper" = lokales Ledger, "live" = echte Venue-Positionen. */
  mode: "paper" | "live";
  /** Venue bzw. "PAPER". */
  venue: string;
  /** Stornierte offene Orders (Paper: 0 — Paper füllt synchron). */
  canceled: number;
  /** Gemeldete Schließungen (Paper: echte Fills; live: zuletzt bekannte Positionen). */
  fills: EmergencyCloseFill[];
  /** `verifyFlat()`-Ergebnis nach dem letzten Close-/Retry-Versuch. */
  flat: boolean;
  /** Fehler-Hinweise, falls cancel/close/verify teilweise scheiterten (nie Wurf). */
  error: string | null;
};

/** H7: Venues mit echtem Live-Pfad, die einen Notfall-Adapter stellen können. */
const H7_LIVE_VENUES = ["BITUNIX", "ALPACA"] as const;

function h7ErrorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * H7: Notfall-Broker auflösen — live, wenn die Plattform Live konfiguriert
 * hat UND der Live-Gate den Adapter freigibt; sonst Paper (Default). Live ist
 * aktuell über das Gate blockiert (`LiveTradingGateError`), der Pfad ist aber
 * live-ready: Sobald die State-Machine LIVE_ENABLED + Flags + Suite + Control
 * Plane freigibt, glattstellt der Not-Halt die ECHTEN Venue-Positionen.
 */
export async function resolveEmergencyBroker(): Promise<{
  mode: "paper" | "live";
  venue: string;
  broker: EmergencyBroker;
}> {
  const env = process.env as Record<string, string | undefined>;
  const liveConfigured =
    platformLiveFromEnv(env) &&
    H7_LIVE_VENUES.some(
      (v) => venueLiveFlagFromEnv(v, env) && venueEnabledFromEnv(v, env) && VENUE_CAPABILITIES[v]?.live === true
    );
  if (liveConfigured) {
    for (const venue of H7_LIVE_VENUES) {
      if (!venueLiveFlagFromEnv(venue, env) || !venueEnabledFromEnv(venue, env)) continue;
      if (!VENUE_CAPABILITIES[venue]?.live) continue;
      try {
        const adapter = await createBroker(venue, "live");
        if (
          typeof adapter.cancelAllOpenOrders !== "function" ||
          typeof adapter.closeAllPositions !== "function" ||
          typeof adapter.verifyFlat !== "function"
        ) {
          console.warn(`[flattenAll] Live-Adapter ${venue} ohne H7-Notfall-Pfad — Fallback Paper.`);
          continue;
        }
        // Runtime-Check oben: der Adapter erfüllt die EmergencyBroker-Methoden.
        const emergency = adapter as unknown as EmergencyBroker;
        return { mode: "live", venue, broker: emergency };
      } catch (e) {
        // Live-Gate noch geschlossen (LiveTradingGateError) → nächste Venue,
        // am Ende Paper-Fallback. Der Factory-Aufruf ist bereits auditiert.
        console.warn(`[flattenAll] Live-Venue ${venue} nicht verfügbar: ${h7ErrorMessage(e)}`);
      }
    }
  }
  const paper = await getBroker();
  return { mode: "paper", venue: "PAPER", broker: paper };
}

/**
 * H7: Die Notfall-Sequenz in EINEM Aufruf — cancel → close → verify.
 * Wirft nie: Fehler landen in `error`, die Glattheit in `flat` (Retry, dann
 * Alarm + Audit — der Not-Halt selbst darf daran nicht scheitern).
 */
async function runH7EmergencySequence(
  broker: EmergencyBroker,
  reason: string,
  maxRetries = 1
): Promise<Pick<FlattenOutcome, "canceled" | "fills" | "flat" | "error">> {
  let canceled = 0;
  let fills: EmergencyCloseFill[] = [];
  let error: string | null = null;

  try {
    const res = await broker.cancelAllOpenOrders();
    canceled = Number(res?.canceled ?? 0);
  } catch (e) {
    error = `CANCEL_FAILED: ${h7ErrorMessage(e)}`;
  }

  try {
    fills = await broker.closeAllPositions(reason);
  } catch (e) {
    error = error ? `${error}; CLOSE_FAILED: ${h7ErrorMessage(e)}` : `CLOSE_FAILED: ${h7ErrorMessage(e)}`;
  }

  let flat = false;
  try {
    flat = await broker.verifyFlat();
  } catch (e) {
    error = error ? `${error}; VERIFY_FAILED: ${h7ErrorMessage(e)}` : `VERIFY_FAILED: ${h7ErrorMessage(e)}`;
  }

  if (!flat && maxRetries > 0) {
    // Nicht flach → einmal nachziehen (Retry), dann alarmieren + auditieren.
    try {
      fills = fills.concat(await broker.closeAllPositions(reason));
    } catch (e) {
      error = error ? `${error}; RETRY_CLOSE_FAILED: ${h7ErrorMessage(e)}` : `RETRY_CLOSE_FAILED: ${h7ErrorMessage(e)}`;
    }
    try {
      flat = await broker.verifyFlat();
    } catch (e) {
      error = error ? `${error}; VERIFY_RETRY_FAILED: ${h7ErrorMessage(e)}` : `VERIFY_RETRY_FAILED: ${h7ErrorMessage(e)}`;
    }
  }

  if (!flat) {
    error = error ? `${error}; NOT_FLAT` : "NOT_FLAT";
  }
  return { canceled, fills, flat, error };
}

/**
 * Alle offenen Positionen glattstellen (Notfall-Runbook), H7 (v1.36.20).
 *
 * Statt nur das lokale Paper-Ledger zu schließen läuft jetzt die
 * venue-unabhängige Notfall-Sequenz `cancelAllOpenOrders → closeAllPositions →
 * verifyFlat` — Paper-Ledger (Default) ODER echte Venue-Positionen (Live,
 * sobald das Live-Gate freigibt). Der Modus im Audit: "paper-only flatten
 * (live disabled)" vs. echte Venue-Glattstellung + Flat-Beweis.
 *
 * `opts.broker` dient Tests/Drills (injizierter Mock oder Adapter) — im
 * Produktivpfad wird der Broker aus der Konfiguration aufgelöst.
 */
export async function flattenAll(
  reason: string,
  opts?: { broker?: EmergencyBroker; mode?: "paper" | "live"; venue?: string }
): Promise<FlattenOutcome> {
  const resolved = opts?.broker
    ? { mode: opts.mode ?? ("paper" as const), venue: opts.venue ?? "PAPER", broker: opts.broker }
    : await resolveEmergencyBroker();

  const seq = await runH7EmergencySequence(resolved.broker, reason);

  // Paper-Modus: lokales DB-Ledger aus den echten Paper-Fills nachziehen
  // (bestehendes Verhalten). Live-Modus: Die Venue ist Quelle der Wahrheit —
  // `close_all_position` liefert keine Fills, wir erfinden keine lokalen
  // Exit-Preise (Positionen ohne belegten Preis bleiben für den Operator
  // sichtbar offen, der Flat-Beweis steht im Audit).
  if (resolved.mode === "paper" && !opts?.broker) {
    for (const f of seq.fills) {
      if (!Number.isFinite(f.fillPrice) || f.fillPrice <= 0) continue;
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
    try {
      const ledger = resolved.broker as unknown as {
        accountEquity: number;
        freeCash: number;
        openPositions: number;
      };
      await writeEquitySnapshot(ledger.accountEquity, ledger.freeCash, ledger.openPositions, "FLATTEN");
    } catch {
      /* Kurvenpunkt optional */
    }
  }

  await logAudit("FLATTEN_ALL", "CRITICAL", {
    mode: resolved.mode,
    venue: resolved.venue,
    reason,
    canceled: seq.canceled,
    closed: seq.fills.length,
    flat: seq.flat,
    error: seq.error,
    liveDisabled: resolved.mode === "paper" ? "paper-only flatten (live disabled)" : undefined,
    fills: seq.fills,
  });

  return { mode: resolved.mode, venue: resolved.venue, ...seq };
}


/**
 * Führt eine bereits genehmigte Proposal ohne erneute Modellentscheidung aus.
 * proposedDetail ist die einzige Orderquelle; unbekannte/PENDING Proposals
 * werden fail-closed abgewiesen.
 */
export async function executeApprovedProposal(
  proposalId: string,
  executorAgentId?: string
): Promise<TurnResult> {
  const base = {
    decision: { type: "TRADE" as const, reason: `approved proposal ${proposalId}` },
    source: "fallback" as const,
    model: "approved-proposal",
    latencyMs: 0,
  };
  const [proposal] = await db.select().from(proposals).where(eq(proposals.id, proposalId)).limit(1);
  if (!proposal || proposal.status !== "APPROVED") {
    await logAudit("ORDER_REJECTED", "WARN", {
      reason: proposal ? "PROPOSAL_NOT_APPROVED" : "PROPOSAL_NOT_FOUND",
      proposalId,
      status: proposal?.status,
    }, proposal?.missionId ?? undefined, executorAgentId);
    return { ...base, status: "BLOCKED", guardrail: proposal ? "PROPOSAL_NOT_APPROVED" : "PROPOSAL_NOT_FOUND" };
  }
  if (killSwitch.isArmed()) {
    await logAudit("ORDER_REJECTED", "WARN", { reason: "KILL_SWITCH_ARMED", proposalId }, proposal.missionId ?? undefined, executorAgentId);
    return { ...base, status: "BLOCKED", guardrail: "KILL_SWITCH_ARMED" };
  }

  // Runtime-Validierung: proposedDetail ist die einzige Quelle; keine Neubildung.
  const detail = proposal.proposedDetail as Record<string, unknown>;
  if (typeof detail?.symbol !== "string" || !sanitizeSymbol(detail.symbol) ||
      (detail.side !== "LONG" && detail.side !== "SHORT") ||
      !Number.isFinite(Number(detail?.qty)) || Number(detail.qty) <= 0 ||
      !Number.isFinite(Number(detail?.riskNotional)) || Number(detail.riskNotional) <= 0 ||
      !Number.isFinite(Number(detail?.stopLoss)) || Number(detail.stopLoss) <= 0 ||
      !Number.isFinite(Number(detail?.takeProfit)) || Number(detail.takeProfit) <= 0) {
    await logAudit("ORDER_REJECTED", "CRITICAL", { reason: "INVALID_PROPOSAL_DETAIL", proposalId, proposedDetail: detail }, proposal.missionId ?? undefined, executorAgentId);
    return { ...base, status: "BLOCKED", guardrail: "INVALID_PROPOSAL_DETAIL" };
  }

  const broker = await getBroker();
  try { await getProductionMarketDataManager().getSnapshot(detail.symbol as string); } catch { /* Broker lehnt fehlenden Kurs ab. */ }
  // H2 FIX (CRITICAL, v1.36.19): submitAtomic({ ...detail — proposedDetail
  // bleibt die EINZIGE Orderquelle (H6 unverändert), aber Guard, Fill und
  // Positions-Insert laufen jetzt in einer exklusiv gesperrten Transaktion
  // (order_intents-Reservierung), statt Broker-Mutation und DB-Insert zeitlich
  // auseinanderzureißen.
  const fill = await broker.submitAtomic({ ...detail, side: detail.side as "LONG" | "SHORT" } as any, {
    persistPosition: async (tx, f) => {
      await tx.insert(positions).values({
        symbol: f.symbol, side: f.side, qty: String(f.qty),
        entryPrice: String(f.fillPrice), currentPrice: String(f.fillPrice),
        stopLoss: f.stopLoss === null ? null : String(f.stopLoss),
        takeProfit: f.takeProfit === null ? null : String(f.takeProfit),
        broker: broker.name, missionId: proposal.missionId, status: "OPEN",
      });
      if (proposal.missionId) {
        await tx.update(missions).set({ status: "ACTIVE", updatedAt: new Date() }).where(eq(missions.id, proposal.missionId));
      }
    },
  });
  const filled = fill.status === "FILLED" && Number.isFinite(fill.fillPrice) && fill.fillPrice > 0;
  await logAudit(filled ? "ORDER_SENT" : "ORDER_REJECTED", filled ? "INFO" : "WARN", {
    proposalId, order: proposal.proposedDetail, fill,
  }, proposal.missionId ?? undefined, executorAgentId);
  if (!filled) {
    await db.update(proposals).set({ status: "AUTO_REJECTED", reason: fill.reason ?? fill.status }).where(eq(proposals.id, proposalId));
    return { ...base, status: "BLOCKED", fill, guardrail: fill.reason ?? fill.status };
  }

  await db.update(proposals).set({ status: "EXECUTED", reason: "Filled by approved-proposal executor" }).where(eq(proposals.id, proposalId));
  try { await writeEquitySnapshot(broker.accountEquity, broker.freeCash, broker.openPositions, "TRADE"); } catch { /* optional */ }
  return { ...base, status: "EXECUTED", fill };
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
    const phases = ["CEO", "RESEARCH", "BACKTEST", "RISK_MANAGER", "APPROVER"];
    const team = await db.select().from(agentTable);
    const results: { agent: string; role: string; result: TurnResult }[] = [];

    // Analyse-/Kontrollphasen dürfen ausschließlich Proposals erzeugen.
    for (const role of phases) {
      for (const agent of team.filter((candidate) => candidate.role === role)) {
        if (killSwitch.isArmed()) return results;
        const result = await runAgentTurn(agent.id, missionId, { proposalOnly: true });
        results.push({ agent: agent.name, role: agent.role, result });
        if (result.status === "KILLED") return results;
      }
    }

    // EXECUTOR -> BROKER: keine neue Modellentscheidung. Ausschließlich der
    // jüngste serverseitig genehmigte Vorschlag dieser Mission wird ausgeführt.
    const executor = team.find((agent) => agent.role === "EXECUTOR");
    const [approved] = await db.select().from(proposals)
      .where(and(eq(proposals.missionId, missionId), eq(proposals.status, "APPROVED")))
      .orderBy(desc(proposals.createdAt)).limit(1);
    if (executor && approved && !killSwitch.isArmed()) {
      const result = await executeApprovedProposal(approved.id, executor.id);
      results.push({ agent: executor.name, role: "EXECUTOR", result });
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
