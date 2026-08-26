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

/**
 * Protokoll-DTOs aus GET /api/firm/log.
 *
 * `agent_messages` enthält absichtlich mehrere Nachrichtensorten: ausführbare
 * Agenten-Turns, Analystenberichte und Systemmeldungen. Diese sind keine
 * Varianten derselben Entscheidung. Der API-Vertrag bildet sie deshalb als
 * diskriminierte Union ab — so kann die UI nie einen Analystenbericht als
 * Trade-Entscheidung oder eine fehlende Latenz als `NaN s` darstellen.
 */
export type ProtocolEntryKind = "turn" | "analysis" | "system" | "message";

export interface ProtocolActorDto {
  /** Menschlich lesbarer, nie leerer Anzeigename. */
  name: string;
  /** Rolle bzw. klarer System-/Archivstatus, nie das Platzhalterzeichen `?`. */
  role: string;
  /** Woher die Attribution stammt (Live-Agent, gespeicherter Snapshot, System). */
  source: "agent" | "snapshot" | "system" | "orphaned";
}

/** LLM-/Ausführungsdaten. Fehlende Alt-Daten werden explizit als null geliefert. */
export interface ProtocolTraceDto {
  source: string | null;
  model: string | null;
  latencyMs: number | null;
  prompt: string | null;
  rawResponse: string | null;
  provider: string | null;
  usage: unknown | null;
  costUsd: number | null;
}

export interface ProtocolAnalysisDto {
  view: "BULLISH" | "BEARISH" | "NEUTRAL" | null;
  /** Normalisierte Konfidenz im geschlossenen Intervall [0, 1]. */
  confidence: number | null;
  thesis: string | null;
}

export interface ProtocolEntryBaseDto {
  id: string;
  at: string;
  /** Ursprünglicher agent_messages.type, z. B. REPORT oder MARKET_SCAN. */
  messageType: string;
  missionId: string | null;
  actor: ProtocolActorDto;
  content: string;
  trace: ProtocolTraceDto;
}

export interface ProtocolTurnEntryDto extends ProtocolEntryBaseDto {
  kind: "turn";
  decision: AgentDecisionDto;
}

export interface ProtocolAnalysisEntryDto extends ProtocolEntryBaseDto {
  kind: "analysis";
  analysis: ProtocolAnalysisDto;
}

export interface ProtocolSystemEntryDto extends ProtocolEntryBaseDto {
  kind: "system";
}

export interface ProtocolMessageEntryDto extends ProtocolEntryBaseDto {
  kind: "message";
}

export type ProtocolEntryDto =
  | ProtocolTurnEntryDto
  | ProtocolAnalysisEntryDto
  | ProtocolSystemEntryDto
  | ProtocolMessageEntryDto;

/**
 * Rückwärtskompatible, auf echte Entscheidungen gefilterte Ansicht. Sie wird
 * vom Workshop für „letzte Agenten-Turns“ benutzt; Analystenberichte stehen in
 * `entries` und werden im Protokoll separat und lesbar dargestellt.
 */
export interface TurnLogEntryDto {
  id: string;
  at: string;
  agent: string;
  role: string;
  missionId: string | null;
  decision: AgentDecisionDto;
  source: string | null;
  model: string | null;
  latencyMs: number | null;
  /** Kurzform der Nachricht (agent_messages.content). */
  content: string;
  prompt: string | null;
  rawResponse: string | null;
  provider: string | null;
  usage: unknown | null;
  costUsd: number | null;
}

export interface LogResponse {
  ok: boolean;
  /** Gemischte, chronologische Protokollansicht (Turn, Analyse, System, Nachricht). */
  entries: ProtocolEntryDto[];
  /** Nur echte Agentenentscheidungen, für bestehende Workshop-Clients. */
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
