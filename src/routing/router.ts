/**
 * MODEL_ROUTER (Task 09) — Systemrolle, KEIN Trading-Agent.
 *
 * Der Router bekommt ausschliesslich strukturierte Metadaten (die 9 Inputs) und
 * entscheidet deterministisch: MODEL_A | MODEL_B | MODEL_C | CLOUD | FALLBACK.
 *
 * HARTE REGELN
 *  1. Kein Agent wechselt selbst sein Modell. Der einzige Weg zu einem anderen
 *     Modell führt über `resolve()`/`requestEscalation()` dieses Routers.
 *     Agent-Text und Confidence sind METADATEN, nie Autorität: Freitext wird
 *     bereits beim Normalisieren verworfoen (Injection-Schutz, Regel 1).
 *  2. Determinismus: gleiche Eingaben ⇒ gleiche Entscheidung. Keine Zufalls-
 *     werte, keine versteckte Zeitquelle (Uhr injiziert), feste Reihenfolgen.
 *  3. Budget-Deckel: Token-/Kostenbudgets je Provider/Agent/Tag werden hier
 *     durchgesetzt; Überschreitung ⇒ Zwangsfallback auf lokal + Audit.
 *  4. Auditierbarkeit: JEDER Wechsel (inkl. Fallback und denied) landet im
 *     Audit-Sink (Datei + `audit_log`).
 *  5. Decoupling: Der Router kennt keine Marktdaten; Provider-Details liegen
 *     ausschliesslich in der Provider-Registry.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveRuntimePath } from "@/lib/appPaths";
import {
  CLASS_ORDER,
  MODEL_CLASSES,
  ROUTING_MODES,
  ROUTING_TASKS,
  TASK_COMPLEXITIES,
  RISK_TIERS,
  HEALTH_STATUSES,
  PROVIDER_IDS,
  classOrdinal,
  clampClass,
  maxClass,
  type EscalationDecision,
  type EscalationTrigger,
  type HealthStatus,
  type ModelCapability,
  type ModelClass,
  type ProviderDescriptor,
  type ProviderId,
  type ProviderModelOverride,
  type ProviderRegistry,
  type RoutingAuditEntry,
  type RoutingContext,
  type RoutingDecision,
  type RoutingMode,
  type RoutingOutcome,
  type RoutingTask,
  type RoutingTrigger,
  type TaskComplexity,
  type RiskTier,
} from "./types";
import { DEFAULT_ROUTING_POLICY, loadRoutingPolicy, type RoutingPolicy } from "./policy";
import { createProviderRegistry, startHealthPoller, type HealthPollerHandle } from "./registry";
import { BudgetTracker } from "./budget";
import { createRoutingAuditSink, readRoutingAudit } from "./audit";
import type { AuditSink } from "./types";

export const ROUTING_MODES_FILE = "data/routing/modes.json";

const DEFAULT_TOKEN_BUDGET = 4096;

// ─────────────────────────────────────────────────────────────────────────────
// Kontext-Normalisierung (Whitelist — Injection-Schutz)
// ─────────────────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteOr(value: unknown, fallback: number, min = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, n);
}

/** Agenten-Schlüssel: kanonisch GROSS, getrimmt, begrenzt. */
export function normalizeAgentKey(agent: unknown): string {
  const raw = typeof agent === "string" ? agent.trim() : "";
  if (raw.length === 0) return "UNKNOWN";
  return raw.slice(0, 64).toUpperCase();
}

/**
 * Überführt beliebige Eingaben in einen gültigen `RoutingContext`.
 * **Nur die 9 Whitelist-Inputs überleben** — Freitext (Prompt-Inhalte,
 * Modellausgaben, News-Texte) wird verworfen und kann keine Entscheidung
 * beeinflussen. Das ist der Kern der Injection-Resistenz (Regel 1).
 */
export function toRoutingContext(raw: unknown, base?: Partial<RoutingContext>): RoutingContext {
  const input = isRecord(raw) ? raw : {};
  const merged: Record<string, unknown> = { ...(base ?? {}), ...input };

  const health: Partial<Record<ProviderId, HealthStatus>> = {};
  if (isRecord(merged.providerHealth)) {
    for (const id of PROVIDER_IDS) {
      const value = (merged.providerHealth as Record<string, unknown>)[id];
      if (HEALTH_STATUSES.includes(value as HealthStatus)) {
        health[id] = value as HealthStatus;
      }
    }
  }

  const capabilities = Array.isArray(merged.requiredCapabilities)
    ? (merged.requiredCapabilities.filter(
        (c): c is ModelCapability => typeof c === "string" && c.length > 0
      ) as ModelCapability[])
    : [];

  const confidenceRaw =
    typeof merged.confidence === "number" ? merged.confidence : Number(merged.confidence);
  const confidence = Number.isFinite(confidenceRaw) ? Math.min(1, Math.max(0, confidenceRaw)) : undefined;

  const contextSizeRaw = Number(merged.contextSize);
  const maxCostRaw = Number(merged.maxCostUsd);
  const currentClass =
    classOrdinal(merged.currentClass) >= 0 ? (merged.currentClass as ModelClass) : undefined;

  return {
    agent: normalizeAgentKey(merged.agent),
    task: ROUTING_TASKS.includes(merged.task as RoutingTask) ? (merged.task as RoutingTask) : "default",
    complexity: TASK_COMPLEXITIES.includes(merged.complexity as TaskComplexity)
      ? (merged.complexity as TaskComplexity)
      : "low",
    risk: RISK_TIERS.includes(merged.risk as RiskTier) ? (merged.risk as RiskTier) : "low",
    latencyRequirementMs: finiteOr(merged.latencyRequirementMs, 0),
    tokenBudget: finiteOr(merged.tokenBudget, DEFAULT_TOKEN_BUDGET, 1),
    ...(Object.keys(health).length > 0 ? { providerHealth: health } : {}),
    ...(capabilities.length > 0 ? { requiredCapabilities: capabilities } : {}),
    ...(Number.isFinite(maxCostRaw) && maxCostRaw >= 0 ? { maxCostUsd: maxCostRaw } : {}),
    ...(Number.isFinite(contextSizeRaw) && contextSizeRaw > 0 ? { contextSize: contextSizeRaw } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    ...(typeof merged.currentModel === "string" && merged.currentModel.trim().length > 0
      ? { currentModel: merged.currentModel.slice(0, 160) }
      : {}),
    ...(currentClass ? { currentClass } : {}),
  };
}

/** Kosten-Schätzung eines Aufrufs (70/30 Input/Output-Split, deterministisch). */
export function estimateCostUsd(descriptor: ProviderDescriptor, tokenBudget: number): number {
  const tokens = Math.max(0, Number(tokenBudget) || 0);
  const inputTokens = tokens * 0.7;
  const outputTokens = tokens * 0.3;
  return (
    Math.round(
      ((inputTokens / 1000) * descriptor.costPer1kIn + (outputTokens / 1000) * descriptor.costPer1kOut) *
        1e6
    ) / 1e6
  );
}

/** "MODEL_C:gemini:gemini-2.0-flash" — kompakte Modell-Signatur fürs Audit. */
export function modelSignature(input: {
  modelClass?: ModelClass | null;
  provider?: ProviderId | "none" | null;
  model?: string | null;
}): string {
  const cls = input.modelClass ?? "none";
  const provider = input.provider ?? "none";
  const model = input.model && input.model.trim().length > 0 ? input.model : "rule-engine";
  return `${cls}:${provider}:${model}`;
}

function complexityOrder(value: TaskComplexity): number {
  return value === "low" ? 0 : value === "medium" ? 1 : value === "high" ? 2 : 3;
}

// ─────────────────────────────────────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────────────────────────────────────

export type ModelRouterOptions = {
  policy?: RoutingPolicy;
  registry?: ProviderRegistry;
  audit?: AuditSink;
  clock?: { now(): Date };
  /** Admin-Override der Routing-Modi (überschreibt die Policy-Tabelle). */
  modes?: Record<string, RoutingMode>;
  /** Explizite Provider/Modell-Auswahl je Agent. */
  overrides?: Record<string, ProviderModelOverride>;
  /** Persistenz der Modi (Default `data/routing/modes.json`, null = aus). */
  modesFile?: string | null;
  /** Persistenz der Provider/Modell-Auswahl (Default `data/routing/overrides.json`). */
  overridesFile?: string | null;
  /** Health-Poller beim Start anwerfen (Default: true, Intervall aus Policy). */
  autoStartPoller?: boolean;
  /** Environment (Policy-Pfad, Budget-Env, Poller-Intervall). */
  env?: Record<string, string | undefined>;
};

export type ResolveOptions = {
  /** Erzwingt eine Klasse (nur für genehmigte Eskalationen). */
  forcedClass?: ModelClass;
  /** Markiert die Entscheidung als eskaliert. */
  escalated?: boolean;
  /** Unterdrückt das resolve-Audit (der Aufrufer auditiert selbst). */
  silentAudit?: boolean;
  /** Zusatzbegründung (Eskalation). */
  reasonSuffix?: string;
};

export type RoutingModeUpdateResult = {
  ok: boolean;
  modes: Record<string, RoutingMode>;
  errors: string[];
  audit: RoutingAuditEntry[];
};

export type RoutingOverrideUpdateResult = {
  ok: boolean;
  overrides: Record<string, ProviderModelOverride>;
  errors: string[];
  audit: RoutingAuditEntry[];
};

export type RouterSnapshot = {
  policyVersion: string;
  modes: Record<string, RoutingMode>;
  overrides: Record<string, ProviderModelOverride>;
  policy: {
    defaultMode: RoutingMode;
    defaultClass: ModelClass;
    agents: Record<string, { mode: RoutingMode; defaultClass?: ModelClass; pinnedModel?: string }>;
    quotaMinPercent: number;
    healthPollerIntervalMs: number;
  };
  providers: ProviderDescriptor[];
  budget: ReturnType<BudgetTracker["snapshot"]>;
  audit: RoutingAuditEntry[];
  lastDecisions: Record<string, RoutingDecision>;
  generatedAt: string;
};

type SelectionResult =
  | {
      ok: true;
      provider: ProviderId;
      model: string;
      descriptor: ProviderDescriptor;
      reason: string;
    }
  | {
      ok: false;
      reason: string;
      trigger: RoutingTrigger;
      lastProvider?: ProviderId;
    };

export class ModelRouter {
  readonly policy: RoutingPolicy;
  readonly registry: ProviderRegistry;
  readonly audit: AuditSink;
  readonly budget: BudgetTracker;
  private readonly clock: { now(): Date };
  private readonly modesFile: string | null;
  private readonly overridesFile: string | null;
  private readonly env: Record<string, string | undefined>;
  private modes: Record<string, RoutingMode>;
  private overrides: Record<string, ProviderModelOverride>;
  private readonly lastDecisions = new Map<string, RoutingDecision>();
  private poller: HealthPollerHandle | null = null;

  constructor(opts: ModelRouterOptions = {}) {
    this.env = opts.env ?? process.env;
    this.policy = opts.policy ?? loadRoutingPolicy(this.env);
    this.registry = opts.registry ?? createProviderRegistry(this.env);
    this.audit = opts.audit ?? createRoutingAuditSink();
    this.clock = opts.clock ?? { now: () => new Date() };
    this.modesFile = opts.modesFile === undefined ? ROUTING_MODES_FILE : opts.modesFile;
    this.overridesFile = opts.overridesFile === undefined ? "data/routing/overrides.json" : opts.overridesFile;

    this.budget = new BudgetTracker(this.policy.budgets, {
      clock: this.clock,
      maxApprovedPerAgentPerDay: this.policy.escalation.maxApprovedPerAgentPerDay,
    });

    // Modi: Policy-Tabelle → Datei → explizite Option (höchste Priorität).
    this.modes = { ...this.modesFromPolicy(), ...this.loadModes(), ...(opts.modes ?? {}) };
    this.overrides = { ...this.loadOverrides(), ...(opts.overrides ?? {}) };
    // Registry-Budgets aus der Policy übernehmen (Karten-Daten = Policy-Wahrheit).
    this.syncRegistryBudgets();

    if (opts.autoStartPoller !== false) {
      this.startHealthPoller();
    }
  }

  // ── Modi ───────────────────────────────────────────────────────────────────

  private modesFromPolicy(): Record<string, RoutingMode> {
    const out: Record<string, RoutingMode> = {};
    for (const [agent, cfg] of Object.entries(this.policy.agents)) {
      out[normalizeAgentKey(agent)] = cfg.mode;
    }
    return out;
  }

  /**
   * Absolute Pfade bleiben absolut (path.join würde sie relativ anhängen).
   * `resolveRuntimePath()` kapselt genau diese Regel — plus `..`-Schutz.
   */
  private modesFilePath(): string | null {
    if (!this.modesFile) return null;
    return resolveRuntimePath(this.modesFile);
  }

  private loadModes(): Record<string, RoutingMode> {
    if (!this.modesFile) return {};
    try {
      const file = this.modesFilePath();
      if (!file) return {};
      if (!existsSync(file)) return {};
      const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (!isRecord(parsed)) return {};
      const out: Record<string, RoutingMode> = {};
      for (const [agent, mode] of Object.entries(parsed)) {
        if (ROUTING_MODES.includes(mode as RoutingMode)) {
          out[normalizeAgentKey(agent)] = mode as RoutingMode;
        }
      }
      return out;
    } catch {
      return {};
    }
  }

  private overridesFilePath(): string | null {
    if (!this.overridesFile) return null;
    return resolveRuntimePath(this.overridesFile);
  }

  private loadOverrides(): Record<string, ProviderModelOverride> {
    if (!this.overridesFile) return {};
    try {
      const file = this.overridesFilePath();
      if (!file) return {};
      if (!existsSync(file)) return {};
      const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (!isRecord(parsed)) return {};
      const out: Record<string, ProviderModelOverride> = {};
      for (const [agent, value] of Object.entries(parsed)) {
        if (!isRecord(value) || !PROVIDER_IDS.includes(value.provider as ProviderId) ||
            typeof value.model !== "string" || value.model.trim().length === 0 ||
            !ROUTING_MODES.includes(value.fallbackMode as RoutingMode)) continue;
        out[normalizeAgentKey(agent)] = { provider: value.provider as ProviderId, model: value.model.trim().slice(0, 160), fallbackMode: value.fallbackMode as RoutingMode };
      }
      return out;
    } catch { return {}; }
  }

  private persistOverrides(): void {
    if (!this.overridesFile) return;
    try {
      const file = this.overridesFilePath();
      if (!file) return;
      const dir = path.dirname(file);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o755 });
      writeFileSync(file, `${JSON.stringify(this.overrides, null, 2)}\n`, { mode: 0o600 });
    } catch { /* best effort; memory remains authoritative */ }
  }

  private persistModes(): void {
    const file = this.modesFilePath();
    if (!file) return;
    try {
      const dir = path.dirname(file);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o755 });
      writeFileSync(file, `${JSON.stringify(this.modes, null, 2)}\n`, { mode: 0o600 });
    } catch {
      /* Persistenz ist best-effort — der Speicherzustand bleibt Autorität. */
    }
  }

  /** Effektiver Modus eines Agenten (Admin-Override > Policy > Default). */
  effectiveMode(agent: string): RoutingMode {
    const key = normalizeAgentKey(agent);
    return this.modes[key] ?? this.policy.agents[key]?.mode ?? this.policy.defaultMode;
  }

  getModes(): Record<string, RoutingMode> {
    return { ...this.modes };
  }

  /**
   * Admin-Änderung der Routing-Modi — immer auditiert (Regel 4 + Admin-Guard).
   * Ungültige Einträge werden abgewiesen, gültige trotzdem übernommen.
   */
  setModes(patch: Record<string, unknown>, actor = "admin"): RoutingModeUpdateResult {
    const errors: string[] = [];
    const audit: RoutingAuditEntry[] = [];
    const now = this.clock.now().toISOString();

    for (const [rawAgent, rawMode] of Object.entries(patch ?? {})) {
      const agent = normalizeAgentKey(rawAgent);
      if (!ROUTING_MODES.includes(rawMode as RoutingMode)) {
        errors.push(
          `${agent}: unbekannter Modus "${String(rawMode)}" (erlaubt: ${ROUTING_MODES.join("|")}).`
        );
        continue;
      }
      const mode = rawMode as RoutingMode;
      const previous = this.effectiveMode(agent);
      if (previous === mode && this.modes[agent] === mode) continue; // keine Änderung
      this.modes[agent] = mode;
      const entry: RoutingAuditEntry = {
        ts: now,
        agent,
        from: `mode:${previous}`,
        to: `mode:${mode}`,
        reason: `Admin-Änderung des Routing-Modus durch ${actor.slice(0, 64)}.`,
        trigger: "ADMIN_MODE_CHANGE",
        policyVersion: this.policy.version,
        outcome: "admin",
        detail: { actor: actor.slice(0, 64), previousMode: previous, mode },
      };
      audit.push(entry);
      void this.audit.write(entry);
    }

    if (audit.length > 0) this.persistModes();
    return { ok: errors.length === 0, modes: this.getModes(), errors, audit };
  }

  getOverrides(): Record<string, ProviderModelOverride> {
    return structuredClone(this.overrides);
  }

  /** Setzt explizite Provider/Model-Auswahlen. Ungültige Modelle werden nie aktiviert. */
  setOverrides(patch: Record<string, unknown>, actor = "admin"): RoutingOverrideUpdateResult {
    const errors: string[] = [];
    const audit: RoutingAuditEntry[] = [];
    const now = this.clock.now().toISOString();
    for (const [rawAgent, raw] of Object.entries(patch ?? {})) {
      const agent = normalizeAgentKey(rawAgent);
      if (raw === null) {
        const previous = this.overrides[agent];
        if (previous) {
          delete this.overrides[agent];
          const entry: RoutingAuditEntry = { ts: now, agent,
            from: `override:${previous.provider}:${previous.model}`, to: "override:none",
            reason: `Provider/Modell-Override durch ${actor.slice(0, 64)} deaktiviert.`,
            trigger: "ADMIN_OVERRIDE_CHANGE", policyVersion: this.policy.version, outcome: "admin",
            detail: { actor: actor.slice(0, 64), cleared: true } };
          audit.push(entry); void this.audit.write(entry);
        }
        continue;
      }
      if (!isRecord(raw) || !PROVIDER_IDS.includes(raw.provider as ProviderId) ||
          typeof raw.model !== "string" || raw.model.trim().length === 0 ||
          !ROUTING_MODES.includes(raw.fallbackMode as RoutingMode)) {
        errors.push(`${agent}: Override erwartet provider, model und fallbackMode.`);
        continue;
      }
      const provider = raw.provider as ProviderId;
      const model = raw.model.trim().slice(0, 160);
      const descriptor = this.registry.get(provider);
      if (!descriptor || !descriptor.models.includes(model)) {
        errors.push(`${agent}: Modell "${model}" ist für Provider ${provider} nicht registriert.`);
        continue;
      }
      const next: ProviderModelOverride = { provider, model, fallbackMode: raw.fallbackMode as RoutingMode };
      const previous = this.overrides[agent];
      this.overrides[agent] = next;
      const entry: RoutingAuditEntry = {
        ts: now, agent,
        from: previous ? `override:${previous.provider}:${previous.model}` : "override:none",
        to: `override:${provider}:${model}`,
        reason: `Admin-Override durch ${actor.slice(0, 64)} (Fallback: ${next.fallbackMode}).`,
        trigger: "ADMIN_OVERRIDE_CHANGE", policyVersion: this.policy.version, outcome: "admin",
        detail: { actor: actor.slice(0, 64), provider, model, fallbackMode: next.fallbackMode },
      };
      audit.push(entry); void this.audit.write(entry);
    }
    if (audit.length > 0) this.persistOverrides();
    return { ok: errors.length === 0, overrides: this.getOverrides(), errors, audit };
  }

  /** Komfort-Wrapper für genau einen Agenten. */
  setMode(agent: string, mode: RoutingMode, actor = "admin"): RoutingModeUpdateResult {
    return this.setModes({ [agent]: mode }, actor);
  }

  // ── Health ─────────────────────────────────────────────────────────────────

  /** Intervall des Pollers (Env `ROUTING_HEALTH_POLL_MS` überschreibt Policy). */
  pollerIntervalMs(): number {
    const envValue = Number(this.env.ROUTING_HEALTH_POLL_MS);
    if (Number.isFinite(envValue) && envValue >= 0) return Math.trunc(envValue);
    return this.policy.healthPollerIntervalMs;
  }

  startHealthPoller(): HealthPollerHandle {
    this.poller?.stop();
    this.poller = startHealthPoller({
      registry: this.registry,
      intervalMs: this.pollerIntervalMs(),
      immediate: true,
      onError: (error) => {
        console.warn("[routing] Health-Poller fehlgeschlagen:", error);
      },
    });
    return this.poller;
  }

  stopHealthPoller(): void {
    this.poller?.stop();
    this.poller = null;
  }

  /** Manuelle Health-Prüfung (Admin/API) — wirft nie. */
  async refreshHealth(): Promise<ProviderDescriptor[]> {
    try {
      return await this.registry.refresh();
    } catch {
      return this.registry.list();
    }
  }

  private syncRegistryBudgets(): void {
    for (const id of PROVIDER_IDS) {
      const limit = this.policy.budgets.providers[id];
      if (limit && Number.isFinite(limit.tokensPerDay)) {
        this.registry.override(id, { tokenBudgetToday: Math.trunc(limit.tokensPerDay) });
      }
    }
  }

  // ── Verbrauch ──────────────────────────────────────────────────────────────

  /** Bucht Token-/Kostenverbrauch auf Budget UND Registry (Karten-Daten). */
  consumeUsage(input: {
    provider: ProviderId;
    agent?: string;
    tokens?: number;
    costUsd?: number;
    latencyMs?: number;
  }): void {
    if (!PROVIDER_IDS.includes(input.provider)) return;
    this.budget.consume({
      provider: input.provider,
      agent: input.agent ? normalizeAgentKey(input.agent) : undefined,
      tokens: input.tokens,
      costUsd: input.costUsd,
    });
    this.registry.recordUsage({
      provider: input.provider,
      tokens: input.tokens ?? 0,
      latencyMs: input.latencyMs,
    });
  }

  // ── Kern: resolve() ────────────────────────────────────────────────────────

  /** Letzte Entscheidung eines Agenten (Audit-Abgleich, Tests). */
  lastDecisionFor(agent: string): RoutingDecision | undefined {
    return this.lastDecisions.get(normalizeAgentKey(agent));
  }

  /** Die eigentliche Routing-Entscheidung — deterministisch über die 9 Inputs. */
  resolve(rawContext: unknown, options: ResolveOptions = {}): RoutingDecision {
    const ctx = toRoutingContext(rawContext);
    const agent = ctx.agent;
    let mode = this.effectiveMode(agent);
    const agentCfg = this.policy.agents[agent];
    const activeOverride = this.overrides[agent];
    const allowCloud = agentCfg?.allowCloud !== false;
    const budgetExempt = agentCfg?.budgetExempt === true;

    // Provider/Modell-Override ist eine explizite Admin-Auswahl, nicht Policy-Input.
    // Sie wird vor der normalen Klassen-/Modusauswertung versucht; Health, Budget,
    // Cloud-Freigabe und Kontext bleiben unverändert harte Router-Guardrails.
    if (activeOverride && !options.forcedClass) {
      const overrideClass = MODEL_CLASSES.find((candidate) =>
        this.policy.classes[candidate].providers.some((p) =>
          p.provider === activeOverride.provider && p.model === activeOverride.model
        )
      ) ?? agentCfg?.defaultClass ?? this.policy.defaultClass;
      const overrideDef = this.policy.classes[overrideClass];
      const picked = this.selectProvider({
        ctx, targetClass: overrideClass, candidates: [activeOverride.provider],
        allowCloud, budgetExempt, classDeployment: overrideDef.deployment,
        modelOverride: activeOverride.model,
      });
      if (picked.ok) {
        return this.finish({ ctx, mode: "manual", decision: picked.descriptor.deployment === "cloud" ? "CLOUD" : overrideClass,
          modelClass: overrideClass, provider: picked.provider, model: picked.model,
          reason: `Expliziter Provider/Modell-Override: ${picked.provider}/${picked.model}.`,
          trigger: "PROVIDER_MODEL_OVERRIDE", auditOutcome: "resolved", chain: [], descriptor: picked.descriptor, options });
      }
      // Fallback automatic/configured: no override is passed into the normal path.
      mode = activeOverride.fallbackMode;
    }
    const ceiling = agentCfg?.classCeiling ?? "MODEL_C";

    // 1) Klassen-Untergrenze: Agenten-Tabelle ∪ Task ∪ Komplexität ∪ Risiko
    const tableClass = agentCfg?.defaultClass ?? this.policy.defaultClass;
    const taskFloor = this.policy.taskOverrides[ctx.task] ?? this.policy.defaultClass;
    const complexityFloor = this.policy.complexityFloor[ctx.complexity] ?? this.policy.defaultClass;
    const riskFloor = this.policy.riskFloor[ctx.risk] ?? this.policy.defaultClass;
    const floor = maxClass(maxClass(maxClass(tableClass, taskFloor), complexityFloor), riskFloor);

    let targetClass: ModelClass;
    let trigger: RoutingTrigger;
    if (options.forcedClass) {
      targetClass = clampClass(options.forcedClass, "MODEL_A", ceiling);
      trigger = options.escalated ? "ESCALATION_APPROVED" : "DEFAULT_TABLE";
    } else if (mode === "manual") {
      targetClass = clampClass(tableClass, "MODEL_A", ceiling);
      trigger = "MANUAL_PINNED";
    } else if (mode === "hybrid") {
      // Klasse kommt aus der Tabelle; der Router entscheidet NUR den Provider.
      targetClass = clampClass(tableClass, "MODEL_A", ceiling);
      trigger = "HYBRID_BOUND";
    } else {
      targetClass = clampClass(floor, "MODEL_A", ceiling);
      trigger = floorTrigger({
        floor,
        tableClass,
        taskFloor,
        complexityFloor,
        riskFloor,
      });
    }

    const classDef = this.policy.classes[targetClass];
    const pinnedModel = mode === "manual" ? agentCfg?.pinnedModel : undefined;
    if (mode === "manual" && (!pinnedModel || pinnedModel === "none")) {
      return this.finish({
        ctx,
        mode,
        decision: "FALLBACK",
        modelClass: targetClass,
        provider: "none",
        model: "rule-engine",
        reason: `Agent ${agent} läuft im Modus manual ohne Modell-Pinning (deterministisch, kein LLM).`,
        trigger: "MANUAL_PINNED",
        auditOutcome: "resolved",
        chain: [],
        options,
      });
    }

    // 2) Provider-Wahl innerhalb der Klasse (Policy-Reihenfolge ist verbindlich)
    const selection = this.selectProvider({
      ctx,
      targetClass,
      candidates: classDef.providers.map((p) => p.provider),
      allowCloud,
      budgetExempt,
      classDeployment: classDef.deployment,
      modelOverride: pinnedModel,
    });

    if (selection.ok) {
      const reason = options.reasonSuffix
        ? `${selection.reason} ${options.reasonSuffix}`
        : selection.reason;
      return this.finish({
        ctx,
        mode,
        decision: selection.descriptor.deployment === "cloud" ? "CLOUD" : targetClass,
        modelClass: targetClass,
        provider: selection.provider,
        model: selection.model,
        reason,
        trigger,
        auditOutcome: "resolved",
        chain: this.fallbackChainFor("offline", selection.provider, { allowCloud, ctx }),
        descriptor: selection.descriptor,
        options,
      });
    }

    // 3) Fallback-Kette des zuletzt geprüften Providers (Timeout/Quota/Health)
    const lastProvider = selection.lastProvider;
    const chainTrigger = selection.trigger;
    if (lastProvider) {
      const chain = this.fallbackChainFor(chainTrigger, lastProvider, { allowCloud, ctx });
      for (const candidate of chain) {
        const picked = this.selectProvider({
          ctx,
          targetClass,
          candidates: [candidate],
          allowCloud,
          budgetExempt,
          classDeployment: classDef.deployment,
          modelOverride: classDef.providers.find((p) => p.provider === candidate)?.model,
        });
        if (picked.ok) {
          return this.finish({
            ctx,
            mode,
            decision: picked.descriptor.deployment === "cloud" ? "CLOUD" : targetClass,
            modelClass: targetClass,
            provider: picked.provider,
            model: picked.model,
            reason: `Fallback-Kette nach ${chainTrigger}:${lastProvider} → ${candidate}. ${picked.reason}`,
            trigger: "FALLBACK_CHAIN",
            auditOutcome: "fallback",
            chain,
            descriptor: picked.descriptor,
            budgetBlocked: chainTrigger === "BUDGET_EXCEEDED",
            options,
          });
        }
      }
    }

    // 4) Zwangs-Rückstufung: von der Zielklasse abwärts auf ein lokales Modell
    for (let index = CLASS_ORDER[targetClass] - 1; index >= 0; index--) {
      const lowerClass = MODEL_CLASSES[index];
      const lowerDef = this.policy.classes[lowerClass];
      const picked = this.selectProvider({
        ctx,
        targetClass: lowerClass,
        candidates: lowerDef.providers.map((p) => p.provider),
        allowCloud,
        budgetExempt,
        classDeployment: lowerDef.deployment,
      });
      if (picked.ok) {
        const budgetBlocked = chainTrigger === "BUDGET_EXCEEDED";
        return this.finish({
          ctx,
          mode,
          decision: picked.descriptor.deployment === "cloud" ? "CLOUD" : lowerClass,
          modelClass: lowerClass,
          provider: picked.provider,
          model: picked.model,
          reason: `Zwangs-Rückstufung ${targetClass} → ${lowerClass} (${selection.reason}).`,
          trigger: chainTrigger,
          auditOutcome: budgetBlocked ? "budget_blocked" : "fallback",
          chain: this.fallbackChainFor("offline", picked.provider, { allowCloud, ctx }),
          descriptor: picked.descriptor,
          budgetBlocked,
          options,
        });
      }
    }

    // 5) Nichts verfügbar ⇒ deterministische Regel-Engine (FALLBACK)
    return this.finish({
      ctx,
      mode,
      decision: "FALLBACK",
      modelClass: targetClass,
      provider: "none",
      model: "rule-engine",
      reason: `Kein nutzbarer Provider für ${agent}/${ctx.task} (${selection.reason}). Deterministische Regel-Engine.`,
      trigger: "NO_PROVIDER",
      auditOutcome: "fallback",
      chain: this.fallbackChainFor("offline", lastProvider ?? "ollama", { allowCloud, ctx }),
      budgetBlocked: chainTrigger === "BUDGET_EXCEEDED",
      options,
    });
  }

  // ── Eskalation ─────────────────────────────────────────────────────────────

  /**
   * Bearbeitet einen `MODEL_ESCALATION_REQUEST`.
   * Der Agent BEANTRAGT — der Router entscheidet (Governance, Regel 1).
   * Ergebnis: approved (Wechsel + Audit) oder denied (Grund + Audit, kein Wechsel).
   */
  requestEscalation(rawRequest: unknown): EscalationDecision {
    const input = isRecord(rawRequest) ? rawRequest : {};
    const agent = normalizeAgentKey(input.agent);
    const complexity: TaskComplexity = TASK_COMPLEXITIES.includes(input.complexity as TaskComplexity)
      ? (input.complexity as TaskComplexity)
      : "low";
    const requestedClass: ModelClass =
      classOrdinal(input.requestedClass) >= 0 ? (input.requestedClass as ModelClass) : "MODEL_C";
    const previous = this.lastDecisionFor(agent);
    const currentClass: ModelClass =
      classOrdinal(input.currentClass) >= 0
        ? (input.currentClass as ModelClass)
        : previous?.modelClass ?? this.policy.defaultClass;
    const currentModel =
      typeof input.currentModel === "string" && input.currentModel.trim().length > 0
        ? input.currentModel.slice(0, 160)
        : previous?.model ?? "rule-engine";

    const confidenceRaw = Number(input.confidence);
    const confidence = Number.isFinite(confidenceRaw)
      ? Math.min(1, Math.max(0, confidenceRaw))
      : undefined;
    const tokenOvershoot = input.tokenOvershoot === true;
    const latencyViolation = input.latencyViolation === true;
    // `reason` ist reines Protokoll: wird NIE ausgewertet (Injection-Schutz).
    const reasonText = typeof input.reason === "string" ? input.reason.slice(0, 400) : "";
    const task = ROUTING_TASKS.includes(input.task as RoutingTask) ? (input.task as RoutingTask) : "default";

    const from = modelSignature({
      modelClass: currentClass,
      provider: previous?.provider ?? "none",
      model: currentModel,
    });
    const ts = this.clock.now().toISOString();
    const esc = this.policy.escalation;
    const agentCfg = this.policy.agents[agent];
    const mode = this.effectiveMode(agent);

    const deny = (trigger: EscalationTrigger, reason: string): EscalationDecision => {
      const entry: RoutingAuditEntry = {
        ts,
        agent,
        from,
        to: from,
        reason,
        trigger,
        policyVersion: this.policy.version,
        outcome: "denied",
        task,
        complexity,
        detail: {
          requestedClass,
          currentClass,
          confidence: confidence ?? null,
          tokenOvershoot,
          latencyViolation,
          agentReason: reasonText.length > 0 ? reasonText : null,
        },
      };
      void this.audit.write(entry);
      return {
        approved: false,
        reason,
        trigger,
        from,
        to: from,
        policyVersion: this.policy.version,
        audit: entry,
      };
    };

    // E1 — keine Höherstufung beantragt
    if (CLASS_ORDER[requestedClass] <= CLASS_ORDER[currentClass]) {
      return deny(
        "REQUESTED_CLASS_NOT_HIGHER",
        `Keine Höherstufung nötig: ${requestedClass} ist nicht über ${currentClass}.`
      );
    }
    // E2 — Zielklasse von der Policy nicht freigegeben
    if (!esc.allowedTargetClasses.includes(requestedClass)) {
      return deny("CLASS_NOT_ALLOWED", `Zielklasse ${requestedClass} ist nicht freigegeben.`);
    }
    // E3 — Agenten-Deckel (classCeiling) gilt auch für Eskalationen
    if (agentCfg?.classCeiling && CLASS_ORDER[requestedClass] > CLASS_ORDER[agentCfg.classCeiling]) {
      return deny(
        "CLASS_NOT_ALLOWED",
        `Agenten-Deckel ${agentCfg.classCeiling} verhindert ${requestedClass}.`
      );
    }
    // E4 — Modus hybrid: Klassengrenze der Tabelle ist hart
    if (
      mode === "hybrid" &&
      agentCfg?.defaultClass &&
      CLASS_ORDER[requestedClass] > CLASS_ORDER[agentCfg.defaultClass]
    ) {
      return deny(
        "HYBRID_CLASS_BOUND",
        `Modus hybrid: Klassengrenze ${agentCfg.defaultClass} des Agenten ${agent} ist bindend.`
      );
    }
    // E5 — Komplexität (oder harter Runtime-Trigger) muss die Eskalation tragen
    const complexityOk = complexityOrder(complexity) >= complexityOrder(esc.minComplexity);
    if (!complexityOk && !(esc.honorRuntimeTriggers && (tokenOvershoot || latencyViolation))) {
      return deny(
        "COMPLEXITY_BELOW_THRESHOLD",
        `Komplexität ${complexity} unter Mindestschwelle ${esc.minComplexity}.`
      );
    }
    // E6 — Confidence: wer sicher ist, braucht kein größeres Modell
    if (confidence !== undefined && confidence > esc.maxConfidenceToApprove) {
      return deny(
        "CONFIDENCE_ABOVE_THRESHOLD",
        `Confidence ${confidence.toFixed(2)} über Schwelle ${esc.maxConfidenceToApprove} — kein Eskalationsbedarf.`
      );
    }
    // E7 — Tageslimit genehmigter Eskalationen
    const approvals = this.budget.approvalsFor(agent);
    if (approvals.count >= approvals.max) {
      return deny(
        "DAILY_LIMIT_REACHED",
        `Tageslimit genehmigter Eskalationen erreicht (${approvals.count}/${approvals.max}).`
      );
    }
    // E8 — Budget/Health: die Zielklasse muss tatsächlich verfügbar sein
    const allowCloud = agentCfg?.allowCloud !== false;
    const target = this.selectProvider({
      ctx: {
        agent,
        task,
        complexity,
        risk: "medium",
        latencyRequirementMs: 0,
        tokenBudget: DEFAULT_TOKEN_BUDGET,
      },
      targetClass: requestedClass,
      candidates: this.policy.classes[requestedClass].providers.map((p) => p.provider),
      allowCloud,
      budgetExempt: agentCfg?.budgetExempt === true,
      classDeployment: this.policy.classes[requestedClass].deployment,
    });
    if (!target.ok) {
      const budgetBlocked = target.trigger === "BUDGET_EXCEEDED";
      return deny(
        budgetBlocked ? "BUDGET_EXCEEDED" : "NO_HEALTHY_PROVIDER",
        budgetBlocked
          ? `Budget-Deckel erreicht: kein Provider der Klasse ${requestedClass} verfügbar.`
          : `Kein verfügbarer Provider für ${requestedClass} (${target.reason}).`
      );
    }

    // Genehmigt: Entscheidung mit erzwungener Zielklasse erzeugen
    this.budget.countApproval(agent);
    const decision = this.resolve(
      {
        agent,
        task,
        complexity,
        risk: "medium",
        latencyRequirementMs: 0,
        tokenBudget: DEFAULT_TOKEN_BUDGET,
      },
      {
        forcedClass: requestedClass,
        escalated: true,
        silentAudit: true,
        reasonSuffix: reasonText ? `(Grund des Agenten: ${reasonText})` : "",
      }
    );

    const to = modelSignature({
      modelClass: decision.modelClass,
      provider: decision.provider,
      model: decision.model,
    });
    const entry: RoutingAuditEntry = {
      ts,
      agent,
      from,
      to,
      reason: `Eskalation genehmigt (${currentClass} → ${requestedClass}). ${decision.reason}`,
      trigger: "ESCALATION_APPROVED",
      policyVersion: this.policy.version,
      outcome: "approved",
      task,
      complexity,
      detail: {
        requestedClass,
        currentClass,
        confidence: confidence ?? null,
        tokenOvershoot,
        latencyViolation,
        agentReason: reasonText.length > 0 ? reasonText : null,
        approvalsToday: approvals.count + 1,
        model: decision.model,
        provider: decision.provider,
      },
    };
    void this.audit.write(entry);
    return {
      approved: true,
      reason: entry.reason,
      trigger: "APPROVED",
      from,
      to,
      policyVersion: this.policy.version,
      decision,
      audit: entry,
    };
  }

  // ── Snapshot (API / Operations Center) ─────────────────────────────────────

  snapshot(auditLimit = 30): RouterSnapshot {
    const lastDecisions: Record<string, RoutingDecision> = {};
    for (const [agent, decision] of this.lastDecisions.entries()) lastDecisions[agent] = decision;
    return {
      policyVersion: this.policy.version,
      modes: this.getModes(),
      overrides: this.getOverrides(),
      policy: {
        defaultMode: this.policy.defaultMode,
        defaultClass: this.policy.defaultClass,
        agents: Object.fromEntries(
          Object.entries(this.policy.agents).map(([agent, cfg]) => [
            agent,
            { mode: cfg.mode, defaultClass: cfg.defaultClass, pinnedModel: cfg.pinnedModel },
          ])
        ),
        quotaMinPercent: this.policy.quotaMinPercent,
        healthPollerIntervalMs: this.pollerIntervalMs(),
      },
      providers: this.registry.list(),
      budget: this.budget.snapshot(),
      audit: readRoutingAudit(auditLimit),
      lastDecisions,
      generatedAt: this.clock.now().toISOString(),
    };
  }

  // ── Interne Helfer ─────────────────────────────────────────────────────────

  /**
   * Schreibt die Entscheidung in den Verlauf und — bei jedem WECHSEL sowie
   * jedem Fallback/Budget-Ereignis — in den Audit-Trail (Regel 4).
   */
  private finish(input: {
    ctx: RoutingContext;
    mode: RoutingMode;
    decision: RoutingOutcome;
    modelClass: ModelClass;
    provider: ProviderId | "none";
    model: string;
    reason: string;
    trigger: RoutingTrigger;
    auditOutcome: RoutingAuditEntry["outcome"];
    chain: ProviderId[];
    descriptor?: ProviderDescriptor;
    budgetBlocked?: boolean;
    options?: ResolveOptions;
  }): RoutingDecision {
    const at = this.clock.now().toISOString();
    const decision: RoutingDecision = {
      agent: input.ctx.agent,
      task: input.ctx.task,
      complexity: input.ctx.complexity,
      risk: input.ctx.risk,
      decision: input.decision,
      modelClass: input.modelClass,
      provider: input.provider,
      model: input.model,
      reason: input.reason,
      trigger: input.trigger,
      policyVersion: this.policy.version,
      mode: input.mode,
      providerChain: input.chain,
      budgetBlocked: input.budgetBlocked === true,
      escalated: input.options?.escalated === true,
      ...(input.descriptor
        ? {
            estimated: {
              latencyMs: input.descriptor.latencyEma,
              costUsd: estimateCostUsd(input.descriptor, input.ctx.tokenBudget),
              contextSize: input.descriptor.contextSize,
            },
          }
        : {}),
      at,
    };

    const previous = this.lastDecisions.get(input.ctx.agent);
    const changed =
      !previous ||
      previous.provider !== decision.provider ||
      previous.model !== decision.model ||
      previous.modelClass !== decision.modelClass;

    if (
      !input.options?.silentAudit &&
      (changed || decision.decision === "FALLBACK" || decision.budgetBlocked)
    ) {
      const entry: RoutingAuditEntry = {
        ts: at,
        agent: decision.agent,
        from: previous
          ? modelSignature({
              modelClass: previous.modelClass,
              provider: previous.provider,
              model: previous.model,
            })
          : "none",
        to: modelSignature({
          modelClass: decision.modelClass,
          provider: decision.provider,
          model: decision.model,
        }),
        reason: decision.reason,
        trigger: decision.trigger,
        policyVersion: decision.policyVersion,
        outcome: routingOutcome({ decision, previous, defaultOutcome: input.auditOutcome }),
        task: decision.task,
        complexity: decision.complexity,
        detail: {
          mode: decision.mode,
          latencyRequirementMs: input.ctx.latencyRequirementMs,
          tokenBudget: input.ctx.tokenBudget,
          chain: decision.providerChain.join(">"),
        },
      };
      void this.audit.write(entry);
    }

    this.lastDecisions.set(input.ctx.agent, decision);
    return decision;
  }

  /**
   * Wählt den ersten Provider, der ALLE Filter erfüllt (Policy-Reihenfolge).
   * Deterministisch: keine Sortierung nach Laufzeit/Zufall, keine Zeitquelle.
   */
  private selectProvider(input: {
    ctx: RoutingContext;
    targetClass: ModelClass;
    candidates: ProviderId[];
    allowCloud: boolean;
    budgetExempt: boolean;
    classDeployment: "local" | "any";
    modelOverride?: string;
  }): SelectionResult {
    const { ctx, targetClass, allowCloud, budgetExempt, classDeployment } = input;
    const seen = new Set<ProviderId>();
    let firstTrigger: RoutingTrigger = "NO_PROVIDER";
    let firstReason = `Kein Provider der Klasse ${targetClass} konfiguriert.`;
    let lastProvider: ProviderId | undefined;
    let first = true;

    const reject = (trigger: RoutingTrigger, reason: string): void => {
      if (first) {
        firstTrigger = trigger;
        firstReason = reason;
        first = false;
      }
    };

    for (const provider of input.candidates) {
      if (seen.has(provider)) continue;
      seen.add(provider);
      lastProvider = provider;

      const descriptor = this.registry.get(provider);
      if (!descriptor) {
        reject("NO_PROVIDER", `Provider ${provider} nicht in der Registry.`);
        continue;
      }
      const health = ctx.providerHealth?.[provider] ?? descriptor.healthStatus;
      if (health === "offline") {
        reject("PROVIDER_OFFLINE", `Provider ${provider} ist offline.`);
        continue;
      }
      if (descriptor.deployment === "cloud" && !allowCloud) {
        reject("PROVIDER_OFFLINE", `Cloud-Provider ${provider} für diesen Agenten nicht freigegeben.`);
        continue;
      }
      if (classDeployment === "local" && descriptor.deployment === "cloud") {
        reject("PROVIDER_OFFLINE", `Klasse ${targetClass} ist lokal gebunden.`);
        continue;
      }
      if (descriptor.quotaRest < this.policy.quotaMinPercent) {
        reject(
          "QUOTA_BELOW_MIN",
          `Restkontingent ${descriptor.quotaRest} % < ${this.policy.quotaMinPercent} %.`
        );
        continue;
      }
      if (ctx.contextSize !== undefined && ctx.contextSize > descriptor.contextSize) {
        reject("CONTEXT_TOO_SMALL", `Kontext ${ctx.contextSize} Token > ${descriptor.contextSize} Token.`);
        continue;
      }
      if (ctx.tokenBudget > descriptor.contextSize) {
        reject("CONTEXT_TOO_SMALL", `Token-Budget ${ctx.tokenBudget} > Kontext ${descriptor.contextSize}.`);
        continue;
      }
      if (ctx.requiredCapabilities && ctx.requiredCapabilities.length > 0) {
        const missing = ctx.requiredCapabilities.filter((c) => !descriptor.capabilities.includes(c));
        if (missing.length > 0) {
          reject("CAPABILITY_MISSING", `Fehlende Fähigkeit(en): ${missing.join(",")}.`);
          continue;
        }
      }
      if (
        ctx.latencyRequirementMs > 0 &&
        descriptor.latencyEma > 0 &&
        descriptor.latencyEma > ctx.latencyRequirementMs
      ) {
        reject(
          "LATENCY_REQUIREMENT",
          `Latenz ${descriptor.latencyEma} ms > Anforderung ${ctx.latencyRequirementMs} ms.`
        );
        continue;
      }
      if (!budgetExempt && this.budget.isExhausted(provider)) {
        reject("BUDGET_EXCEEDED", `Token-/Kosten-Deckel von ${provider} erreicht.`);
        continue;
      }
      if (!budgetExempt && this.budget.agentExhausted(ctx.agent)) {
        reject("BUDGET_EXCEEDED", `Token-Deckel des Agenten ${ctx.agent} erreicht.`);
        continue;
      }
      if (ctx.maxCostUsd !== undefined) {
        const cost = estimateCostUsd(descriptor, ctx.tokenBudget);
        if (cost > ctx.maxCostUsd) {
          reject("COST_CEILING", `Geschätzte Kosten ${cost} USD > Deckel ${ctx.maxCostUsd} USD.`);
          continue;
        }
      }

      const model =
        input.modelOverride && input.modelOverride.length > 0
          ? input.modelOverride
          : (this.policy.classes[targetClass].providers.find((p) => p.provider === provider)?.model ??
            descriptor.defaultModel);
      return {
        ok: true,
        provider,
        model,
        descriptor,
        reason: `Klasse ${targetClass} (${this.policy.classes[targetClass].label}) via ${provider}.`,
      };
    }

    return { ok: false, reason: firstReason, trigger: firstTrigger, lastProvider };
  }

  /** Konfigurierte Fallback-Kette: `"<trigger>:<provider>"` → `"offline:<id>"` → `default`. */
  private fallbackChainFor(
    trigger: string,
    provider: ProviderId,
    opts: { allowCloud: boolean; ctx: RoutingContext }
  ): ProviderId[] {
    const chains = this.policy.fallbackChains;
    const key = `${String(trigger).toLowerCase()}:${provider}`;
    const raw = chains[key] ?? chains[`offline:${provider}`] ?? chains.default ?? [];
    return raw.filter((id) => {
      if (id === provider) return false;
      const descriptor = this.registry.get(id);
      if (!descriptor) return false;
      if (!opts.allowCloud && descriptor.deployment === "cloud") return false;
      const health = opts.ctx.providerHealth?.[id] ?? descriptor.healthStatus;
      return health !== "offline";
    });
  }
}

/** Bestimmt die Audit-Art eines Wechsels (Regel 4). */
function routingOutcome(input: {
  decision: RoutingDecision;
  previous: RoutingDecision | undefined;
  defaultOutcome: RoutingAuditEntry["outcome"];
}): RoutingAuditEntry["outcome"] {
  const { decision, previous, defaultOutcome } = input;
  if (decision.budgetBlocked) return "budget_blocked";
  if (decision.decision === "FALLBACK") return "fallback";
  // Seitwärts-/Rückwärtswechsel des Providers ist immer ein Fallback-Ereignis
  // (Health, Quota, Latenz) — auch wenn die Klasse gleich bleibt.
  if (
    previous &&
    previous.provider !== "none" &&
    previous.provider !== decision.provider &&
    CLASS_ORDER[decision.modelClass] <= CLASS_ORDER[previous.modelClass]
  ) {
    return "fallback";
  }
  return defaultOutcome;
}

/** Bestimmt den Trigger, der die Klassen-Untergrenze angehoben hat. */
function floorTrigger(input: {
  floor: ModelClass;
  tableClass: ModelClass;
  taskFloor: ModelClass;
  complexityFloor: ModelClass;
  riskFloor: ModelClass;
}): RoutingTrigger {
  const { floor, tableClass, taskFloor, complexityFloor, riskFloor } = input;
  if (floor === tableClass) return "DEFAULT_TABLE";
  if (riskFloor === floor && CLASS_ORDER[riskFloor] > CLASS_ORDER[tableClass]) return "RISK_FLOOR";
  if (complexityFloor === floor && CLASS_ORDER[complexityFloor] > CLASS_ORDER[tableClass]) {
    return "COMPLEXITY_FLOOR";
  }
  if (taskFloor === floor && CLASS_ORDER[taskFloor] > CLASS_ORDER[tableClass]) return "TASK_OVERRIDE";
  return "DEFAULT_TABLE";
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton (Produktivbetrieb) + Test-Haken
// ─────────────────────────────────────────────────────────────────────────────

const G = globalThis as typeof globalThis & {
  __modelRouter?: ModelRouter;
};

/** Singleton des Routers (Next.js-Runtime, mehrere Module). */
export function getModelRouter(opts?: ModelRouterOptions): ModelRouter {
  if (opts) {
    G.__modelRouter = new ModelRouter(opts);
    return G.__modelRouter;
  }
  if (!G.__modelRouter) {
    G.__modelRouter = new ModelRouter();
  }
  return G.__modelRouter;
}

/** Nur Tests: Router ersetzen (z. B. mit Fake-Registry). */
export function setModelRouterForTests(router: ModelRouter): ModelRouter {
  G.__modelRouter = router;
  return router;
}

/** Nur Tests: Singleton verwerfen. */
export function resetModelRouterForTests(): void {
  G.__modelRouter?.stopHealthPoller();
  G.__modelRouter = undefined;
}

/** Unveränderliche Kopie der Default-Policy (Doku/Tests). */
export function defaultRoutingPolicy(): RoutingPolicy {
  return structuredClone(DEFAULT_ROUTING_POLICY);
}
