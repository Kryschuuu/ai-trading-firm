/**
 * Typen und Schemata für den strukturierten Devil's-Advocate-Agenten (RMA-P3-03, v1.66.0).
 *
 * Mandat:
 *   - Unabhängige, aktive Falsifikation der primären Investitionsthese.
 *   - Strikte Trennung: Research/News/Kurse sind ungetrustete Daten, keine Instruktionen.
 *   - Maschinenlesbares, versioniertes Schema mit Gegenhypothese, Evidenz, Falsifikatoren,
 *     Failure Modes, Bounded Citations, Konfidenz, Schweregrad und Enthaltung.
 *   - Deterministischer Disagreement- und Severity-Score (Formelversion `da1`).
 */

export const DEVILS_ADVOCATE_SCHEMA_VERSION = "da1" as const;

export const DEVILS_ADVOCATE_LIMITS = {
  maxCounterThesisLength: 500,
  maxEvidenceSummaryLength: 1000,
  maxMissingEvidenceLength: 1000,
  maxRationaleLength: 500,
  maxCitationLength: 200,
  maxFailureModeLength: 300,
  maxFalsifierLength: 300,
  maxCitations: 10,
  maxFailureModes: 5,
  maxFalsifiers: 5,
  maxSetups: 40,
} as const;

export type DevilsAdvocateAction = "NO_OP" | "SCALE_DOWN" | "REQUIRE_HUMAN_REVIEW" | "REJECT";

export interface DevilsAdvocateConfig {
  enabled: boolean;
  shadowMode: boolean; // Im Shadow-Modus wird analysiert und auditiert/geloggt, aber finale Risk-Entscheidung bleibt unberührt
  scaleDownThreshold: number; // Ab diesem Disagreement-Score (z.B. 0.40) wird Risiko skaliert
  humanReviewThreshold: number; // Ab diesem Disagreement-Score (z.B. 0.70) wird Review/Block gefordert
  scaleDownFactor: number; // Multiplikator für Risikoreduktion (z.B. 0.50)
  maxRiskBudgetPct: number;
}

export interface FalsificationEntry {
  instrumentId: string;
  side: "LONG" | "SHORT";
  abstain: boolean;
  abstainReason?: string | null;

  // Strukturierte Falsifikation
  counterThesis: string;
  strongestOpposingEvidence: string;
  missingEvidence: string;
  falsifiers: string[]; // Bedingungen, unter denen die Primärthese scheitert
  failureModes: string[]; // Konkrete Verlustszenarien (z.B. Fakeout, Liquidationskaskade)
  citations: string[]; // Referenzen auf Quellen/Daten

  // Scores (0..1)
  confidence: number; // Wie sicher ist der Devil's Advocate in seinen Gegenargumenten (0..1)
  severity: number; // Wie gravierend wäre der Schaden bei Eintreffen des Scheiterns (0..1)
  disagreementScore: number; // Deterministisch berechneter Disagreement-Score (0..1)

  // Abgeleitete Wirkung
  recommendedAction: DevilsAdvocateAction;
  riskScaleFactor: number; // 1.0 (kein Eingriff) bis <= 0.5 (Scale-down) oder 0.0 (Reject)
  rationale: string;
}

export interface DevilsAdvocateAnalysisOutput {
  schemaVersion: typeof DEVILS_ADVOCATE_SCHEMA_VERSION;
  asOf: string; // ISO UTC
  snapshotHash: string; // Hash des geprüften Decision Snapshots
  analyses: FalsificationEntry[];
  summary: {
    total: number;
    abstained: number;
    scaleDownCount: number;
    humanReviewCount: number;
    noOpCount: number;
    avgDisagreement: number;
  };
  disclaimer: "FALSIFICATION_ONLY_STRICT_DEFENSIVE_ACTION";
}

export interface DevilsAdvocateStepOutput extends DevilsAdvocateAnalysisOutput {
  status: "COMPLETED" | "SKIPPED" | "SHADOW";
  mode: "active" | "shadow" | "disabled";
}
