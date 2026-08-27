/**
 * Step 6: Risk Manager (10:00 UTC).
 *
 * Berechnet Korrelationen und Portfolio Exposure über AnalyticsPort (Task 05)
 * und bewertet Klumpenrisiken und Risikoallokationen.
 */

import type { StepDefinition, StepExecutionContext } from "../types";
import { type RiskStepOutput, validateRiskOutput } from "../schemas";
import { assertShortlistLimit } from "../security";
import type { SelectionStepOutput, TechnicalStepOutput, NewsStepOutput } from "../schemas";

export interface RiskStepInput {
  symbols?: string[];
}

export const riskStep: StepDefinition<RiskStepInput, RiskStepOutput> = {
  stepId: "06-risk-manager",
  name: "Risk Manager",
  role: "RISK_MANAGER",
  timeWindow: "10:00-11:00",
  llmAllowed: true,
  retryPolicy: {
    maxAttempts: 2,
    backoffMs: 200,
  },

  async execute(context: StepExecutionContext<RiskStepInput>): Promise<RiskStepOutput> {
    const selection = context.previousStepOutputs["03-market-selection"] as SelectionStepOutput | undefined;
    const techOutput = context.previousStepOutputs["04-technical-analyst"] as TechnicalStepOutput | undefined;
    const newsOutput = context.previousStepOutputs["05-news-analyst"] as NewsStepOutput | undefined;

    const symbols =
      context.input?.symbols ??
      selection?.candidates.map((c) => c.instrumentId) ??
      [];

    assertShortlistLimit(symbols, 40);

    context.log(`Berechne Portfolio-Analytics und Korrelationen für ${symbols.length} Instrumente …`);

    // Numerische Korrelationen & Cluster über AnalyticsPort berechnen (Task 05)
    const analytics = await context.ports.analytics.computeCorrelationAndRisk(symbols, context.asOf);

    // Deterministische Vorfilterung bei extremen Korrelationen
    const approvedCandidates: string[] = [];
    const rejectedCandidates: Array<{ instrumentId: string; reason: string }> = [];

    for (const sym of symbols) {
      // Wenn News-Risiko CRITICAL oder Regime EXTREME ist
      const newsItem = newsOutput?.analyses.find((a) => a.instrumentId === sym);
      const isCriticalNews = newsItem && (newsItem.impactScore < 20 || newsItem.riskFlags.includes("HALT"));
      const isExtremeRegime = analytics.regimes[sym] === "EXTREME";

      if (isCriticalNews) {
        rejectedCandidates.push({ instrumentId: sym, reason: "Abgelehnt durch Risk Manager: Kritisches News-Risiko" });
      } else if (isExtremeRegime) {
        rejectedCandidates.push({ instrumentId: sym, reason: "Abgelehnt durch Risk Manager: Extremes Volatilitätsregime" });
      } else {
        approvedCandidates.push(sym);
      }
    }

    const fallback: RiskStepOutput = {
      approvedCandidates,
      rejectedCandidates,
      correlationWarnings: analytics.exposureWarnings,
      maxPositionPct: 0.1,
      riskBudgetPerTrade: 0.01,
      rationale: "Konservative Risiko-Freigabe basierend auf Korrelationsmatrix und Portfolio-Exposure (Deterministischer Fallback)",
    };

    const systemPrompt = `You are the Risk Manager of an autonomous trading firm.
Your duty is capital protection and exposure control.
Review the candidate instruments alongside the computed correlation matrix, clusters, and technical/news signals.
Approve healthy setups, reject excessive cluster risks or toxic regimes.
Enforce code ceilings: maxPositionPct <= 0.25 (25%), riskBudgetPerTrade <= 0.02 (2%).
Respond strictly in JSON matching the schema.`;

    const userPrompt = `Review the risk profile for:
Symbols: ${JSON.stringify(symbols)}
Correlation warnings: ${JSON.stringify(analytics.exposureWarnings)}
Clusters: ${JSON.stringify(analytics.clusters)}
JSON schema:
{
  "approvedCandidates": ["string"],
  "rejectedCandidates": [{ "instrumentId": "string", "reason": "string" }],
  "correlationWarnings": ["string"],
  "maxPositionPct": 0.10,
  "riskBudgetPerTrade": 0.01,
  "rationale": "string"
}`;

    const res = await context.ports.agent.invokeAgent<RiskStepOutput>({
      role: "RISK_MANAGER",
      systemPrompt,
      userPrompt,
      untrustedData: {
        analytics,
        technicalSummary: techOutput?.analyses.slice(0, 40),
        newsSummary: newsOutput?.analyses.slice(0, 40),
      },
      schemaValidator: validateRiskOutput,
      fallback,
    });

    return res.output;
  },
};
