/**
 * Router-Adapter (Task 09) — Integration in die bestehende LLM-Abstraktion.
 *
 * Jeder `chat()`-Pfad der Agenten-Laufzeit läuft über `routeChat()`:
 *
 *   Agent → routeChat(spec) → router.resolve(context)   [Entscheidung]
 *                           → chatLlm(req, {providers}) [Kette: Ziel + Fallbacks]
 *                           → Verbrauch buchen, Abweichungen auditieren
 *
 * Eigenschaften:
 *   - Der Agent übergibt NUR strukturierte Metadaten; Freitext (Prompt-Inhalte)
 *     erreicht den Router nie (Injection-Schutz, Regel 1).
 *   - Fallback-Ketten (Timeout/Quota/Health) greifen automatisch; jeder
 *     tatsächliche Provider-Wechsel wird auditiert (Regel 4).
 *   - Scheitert die gesamte Kette, antwortet der deterministische Ersatz des
 *     Aufrufers (`fallbackContent`) — es wird nie blind weitergemacht.
 */
import { chatLlm, type LlmChatRequest, type LlmMessage, type LlmUsage } from "@/lib/llmProvider";
import { publicErrorMessage } from "@/lib/secrets";
import { estimateCostUsd, getModelRouter, modelSignature, type ModelRouter } from "./router";
import {
  PROVIDER_IDS,
  type EscalationRequest,
  type ModelCapability,
  type ProviderId,
  type RoutingAuditEntry,
  type RoutingContext,
  type RoutingDecision,
  type RoutingTask,
  type RiskTier,
  type TaskComplexity,
} from "./types";

export type RoutedChatSpec = {
  /** Agenten-Rolle (CEO, RESEARCH, TECHNICAL_ANALYST …). */
  agent: string;
  /** Aufgaben-ID (Whitelist) — bestimmt die Klassen-Untergrenze mit. */
  task?: RoutingTask;
  complexity?: TaskComplexity;
  risk?: RiskTier;
  latencyRequirementMs?: number;
  tokenBudget?: number;
  contextSize?: number;
  requiredCapabilities?: ModelCapability[];
  maxCostUsd?: number;

  messages: LlmMessage[];
  temperature?: number;
  json?: boolean;
  schema?: Record<string, unknown>;
  maxTokens?: number;
  timeoutMs?: number;
  /** Deterministischer Ersatzinhalt, wenn kein Modell verfügbar ist. */
  fallbackContent?: string;
};

export type RoutedChatResult = {
  content: string;
  provider: ProviderId | "none";
  model: string;
  decision: RoutingDecision;
  /** Tatsächlich genutzte Provider-Kette (Ziel + Fallbacks). */
  chain: ProviderId[];
  usedFallback: boolean;
  usage?: LlmUsage;
  latencyMs: number;
  costUsd?: number;
  /** Provider-Wechsel innerhalb der Kette (auditiert). */
  switched: boolean;
  error?: string;
};

export type RouteChatOptions = {
  router?: ModelRouter;
  env?: Record<string, string | undefined>;
  fetchFn?: typeof fetch;
  /** Injektion für Tests: chatLlm ersetzen. */
  chatFn?: typeof chatLlm;
  /**
   * Bereits getroffene Entscheidung (genehmigte Eskalation) — der Router wird
   * dann NICHT erneut befragt; der Wechsel ist bereits auditiert.
   */
  forcedDecision?: RoutingDecision;
};

/** Baut den Routing-Kontext aus der Spec — Whitelist, kein Freitext. */
export function routingContextFromSpec(spec: RoutedChatSpec): RoutingContext {
  return {
    agent: spec.agent,
    task: spec.task ?? "default",
    complexity: spec.complexity ?? "medium",
    // Analysten erzeugt Analysen, keine Orders ⇒ Risikostufe default "low".
    risk: spec.risk ?? "low",
    latencyRequirementMs: spec.latencyRequirementMs ?? 0,
    tokenBudget: spec.tokenBudget ?? (Number(spec.maxTokens ?? 0) * 2 || 4096),
    ...(spec.contextSize !== undefined ? { contextSize: spec.contextSize } : {}),
    ...(spec.requiredCapabilities && spec.requiredCapabilities.length > 0
      ? { requiredCapabilities: spec.requiredCapabilities }
      : {}),
    ...(spec.maxCostUsd !== undefined ? { maxCostUsd: spec.maxCostUsd } : {}),
  };
}

/**
 * Führt einen gerouteten Chat-Aufruf aus. Der Router entscheidet über Klasse,
 * Provider und Modell; die Fallback-Kette stammt aus der Policy.
 */
export async function routeChat(
  spec: RoutedChatSpec,
  opts: RouteChatOptions = {}
): Promise<RoutedChatResult> {
  const router = opts.router ?? getModelRouter();
  const started = Date.now();
  const decision = opts.forcedDecision ?? router.resolve(routingContextFromSpec(spec));
  const chain: ProviderId[] = [decision.provider, ...decision.providerChain].filter((p): p is ProviderId =>
    PROVIDER_IDS.includes(p as ProviderId)
  );

  // Kein Modell verfügbar ⇒ deterministische Regel-Engine des Aufrufers.
  if (decision.provider === "none" || chain.length === 0) {
    return {
      content: spec.fallbackContent ?? "",
      provider: "none",
      model: "rule-engine",
      decision,
      chain: [],
      usedFallback: true,
      latencyMs: Date.now() - started,
      switched: false,
    };
  }

  const request: LlmChatRequest = {
    model: decision.model,
    messages: spec.messages,
    temperature: spec.temperature,
    json: spec.json,
    schema: spec.schema,
    maxTokens: spec.maxTokens,
    timeoutMs: spec.timeoutMs,
  };

  const chat = opts.chatFn ?? chatLlm;
  try {
    const result = await chat(request, {
      providers: chain,
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
    });
    const provider = (PROVIDER_IDS.includes(result.provider as ProviderId)
      ? result.provider
      : chain[0]) as ProviderId;
    const tokens = Number(result.usage?.totalTokens ?? 0);
    const costUsd = result.costUsd ?? estimateCost(router, provider, decision, spec);
    const latencyMs = Date.now() - started;

    router.consumeUsage({
      provider,
      agent: decision.agent,
      tokens: Number.isFinite(tokens) ? tokens : 0,
      costUsd,
      latencyMs: Number.isFinite(result.latencyMs) ? result.latencyMs : latencyMs,
    });

    // JEDER Abweichung vom Routing-Ziel wird auditiert (Regel 4).
    const switched = provider !== decision.provider || result.model !== decision.model;
    if (switched) {
      void router.audit.write({
        ts: new Date().toISOString(),
        agent: decision.agent,
        from: modelSignature({
          modelClass: decision.modelClass,
          provider: decision.provider,
          model: decision.model,
        }),
        to: modelSignature({ modelClass: decision.modelClass, provider, model: result.model }),
        reason: `Fallback-Kette gegriffen (Ziel ${decision.provider} nicht erreichbar/nicht nutzbar).`,
        trigger: "FALLBACK_CHAIN",
        policyVersion: decision.policyVersion,
        outcome: "fallback",
        task: decision.task,
        complexity: decision.complexity,
        detail: { chain: chain.join(">") },
      } satisfies RoutingAuditEntry);
    }

    return {
      content: result.content,
      provider,
      model: result.model,
      decision,
      chain,
      usedFallback: false,
      usage: result.usage,
      latencyMs,
      costUsd,
      switched,
    };
  } catch (e) {
    const message = publicErrorMessage(e, "LLM-Aufruf fehlgeschlagen");
    void router.audit.write({
      ts: new Date().toISOString(),
      agent: decision.agent,
      from: modelSignature({
        modelClass: decision.modelClass,
        provider: decision.provider,
        model: decision.model,
      }),
      to: "none:none:rule-engine",
      reason: `Alle Provider der Kette fehlgeschlagen (${chain.join(">")}): ${message}`,
      trigger: "FALLBACK_CHAIN",
      policyVersion: decision.policyVersion,
      outcome: "fallback",
      task: decision.task,
      complexity: decision.complexity,
      detail: { chain: chain.join(">") },
    } satisfies RoutingAuditEntry);

    return {
      content: spec.fallbackContent ?? "",
      provider: "none",
      model: "rule-engine",
      decision,
      chain,
      usedFallback: true,
      latencyMs: Date.now() - started,
      switched: true,
      error: message,
    };
  }
}

function estimateCost(
  router: ModelRouter,
  provider: ProviderId,
  decision: RoutingDecision,
  spec: RoutedChatSpec
): number | undefined {
  const descriptor = router.registry.get(provider);
  if (!descriptor) return undefined;
  const budget = spec.tokenBudget ?? (Number(spec.maxTokens ?? 0) || 4096);
  return estimateCostUsd(descriptor, budget) || undefined;
}

/**
 * Baut einen `MODEL_ESCALATION_REQUEST` aus **Runtime-Metriken**.
 * Prompt- oder Modelltext ist bewusst kein Parameter — Trigger sind nur
 * complexity, confidence, Token-Überschuss und Latenzverletzung (Regel 1).
 */
export function escalationFromRuntime(input: {
  agent: string;
  task?: RoutingTask;
  complexity: TaskComplexity;
  confidence?: number;
  currentModel?: string;
  currentClass?: "MODEL_A" | "MODEL_B" | "MODEL_C";
  requestedClass?: "MODEL_A" | "MODEL_B" | "MODEL_C";
  tokenOvershoot?: boolean;
  latencyViolation?: boolean;
  reason?: string;
}): EscalationRequest {
  return {
    agent: input.agent,
    task: input.task ?? "default",
    complexity: input.complexity,
    reason: (input.reason ?? "Agent meldet unzureichende Modellkapazität.").slice(0, 400),
    requestedClass: input.requestedClass ?? "MODEL_C",
    ...(input.currentModel ? { currentModel: input.currentModel } : {}),
    ...(input.currentClass ? { currentClass: input.currentClass } : {}),
    ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
    ...(input.tokenOvershoot !== undefined ? { tokenOvershoot: input.tokenOvershoot } : {}),
    ...(input.latencyViolation !== undefined ? { latencyViolation: input.latencyViolation } : {}),
  };
}

/** Metadaten-Block für `agent_messages.meta` (Trace/Transparenz). */
export function routingMeta(result: RoutedChatResult): Record<string, unknown> {
  return {
    routerVersion: result.decision.policyVersion,
    routing: {
      agent: result.decision.agent,
      task: result.decision.task,
      decision: result.decision.decision,
      modelClass: result.decision.modelClass,
      mode: result.decision.mode,
      trigger: result.decision.trigger,
      reason: result.decision.reason,
      chain: result.chain,
      budgetBlocked: result.decision.budgetBlocked,
      escalated: result.decision.escalated,
    },
    provider: result.provider,
    model: result.model,
    usedFallback: result.usedFallback,
  };
}
