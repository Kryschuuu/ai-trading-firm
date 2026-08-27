/**
 * Step 7: Research (nach 10:00 UTC).
 *
 * Generiert konkrete Trade-Setups für vom Risk Manager freigegebene Kandidaten.
 *
 * HARTE SICHERHEITS-GARANTIE:
 * Setups sind AUSSCHLIESSLICH VORSCHLÄGE (isProposal: true).
 * Dieser Schritt platziert KEINE Orders und verändert KEINE Broker-Zustände.
 */

import type { StepDefinition, StepExecutionContext } from "../types";
import { type ResearchStepOutput, validateResearchOutput, type TradeSetupProposal } from "../schemas";
import { assertShortlistLimit } from "../security";
import type { RiskStepOutput, TechnicalStepOutput } from "../schemas";

export interface ResearchStepInput {
  approvedCandidates?: string[];
}

export const researchStep: StepDefinition<ResearchStepInput, ResearchStepOutput> = {
  stepId: "07-research",
  name: "Research",
  role: "RESEARCH",
  timeWindow: "11:00-12:00",
  llmAllowed: true,
  retryPolicy: {
    maxAttempts: 2,
    backoffMs: 200,
  },

  async execute(context: StepExecutionContext<ResearchStepInput>): Promise<ResearchStepOutput> {
    const riskOutput = context.previousStepOutputs["06-risk-manager"] as RiskStepOutput | undefined;
    const techOutput = context.previousStepOutputs["04-technical-analyst"] as TechnicalStepOutput | undefined;

    const approved =
      context.input?.approvedCandidates ??
      riskOutput?.approvedCandidates ??
      [];

    assertShortlistLimit(approved, 40);

    context.log(`Erzeuge konkrete Setup-Vorschläge für ${approved.length} freigegebene Instrumente …`);

    // Deterministischer Fallback für Setups
    const defaultSetups: TradeSetupProposal[] = approved.slice(0, 10).map((sym) => {
      const ta = techOutput?.analyses.find((a) => a.instrumentId === sym);
      const isBull = ta?.bias === "BULLISH";
      const entryPrice = ta?.keyLevels.support && ta.keyLevels.support > 0 ? ta.keyLevels.support * 1.01 : 100;
      const stopLoss = isBull ? entryPrice * 0.95 : entryPrice * 1.05;
      const takeProfit = isBull ? entryPrice * 1.10 : entryPrice * 0.90;

      return {
        instrumentId: sym,
        side: isBull ? "LONG" : "SHORT",
        entryPrice: Number(entryPrice.toFixed(2)),
        stopLoss: Number(stopLoss.toFixed(2)),
        takeProfit: Number(takeProfit.toFixed(2)),
        riskScore: 0.5,
        timeframe: "4h",
        thesis: `Deterministisches ${isBull ? "Long" : "Short"}-Setup an Unterstützungs-/Widerstandsniveau`,
        isProposal: true,
      };
    });

    const fallback: ResearchStepOutput = {
      setups: defaultSetups,
      totalSetups: defaultSetups.length,
      disclaimer: "PROPOSAL_ONLY_NO_ORDERS_PLACED",
    };

    if (approved.length === 0) {
      return fallback;
    }

    const systemPrompt = `You are the Research Analyst of an autonomous trading firm.
Formulate concrete, disciplined trade setups for the approved candidate instruments.
SECURITY MANDATE: Your outputs are strictly PROPOSALS for evaluation. No execution occurs.
Specify exact entry, stop loss (mandatory), and take profit targets.
Respond strictly in JSON conforming to the schema.`;

    const userPrompt = `Formulate setups for approved instruments:
${JSON.stringify(approved)}
Technical context:
${JSON.stringify(techOutput?.analyses.slice(0, 40))}
JSON schema:
{
  "setups": [
    {
      "instrumentId": "string",
      "side": "LONG|SHORT",
      "entryPrice": 100.0,
      "stopLoss": 95.0,
      "takeProfit": 110.0,
      "riskScore": 0.4,
      "timeframe": "4h",
      "thesis": "string",
      "isProposal": true
    }
  ],
  "totalSetups": number,
  "disclaimer": "PROPOSAL_ONLY_NO_ORDERS_PLACED"
}`;

    const res = await context.ports.agent.invokeAgent<ResearchStepOutput>({
      role: "RESEARCH",
      systemPrompt,
      userPrompt,
      untrustedData: { approvedSymbols: approved },
      schemaValidator: validateResearchOutput,
      fallback,
    });

    return res.output;
  },
};
