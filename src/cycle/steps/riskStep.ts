/**
 * Step 6: Risk Manager (10:00 UTC).
 *
 * Berechnet point-in-time-Korrelationen und Relative-Portfolio-Gewichte.
 * Deterministische News-/Regime-Sperren sind autoritativ: die LLM-Antwort darf
 * Kandidaten ablehnen, aber keine codeseitig abgelehnten oder unbekannten
 * Symbole wieder freigeben. Die Gewichte sind Vorschläge, keine Orderfreigabe.
 */

import type { StepDefinition, StepExecutionContext } from "../types";
import { type RiskPortfolioAllocation, type RiskStepOutput, validateRiskOutput } from "../schemas";
import { assertShortlistLimit } from "../security";
import type { SelectionStepOutput, TechnicalStepOutput, NewsStepOutput } from "../schemas";
import { assertNoWeightsOnRejection, optimizeWithGuard, type SeriesInput } from "@/portfolio";

export interface RiskStepInput {
  symbols?: string[];
}

const MIN_PORTFOLIO_PRICE_POINTS = 5;
const MAX_PORTFOLIO_PRICE_POINTS = 1_000;

function normalizeSymbols(values: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const symbol = value.trim();
    if (symbol && !seen.has(symbol)) {
      seen.add(symbol);
      normalized.push(symbol);
    }
  }
  return normalized;
}

function equalWeightAllocation(
  symbols: readonly string[],
  reason?: string,
): RiskPortfolioAllocation {
  if (symbols.length === 0) return { method: "NONE", weights: [] };
  const weight = 1 / symbols.length;
  return {
    method: "EQUAL_WEIGHT_FALLBACK",
    weights: symbols.map((instrumentId) => ({ instrumentId, weight })),
    ...(reason ? { reason } : {}),
  };
}

/**
 * Richtet die freigegebenen Preisreihen ausschließlich über gemeinsame,
 * point-in-time Candle-Zeitstempel aus. Bei einer Lücke wird nicht geraten.
 */
function alignPortfolioSeries(
  symbols: readonly string[],
  data: Record<string, { timestamps: number[]; prices: number[] }> | undefined,
  asOf: Date,
): SeriesInput[] | null {
  if (symbols.length === 0 || !data || !Number.isFinite(asOf.getTime())) return null;
  const bySymbol = new Map<string, Map<number, number>>();
  for (const symbol of symbols) {
    const series = data[symbol];
    if (
      !series ||
      !Array.isArray(series.timestamps) ||
      !Array.isArray(series.prices) ||
      series.timestamps.length !== series.prices.length
    ) {
      return null;
    }
    const points = new Map<number, number>();
    for (let i = 0; i < series.timestamps.length; i++) {
      const timestamp = series.timestamps[i];
      const price = series.prices[i];
      if (
        Number.isSafeInteger(timestamp) &&
        timestamp <= asOf.getTime() &&
        Number.isFinite(price) &&
        price > 0
      ) {
        points.set(timestamp, price);
      }
    }
    if (points.size < MIN_PORTFOLIO_PRICE_POINTS) return null;
    bySymbol.set(symbol, points);
  }

  const first = bySymbol.get(symbols[0]);
  if (!first) return null;
  const commonTimestamps = [...first.keys()]
    .filter((timestamp) => symbols.every((symbol) => bySymbol.get(symbol)?.has(timestamp)))
    .sort((a, b) => a - b)
    .slice(-MAX_PORTFOLIO_PRICE_POINTS);
  if (commonTimestamps.length < MIN_PORTFOLIO_PRICE_POINTS) return null;

  return symbols.map((symbol) => {
    const points = bySymbol.get(symbol)!;
    return {
      symbol,
      prices: commonTimestamps.map((timestamp) => points.get(timestamp)!),
    };
  });
}

function computePortfolioAllocation(
  symbols: readonly string[],
  seriesBySymbol: Record<string, { timestamps: number[]; prices: number[] }> | undefined,
  asOf: Date,
): RiskPortfolioAllocation {
  if (symbols.length === 0) return { method: "NONE", weights: [] };
  const series = alignPortfolioSeries(symbols, seriesBySymbol, asOf);
  if (!series) return equalWeightAllocation(symbols, "INSUFFICIENT_ALIGNED_POINT_IN_TIME_HISTORY");

  try {
    const result = optimizeWithGuard({
      series,
      mode: "risk_parity",
      bounds: { minWeight: 0, maxWeight: 1 },
      covariance: { method: "sample" },
      solver: { singularMatrixPolicy: "ridge" },
      // These are relative shares inside the already risk-approved shortlist,
      // not account-equity position sizes. Absolute risk caps remain enforced
      // by the downstream RiskGuard / execution authority chain.
      guard: {
        position: { maxWeightPerInstrument: 1, minWeight: 0 },
        correlation: { threshold: 0.75, maxClusterExposure: 1 },
        allowCashResidual: false,
      },
    });
    assertNoWeightsOnRejection(result);
    if (result.rejected || result.weights.length !== symbols.length || !result.diagnostics.converged) {
      return equalWeightAllocation(symbols, "OPTIMIZER_NOT_CONVERGED_OR_GUARD_REJECTED");
    }
    const sum = result.weights.reduce((total, weight) => total + weight, 0);
    if (
      Math.abs(sum - 1) > 1e-6 ||
      result.weights.some((weight) => !Number.isFinite(weight) || weight < 0)
    ) {
      return equalWeightAllocation(symbols, "OPTIMIZER_RETURNED_INVALID_WEIGHTS");
    }
    return {
      method: "RISK_PARITY",
      weights: symbols.map((instrumentId, index) => ({ instrumentId, weight: result.weights[index] })),
    };
  } catch {
    // Numerische/Guard-Fehler werden nicht zu Gewichten geraten; der explizite
    // Fallback ist gleichgewichtet und wird im Artefakt als solcher markiert.
    return equalWeightAllocation(symbols, "OPTIMIZER_UNAVAILABLE");
  }
}

function reconcileRiskDecision(
  symbols: readonly string[],
  deterministicAllowed: readonly string[],
  deterministicRejected: RiskStepOutput["rejectedCandidates"],
  modelOutput: RiskStepOutput,
): RiskStepOutput {
  const inputSet = new Set(symbols);
  const allowedSet = new Set(deterministicAllowed);
  const modelApprovedSet = new Set(modelOutput.approvedCandidates.filter((symbol) => inputSet.has(symbol)));
  const modelRejected = new Map<string, string>();
  for (const rejected of modelOutput.rejectedCandidates) {
    if (inputSet.has(rejected.instrumentId) && !modelRejected.has(rejected.instrumentId)) {
      modelRejected.set(rejected.instrumentId, rejected.reason);
    }
  }

  // A rejection always wins over an approval; model approval can only narrow
  // the deterministic candidate set and can never expand it.
  const approvedCandidates = symbols.filter(
    (symbol) => allowedSet.has(symbol) && modelApprovedSet.has(symbol) && !modelRejected.has(symbol),
  );
  const rejectedBySymbol = new Map<string, string>();
  for (const rejection of deterministicRejected) rejectedBySymbol.set(rejection.instrumentId, rejection.reason);
  for (const symbol of symbols) {
    if (rejectedBySymbol.has(symbol) || approvedCandidates.includes(symbol)) continue;
    rejectedBySymbol.set(
      symbol,
      modelRejected.get(symbol) ?? "Nicht durch die Risk-Ausgabe freigegeben (fail-closed)",
    );
  }

  return {
    ...modelOutput,
    approvedCandidates,
    rejectedCandidates: symbols
      .filter((symbol) => rejectedBySymbol.has(symbol))
      .map((instrumentId) => ({ instrumentId, reason: rejectedBySymbol.get(instrumentId)! })),
  };
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

    const requestedSymbols =
      context.input?.symbols ??
      selection?.candidates.map((candidate) => candidate.instrumentId) ??
      [];
    assertShortlistLimit(requestedSymbols, 40);
    const symbols = normalizeSymbols(requestedSymbols);

    context.log(`Berechne Portfolio-Analytics und Korrelationen für ${symbols.length} Instrumente …`);

    const analytics = await context.ports.analytics.computeCorrelationAndRisk(symbols, context.asOf);
    const deterministicAllowed: string[] = [];
    const deterministicRejected: RiskStepOutput["rejectedCandidates"] = [];

    for (const symbol of symbols) {
      const news = newsOutput?.analyses.find((analysis) => analysis.instrumentId === symbol);
      const criticalNews = Boolean(
        news &&
          (news.impactScore < 20 || news.riskFlags.some((flag) => flag.toUpperCase() === "HALT")),
      );
      const extremeRegime = analytics.regimes[symbol] === "EXTREME";
      if (criticalNews) {
        deterministicRejected.push({
          instrumentId: symbol,
          reason: "Abgelehnt durch Risk Manager: Kritisches News-Risiko",
        });
      } else if (extremeRegime) {
        deterministicRejected.push({
          instrumentId: symbol,
          reason: "Abgelehnt durch Risk Manager: Extremes Volatilitätsregime",
        });
      } else {
        deterministicAllowed.push(symbol);
      }
    }

    const fallback: RiskStepOutput = {
      approvedCandidates: deterministicAllowed,
      rejectedCandidates: deterministicRejected,
      correlationWarnings: analytics.exposureWarnings,
      maxPositionPct: 0.1,
      riskBudgetPerTrade: 0.01,
      rationale: "Konservative Risiko-Freigabe nach deterministischer News- und Regime-Prüfung",
    };

    const systemPrompt = `You are the Risk Manager of an autonomous trading firm.
Your duty is capital protection and exposure control.
Review the candidate instruments alongside the computed correlation matrix, clusters, and technical/news signals.
The code-provided eligible list is authoritative: approve only a subset of it. Any code-rejected symbol must remain rejected.
Enforce code ceilings: maxPositionPct <= 0.25 (25%), riskBudgetPerTrade <= 0.02 (2%).
Respond strictly in JSON matching the schema.`;

    const userPrompt = `Review the risk profile for:
Symbols: ${JSON.stringify(symbols)}
Code-eligible candidates (you may only narrow this list): ${JSON.stringify(deterministicAllowed)}
Code-rejected candidates (must remain rejected): ${JSON.stringify(deterministicRejected)}
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

    const agentAnalytics = {
      correlations: analytics.correlations,
      clusters: analytics.clusters,
      regimes: analytics.regimes,
      exposureWarnings: analytics.exposureWarnings,
    };
    const res = await context.ports.agent.invokeAgent<RiskStepOutput>({
      role: "RISK_MANAGER",
      systemPrompt,
      userPrompt,
      untrustedData: {
        analytics: agentAnalytics,
        technicalSummary: techOutput?.analyses.slice(0, 40),
        newsSummary: newsOutput?.analyses.slice(0, 40),
      },
      schemaValidator: validateRiskOutput,
      fallback,
    });

    const decision = reconcileRiskDecision(symbols, deterministicAllowed, deterministicRejected, res.output);
    if (decision.approvedCandidates.length !== res.output.approvedCandidates.length) {
      context.log("Risk-Ausgabe begrenzt: nicht freigegebene, unbekannte oder zugleich abgelehnte Symbole wurden entfernt.", "WARN");
    }
    const allocation = computePortfolioAllocation(
      decision.approvedCandidates,
      analytics.portfolioSeriesBySymbol,
      context.asOf,
    );
    context.log(
      `Portfolio-Allokation ${allocation.method}: ${allocation.weights.length} Assets` +
        (allocation.reason ? ` (${allocation.reason})` : ""),
      allocation.method === "EQUAL_WEIGHT_FALLBACK" ? "WARN" : "INFO",
    );

    return {
      ...decision,
      correlationWarnings: [...new Set([...analytics.exposureWarnings, ...decision.correlationWarnings])].slice(0, 10),
      portfolioAllocation: allocation,
    };
  },
};
