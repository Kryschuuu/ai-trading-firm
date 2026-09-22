/**
 * Deterministische Bewertung und Schwellenwert-Logik des Devil's Advocate (RMA-P3-03, v1.66.0).
 *
 * Invariante:
 *   - Reine, versionierte Ableitung (`da1`).
 *   - Hohes Disagreement kann NIEMALS das Risiko erhöhen.
 *   - Gültige Aktionen sind ausschließlich:
 *       NO_OP (Faktor 1.0)
 *       SCALE_DOWN (Faktor z.B. 0.50)
 *       REQUIRE_HUMAN_REVIEW (Faktor 0.0 — Trade muss manuell freigegeben werden oder wird pausiert)
 *       REJECT (Faktor 0.0)
 *   - Bei Enthaltung (abstain=true) bleibt das Risiko unberührt (NO_OP mit Faktor 1.0),
 *     wobei fehlende Evidenz explizit dokumentiert wird.
 */

import type { DevilsAdvocateAction, DevilsAdvocateConfig } from "./types";

export interface ComputeScoreParams {
  confidence: number; // 0..1
  severity: number; // 0..1
  falsifierCount: number;
  failureModeCount: number;
  abstain: boolean;
}

/**
 * Berechnet den Disagreement-Score deterministisch (Formel da1):
 * Wenn abstain = true: Score ist 0 (kein hinreichender Dissens nachweisbar).
 * Andernfalls: Basis = (0.6 * confidence + 0.4 * severity).
 * Bonus für konkrete Falsifikatoren & Szenarien (max +0.10).
 * Ergebnis ist strikt auf [0, 1] geklemmt.
 */
export function computeDisagreementScore(params: ComputeScoreParams): number {
  if (params.abstain) {
    return 0;
  }

  const conf = Math.max(0, Math.min(1, params.confidence));
  const sev = Math.max(0, Math.min(1, params.severity));

  const baseScore = 0.6 * conf + 0.4 * sev;

  // Spezifitäts-Bonus: Mindestens 2 Falsifikatoren und 1 Failure Mode stützen die Gegenhypothese
  let specificityBonus = 0;
  if (params.falsifierCount >= 2 && params.failureModeCount >= 1) {
    specificityBonus = Math.min(0.10, (params.falsifierCount + params.failureModeCount) * 0.02);
  }

  const rawScore = baseScore + specificityBonus;
  return Number(Math.max(0, Math.min(1, rawScore)).toFixed(4));
}

/**
 * Leitet die defensive Aktion und den Risikofaktor ab.
 * Niemals automatischer Risk-Boost (> 1.0).
 */
export function evaluateDisagreementAction(
  disagreementScore: number,
  config: DevilsAdvocateConfig,
  abstain: boolean
): { action: DevilsAdvocateAction; riskScaleFactor: number; rationale: string } {
  if (abstain) {
    return {
      action: "NO_OP",
      riskScaleFactor: 1.0,
      rationale: "Devil's Advocate enthält sich mangels belastbarer Gegenevidenz (keine Risikomodifikation).",
    };
  }

  // Shadow Mode schützt das System vor ungetesteten Live-Änderungen:
  if (config.shadowMode) {
    return {
      action: "NO_OP",
      riskScaleFactor: 1.0,
      rationale: `Shadow Mode aktiv: berechneter Dissens ${disagreementScore} (wäre ${
        disagreementScore >= config.humanReviewThreshold
          ? "REQUIRE_HUMAN_REVIEW"
          : disagreementScore >= config.scaleDownThreshold
          ? "SCALE_DOWN"
          : "NO_OP"
      }).`,
    };
  }

  if (disagreementScore >= config.humanReviewThreshold) {
    return {
      action: "REQUIRE_HUMAN_REVIEW",
      riskScaleFactor: 0.0,
      rationale: `Starker Dissens (${disagreementScore} >= ${config.humanReviewThreshold}): Primärthese gravierend falsifiziert — menschlicher Review oder Stop erforderlich.`,
    };
  }

  if (disagreementScore >= config.scaleDownThreshold) {
    return {
      action: "SCALE_DOWN",
      riskScaleFactor: Math.min(1.0, Math.max(0.1, config.scaleDownFactor)),
      rationale: `Moderater Dissens (${disagreementScore} >= ${config.scaleDownThreshold}): Risiko wird auf Faktor ${config.scaleDownFactor} skaliert.`,
    };
  }

  return {
    action: "NO_OP",
    riskScaleFactor: 1.0,
    rationale: `Geringer Dissens (${disagreementScore} < ${config.scaleDownThreshold}): Gegenargumente nicht hinreichend gravierend.`,
  };
}
