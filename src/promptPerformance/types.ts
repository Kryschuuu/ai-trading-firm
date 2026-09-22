/**
 * Typen & Grenzen des Prompt-Version-Metrikvergleichs (RMA-P3-02, v1.65.0)
 *
 * Domain-Schnitt zwischen Kanonisierung, Store, Metriken und Vergleich —
 * kein DB-/Netz-Import, damit Tests ohne Postgres laufen können.
 */

/** Harte API-/Speichergrenzen (bounded by design; keine unbeschränkten Labels). */
export const PROMPT_PERF_LIMITS = {
  /** Artefakte/Listen: hart geklemmt, Default 50, Maximum 200 (wie Forecasts). */
  defaultListLimit: 50,
  maxListLimit: 200,
  /** Runs/Metriken: hart geklemmt, Maximum 5 000 je Version (Schutz vor Scan). */
  maxRunsPerQuery: 5_000,
  maxMetricsForecasts: 20_000,
  /** Vergleich: maximal 500 Segmente, sonst `TOO_MANY_SEGMENTS` (wie Forecasts). */
  maxCompareSegments: 500,
  /** Mindeststichprobe je Segment für `status: ok` (Default 30 wie Forecasts). */
  minSampleDefault: 30,
  minSampleMin: 5,
  minSampleMax: 1_000,
  /** Promptlänge: still gekürzt auf 200 000 Zeichen (Schutz, nicht Secret). */
  maxPromptTextLength: 200_000,
} as const;

/** Gültige Sampling-Rollen (bounded; Instrument-IDs nie als Label). */
export const PROMPT_ROLES = [
  "CEO",
  "RESEARCH",
  "BACKTEST",
  "RISK_MANAGER",
  "APPROVER",
  "EXECUTOR",
  "TECHNICAL_ANALYST",
  "MACRO_ANALYST",
  "NEWS_ANALYST",
  "SWING_RESEARCHER",
  "SCOUT",
  "DILIGENCE",
  "DEVILS_ADVOCATE",
] as const;

export type PromptRole = (typeof PROMPT_ROLES)[number];

/** Fehlerklasse des Prompt-Performance-Moduls (maschinenlesbarer Code). */
export class PromptPerfError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail?: Record<string, unknown>
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Artefakt-Metadaten (immutable Prompt-Version). */
export interface PromptArtifact {
  id: string;
  agentId: string | null;
  role: string;
  version: number;
  promptHash: string; // pp1:<64 hex>
  templateSchemaVersion: string; // "1"
  promptText: string; // kanonischer Text (nur berechtigt abrufbar)
  createdAt: Date;
}

/** Provenanz eines einzelnen LLM-Aufrufs. */
export interface PromptRunProvenance {
  id: string;
  artifactId: string | null; // null = UNKNOWN (historische Lücke)
  agentId: string | null;
  role: string;
  promptHash: string; // pp1:<hex> | UNKNOWN
  promptVersion: number | null; // null = UNKNOWN
  provider: string; // bounded label (ollama|openai|gemini|anthropic|fallback)
  model: string;
  temperature: number | null;
  maxTokens: number | null;
  toolSchemaVersion: string | null;
  startedAt: Date;
  endedAt: Date;
  latencyMs: number; // ms, Einheit klar
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  costStatus: "billed" | "free" | "unknown";
  success: boolean;
  errorCode: string | null;
  idempotencyKey: string; // stabiler Retry-Schlüssel
  createdAt: Date;
}

/** Per-Version-Metriken (Forecast + Attribution + Laufzeit). */
export interface PromptVersionMetrics {
  promptVersion: number | null; // null = UNKNOWN
  promptHash: string;
  versionLabel: string; // bounded label vN#abcd1234
  counts: {
    runs: number;
    forecastsTotal: number;
    forecastsResolved: number;
    forecastsVoid: number;
    forecastsPending: number;
  };
  coverage: number | null; // (resolved+void)/due, null bei due=0
  abstentionRate: number | null;
  forecastQuality: {
    brierScore: number | null;
    brierScoreMultiClass: number | null;
    brierSkillScore: number | null;
    logLoss: number | null;
    expectedCalibrationError: number | null;
    hitRate: number | null;
    hitRateWilson95: { lower: number; upper: number } | null;
    brierUncertainty: { se: number; lower: number; upper: number } | null;
    reliability: Array<{
      index: number;
      count: number;
      meanForecast: number | null;
      observedRate: number | null;
      wilson95: { lower: number; upper: number } | null;
    }>;
    status: "ok" | "insufficient-sample";
  };
  tradeContribution: {
    attributedPnl: number | null; // Summe der AGENT-Beiträge (null = keine Attribution)
    tradeCount: number;
    avgContribution: number | null;
    maxDrawdown: number | null; // max. kumulierter Drawdown (negativ oder 0), null = keine Attribution
  };
  runtime: {
    latency: {
      count: number;
      avgMs: number | null;
      p50Ms: number | null;
      p95Ms: number | null;
    };
    tokens: {
      totalPrompt: number;
      totalCompletion: number;
      total: number;
      avgPerRun: number | null;
    };
    cost: {
      totalUsd: number;
      avgUsd: number | null;
      billedRuns: number;
      freeRuns: number;
    };
  };
}

/** Vergleichsbericht Baseline vs Candidate mit identischen Segmenten. */
export interface PromptComparisonReport {
  generatedAt: string;
  baseline: PromptVersionMetrics;
  candidate: PromptVersionMetrics;
  filters: {
    agentRole?: string;
    horizonId?: string;
    entityId?: string;
    regime?: string;
    fromAsOf?: string;
    toAsOf?: string;
  };
  deltas: {
    brierDelta: number | null; // candidate - baseline (negativ = besser)
    bssDelta: number | null;
    eceDelta: number | null;
    hitRateDelta: number | null;
    coverageDelta: number | null;
    latencyDeltaMs: number | null;
    costDeltaUsd: number | null;
    pnlDelta: number | null;
  };
  recommendation: {
    action: "MAINTAIN_BASELINE" | "CONSIDER_CANDIDATE" | "INSUFFICIENT_EVIDENCE";
    reason: string;
    // Promotion nur als Empfehlung hinter bestehendem Gate — nie automatisch.
    gateRequired: "human-review";
    calibrationGuard: {
      // Candidate darf nicht schlechter kalibriert sein als Baseline allein wegen PnL.
      candidateEce: number | null;
      baselineEce: number | null;
      passes: boolean;
    };
  };
  warnings: string[];
}
