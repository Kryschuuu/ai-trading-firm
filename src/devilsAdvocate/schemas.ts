/**
 * Validierungsschemata für den Devil's Advocate (RMA-P3-03, v1.66.0).
 */

import {
  DEVILS_ADVOCATE_LIMITS,
  DEVILS_ADVOCATE_SCHEMA_VERSION,
  type DevilsAdvocateAnalysisOutput,
  type FalsificationEntry,
} from "./types";
import { computeDisagreementScore, evaluateDisagreementAction } from "./scoring";
import { loadDevilsAdvocateConfig } from "./config";

export function validateDevilsAdvocateOutput(input: unknown): {
  valid: boolean;
  data?: DevilsAdvocateAnalysisOutput;
  error?: string;
} {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { valid: false, error: "Devil's Advocate output must be an object" };
  }

  const obj = input as Record<string, unknown>;
  if (!Array.isArray(obj.analyses)) {
    return { valid: false, error: "Devil's Advocate output: analyses must be an array" };
  }

  const cfg = loadDevilsAdvocateConfig();
  const rawList = obj.analyses;
  const analyses: FalsificationEntry[] = [];

  let abstainedCount = 0;
  let scaleDownCount = 0;
  let humanReviewCount = 0;
  let noOpCount = 0;
  let totalDisagreement = 0;

  for (let i = 0; i < rawList.length && i < DEVILS_ADVOCATE_LIMITS.maxSetups; i++) {
    const item = rawList[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const raw = item as Record<string, unknown>;

    const instrumentId = typeof raw.instrumentId === "string" ? raw.instrumentId.trim() : "";
    if (!instrumentId) continue;

    const side = typeof raw.side === "string" && raw.side.toUpperCase() === "SHORT" ? "SHORT" : "LONG";
    const abstain = Boolean(raw.abstain);
    const abstainReason = typeof raw.abstainReason === "string" ? raw.abstainReason.slice(0, 200) : null;

    const counterThesis = typeof raw.counterThesis === "string"
      ? raw.counterThesis.slice(0, DEVILS_ADVOCATE_LIMITS.maxCounterThesisLength)
      : abstain ? "Enthaltung mangels Daten" : "Keine Gegenhypothese formuliert";

    const strongestOpposingEvidence = typeof raw.strongestOpposingEvidence === "string"
      ? raw.strongestOpposingEvidence.slice(0, DEVILS_ADVOCATE_LIMITS.maxEvidenceSummaryLength)
      : "";

    const missingEvidence = typeof raw.missingEvidence === "string"
      ? raw.missingEvidence.slice(0, DEVILS_ADVOCATE_LIMITS.maxMissingEvidenceLength)
      : "";

    const falsifiers = Array.isArray(raw.falsifiers)
      ? raw.falsifiers
          .filter((f): f is string => typeof f === "string" && f.trim().length > 0)
          .slice(0, DEVILS_ADVOCATE_LIMITS.maxFalsifiers)
          .map((f) => f.slice(0, DEVILS_ADVOCATE_LIMITS.maxFalsifierLength))
      : [];

    const failureModes = Array.isArray(raw.failureModes)
      ? raw.failureModes
          .filter((m): m is string => typeof m === "string" && m.trim().length > 0)
          .slice(0, DEVILS_ADVOCATE_LIMITS.maxFailureModes)
          .map((m) => m.slice(0, DEVILS_ADVOCATE_LIMITS.maxFailureModeLength))
      : [];

    const citations = Array.isArray(raw.citations)
      ? raw.citations
          .filter((c): c is string => typeof c === "string" && c.trim().length > 0)
          .slice(0, DEVILS_ADVOCATE_LIMITS.maxCitations)
          .map((c) => c.slice(0, DEVILS_ADVOCATE_LIMITS.maxCitationLength))
      : [];

    const confidence = typeof raw.confidence === "number" && Number.isFinite(raw.confidence)
      ? Math.max(0, Math.min(1, raw.confidence))
      : 0;

    const severity = typeof raw.severity === "number" && Number.isFinite(raw.severity)
      ? Math.max(0, Math.min(1, raw.severity))
      : 0;

    // Deterministische Score-Berechnung (Code-Ebene, nicht dem LLM überlassen)
    const disagreementScore = computeDisagreementScore({
      confidence,
      severity,
      falsifierCount: falsifiers.length,
      failureModeCount: failureModes.length,
      abstain,
    });

    const actionEval = evaluateDisagreementAction(disagreementScore, cfg, abstain);

    if (abstain) abstainedCount++;
    if (actionEval.action === "SCALE_DOWN") scaleDownCount++;
    else if (actionEval.action === "REQUIRE_HUMAN_REVIEW" || actionEval.action === "REJECT") humanReviewCount++;
    else noOpCount++;

    totalDisagreement += disagreementScore;

    analyses.push({
      instrumentId,
      side,
      abstain,
      abstainReason,
      counterThesis,
      strongestOpposingEvidence,
      missingEvidence,
      falsifiers,
      failureModes,
      citations,
      confidence,
      severity,
      disagreementScore,
      recommendedAction: actionEval.action,
      riskScaleFactor: actionEval.riskScaleFactor,
      rationale: actionEval.rationale,
    });
  }

  const total = analyses.length;
  const avgDisagreement = total > 0 ? Number((totalDisagreement / total).toFixed(4)) : 0;

  const data: DevilsAdvocateAnalysisOutput = {
    schemaVersion: DEVILS_ADVOCATE_SCHEMA_VERSION,
    asOf: typeof obj.asOf === "string" ? obj.asOf : new Date().toISOString(),
    snapshotHash: typeof obj.snapshotHash === "string" ? obj.snapshotHash : "unknown",
    analyses,
    summary: {
      total,
      abstained: abstainedCount,
      scaleDownCount,
      humanReviewCount,
      noOpCount,
      avgDisagreement,
    },
    disclaimer: "FALSIFICATION_ONLY_STRICT_DEFENSIVE_ACTION",
  };

  return { valid: true, data };
}
