import type {
  AgentDecisionDto,
  ProtocolActorDto,
  ProtocolAnalysisDto,
  ProtocolEntryDto,
  ProtocolTraceDto,
  ProtocolTurnEntryDto,
  TurnLogEntryDto,
} from "./types";

/**
 * Normalisierung der heterogenen `agent_messages`-Historie für das Protokoll.
 *
 * Eine Tabellenzeile ist nicht automatisch ein Agenten-Turn: Analysten schreiben
 * ANALYSIS/RECOMMENDATION, der Monitor schreibt MARKET_SCAN. Früher wurden alle
 * Zeilen als `decision` gerendert; dadurch entstanden Status `?` und `NaN s`.
 * Diese Datei ist bewusst DB- und React-frei, damit die Klassifizierung für neue
 * und bereits gespeicherte Einträge deterministisch getestet werden kann.
 */

export type StoredProtocolMessage = {
  id: string;
  createdAt: Date | string | null | undefined;
  agentId: string | null | undefined;
  missionId: string | null | undefined;
  type: string | null | undefined;
  content: string | null | undefined;
  meta: unknown;
};

export type ProtocolAgentLookup = {
  id: string;
  name: string;
  role: string;
};

const DECISION_TYPES = new Set<AgentDecisionDto["type"]>([
  "TRADE",
  "KILL",
  "HOLD",
  "REPORT",
  "APPROVE",
  "REJECT",
]);

const ANALYSIS_MESSAGE_TYPES = new Set(["ANALYSIS", "RECOMMENDATION"]);
const ANALYSIS_VIEWS = new Set(["BULLISH", "BEARISH", "NEUTRAL"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Nur sinnvolle Strings übernehmen — Objekte dürfen nie als "[object Object]" erscheinen. */
function textOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length > 0 ? text : null;
}

/** Platzhalter aus alten Log-Views dürfen nie wieder als Actor-Label durchsickern. */
function actorTextOrNull(value: unknown): string | null {
  const text = textOrNull(value);
  if (!text) return null;
  return ["?", "unknown", "unbekannt"].includes(text.toLowerCase()) ? null : text;
}

/** JSONB kann historische Zahlen als String enthalten; NaN/Infinity bleiben null. */
function finiteNumberOrNull(value: unknown, min = Number.NEGATIVE_INFINITY): number | null {
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(number) && number >= min ? number : null;
}

function asMessageType(value: unknown): string {
  return textOrNull(value)?.toUpperCase() ?? "MESSAGE";
}

function normalizeTimestamp(value: StoredProtocolMessage["createdAt"]): string {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : "";
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed && Number.isFinite(new Date(trimmed).getTime())) return new Date(trimmed).toISOString();
  }
  // Die Datenbankspalte ist NOT NULL. Der leere Wert ist nur ein sicherer
  // Fallback für kaputte historische Daten; die UI zeigt „Zeit unbekannt“.
  return "";
}

function readActorSnapshot(meta: Record<string, unknown>): { name: string; role: string } | null {
  const actor = isRecord(meta.actor) ? meta.actor : null;
  if (!actor) return null;
  const name = actorTextOrNull(actor.name);
  if (!name) return null;
  return {
    name,
    role: actorTextOrNull(actor.role) ?? "AGENT",
  };
}

function isAnalysisMessage(messageType: string, meta: Record<string, unknown>): boolean {
  const kind = textOrNull(meta.kind)?.toUpperCase();
  return (
    ANALYSIS_MESSAGE_TYPES.has(messageType) ||
    (kind !== undefined && ANALYSIS_MESSAGE_TYPES.has(kind)) ||
    isRecord(meta.analysis)
  );
}

function isSystemMessage(messageType: string, meta: Record<string, unknown>): boolean {
  return messageType === "MARKET_SCAN" || textOrNull(meta.source)?.toLowerCase() === "monitor";
}

function resolveActor(
  message: StoredProtocolMessage,
  messageType: string,
  meta: Record<string, unknown>,
  agents: ReadonlyMap<string, ProtocolAgentLookup>,
  isAnalysis: boolean
): ProtocolActorDto {
  const liveAgent = message.agentId ? agents.get(message.agentId) : undefined;
  if (liveAgent) {
    return {
      name: actorTextOrNull(liveAgent.name) ?? "Agent",
      role: actorTextOrNull(liveAgent.role) ?? "AGENT",
      source: "agent",
    };
  }

  // Neue Einträge halten Name/Rolle als Audit-Snapshot vor. Das bewahrt die
  // Attribution auch nach einer späteren Agentenbereinigung oder Umbenennung.
  const snapshot = readActorSnapshot(meta);
  if (snapshot) return { ...snapshot, source: "snapshot" };

  if (isSystemMessage(messageType, meta)) {
    return { name: "Marktmonitor", role: "SYSTEM", source: "system" };
  }
  if (isAnalysis && !message.agentId) {
    return { name: "Analystendienst", role: "ANALYSE", source: "system" };
  }
  if (message.agentId) {
    return {
      name: "Archivierter Agent",
      role: "NICHT MEHR VERFÜGBAR",
      source: "orphaned",
    };
  }
  return { name: "System", role: "SYSTEM", source: "system" };
}

function normalizeTrace(meta: Record<string, unknown>): ProtocolTraceDto {
  // Unterstützt sowohl das etablierte flache Engine-Meta als auch ein mögliches
  // zukünftiges `meta.trace`-Objekt, ohne die alte Historie zu brechen.
  const trace = isRecord(meta.trace) ? meta.trace : meta;
  return {
    source: textOrNull(trace.source),
    model: textOrNull(trace.model),
    latencyMs: finiteNumberOrNull(trace.latencyMs, 0),
    prompt: textOrNull(trace.prompt),
    rawResponse: textOrNull(trace.rawResponse),
    provider: textOrNull(trace.provider),
    usage: trace.usage ?? null,
    costUsd: finiteNumberOrNull(trace.costUsd, 0),
  };
}

function normalizeDecision(value: unknown): AgentDecisionDto | null {
  if (!isRecord(value)) return null;
  const type = textOrNull(value.type)?.toUpperCase();
  if (!type || !DECISION_TYPES.has(type as AgentDecisionDto["type"])) return null;

  const decision: AgentDecisionDto = { type: type as AgentDecisionDto["type"] };
  const symbol = textOrNull(value.symbol);
  const side = textOrNull(value.side)?.toUpperCase();
  const stopLossPct = finiteNumberOrNull(value.stopLossPct);
  const reason = textOrNull(value.reason);
  const riskScore = finiteNumberOrNull(value.riskScore);

  if (symbol) decision.symbol = symbol;
  if (side === "LONG" || side === "SHORT") decision.side = side;
  if (stopLossPct !== null) decision.stopLossPct = stopLossPct;
  if (reason) decision.reason = reason;
  if (riskScore !== null) decision.riskScore = riskScore;
  return decision;
}

function viewFromLegacyType(value: unknown): ProtocolAnalysisDto["view"] {
  switch (textOrNull(value)?.toUpperCase()) {
    case "TRADE":
    case "APPROVE":
      return "BULLISH";
    case "REJECT":
    case "KILL":
      return "BEARISH";
    case "HOLD":
    case "REPORT":
      return "NEUTRAL";
    default:
      return null;
  }
}

function normalizeAnalysis(meta: Record<string, unknown>): ProtocolAnalysisDto {
  const analysis = isRecord(meta.analysis) ? meta.analysis : meta;
  const rawView = textOrNull(analysis.view)?.toUpperCase();
  const view = rawView && ANALYSIS_VIEWS.has(rawView)
    ? (rawView as ProtocolAnalysisDto["view"])
    : viewFromLegacyType(analysis.type);
  const rawConfidence = finiteNumberOrNull(analysis.confidence);

  return {
    view,
    // Ein Modell darf keine 250%-Konfidenz in das Protokoll schreiben.
    confidence: rawConfidence === null ? null : Math.min(Math.max(rawConfidence, 0), 1),
    thesis: textOrNull(analysis.thesis) ?? textOrNull(analysis.reason),
  };
}

/** Klassifiziert und normalisiert genau eine persistierte Nachricht. */
export function normalizeProtocolMessage(
  message: StoredProtocolMessage,
  agents: ReadonlyMap<string, ProtocolAgentLookup>
): ProtocolEntryDto {
  const meta = isRecord(message.meta) ? message.meta : {};
  const messageType = asMessageType(message.type);
  const analysisMessage = isAnalysisMessage(messageType, meta);
  const actor = resolveActor(message, messageType, meta, agents, analysisMessage);
  const base = {
    id: textOrNull(message.id) ?? "unbekannter-eintrag",
    at: normalizeTimestamp(message.createdAt),
    messageType,
    missionId: textOrNull(message.missionId),
    actor,
    content: typeof message.content === "string" ? message.content : "",
    trace: normalizeTrace(meta),
  };

  // ANALYSIS/RECOMMENDATION hat Vorrang: auch wenn ein Fallback ein
  // {type:"HOLD"} lieferte, bleibt es ein Analystenbericht und kein Turn.
  if (analysisMessage) {
    return { ...base, kind: "analysis", analysis: normalizeAnalysis(meta) };
  }

  const decision = normalizeDecision(meta.decision);
  if (decision) return { ...base, kind: "turn", decision };

  if (isSystemMessage(messageType, meta) || actor.source === "system") {
    return { ...base, kind: "system" };
  }
  return { ...base, kind: "message" };
}

export function isProtocolTurn(entry: ProtocolEntryDto): entry is ProtocolTurnEntryDto {
  return entry.kind === "turn";
}

/** Form der bisherigen `turns`-Liste; nur aus echten Entscheidungen erzeugbar. */
export function toTurnLogEntry(entry: ProtocolTurnEntryDto): TurnLogEntryDto {
  return {
    id: entry.id,
    at: entry.at,
    agent: entry.actor.name,
    role: entry.actor.role,
    missionId: entry.missionId,
    decision: entry.decision,
    source: entry.trace.source,
    model: entry.trace.model,
    latencyMs: entry.trace.latencyMs,
    content: entry.content,
    prompt: entry.trace.prompt,
    rawResponse: entry.trace.rawResponse,
    provider: entry.trace.provider,
    usage: entry.trace.usage,
    costUsd: entry.trace.costUsd,
  };
}
