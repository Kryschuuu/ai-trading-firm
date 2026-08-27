/**
 * Step 2: Macro Analyst (06:00 UTC).
 *
 * Analysiert die Cross-Market-Makrolage und Volatilitätsregime:
 * Pflicht-Assets: BTC, ETH, DXY, SPX, Nasdaq, Gold, Bonds.
 */

import type { StepDefinition, StepExecutionContext } from "../types";
import { type MacroStepOutput, validateMacroOutput } from "../schemas";

export const MACRO_REQUIRED_ASSETS = ["BTC", "ETH", "DXY", "SPX", "Nasdaq", "Gold", "Bonds"] as const;

export interface MacroStepInput {
  asOf?: string;
  externalMacroData?: Record<string, { price?: number; change24hPct?: number; trend?: string }>;
}

export const macroStep: StepDefinition<MacroStepInput, MacroStepOutput> = {
  stepId: "02-macro-analyst",
  name: "Macro Analyst",
  role: "MACRO_ANALYST",
  timeWindow: "06:00-07:00",
  llmAllowed: true,
  retryPolicy: {
    maxAttempts: 2,
    backoffMs: 200,
  },

  async execute(context: StepExecutionContext<MacroStepInput>): Promise<MacroStepOutput> {
    context.log("Starte Makro-Analyse für BTC, ETH, DXY, SPX, Nasdaq, Gold, Bonds …");

    const fallback: MacroStepOutput = {
      view: "NEUTRAL",
      regime: "MIXED",
      volatilityRegime: "NORMAL",
      assets: {
        btc: { trend: "SIDEWAYS", note: "Standard-Fallback" },
        eth: { trend: "SIDEWAYS", note: "Standard-Fallback" },
        dxy: { trend: "SIDEWAYS", note: "Standard-Fallback" },
        spx: { trend: "SIDEWAYS", note: "Standard-Fallback" },
        nasdaq: { trend: "SIDEWAYS", note: "Standard-Fallback" },
        gold: { trend: "SIDEWAYS", note: "Standard-Fallback" },
        bonds: { trend: "SIDEWAYS", note: "Standard-Fallback" },
      },
      thesis: "Reguläres Makro-Regime ohne extreme Ausschläge (Deterministischer Fallback)",
      confidence: 0.5,
    };

    const systemPrompt = `You are the Macro Analyst of an autonomous trading firm.
Your task is to analyze the global macroeconomic environment across all 7 core asset classes:
BTC, ETH, DXY, SPX, Nasdaq, Gold, Bonds.
Determine the overall market regime (RISK_ON, RISK_OFF, or MIXED) and the volatility regime (LOW, NORMAL, HIGH, or EXTREME).
Always respond with strictly valid JSON matching the schema.`;

    const userPrompt = `Evaluate the current macro environment across the 7 mandated assets:
BTC, ETH, DXY, SPX, Nasdaq, Gold, Bonds.
Output JSON schema:
{
  "view": "BULLISH|BEARISH|NEUTRAL",
  "regime": "RISK_ON|RISK_OFF|MIXED",
  "volatilityRegime": "LOW|NORMAL|HIGH|EXTREME",
  "assets": {
    "btc": { "price": 0, "change24hPct": 0, "trend": "UP|DOWN|SIDEWAYS", "note": "string" },
    "eth": { ... },
    "dxy": { ... },
    "spx": { ... },
    "nasdaq": { ... },
    "gold": { ... },
    "bonds": { ... }
  },
  "thesis": "concise rationale (max 300 chars)",
  "confidence": 0.0 - 1.0
}`;

    const res = await context.ports.agent.invokeAgent<MacroStepOutput>({
      role: "MACRO_ANALYST",
      systemPrompt,
      userPrompt,
      untrustedData: context.input?.externalMacroData ?? { coveredAssets: MACRO_REQUIRED_ASSETS },
      schemaValidator: validateMacroOutput,
      fallback,
      escalationCheck(raw, parsed) {
        const text = String(raw).toLowerCase();
        if (text.includes("geopolitical crisis") || text.includes("black swan") || text.includes("market crash")) {
          return {
            agent: "MACRO_ANALYST",
            reason: "Extremes Makro-Risiko oder Black-Swan-Ereignis erkannt",
            complexity: "critical",
            confidence: 0.3,
          };
        }
        return null;
      },
    });

    if (res.usedFallback) {
      context.log("Macro Analyst nutzte Fallback-Antwort.", "WARN");
    }

    if (res.escalation) {
      context.emitEscalation(res.escalation);
    }

    return res.output;
  },
};
