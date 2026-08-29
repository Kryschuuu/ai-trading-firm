/**
 * Modell-Routing (Task 09) — öffentliche Fassade.
 *
 *   ModelRouter     — die Systemrolle MODEL_ROUTER (kein Trading-Agent!)
 *   policy          — versionierte, schema-validierte Routing-Policy
 *   registry        — Provider-Registry inkl. Health-Poller und Fake für Tests
 *   audit           — AuditSink (Memory · Datei · Datenbank)
 *   adapter         — Integration in die bestehende chat()-Abstraktion
 */

export * from "./types";
export {
  DEFAULT_POLICY_VERSION,
  DEFAULT_ROUTING_POLICY,
  ROUTING_POLICY_ENV,
  RoutingPolicyError,
  assertRoutingPolicy,
  loadRoutingPolicy,
  validateRoutingPolicy,
  type RoutingPolicy,
  type RoutingPolicyAgent,
  type RoutingPolicyBudget,
  type RoutingPolicyClass,
  type RoutingPolicyEscalation,
  type RoutingPolicyProvider,
} from "./policy";
export {
  CLOUD_PROVIDERS,
  EnvProviderRegistry,
  FakeProviderRegistry,
  HEALTH_PROBE_ENV,
  HEALTH_TIMEOUT_ENV,
  LOCAL_PROVIDERS,
  buildDefaultRegistry,
  buildProviderDescriptor,
  createFakeProviderRegistry,
  createProviderRegistry,
  fetchOllamaContextSize,
  nextLatencyEma,
  probeProviderHealth,
  quotaFromBudget,
  startHealthPoller,
  type FakeProviderRegistryOptions,
  type HealthPollerHandle,
  type HealthPollerOptions,
  type HealthProbeOptions,
} from "./registry";
export {
  BudgetTracker,
  dayKey,
  type BudgetClock,
  type BudgetInput,
  type BudgetSnapshot,
  type BudgetUsage,
} from "./budget";
export {
  ROUTING_AUDIT_DIR,
  ROUTING_AUDIT_EVENT,
  ROUTING_AUDIT_FILE,
  CompositeAuditSink,
  DatabaseAuditSink,
  FileAuditSink,
  MemoryAuditSink,
  clearRoutingAuditForTests,
  createRoutingAuditSink,
  readRoutingAudit,
  routingAuditRing,
} from "./audit";
export {
  ModelRouter,
  ROUTING_MODES_FILE,
  defaultRoutingPolicy,
  estimateCostUsd,
  getModelRouter,
  modelSignature,
  normalizeAgentKey,
  resetModelRouterForTests,
  setModelRouterForTests,
  toRoutingContext,
  type ModelRouterOptions,
  type ResolveOptions,
  type RouterSnapshot,
  type RoutingModeUpdateResult,
  type RoutingOverrideUpdateResult,
} from "./router";
export {
  escalationFromRuntime,
  routeChat,
  routingContextFromSpec,
  routingMeta,
  type RouteChatOptions,
  type RoutedChatResult,
  type RoutedChatSpec,
} from "./adapter";
