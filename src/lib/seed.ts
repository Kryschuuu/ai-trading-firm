import { db } from "@/db";
import { agents, missions, riskConfig, killSwitches } from "@/db/schema";
import { count, eq } from "drizzle-orm";
import { RISK_LIMITS } from "./riskGuard";

/**
 * Legt Standard-Team, Missionen und die beschreibenden Risikozeilen an.
 * Idempotent — mehrfaches Aufrufen erzeugt keine Duplikate und löscht nichts.
 *
 * Die Modelltags kommen aus der .env (MODEL_*). Standard ist Variante A
 * (schlanke Modelle für den N150); für Variante B die auskommentierten Werte
 * in .env.example verwenden.
 */
const TEAM = () => [
  {
    name: "Lex (CEO)",
    role: "CEO",
    model: process.env.MODEL_CEO || "qwen2.5:3b-instruct-q4_K_M",
    systemPrompt:
      "Du bist der CEO einer Trading-Firma. Du legst Strategie und Auftrag fest und delegierst. " +
      "Du platzierst NIEMALS selbst Orders. Antworte ausschließlich mit einem JSON-Objekt.",
  },
  {
    name: "Rhea (Research)",
    role: "RESEARCH",
    model: process.env.MODEL_RESEARCH || "qwen2.5:3b-instruct-q4_K_M",
    systemPrompt:
      "Du bist Marktanalystin. Du lieferst zum Missionssymbol ein konkretes Setup mit Richtung, " +
      "Stop-Loss in Prozent (2 bis 10) und einem Risikoscore von 0 bis 1. Bei unklarer Lage " +
      'antwortest du mit {"type":"HOLD"}. Antworte ausschließlich mit einem JSON-Objekt.',
  },
  {
    name: "Milo (Backtest)",
    role: "BACKTEST",
    model: process.env.MODEL_BACKTEST || "qwen2.5:3b-instruct-q4_K_M",
    systemPrompt:
      "Du prüfst Strategien gegen historische Daten und schreibst Testcode. In der Paper-Phase " +
      "bist du nicht blockierend. Antworte ausschließlich mit einem JSON-Objekt.",
  },
  {
    name: "Rigel (Risk Manager)",
    role: "RISK_MANAGER",
    model: process.env.MODEL_RISK || "qwen2.5:3b-instruct-q4_K_M",
    systemPrompt:
      "Du bewertest jeden Vorschlag unabhängig gegen das Risikobudget und darfst ihn ablehnen. " +
      "Im Zweifel lehnst du ab. Antworte ausschließlich mit einem JSON-Objekt.",
  },
  {
    name: "Vega (Approver)",
    role: "APPROVER",
    model: process.env.MODEL_APPROVER || "qwen2.5:3b-instruct-q4_K_M",
    systemPrompt:
      "Du bist der Stellvertreter des Menschen. Du gibst Ordervorschläge frei oder lehnst sie ab, " +
      "bevor der Executor handeln darf. Antworte ausschließlich mit einem JSON-Objekt.",
  },
  {
    name: "Nova (Executor)",
    role: "EXECUTOR",
    model: process.env.MODEL_EXECUTOR || "qwen2.5:1.5b-instruct-q4_K_M",
    systemPrompt:
      "Du übersetzt freigegebene Entscheidungen in Broker-Orders. Die harten Limits und der " +
      "Kill-Switch liegen außerhalb von dir und sind unveränderlich. Antworte ausschließlich mit JSON.",
  },
];

export async function ensureSeeded() {
  const agentCount = (await db.select({ c: count() }).from(agents))[0].c;
  if (agentCount === 0) await db.insert(agents).values(TEAM());

  const missionCount = (await db.select({ c: count() }).from(missions))[0].c;
  if (missionCount === 0) {
    await db.insert(missions).values([
      {
        title: "Erste Paper-Mission: BTC Long-Only",
        objective:
          "Nur Long in BTC. Maximal 25 % des Kapitals pro Position, Stop-Loss verpflichtend, " +
          "kein Hebel, keine Shorts. Ziel ist das Validieren der Pipeline, nicht die Rendite.",
        symbol: "BTC",
        riskBudget: "0.02",
        maxPositionPct: "0.25",
        status: "PENDING",
      },
      {
        title: "Beobachtungsmandat: SPY",
        objective:
          "Beobachte SPY und melde Setups. Handle nur bei klarem Trendsignal, sonst HOLD. " +
          "Gleiche harte Grenzen wie in der BTC-Mission.",
        symbol: "SPY",
        riskBudget: "0.01",
        maxPositionPct: "0.20",
        status: "PENDING",
      },
    ]);
  }

  // Spiegelt die Code-Limits nur zur Anzeige. Wirksam sind ausschließlich die
  // Werte in src/lib/riskGuard.ts.
  const cfgRows: [string, string, string][] = [
    ["maxPositionPct", String(RISK_LIMITS.maxPositionPct), "Max. Anteil des Kapitals pro Position"],
    ["maxRiskPerTrade", String(RISK_LIMITS.maxRiskPerTrade), "Max. Risiko pro Trade"],
    ["maxConcurrentPositions", String(RISK_LIMITS.maxConcurrentPositions), "Max. gleichzeitig offene Positionen"],
    ["maxLeverage", String(RISK_LIMITS.maxLeverage), "Max. Hebel"],
    ["maxEquityDrawdownPct", String(RISK_LIMITS.maxEquityDrawdownPct), "Auto-Kill-Schwelle beim Drawdown"],
  ];
  for (const [key, value, description] of cfgRows) {
    const existing = await db.select().from(riskConfig).where(eq(riskConfig.key, key));
    if (existing.length === 0) await db.insert(riskConfig).values({ key, value, description });
    else await db.update(riskConfig).set({ value, description }).where(eq(riskConfig.key, key));
  }

  const ks = await db.select().from(killSwitches).limit(1);
  if (ks.length === 0) {
    await db.insert(killSwitches).values({
      reason: "SYSTEM_BOOT",
      triggeredBy: "system",
      armed: false,
    });
  }
}
