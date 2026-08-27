/**
 * Step 3: Market Selection Agent (07:00 UTC).
 *
 * Erstellt die Daily Candidate List aus den Ergebnissen des Scanners (Step 1)
 * und dem Makro-Regime (Step 2).
 *
 * Code-Grenze: Maximal 40 Instrumente in der Shortlist.
 */

import type { StepDefinition, StepExecutionContext } from "../types";
import { type SelectionStepOutput, validateSelectionOutput } from "../schemas";
import { assertShortlistLimit } from "../security";
import type { DailyUniverseArtifact } from "@/scanner/artifacts";
import type { MacroStepOutput } from "../schemas";

export interface SelectionStepInput {
  scannerArtifact?: DailyUniverseArtifact;
  macroOutput?: MacroStepOutput;
}

export const selectionStep: StepDefinition<SelectionStepInput, SelectionStepOutput> = {
  stepId: "03-market-selection",
  name: "Market Selection Agent",
  role: "MARKET_SELECTION",
  timeWindow: "07:00-08:00",
  llmAllowed: true,
  retryPolicy: {
    maxAttempts: 2,
    backoffMs: 200,
  },

  async execute(context: StepExecutionContext<SelectionStepInput>): Promise<SelectionStepOutput> {
    context.log("Erstelle Daily Candidate List aus Scanner- und Makro-Daten …");

    const scannerArtifact =
      context.input?.scannerArtifact ??
      (context.previousStepOutputs["01-market-scanner"] as DailyUniverseArtifact | undefined);

    const macroOutput =
      context.input?.macroOutput ??
      (context.previousStepOutputs["02-macro-analyst"] as MacroStepOutput | undefined);

    // Deep- und Daily-Kandidaten aus dem Scanner heranziehen
    const deepCandidates = scannerArtifact?.levels.deep ?? [];
    const dailyCandidates = scannerArtifact?.levels.daily ?? [];

    // Fallback-Zusammenstellung (bis zu 40 Instrumente)
    const baseList = deepCandidates.length > 0 ? deepCandidates : dailyCandidates;
    const boundedCandidates = baseList.slice(0, 40).map((c, i) => ({
      instrumentId: c.instrumentId,
      rank: i + 1,
      score: c.score,
      assetClass: c.assetClass,
      selectionRationale: `Selektiert über Scanner-Score ${c.score.toFixed(1)} (${c.regime}-Regime)`,
    }));

    const fallback: SelectionStepOutput = {
      candidates: boundedCandidates,
      selectedCount: boundedCandidates.length,
      asOf: context.clock.toISOString(),
    };

    const systemPrompt = `You are the Market Selection Agent of an autonomous trading firm.
Your role is to evaluate the candidates proposed by the deterministic Market Scanner in light of the Macro Analyst's findings.
Select a focused Daily Candidate List containing at most 40 instruments.
Rank them and provide a short selection rationale for each.
Respond strictly in JSON matching the schema.`;

    const userPrompt = `Macro Regime: ${macroOutput?.regime ?? "MIXED"} (View: ${macroOutput?.view ?? "NEUTRAL"}, Vol: ${
      macroOutput?.volatilityRegime ?? "NORMAL"
    }).
Scanner provided ${baseList.length} top candidates.
Select and rank up to 40 candidates.
JSON schema:
{
  "candidates": [
    { "instrumentId": "string", "rank": 1, "score": 85.0, "assetClass": "crypto", "selectionRationale": "string" }
  ],
  "selectedCount": number,
  "asOf": "string"
}`;

    const res = await context.ports.agent.invokeAgent<SelectionStepOutput>({
      role: "MARKET_SELECTION",
      systemPrompt,
      userPrompt,
      untrustedData: {
        candidatesPreview: baseList.slice(0, 40).map((c) => ({
          id: c.instrumentId,
          score: c.score,
          assetClass: c.assetClass,
          regime: c.regime,
        })),
        macroContext: macroOutput,
      },
      schemaValidator: validateSelectionOutput,
      fallback,
    });

    // Harte Code-Schranke: Die Liste darf niemals 40 Instrumente überschreiten
    assertShortlistLimit(res.output.candidates, 40);

    return res.output;
  },
};
