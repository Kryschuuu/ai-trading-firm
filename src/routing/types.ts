/**
 * Typen des Model Routers (Task 09).
 *
 * Der MODEL_ROUTER ist eine **Systemrolle**, kein Trading-Agent: er sieht
 * ausschliesslich strukturierte Metadaten und trifft daraus eine deterministische
 * Entscheidung. Freitext (Prompt-Inhalte, Modellausgaben) ist **nie** Eingabe.
 *
 * Kernbegriffe:
 *   - `ModelClass`   — Modell-KLASSE (MODEL_A = lokal klein 3–8B,
 *                      MODEL_B = lokal mittel 8–30B, MODEL_C = gross).
 *   - `RoutingOutcome` — Ergebnisraum: MODEL_A | MODEL_B | MODEL_C | CLOUD | FALLBACK.
 *                      CLOUD = Klasse wird von einem Cloud-Provider bedient,
 *                      FALLBACK = kein Modell nutzbar (deterministische Regel-Engine)
 *                      bzw. erzwungene Rückstufung (Budget/Health).
 *   - `RoutingMode`  — manual (festes Modell, Eskalation möglich) ·
 *                      automatic (Router entscheidet frei) ·
 *                      hybrid (Router nur INNERHALB der Klassen-Grenzen der Tabelle).
 */

// ─────────────────────────────────────────────────────────────────────────────
// Modell-Klassen
// ─────────────────────────────────────────────────────────────────────────────

/** Die drei Modell-Klassen der Governance-Policy. */
export type ModelClass = "MODEL_A" | "MODEL_B" | "MODEL_C";

/** Sprechender Name je Klasse (Docs/API). */
export type ModelClassLabel = "local-small" | "local-medium" | "large";

/** Ergebnisraum des Routers (Erweiterung der Klassen um Cloud + Fallback). */
export type RoutingOutcome = "MODEL_A" | "MODEL_B" | "MODEL_C" | "CLOUD" | "FALLBACK";

/** Routing-Modus eines Agenten. */
export type RoutingMode = "manual" | "automatic" | "hybrid";

export const MODEL_CLASSES: readonly ModelClass[] = ["MODEL_A", "MODEL_B", "MODEL_C"];
export const ROUTING_OUTCOMES: readonly RoutingOutcome[] = [
  "MODEL_A",
  "MODEL_B",
  "MODEL_C",
  "CLOUD",
  "FALLBACK",
];
export const ROUTING_MODES: readonly RoutingMode[] = ["manual", "automatic", "hybrid"];

/** Ordnungszahl der Klassen (A < B < C) — Grundlage aller Vergleiche. */
export const CLASS_ORDER: Readonly<Record<ModelClass, number>> = {
  MODEL_A: 0,
  MODEL_B: 1,
  MODEL_C: 2,
};

export const CLASS_LABEL: Readonly<Record<ModelClass, ModelClassLabel>> = {
  MODEL_A: "local-small",
  MODEL_B: "local-medium",
  MODEL_C: "large",
};

export function classOrdinal(value: unknown): number {
  return value === "MODEL_A" ? 0 : value === "MODEL_B" ? 1 : value === "MODEL_C" ? 2 : -1;
}

/** Höhere von zwei Klassen (deterministisch, keine Seiteneffekte). */
export function maxClass(a: ModelClass, b: ModelClass): ModelClass {
  return CLASS_ORDER[a] >= CLASS_ORDER[b] ? a : b;
}

export function minClass(a: ModelClass, b: ModelClass): ModelClass {
  return CLASS_ORDER[a] <= CLASS_ORDER[b] ? a : b;
}

/** Klemmt eine Klasse auf ein Intervall [min, max]. */
export function clampClass(value: ModelClass, min: ModelClass, max: ModelClass): ModelClass {
  return minClass(maxClass(value, min), max);
}

// ─────────────────────────────────────────────────────────────────────────────
// Die 9 Routing-Inputs
// ─────────────────────────────────────────────────────────────────────────────

export type TaskComplexity = "low" | "medium" | "high" | "critical";
export type RiskTier = "low" | "medium" | "high";

export const TASK_COMPLEXITIES: readonly TaskComplexity[] = ["low", "medium", "high", "critical"];
export const RISK_TIERS: readonly RiskTier[] = ["low", "medium", "high"];

export const COMPLEXITY_ORDER: Readonly<Record<TaskComplexity, number>> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

export const RISK_ORDER: Readonly<Record<RiskTier, number>> = {
  low: 0,
  medium: 1,
  high: 2,
};

/**
 * Aufgaben-IDs — **Whitelist**. Unbekannte Tasks fallen auf `default` zurück,
 * damit ein Agent nie über einen frei erfundenen Task-Namen eine höhere Klasse
 *erschleichen kann.
 */
export type RoutingTask =
  // MODEL_A (lokal klein): JSON-Klassifikation, Ranking, Zusammenfassung, Standard-TA, News-Kategorisierung, einfache Risikoentscheidung
  | "json_classification"
  | "market_ranking"
  | "summarization"
  | "technical_analysis_standard"
  | "news_categorization"
  | "simple_risk_decision"
  // MODEL_B (lokal mittel): Research
  | "research"
  // MODEL_C (gross): Synthese, Selektion, Portfolio, komplexe Research, Regime, widersprüchliche Evidenz, Strategie, Wochenbericht
  | "technical_news_synthesis"
  | "market_selection"
  | "portfolio_analysis"
  | "complex_research"
  | "regime_analysis"
  | "conflicting_evidence"
  | "strategy_development"
  | "weekly_report"
  // Neutral
  | "default";

export const ROUTING_TASKS: readonly RoutingTask[] = [
  "json_classification",
  "market_ranking",
  "summarization",
  "technical_analysis_standard",
  "news_categorization",
  "simple_risk_decision",
  "research",
  "technical_news_synthesis",
  "market_selection",
  "portfolio_analysis",
  "complex_research",
  "regime_analysis",
  "conflicting_evidence",
  "strategy_development",
  "weekly_report",
  "default",
];

/** Fähigkeiten, die ein Provider/Modell mitbringen kann. */
export type ModelCapability =
  | "chat"
  | "json"
  | "schema"
  | "long-context"
  | "tools"
  | "vision"
  | "embedding";

// ─────────────────────────────────────────────────────────────────────────────
// Provider-Registry
// ─────────────────────────────────────────────────────────────────────────────

export type ProviderId = "ollama" | "openai" | "gemini" | "anthropic";

export const PROVIDER_IDS: readonly ProviderId[] = ["ollama", "openai", "gemini", "anthropic"];

export type HealthStatus = "online" | "degraded" | "offline";

export const HEALTH_STATUSES: readonly HealthStatus[] = ["online", "degraded", "offline"];

/**
 * Eintrag der Provider-Registry (Task 09, Erweiterung von PROVIDER_INTEGRATION.md).
 * Provider-Details (URLs, Keys, Modell-Tags) leben ausschliesslich hier bzw. in
 * `src/lib/llmProvider.ts` — der Router selbst kennt keine Endpunkte.
 */
export type ProviderDescriptor = {
  id: ProviderId;
  label: string;
  /** local = eigene Hardware (0 €, kein Datenabfluss); cloud = externer Anbieter. */
  deployment: "local" | "cloud";
  /** Verfügbare Modell-Tags (Ollama: live vom Server gelesen). */
  models: string[];
  /** Primär genutztes Modell dieser Karte. */
  defaultModel: string;
  capabilities: ModelCapability[];
  /** Maximal nutzbares Kontextfenster in Tokens. */
  contextSize: number;
  /** Kosten je 1k Token (USD) — lokal: 0. */
  costPer1kIn: number;
  costPer1kOut: number;
  healthStatus: HealthStatus;
  /** Geglättete Antwortzeit (EMA) in Millisekunden. */
  latencyEma: number;
  /** Token-Budget pro Tag (Deckel). */
  tokenBudgetToday: number;
  /** Heute verbrauchte Tokens. */
  tokensUsedToday: number;
  /** Verbleibendes Kontingent des Anbieters in Prozent (0–100). */
  quotaRest: number;
  /** Zeitpunkt der letzten Health-Prüfung (ISO). */
  lastCheckedAt?: string;
  /** Redigierte Fehlermeldung der letzten Prüfung (niemals Keys). */
  error?: string;
};

export type ProviderRegistrySnapshot = {
  providers: ProviderDescriptor[];
  checkedAt: string;
};

/** Health-/Quota-/Latenz-Zustand ist injizierbar (Tests ohne echte Provider). */
export type ProviderRegistryOverrides = Partial<
  Pick<
    ProviderDescriptor,
    | "models"
    | "defaultModel"
    | "capabilities"
    | "contextSize"
    | "costPer1kIn"
    | "costPer1kOut"
    | "healthStatus"
    | "latencyEma"
    | "tokenBudgetToday"
    | "tokensUsedToday"
    | "quotaRest"
  >
>;

export interface ProviderRegistry {
  list(): ProviderDescriptor[];
  get(id: ProviderId): ProviderDescriptor | undefined;
  /**Health-Prüfung (Netzwerk nur bei lokalen Providern, konfigurierbar). */
  refresh(): Promise<ProviderDescriptor[]>;
  /** Verbrauch buchen (Tokens + Latenz); wirkt auf Budget und EMA. */
  recordUsage(input: {
    provider: ProviderId;
    tokens: number;
    latencyMs?: number;
  }): void;
  /** Zustand direkt setzen (Tests, Admin-Sonden). */
  override(id: ProviderId, patch: ProviderRegistryOverrides): ProviderDescriptor | undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Routing-Kontext und Entscheidung
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Die 9 strukturierten Routing-Inputs. Freitext ist **nie** Teil des Kontexts:
 * `toRoutingContext()` verwirft jedes unbekannte Feld (Injection-Schutz).
 */
export type RoutingContext = {
  /** 1. Aufgabe (Whitelist-ID). */
  task: RoutingTask;
  /** 2. Komplexität der Aufgabe. */
  complexity: TaskComplexity;
  /** 3. Risiko der Entscheidung (Kapitalwirkung). */
  risk: RiskTier;
  /** 4. Latenzanforderung in Millisekunden. */
  latencyRequirementMs: number;
  /** 5. Token-Budget dieses Aufrufs. */
  tokenBudget: number;
  /** 6. Gesundheit je Provider (überschreibt die Registry, wenn gesetzt). */
  providerHealth?: Readonly<Partial<Record<ProviderId, HealthStatus>>>;
  /** 7. Geforderte Modell-/Provider-Fähigkeiten. */
  requiredCapabilities?: readonly ModelCapability[];
  /** 8. Kostendeckel dieses Aufrufs in USD. */
  maxCostUsd?: number;
  /** 9. Benötigte Kontextgrösse in Tokens. */
  contextSize?: number;

  // ── Kontext-Metadaten (Autorität bleibt beim Router) ──
  /** Agenten-Rolle, z. B. CEO, RESEARCH, TECHNICAL_ANALYST. */
  agent: string;
  /** Selbstauskunft des Agenten — reine METADATEN, nie autoritativ. */
  confidence?: number;
  /** Aktuell genutztes Modell (nur für Audit/Eskalation). */
  currentModel?: string;
  /** Aktuell genutzte Klasse (nur für Audit/Eskalation). */
  currentClass?: ModelClass;
};

/** Maschinenlesbarer Auslöser einer Entscheidung. */
export type RoutingTrigger =
  | "DEFAULT_TABLE"
  | "TASK_OVERRIDE"
  | "COMPLEXITY_FLOOR"
  | "RISK_FLOOR"
  | "MANUAL_PINNED"
  | "HYBRID_BOUND"
  | "LATENCY_REQUIREMENT"
  | "CONTEXT_TOO_SMALL"
  | "CAPABILITY_MISSING"
  | "PROVIDER_OFFLINE"
  | "QUOTA_BELOW_MIN"
  | "BUDGET_EXCEEDED"
  | "COST_CEILING"
  | "FALLBACK_CHAIN"
  | "NO_PROVIDER"
  | "ESCALATION_APPROVED"
  | "ESCALATION_DENIED";

export type RoutingDecision = {
  agent: string;
  task: RoutingTask;
  complexity: TaskComplexity;
  risk: RiskTier;
  /** Ergebnisraum: MODEL_A | MODEL_B | MODEL_C | CLOUD | FALLBACK. */
  decision: RoutingOutcome;
  /** Klasse, auf die geroutet wurde (bei FALLBACK: zuletzt versuchte Klasse). */
  modelClass: ModelClass;
  /** Gewählter Provider — "none" bedeutet: deterministische Regel-Engine. */
  provider: ProviderId | "none";
  model: string;
  /** Menschenlesbare Begründung. */
  reason: string;
  /** Maschinenlesbarer Trigger. */
  trigger: RoutingTrigger;
  policyVersion: string;
  mode: RoutingMode;
  /** Geordnete Fallback-Kette (Provider-Reihenfolge). */
  providerChain: ProviderId[];
  /** true, wenn der Deckel (Budget/Cost/Quota) die Entscheidung erzwungen hat. */
  budgetBlocked: boolean;
  /** true, wenn die Klasse via Eskalation angehoben wurde. */
  escalated: boolean;
  estimated?: {
    latencyMs: number;
    costUsd: number;
    contextSize: number;
  };
  at: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// Eskalation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Eskalationsantrag eines Agenten (`MODEL_ESCALATION_REQUEST`).
 *
 * WICHTIG: Ein Agent kann eine Eskalation nur BEANTRAGEN. Trigger sind
 * ausschliesslich Runtime-Metriken (complexity, confidence, tokenOvershoot,
 * latencyViolation) — niemals Prompt-Inhalte Dritter.
 */
export type EscalationRequest = {
  agent: string;
  task?: RoutingTask;
  complexity: TaskComplexity;
  /** Freitext-Begründung — wird im Audit protokolliert, aber NIE ausgewertet. */
  reason: string;
  currentModel?: string;
  currentClass?: ModelClass;
  requestedClass: ModelClass;
  confidence?: number;
  /** Agent meldet Token-Überschuss des aktuellen Modells. */
  tokenOvershoot?: boolean;
  /** Agent meldet Latenzverletzung. */
  latencyViolation?: boolean;
};

export type EscalationTrigger =
  | "REQUESTED_CLASS_NOT_HIGHER"
  | "COMPLEXITY_BELOW_THRESHOLD"
  | "CONFIDENCE_ABOVE_THRESHOLD"
  | "CLASS_NOT_ALLOWED"
  | "DAILY_LIMIT_REACHED"
  | "BUDGET_EXCEEDED"
  | "NO_HEALTHY_PROVIDER"
  | "HYBRID_CLASS_BOUND"
  | "APPROVED";

export type EscalationDecision = {
  approved: boolean;
  /** Menschenlesbare Begründung (auch bei Ablehnung). */
  reason: string;
  trigger: EscalationTrigger;
  /** "MODEL_A:ollama:qwen2.5:3b" — Ausgangszustand. */
  from: string;
  /** Zielzustand (bei denied == from). */
  to: string;
  policyVersion: string;
  /** Neue Routing-Entscheidung — nur bei approved gesetzt. */
  decision?: RoutingDecision;
  audit: RoutingAuditEntry;
};

// ─────────────────────────────────────────────────────────────────────────────
// Audit
// ─────────────────────────────────────────────────────────────────────────────

export type RoutingAuditOutcome =
  /** Router hat geroutet (ohne Klassenwechsel). */
  | "resolved"
  /** Eskalation genehmigt → Modellwechsel. */
  | "approved"
  /** Eskalation abgelehnt → KEIN Modellwechsel. */
  | "denied"
  /** Fallback-Kette gegriffen (Timeout/Quota/Health). */
  | "fallback"
  /** Budget-Deckel erzwungen → Rückstufung auf lokal. */
  | "budget_blocked"
  /** Admin-Änderung (Policy/Modi). */
  | "admin";

export const ROUTING_AUDIT_OUTCOMES: readonly RoutingAuditOutcome[] = [
  "resolved",
  "approved",
  "denied",
  "fallback",
  "budget_blocked",
  "admin",
];

/**
 * Audit-Satz — Regel 4: JEDER Wechsel (inkl. Fallback und denied) wird protokolliert.
 * `{ts, agent, von, nach, Grund/Trigger, Policy-Version, approved/denied/fallback}`.
 */
export type RoutingAuditEntry = {
  ts: string;
  agent: string;
  /** Ausgang: "MODEL_A:ollama:qwen2.5:3b" oder "none". */
  from: string;
  /** Ziel: "MODEL_C:gemini:gemini-2.0-flash" oder "none:rule-engine". */
  to: string;
  /** Menschenlesbarer Grund. */
  reason: string;
  /** Maschinenlesbarer Trigger/Grund-Code. */
  trigger: string;
  policyVersion: string;
  outcome: RoutingAuditOutcome;
  task?: string;
  complexity?: string;
  /** Zusätzliche Metadaten (niemals Prompt-Inhalte, niemals Secrets). */
  detail?: Record<string, string | number | boolean | null>;
};

/** Senke für Routing-Audits (Memory · Datei · Datenbank). */
export interface AuditSink {
  readonly name: string;
  write(entry: RoutingAuditEntry): void | Promise<void>;
}
