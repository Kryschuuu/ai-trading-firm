/**
 * Typen und Schnittstellen für den Daily/Weekly Agent Cycle (Task 06).
 *
 * Orchestriert die Tages- und Wochenroutine:
 *   - Deterministischer Scanner (null LLM)
 *   - LLM-Analyse nur auf Top-40 Shortlists
 *   - Input-/Output-Contracts mit JSON-Schema-Validierung
 *   - Prompt-Injection-Schutz über strikte Datentrennung
 *   - Injizierbare Clock und Scheduler
 *   - Fehlerbehandlung, kontrollierter Abbruch, Audit-Log
 */

import type { DailyUniverseArtifact } from "@/scanner/artifacts";
import type { WeeklyReview } from "@/scanner/weekly";

/** Rollen der Pipeline-Schritte */
export type CycleStepRole =
  | "MARKET_SCANNER"
  | "MACRO_ANALYST"
  | "MARKET_SELECTION"
  | "TECHNICAL_ANALYST"
  | "NEWS_ANALYST"
  | "RISK_MANAGER"
  | "RESEARCH"
  | "BACKTEST_VERIFICATION"
  | "WEEKLY_REVIEW";

/** Status eines Zyklen-Laufs */
export type CycleStatus = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "ABORTED";

/** Status eines einzelnen Schritts */
export type StepStatus = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "SKIPPED";

/** Komplexitätsgrad einer Eskalationsanforderung */
export type EscalationComplexity = "low" | "medium" | "high" | "critical";

/**
 * Event für Modell-Eskalation.
 * Vorbereitung für Task-09 (Model Router). Falls kein Router existiert,
 * wird das Event protokolliert und die bestehende Provider-Fallback-Kette genutzt.
 */
export interface ModelEscalationRequest {
  agent: string;
  reason: string;
  complexity: EscalationComplexity;
  confidence?: number;
  timestamp: string;
}

/** Konfigurierbare Retry-Policy je Step */
export interface RetryPolicy {
  /** Maximale Anzahl Versuche (Standard: 1 = kein Retry) */
  maxAttempts: number;
  /** Basis-Verzögerung in Millisekunden vor erneutem Versuch */
  backoffMs: number;
  /** Multiplikator für exponentielles Backoff (Standard: 2) */
  backoffMultiplier?: number;
}

/** Protokolleintrag eines ausgeführten Schritts */
export interface StepRunRecord {
  stepId: string;
  role: CycleStepRole;
  status: StepStatus;
  attempts: number;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  error?: string;
  outputSummary?: Record<string, unknown>;
  artifactPath?: string;
}

/** Ergebnis und Metadaten eines Zyklus-Laufs */
export interface CycleRunRecord {
  id: string;
  type: "daily" | "weekly";
  date: string; // YYYY-MM-DD
  week?: string; // YYYY-Www (nur bei weekly)
  status: CycleStatus;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  steps: StepRunRecord[];
  escalations: ModelEscalationRequest[];
  artifacts: string[];
  error?: {
    stepId: string;
    message: string;
    code?: string;
  };
}

/** Audit-Ereignis für Zyklen */
export interface CycleAuditEvent {
  event:
    | "CYCLE_STARTED"
    | "CYCLE_COMPLETED"
    | "CYCLE_FAILED"
    | "CYCLE_STEP_STARTED"
    | "CYCLE_STEP_COMPLETED"
    | "CYCLE_STEP_RETRY"
    | "CYCLE_STEP_FAILED"
    | "MODEL_ESCALATION_REQUEST";
  level: "INFO" | "WARN" | "CRITICAL";
  cycleId: string;
  stepId?: string;
  role?: string;
  detail: Record<string, unknown>;
  timestamp: string;
}

/** Uhr-Abstraktion zur Zeiteinjektion */
export interface Clock {
  now(): Date;
  nowMs(): number;
  toISOString(): string;
}

/** Harte Code-Grenze für Shortlists */
export const MAX_SHORTLIST_LIMIT = 40;

/** Fehler bei Verletzung des Shortlist-Limits */
export class ShortlistLimitExceededError extends Error {
  readonly count: number;
  readonly limit: number;

  constructor(count: number, limit = MAX_SHORTLIST_LIMIT) {
    super(`Shortlist-Limit überschritten: ${count} Instrumente übergeben, maximal ${limit} erlaubt.`);
    this.name = "ShortlistLimitExceededError";
    this.count = count;
    this.limit = limit;
  }
}

/** Kontext für die Ausführung eines Schritts */
export interface StepExecutionContext<TInput = unknown> {
  cycleId: string;
  date: string;
  asOf: Date;
  clock: Clock;
  input: TInput;
  previousStepOutputs: Readonly<Record<string, unknown>>;
  ports: CyclePorts;
  emitEscalation(req: Omit<ModelEscalationRequest, "timestamp">): void;
  log(message: string, level?: "INFO" | "WARN" | "CRITICAL"): void;
}

/** Definition eines einzelnen Pipeline-Schritts */
export interface StepDefinition<TInput = unknown, TOutput = unknown> {
  stepId: string;
  name: string;
  role: CycleStepRole;
  timeWindow: string; // z. B. "00:00-06:00"
  llmAllowed: boolean;
  retryPolicy?: RetryPolicy;
  validateInput?(input: unknown): TInput;
  validateOutput?(output: unknown): TOutput;
  execute(context: StepExecutionContext<TInput>): Promise<TOutput>;
}

/** Port-Schnittstellen für die Dependency Injection */
export interface CyclePorts {
  scanner: ScannerPort;
  analytics: AnalyticsPort;
  agent: AnalysisAgentPort;
  audit: CycleAuditPort;
}

/** Port für den Market Scanner (task-04) */
export interface ScannerPort {
  runScan(asOf: Date): Promise<DailyUniverseArtifact>;
}

/** Port für Portfolio Analytics & Risiko (task-05) */
export interface AnalyticsPort {
  computeCorrelationAndRisk(symbols: string[], asOf: Date): Promise<{
    correlations: Record<string, Record<string, number>>;
    clusters: string[][];
    regimes: Record<string, string>;
    exposureWarnings: string[];
  }>;
}

/** Agenten-Aufrufanfrage */
export interface AgentInvocationSpec<TOutput> {
  role: CycleStepRole;
  systemPrompt: string;
  userPrompt: string;
  /** Strukturierte externe Nutzdaten (Prompt-Injection-Schutz) */
  untrustedData?: unknown;
  /** JSON-Schema-Validierer für die Ausgabe */
  schemaValidator: (parsed: unknown) => { valid: boolean; data?: TOutput; error?: string };
  /** Sicherer Fallback bei ungültiger oder verweigerter Modellausgabe */
  fallback: TOutput;
  /** Optionale Eskalationsprüfung */
  escalationCheck?: (raw: string, parsed?: unknown) => Omit<ModelEscalationRequest, "timestamp"> | null;
}

/** Ergebnis eines Agenten-Aufrufs */
export interface AgentInvocationResult<TOutput> {
  output: TOutput;
  rawText: string;
  usedFallback: boolean;
  modelUsed: string;
  escalation?: ModelEscalationRequest;
}

/** Port für LLM-Agenten-Ausführung */
export interface AnalysisAgentPort {
  invokeAgent<T>(spec: AgentInvocationSpec<T>): Promise<AgentInvocationResult<T>>;
}

/** Port für Audit-Logging */
export interface CycleAuditPort {
  logEvent(event: CycleAuditEvent): Promise<void>;
  getEvents(cycleId?: string): Promise<CycleAuditEvent[]>;
}
