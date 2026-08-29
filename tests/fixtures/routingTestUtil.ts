/**
 * Test-Fixture für den Model Router (Task 09).
 *
 * Baut einen Router OHNE echte Provider: Fake-Registry (Health/Quota/Latenz/
 * Timeout injizierbar), Memory-Audit-Senke und feste Uhr (deterministisch).
 */
import {
  ModelRouter,
  DEFAULT_ROUTING_POLICY,
  FakeProviderRegistry,
  MemoryAuditSink,
  createFakeProviderRegistry,
  type ModelRouterOptions,
} from "../../src/routing";
import type { FakeProviderRegistryOptions } from "../../src/routing/registry";
import type { ProviderId, RoutingMode } from "../../src/routing/types";
import type {
  RoutingPolicy,
  RoutingPolicyAgent,
} from "../../src/routing/policy";

export const FIXED_NOW = new Date("2026-08-28T12:00:00.000Z");

export type TestRouterOptions = {
  /** Schwache Patches auf die Default-Policy (eine Ebene, `agents` separat). */
  policy?: Partial<Omit<RoutingPolicy, "agents" | "classes" | "budgets" | "escalation">> &
    Partial<Pick<RoutingPolicy, "classes" | "budgets" | "escalation">>;
  /** Agenten-Tabelle ergänzen/überschreiben. */
  agents?: Record<string, RoutingPolicyAgent>;
  /** Startzustand der Fake-Registry je Provider. */
  providers?: FakeProviderRegistryOptions["providers"];
  modes?: Record<string, RoutingMode>;
  now?: Date;
};

export type TestRouter = {
  router: ModelRouter;
  audit: MemoryAuditSink;
  /** Fake-Registry: Health/Quota/Latenz/Timeout injizierbar. */
  registry: FakeProviderRegistry;
  clock: { now(): Date };
};

/** Erzeugt einen vollständig isolierten Router für Tests. */
export function createTestRouter(opts: TestRouterOptions = {}): TestRouter {
  const policy: RoutingPolicy = {
    ...structuredClone(DEFAULT_ROUTING_POLICY),
    ...(opts.policy ?? {}),
    agents: { ...structuredClone(DEFAULT_ROUTING_POLICY.agents), ...(opts.agents ?? {}) },
  };
  const audit = new MemoryAuditSink();
  const registry = createFakeProviderRegistry({ providers: opts.providers });
  const clock = { now: () => opts.now ?? FIXED_NOW };
  const routerOptions: ModelRouterOptions = {
    policy,
    registry,
    audit,
    clock,
    modesFile: null,
    overridesFile: null,
    autoStartPoller: false,
    env: {},
    ...(opts.modes ? { modes: opts.modes } : {}),
  };
  const router = new ModelRouter(routerOptions);
  return { router, audit, registry, clock };
}

/** Standard-Routing-Kontext für Tests (alle 9 Inputs explizit). */
export function ctx(input: {
  agent: string;
  task?: string;
  complexity?: "low" | "medium" | "high" | "critical";
  risk?: "low" | "medium" | "high";
  latencyRequirementMs?: number;
  tokenBudget?: number;
  providerHealth?: Partial<Record<ProviderId, "online" | "degraded" | "offline">>;
  requiredCapabilities?: ("chat" | "json" | "schema" | "long-context" | "tools" | "vision" | "embedding")[];
  maxCostUsd?: number;
  contextSize?: number;
  confidence?: number;
  currentModel?: string;
  currentClass?: "MODEL_A" | "MODEL_B" | "MODEL_C";
}): Record<string, unknown> {
  return {
    agent: input.agent,
    task: input.task ?? "default",
    complexity: input.complexity ?? "low",
    risk: input.risk ?? "low",
    latencyRequirementMs: input.latencyRequirementMs ?? 0,
    tokenBudget: input.tokenBudget ?? 2048,
    ...(input.providerHealth ? { providerHealth: input.providerHealth } : {}),
    ...(input.requiredCapabilities ? { requiredCapabilities: input.requiredCapabilities } : {}),
    ...(input.maxCostUsd !== undefined ? { maxCostUsd: input.maxCostUsd } : {}),
    ...(input.contextSize !== undefined ? { contextSize: input.contextSize } : {}),
    ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
    ...(input.currentModel ? { currentModel: input.currentModel } : {}),
    ...(input.currentClass ? { currentClass: input.currentClass } : {}),
  };
}

/** Kanonische Signatur einer Entscheidung (Vergleich/Determinismus). */
export function signature(decision: {
  decision: string;
  modelClass: string;
  provider: string;
  model: string;
  trigger: string;
}): string {
  return `${decision.decision}|${decision.modelClass}|${decision.provider}|${decision.model}|${decision.trigger}`;
}
