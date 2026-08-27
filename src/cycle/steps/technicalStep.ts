/**
 * Step 4: Technical Analyst (08:00 UTC).
 *
 * Führt Multi-Timeframe-Technische-Analyse durch.
 * HARTE CODE-GRENZE: Nur die Top-40 der Daily Candidate List werden analysiert.
 * Wird ein 41. Instrument übergeben, schlägt die Validierung mit ShortlistLimitExceededError fehl.
 */

import type { StepDefinition, StepExecutionContext } from "../types";
import { type TechnicalStepOutput, validateTechnicalOutput } from "../schemas";
import { assertShortlistLimit } from "../security";
import type { SelectionStepOutput } from "../schemas";

export interface TechnicalStepInput {
  candidates?: Array<{ instrumentId: string; rank?: number; score?: number }>;
}

export const technicalStep: StepDefinition<TechnicalStepInput, TechnicalStepOutput> = {
  stepId: "04-technical-analyst",
  name: "Technical Analyst",
  role: "TECHNICAL_ANALYST",
  timeWindow: "08:00-09:00",
  llmAllowed: true,
  retryPolicy: {
    maxAttempts: 2,
    backoffMs: 200,
  },

  validateInput(input: unknown): TechnicalStepInput {
    let list: Array<{ instrumentId: string }> = [];
    if (input && typeof input === "object") {
      const obj = input as Record<string, unknown>;
      if (Array.isArray(obj.candidates)) {
        list = obj.candidates as Array<{ instrumentId: string }>;
      }
    }

    // HARTE CODE-GRENZE: 41+ Instrumente werden strikt abgewiesen
    assertShortlistLimit(list, 40);

    return { candidates: list };
  },

  async execute(context: StepExecutionContext<TechnicalStepInput>): Promise<TechnicalStepOutput> {
    const selection =
      context.input?.candidates ??
      (context.previousStepOutputs["03-market-selection"] as SelectionStepOutput | undefined)?.candidates ??
      [];

    // Erneute Prüfung der Code-Grenze am Ausführungspunkt
    assertShortlistLimit(selection, 40);

    context.log(`Starte Technische Analyse für ${selection.length} Instrumente (Code-Limit: max. 40) …`);

    // Standard-Fallback für alle Kandidaten
    const defaultAnalyses = selection.map((c) => ({
      instrumentId: c.instrumentId,
      bias: "NEUTRAL" as const,
      technicalScore: 50,
      rsi: 50,
      trend: "neutral",
      keyLevels: { support: 0, resistance: 0 },
      thesis: "Reguläre Konsolidierung im 4h/1h-Chart (Deterministischer Fallback)",
    }));

    const fallback: TechnicalStepOutput = {
      analyses: defaultAnalyses,
      analyzedCount: defaultAnalyses.length,
    };

    if (selection.length === 0) {
      return fallback;
    }

    const systemPrompt = `You are the Technical Analyst of an autonomous trading firm.
Analyze the provided shortlist of market instruments (strictly bounded to max 40).
For each instrument, determine:
- bias: BULLISH | BEARISH | NEUTRAL
- technicalScore: 0 to 100
- RSI and ATR estimates
- trend and key support/resistance levels
- concise technical thesis
Respond strictly with valid JSON conforming to the schema.`;

    const userPrompt = `Analyze the following instruments (strictly max 40):
${JSON.stringify(selection.map((s) => s.instrumentId))}
JSON schema:
{
  "analyses": [
    {
      "instrumentId": "string",
      "bias": "BULLISH|BEARISH|NEUTRAL",
      "technicalScore": 75.0,
      "rsi": 54.2,
      "atr": 1.5,
      "trend": "bullish",
      "keyLevels": { "support": 100, "resistance": 110 },
      "thesis": "string"
    }
  ],
  "analyzedCount": number
}`;

    const res = await context.ports.agent.invokeAgent<TechnicalStepOutput>({
      role: "TECHNICAL_ANALYST",
      systemPrompt,
      userPrompt,
      untrustedData: { instrumentsToAnalyze: selection },
      schemaValidator: validateTechnicalOutput,
      fallback,
    });

    // Validierung der Ausgabegrenze
    assertShortlistLimit(res.output.analyses, 40);

    return res.output;
  },
};
