/**
 * Pipeline Step 7b (oder nach Research / Backtest): Devil's Advocate Step.
 *
 * Nimmt verifizierte Setups und deren Research-/Markt-Kontext, führt eine
 * unabhängige Falsifikation durch und gibt strukturierte Falsifikations-
 * ergebnisse mit Disagreement-Score und Risikoskalierung zurück.
 */

import type { StepDefinition, StepExecutionContext } from "../types";
import type { BacktestStepOutput, ResearchStepOutput, TradeSetupProposal } from "../schemas";
import {
  type DevilsAdvocateStepOutput,
  DEVILS_ADVOCATE_SCHEMA_VERSION,
} from "@/devilsAdvocate/types";
import { validateDevilsAdvocateOutput } from "@/devilsAdvocate/schemas";
import { loadDevilsAdvocateConfig } from "@/devilsAdvocate/config";
import { DEVILS_ADVOCATE_SYSTEM_PROMPT, buildDevilsAdvocateUserPrompt } from "@/devilsAdvocate/prompt";
import { createHash } from "node:crypto";

export interface DevilsAdvocateStepInput {
  setups?: TradeSetupProposal[];
}

function hashInput(data: unknown): string {
  return "da1:" + createHash("sha256").update(JSON.stringify(data ?? {})).digest("hex");
}

export const devilsAdvocateStep: StepDefinition<DevilsAdvocateStepInput, DevilsAdvocateStepOutput> = {
  stepId: "07b-devils-advocate",
  name: "Devil's Advocate",
  role: "DEVILS_ADVOCATE",
  timeWindow: "12:00-13:00",
  llmAllowed: true,
  retryPolicy: {
    maxAttempts: 2,
    backoffMs: 200,
  },

  async execute(context: StepExecutionContext<DevilsAdvocateStepInput>): Promise<DevilsAdvocateStepOutput> {
    const cfg = loadDevilsAdvocateConfig();
    const researchOutput = context.previousStepOutputs["07-research"] as ResearchStepOutput | undefined;
    const backtestOutput = context.previousStepOutputs["08-backtest-verification"] as BacktestStepOutput | undefined;

    // Nur verifizierte Setups falsifizieren, falls Backtest schon da ist; sonst Research-Setups
    let candidateSetups: TradeSetupProposal[] = [];
    if (context.input?.setups) {
      candidateSetups = context.input.setups;
    } else if (backtestOutput?.verifiedSetups) {
      candidateSetups = backtestOutput.verifiedSetups
        .filter((v) => v.verified)
        .map((v) => v.setup);
    } else if (researchOutput?.setups) {
      candidateSetups = researchOutput.setups;
    }

    const asOfStr = context.clock.toISOString();
    const snapshotHash = hashInput({
      setups: candidateSetups,
      macro: context.previousStepOutputs["02-macro-analyst"],
      news: context.previousStepOutputs["05-news-analyst"],
    });

    // Leer-Fallback bei keinen Kandidaten oder Deaktivierung
    const fallbackOutput: DevilsAdvocateStepOutput = {
      schemaVersion: DEVILS_ADVOCATE_SCHEMA_VERSION,
      asOf: asOfStr,
      snapshotHash,
      analyses: candidateSetups.map((s) => ({
        instrumentId: s.instrumentId,
        side: s.side,
        abstain: true,
        abstainReason: cfg.enabled ? "NO_COUNTER_EVIDENCE" : "DEVILS_ADVOCATE_DISABLED",
        counterThesis: "Enthaltung mangels Widerspruchsevidenz",
        strongestOpposingEvidence: "",
        missingEvidence: "",
        falsifiers: [],
        failureModes: [],
        citations: [],
        confidence: 0,
        severity: 0,
        disagreementScore: 0,
        recommendedAction: "NO_OP",
        riskScaleFactor: 1.0,
        rationale: "Keine Einwände festgestellt.",
      })),
      summary: {
        total: candidateSetups.length,
        abstained: candidateSetups.length,
        scaleDownCount: 0,
        humanReviewCount: 0,
        noOpCount: candidateSetups.length,
        avgDisagreement: 0,
      },
      disclaimer: "FALSIFICATION_ONLY_STRICT_DEFENSIVE_ACTION",
      status: cfg.enabled ? (cfg.shadowMode ? "SHADOW" : "COMPLETED") : "SKIPPED",
      mode: cfg.enabled ? (cfg.shadowMode ? "shadow" : "active") : "disabled",
    };

    if (!cfg.enabled || candidateSetups.length === 0) {
      context.log(
        !cfg.enabled
          ? "Devil's Advocate ist per Konfiguration deaktiviert (DEVILS_ADVOCATE_ENABLED=false)."
          : "Keine Kandidaten für Falsifikation vorhanden.",
        "INFO"
      );
      return fallbackOutput;
    }

    context.log(
      `Devil's Advocate prüft ${candidateSetups.length} Setups auf Falsifikation (${cfg.shadowMode ? "SHADOW MODE" : "ACTIVE"}) …`
    );

    const userPrompt = buildDevilsAdvocateUserPrompt({
      proposals: candidateSetups,
      technicalAnalyses: context.previousStepOutputs["04-technical-analyst"],
      macroContext: context.previousStepOutputs["02-macro-analyst"],
      newsContext: context.previousStepOutputs["05-news-analyst"],
    });

    const untrustedData = {
      setups: candidateSetups,
      macro: context.previousStepOutputs["02-macro-analyst"],
      technical: context.previousStepOutputs["04-technical-analyst"],
      news: context.previousStepOutputs["05-news-analyst"],
    };

    const res = await context.ports.agent.invokeAgent<any>({
      role: "DEVILS_ADVOCATE",
      systemPrompt: DEVILS_ADVOCATE_SYSTEM_PROMPT,
      userPrompt,
      untrustedData,
      schemaValidator: (raw) => {
        const v = validateDevilsAdvocateOutput(raw);
        return { valid: v.valid, data: v.data, error: v.error };
      },
      fallback: fallbackOutput,
    });

    const validated = res.output;
    const finalOutput: DevilsAdvocateStepOutput = {
      ...validated,
      asOf: asOfStr,
      snapshotHash,
      status: cfg.shadowMode ? "SHADOW" : "COMPLETED",
      mode: cfg.shadowMode ? "shadow" : "active",
    };

    await context.ports.audit.logEvent({
      event: "CYCLE_STEP_COMPLETED",
      level: "INFO",
      cycleId: context.cycleId,
      stepId: "07b-devils-advocate",
      role: "DEVILS_ADVOCATE",
      timestamp: asOfStr,
      detail: {
        snapshotHash,
        total: finalOutput.summary.total,
        abstained: finalOutput.summary.abstained,
        scaleDownCount: finalOutput.summary.scaleDownCount,
        humanReviewCount: finalOutput.summary.humanReviewCount,
        avgDisagreement: finalOutput.summary.avgDisagreement,
        mode: finalOutput.mode,
      },
    });

    return finalOutput;
  },
};
