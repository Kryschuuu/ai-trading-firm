/**
 * Geteilte TypeScript-Typen für API-Responses (Client & Server).
 *
 * Ziel: keine `any`-Felder in Workshop/Dashboard-Komponenten. Die Typen
 * beschreiben die JSON-Drahtform — Drizzle-Rows mit numeric kommen als
 * String aus Postgres und werden hier bewusst als string modelliert,
 * Konvertierungen passieren explizit in den Komponenten.
 */

/** Zeile aus `agents` (POST /api/firm, PUT /api/firm/agents). */
export interface AgentRow {
  id: string;
  name: string;
  /** CEO | RESEARCH | BACKTEST | RISK_MANAGER | APPROVER | EXECUTOR */
  role: string;
  model: string;
  /** IDLE | RUNNING | BLOCKED | STOPPED */
  status: string;
  systemPrompt: string;
  createdAt: string;
  updatedAt: string;
}

/** Zeile aus `missions` (GET /api/firm, POST/PUT /api/firm/missions). */
export interface MissionRow {
  id: string;
  title: string;
  objective: string;
  symbol: string | null;
  /** numeric → kommt als String aus Postgres. */
  riskBudget: string;
  maxPositionPct: string;
  /** PENDING | ACTIVE | COMPLETED | KILLED */
  status: string;
  createdAt: string;
  updatedAt: string;
}

/** Entscheidung eines Agenten (engine.ts AgentDecision). */
export interface AgentDecisionDto {
  type: "TRADE" | "KILL" | "HOLD" | "REPORT" | "APPROVE" | "REJECT";
  symbol?: string;
  side?: "LONG" | "SHORT";
  stopLossPct?: number;
  reason?: string;
  riskScore?: number;
}

/** Trace-Schritt aus engine.ts (Schicht für Schicht). */
export interface TraceStepDto {
  layer: string;
  ok: boolean;
  detail: string;
}

/** Ergebnis eines einzelnen Agenten-Turns (POST /api/firm/run → result). */
export interface TurnResultDto {
  status: "EXECUTED" | "BLOCKED" | "HOLD" | "KILLED" | "REPORT" | "NOOP";
  decision: AgentDecisionDto;
  source: "ollama" | "fallback";
  model: string;
  latencyMs: number;
  fill?: unknown;
  guardrail?: string;
  trace?: TraceStepDto[];
}

export interface RunTurnResponse {
  ok: boolean;
  result?: TurnResultDto;
  error?: string;
}

/** Ein Turn aus GET /api/firm/log (letzte Agenten-Nachrichten). */
export interface TurnLogEntryDto {
  id: string;
  at: string;
  agent: string;
  role: string;
  missionId: string | null;
  decision: AgentDecisionDto | null;
  source?: string;
  model?: string;
  latencyMs?: number;
  /** Kurzform der Nachricht (agent_messages.content). */
  content?: string;
  prompt: string | null;
  rawResponse: string | null;
  provider?: string | null;
}

export interface LogResponse {
  ok: boolean;
  turns: TurnLogEntryDto[];
}

/** Response von GET /api/firm/missions. */
export interface MissionsIndexResponse {
  ok: boolean;
  missions: MissionRow[];
  symbols: string[];
  limits: {
    riskBudget: [number, number];
    maxPositionPct: [number, number];
  };
}

/** Response von POST/PUT /api/firm/missions. */
export interface MissionMutationResponse {
  ok: boolean;
  mission?: MissionRow;
  warnings?: string[];
  error?: string;
}

/** Response von PUT /api/firm/agents. */
export interface AgentPromptResponse {
  ok: boolean;
  agent?: AgentRow;
  warnings?: string[];
  error?: string;
}
