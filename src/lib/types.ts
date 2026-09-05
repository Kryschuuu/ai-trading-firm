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
  /** Optimistic-Lock-Version (W2, v1.36.24) — steigt bei jedem Prompt-Update. */
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** Zeile aus `missions` (GET /api/firm, POST/PUT /api/firm/missions). */
export interface MissionRow {
  id: string;
  title: string;
  objective: string;
  /** Einzel-Symbol bei `scope = "SINGLE_SYMBOL"`, sonst `null`. */
  symbol: string | null;
  /**
   * Missions-Typ (v1.35.0): `"SINGLE_SYMBOL"` (ein Instrument) oder
   * `"SCAN_UNIVERSE"` (ein Marktsegment wird gescannt). Alt-Zeilen liefern den
   * DB-Default `"SINGLE_SYMBOL"`; ältere Frontends ohne das Feld behandeln es
   * als `"SINGLE_SYMBOL"`.
   */
  scope?: string | null;
  /** Marktsegment bei `scope = "SCAN_UNIVERSE"` (z. B. `ALL`, `INDICES`, `PENNY`). */
  segment?: string | null;
  /** Vorlagen-Slug, aus dem die Mission entstanden ist (reine Herkunft). */
  templateId?: string | null;
  /** numeric → kommt als String aus Postgres. */
  riskBudget: string;
  maxPositionPct: string;
  /** PENDING | ACTIVE | COMPLETED | KILLED */
  status: string;
  createdAt: string;
  updatedAt: string;
}

/** Missions-Typ in Klartext (GET /api/firm/missions → `scopes`). */
export interface MissionScopeDto {
  /** `SINGLE_SYMBOL` | `SCAN_UNIVERSE`. */
  id: string;
  /** Deutsche Bezeichnung für Auswahllisten. */
  label: string;
}

/**
 * Marktsegment in Klartext (GET /api/firm/missions → `segments`).
 *
 * Spiegel von `missionSegmentDto()` plus `instrumentCount`: die aktuell in der
 * Instrument-Registry gefundenen Instrumente. `0` bedeutet „Daten fehlen“
 * (`npm run universe:seed:markets` / `npm run market:sync`), nicht „keine
 * Chance“ — die UI zeigt den Hinweis direkt am Segment.
 */
export interface MissionSegmentDto {
  id: string;
  label: string;
  emoji: string;
  short: string;
  description: string;
  rule: string;
  maxCandidates: number;
  suggestedRiskBudget: number;
  suggestedMaxPositionPct: number;
  runtimeFilterNote: string | null;
  help: { kurzinfo: string; technischeInfo: string; risiko: string };
  instrumentCount: number;
}

/** Wiederverwendbare Missions-Vorlage (GET /api/firm/missions → `templates`). */
export interface MissionTemplateDto {
  id: string;
  name: string;
  category: string;
  categoryLabel: string;
  scope: string;
  scopeLabel: string;
  segment: string | null;
  segmentLabel: string | null;
  symbol: string | null;
  title: string;
  objective: string;
  riskBudget: number;
  maxPositionPct: number;
  riskProfile: string;
  riskProfileLabel: string;
  riskProfileHint: string;
  seeded: boolean;
  why: string;
  successCriteria: string;
  help: { kurzinfo: string; technischeInfo: string; risiko: string };
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

/**
 * Unveränderte Zeile aus `agent_messages`. Wird zusätzlich zum normalisierten
 * Eintrag ausgeliefert, damit die UI einen echten „Rohdaten"-Reiter anbieten
 * kann, statt die normalisierte Sicht als Original auszugeben.
 */
export interface ProtocolRawRowDto {
  id: string;
  createdAt: string | null;
  agentId: string | null;
  missionId: string | null;
  type: string | null;
  content: string | null;
  meta: unknown;
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
  /** Originale DB-Zeile — Basis des „Rohdaten"-Reiters im Protokoll. */
  raw?: ProtocolRawRowDto;
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

/** Zeile aus `audit_log`, wie sie das Dashboard rendert. */
export interface AuditLogRowDto {
  id: string;
  createdAt: string;
  event: string;
  level: string;
  detail: unknown;
  missionId: string | null;
  agentId: string | null;
}

/** Paging-Metadaten für beide Listen (Audit-Trail und Protokoll). */
export interface ListPageMetaDto {
  page: number;
  pageSize: number;
  pages: number;
  /** Gesamtzahl passender Zeilen — unabhängig von der aktuellen Seite. */
  auditTotal: number;
  entryTotal: number;
}

export interface LogResponse {
  ok: boolean;
  /** Gemischte, chronologische Protokollansicht (Turn, Analyse, System, Nachricht). */
  entries: ProtocolEntryDto[];
  /** Nur echte Agentenentscheidungen, für bestehende Workshop-Clients. */
  turns: TurnLogEntryDto[];
  /** Audit-Trail der aktuellen Seite. */
  audit?: AuditLogRowDto[];
  /** Paging-Informationen (Seite, Seitengröße, Gesamtzahlen). */
  meta?: ListPageMetaDto;
}

/** Response von GET /api/firm/missions. */
export interface MissionsIndexResponse {
  ok: boolean;
  missions: MissionRow[];
  /** Handelsbare Einzel-Symbole des Paper-Brokers. */
  symbols: string[];
  limits: {
    riskBudget: [number, number];
    maxPositionPct: [number, number];
  };
  /** Missions-Typen (v1.35.0). */
  scopes?: MissionScopeDto[];
  /** Marktsegmente inklusive aktueller Kandidatenzahl (v1.35.0). */
  segments?: MissionSegmentDto[];
  /** Allowlist der Segment-IDs (v1.35.0). */
  segmentIds?: string[];
  /** Wiederverwendbare Vorlagen (v1.35.0). */
  templates?: MissionTemplateDto[];
}

/** Response von POST/PUT /api/firm/missions. */
export interface MissionMutationResponse {
  ok: boolean;
  mission?: MissionRow;
  warnings?: string[];
  /** Audit-Zuverlässigkeit der Änderung (S1). */
  audit?: AuditWriteStatusDto;
  error?: string;
}

/**
 * Status des Sicherheits-Audits zu einer Mutation (S1, v1.36.18).
 *
 * `durable: false` heißt: der Beleg ist weder in `audit_log` noch im
 * persistenten Spool — die UI muss das als Warnung zeigen, nicht als Erfolg
 * ohne Weiteres. `degraded: true` heißt: Spool-Reserve, Nachzug ausstehend.
 */
export interface AuditWriteStatusDto {
  durable: boolean;
  target: "db" | "spool" | "none";
  degraded: boolean;
  attempts?: number;
}

/** Response von PUT /api/firm/agents. */
export interface AgentPromptResponse {
  ok: boolean;
  agent?: AgentRow;
  /** Neue Optimistic-Lock-Version nach erfolgreichem Update (W2). */
  version?: number;
  warnings?: string[];
  /** Audit-Zuverlässigkeit der Änderung (S1). */
  audit?: AuditWriteStatusDto;
  /** Beim 409-Konflikt: aktuelle Version in der DB (zum Neuladen). */
  currentVersion?: number;
  hint?: string;
  error?: string;
}
