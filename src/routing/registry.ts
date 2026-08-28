/**
 * Provider-Registry (Task 09) — Erweiterung von `src/lib/llmProvider.ts`.
 *
 * Die Registry ist die EINZIGE Stelle, die Provider-Details kennt (URLs, Keys,
 * Modell-Tags, Preise, Kontextgrössen). Der Router sieht ausschliesslich die
 * hier erzeugten `ProviderDescriptor`-Karten:
 *
 *   { id, models[], capabilities[], contextSize, costPer1kIn/Out,
 *     healthStatus, latencyEma, tokenBudgetToday, tokensUsedToday, quotaRest }
 *
 * Health-Poller: konfigurierbares Intervall (`ROUTING_HEALTH_POLL_MS`,
 * Standard aus der Policy `healthPollerIntervalMs`, 0 = aus). Bei Ollama werden
 * zusätzlich Modellliste und Kontextgrösse gelesen.
 *
 * TESTBARKEIT: `createFakeProviderRegistry()` liefert eine Registry ohne
 * Netzwerk — Health/Quota/Latenz/Timeout sind injizierbar.
 */
import {
  PROVIDER_IDS,
  type HealthStatus,
  type ProviderDescriptor,
  type ProviderId,
  type ProviderRegistry,
  type ProviderRegistryOverrides,
} from "./types";
import { costPerMTok } from "@/lib/llmProvider";

export const LOCAL_PROVIDERS: readonly ProviderId[] = ["ollama", "openai"];
export const CLOUD_PROVIDERS: readonly ProviderId[] = ["gemini", "anthropic"];

/** Health-Prüfverhalten: off | local (Default) | all. */
export const HEALTH_PROBE_ENV = "ROUTING_HEALTH_PROBE";
/** Timeout einer Health-Prüfung in ms. */
export const HEALTH_TIMEOUT_ENV = "ROUTING_HEALTH_TIMEOUT_MS";

const DEFAULT_CONTEXT_SIZE: Record<ProviderId, number> = {
  ollama: 4096,
  openai: 8192,
  gemini: 32_768,
  anthropic: 200_000,
};

const DEFAULT_MODEL: Record<ProviderId, string> = {
  ollama: "qwen2.5:3b-instruct-q4_K_M",
  openai: "local-model",
  gemini: "gemini-2.0-flash",
  anthropic: "claude-3-5-haiku-latest",
};

const PROVIDER_LABEL: Record<ProviderId, string> = {
  ollama: "Ollama (lokal)",
  openai: "OpenAI-kompatibel (lokal/compat)",
  gemini: "Google Gemini (Cloud)",
  anthropic: "Anthropic Claude (Cloud)",
};

function envInt(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** Kosten je 1k Token aus den Referenztarifen (USD je 1 Mio. Token). */
function costPer1k(provider: ProviderId, side: "input" | "output", env: Record<string, string | undefined>): number {
  return Number(((costPerMTok(provider, side, env) / 1_000_000) * 1000).toFixed(8));
}

function isLocal(provider: ProviderId): boolean {
  return provider === "ollama" || provider === "openai";
}

// ─────────────────────────────────────────────────────────────────────────────
// Basis-Karten aus der Umgebung
// ─────────────────────────────────────────────────────────────────────────────

/** Baut die Startkarte eines Providers (ohne Netzwerk). */
export function buildProviderDescriptor(
  id: ProviderId,
  env: Record<string, string | undefined> = process.env
): ProviderDescriptor {
  const contextEnv: Record<ProviderId, string> = {
    ollama: "OLLAMA_NUM_CTX",
    openai: "LLM_CONTEXT_SIZE",
    gemini: "GEMINI_CONTEXT_SIZE",
    anthropic: "ANTHROPIC_CONTEXT_SIZE",
  };
  const modelEnv =
    id === "ollama"
      ? env.MODEL_ROUTING_OLLAMA_DEFAULT
      : id === "gemini"
        ? env.GEMINI_MODEL ?? env.LLM_MODEL
        : id === "anthropic"
          ? env.ANTHROPIC_MODEL ?? env.LLM_MODEL
          : env.LLM_MODEL;

  const budgetEnv: Record<ProviderId, string> = {
    ollama: "ROUTING_BUDGET_OLLAMA_TOKENS",
    openai: "ROUTING_BUDGET_OPENAI_TOKENS",
    gemini: "ROUTING_BUDGET_GEMINI_TOKENS",
    anthropic: "ROUTING_BUDGET_ANTHROPIC_TOKENS",
  };

  const keyEnv: Record<ProviderId, string | undefined> = {
    ollama: undefined,
    openai: "LLM_API_KEY",
    gemini: "GEMINI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
  };
  const keyName = keyEnv[id];
  const hasKey = keyName ? Boolean(env[keyName]) : true;
  const cloud = !isLocal(id);

  return {
    id,
    label: PROVIDER_LABEL[id],
    deployment: cloud ? "cloud" : "local",
    models: [],
    defaultModel: modelEnv?.trim() || DEFAULT_MODEL[id],
    capabilities:
      id === "ollama"
        ? ["chat", "json", "schema"]
        : id === "openai"
          ? ["chat", "json", "schema"]
          : id === "gemini"
            ? ["chat", "json", "schema", "long-context"]
            : ["chat", "json", "schema", "long-context"],
    contextSize: envInt(env[contextEnv[id]], DEFAULT_CONTEXT_SIZE[id], 512, 2_000_000),
    costPer1kIn: cloud ? costPer1k(id, "input", env) : 0,
    costPer1kOut: cloud ? costPer1k(id, "output", env) : 0,
    // Ohne Health-Prüfung: Cloud ohne Key ist nicht nutzbar, lokale Provider
    // gelten bis zur ersten Prüfung als „degraded“ (nie optimistisch online).
    healthStatus: cloud ? (hasKey ? "degraded" : "offline") : "degraded",
    latencyEma: 0,
    tokenBudgetToday: envInt(env[budgetEnv[id]], id === "ollama" ? 5_000_000 : id === "openai" ? 500_000 : id === "gemini" ? 200_000 : 100_000, 0, 1_000_000_000),
    tokensUsedToday: 0,
    quotaRest: 100,
    ...(cloud && !hasKey ? { error: "Kein API-Key konfiguriert (Provider nicht nutzbar)." } : {}),
  };
}

/** Startkarten aller vier Provider (deterministische Reihenfolge). */
export function buildDefaultRegistry(
  env: Record<string, string | undefined> = process.env
): ProviderDescriptor[] {
  return PROVIDER_IDS.map((id) => buildProviderDescriptor(id, env));
}

// ─────────────────────────────────────────────────────────────────────────────
// Health-Prüfung
// ─────────────────────────────────────────────────────────────────────────────

export type HealthProbeOptions = {
  env?: Record<string, string | undefined>;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  /** Erzwingt eine Netzwerkprüfung auch für Cloud-Provider. */
  force?: boolean;
};

function baseUrlFor(provider: ProviderId, env: Record<string, string | undefined>): string {
  switch (provider) {
    case "ollama":
      return env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
    case "openai":
      return env.LLM_BASE_URL || "http://127.0.0.1:8080/v1";
    case "gemini":
      return env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta";
    case "anthropic":
      return env.ANTHROPIC_BASE_URL || "https://api.anthropic.com/v1";
  }
}

function keyFor(provider: ProviderId, env: Record<string, string | undefined>): string | undefined {
  switch (provider) {
    case "ollama":
      return undefined;
    case "openai":
      return env.LLM_API_KEY;
    case "gemini":
      return env.GEMINI_API_KEY;
    case "anthropic":
      return env.ANTHROPIC_API_KEY;
  }
}

/** GET mit hartem Timeout; wirft bei Netzwerk-/HTTP-Fehler. */
async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetchFn: typeof fetch
): Promise<unknown> {
  const res = await fetchFn(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  } as RequestInit);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return (await res.json()) as unknown;
}

/** Modellliste je Provider (read-only, kostenlos). */
async function listProviderModels(
  provider: ProviderId,
  opts: Required<Pick<HealthProbeOptions, "env" | "timeoutMs">> &
    Pick<HealthProbeOptions, "fetchFn">
): Promise<string[]> {
  const { env, timeoutMs } = opts;
  const fetchFn = opts.fetchFn ?? fetch;
  const base = baseUrlFor(provider, env);
  const key = keyFor(provider, env);

  if (provider === "ollama") {
    const data = (await fetchJson(`${base}/api/tags`, { method: "GET" }, timeoutMs, fetchFn)) as {
      models?: { name?: string; model?: string }[];
    };
    return (data.models ?? [])
      .map((m) => m.name ?? m.model ?? "")
      .filter((name) => name.length > 0);
  }
  if (provider === "openai") {
    const data = (await fetchJson(
      `${base}/models`,
      { method: "GET", headers: key ? { Authorization: `Bearer ${key}` } : {} },
      timeoutMs,
      fetchFn
    )) as { data?: { id?: string }[] };
    return (data.data ?? []).map((m) => m.id ?? "").filter((id) => id.length > 0);
  }
  if (provider === "gemini") {
    const data = (await fetchJson(
      `${base}/models?key=${encodeURIComponent(key ?? "")}`,
      { method: "GET" },
      timeoutMs,
      fetchFn
    )) as { models?: { name?: string }[] };
    return (data.models ?? [])
      .map((m) => (m.name ?? "").replace(/^models\//, ""))
      .filter((id) => id.length > 0);
  }
  const data = (await fetchJson(
    `${base}/models?limit=100`,
    { method: "GET", headers: { "x-api-key": key ?? "", "anthropic-version": "2023-06-01" } },
    timeoutMs,
    fetchFn
  )) as { data?: { id?: string }[] };
  return (data.data ?? []).map((m) => m.id ?? "").filter((id) => id.length > 0);
}

/**
 * Ollama-Sonderfall: Kontextgrösse eines Modells (`POST /api/show`).
 * Best-effort — schlägt die Prüfung fehl, bleibt der konfigurierte Wert stehen.
 */
export async function fetchOllamaContextSize(
  model: string,
  opts: Pick<HealthProbeOptions, "env" | "fetchFn" | "timeoutMs"> = {}
): Promise<number | null> {
  const env = opts.env ?? process.env;
  const timeoutMs = opts.timeoutMs ?? envInt(env[HEALTH_TIMEOUT_ENV], 1500, 100, 30_000);
  const fetchFn = opts.fetchFn ?? fetch;
  if (!model) return null;
  try {
    const data = (await fetchJson(
      `${baseUrlFor("ollama", env)}/api/show`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, verbose: false }),
      },
      timeoutMs,
      fetchFn
    )) as { model_info?: Record<string, { context_length?: number }> };
    const infos = Object.values(data.model_info ?? {});
    for (const info of infos) {
      const ctx = Number(info?.context_length);
      if (Number.isFinite(ctx) && ctx > 0) return ctx;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Prüft einen Provider und liefert den aktualisierten Descriptor.
 * Wirft NIE — Fehler werden als `offline` + redigierte Meldung abgebildet.
 */
export async function probeProviderHealth(
  descriptor: ProviderDescriptor,
  opts: HealthProbeOptions = {}
): Promise<ProviderDescriptor> {
  const env = opts.env ?? process.env;
  const timeoutMs = opts.timeoutMs ?? envInt(env[HEALTH_TIMEOUT_ENV], 1500, 100, 30_000);
  const mode = (env[HEALTH_PROBE_ENV] ?? "local").trim().toLowerCase();
  const cloud = !isLocal(descriptor.id);
  const key = keyFor(descriptor.id, env);
  const checkedAt = new Date().toISOString();
  const next: ProviderDescriptor = { ...descriptor, lastCheckedAt: checkedAt };

  if (cloud && !key) {
    return {
      ...next,
      healthStatus: "offline",
      error: "Kein API-Key konfiguriert (Provider nicht nutzbar).",
      quotaRest: 0,
    };
  }
  if (cloud && mode !== "all" && !opts.force) {
    // Kein Fern-Check: Cloud-Provider gelten mit Key als nutzbar, aber bis zur
    // ersten echten Messung ohne Latenzwert („online“, quota unverändert).
    return { ...next, healthStatus: "online", error: undefined };
  }

  const started = Date.now();
  try {
    const models = await listProviderModels(descriptor.id, { env, timeoutMs, fetchFn: opts.fetchFn });
    const latency = Date.now() - started;
    let contextSize = descriptor.contextSize;
    if (descriptor.id === "ollama") {
      const ctx = await fetchOllamaContextSize(descriptor.defaultModel, { env, timeoutMs, fetchFn: opts.fetchFn });
      if (ctx !== null) contextSize = ctx;
    }
    return {
      ...next,
      models: models.length > 0 ? models : descriptor.models,
      contextSize,
      healthStatus: models.length > 0 ? "online" : "degraded",
      latencyEma: descriptor.latencyEma > 0 ? Math.round(descriptor.latencyEma * 0.8 + latency * 0.2) : latency,
      error: undefined,
    };
  } catch (e) {
    return {
      ...next,
      healthStatus: "offline",
      error: e instanceof Error ? e.message.slice(0, 200) : "Health-Prüfung fehlgeschlagen",
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Registry-Implementierungen
// ─────────────────────────────────────────────────────────────────────────────

/** EMA-Glättung (80 % alt, 20 % neu); erster Wert setzt die EMA direkt. */
export function nextLatencyEma(previous: number, observed: number): number {
  if (!Number.isFinite(observed) || observed < 0) return previous;
  if (!Number.isFinite(previous) || previous <= 0) return Math.round(observed);
  return Math.round(previous * 0.8 + observed * 0.2);
}

/** Verbleibendes Kontingent in Prozent (0..100) aus Budget und Verbrauch. */
export function quotaFromBudget(tokensUsed: number, budget: number): number {
  if (!Number.isFinite(budget) || budget <= 0) return 100;
  const rest = 1 - tokensUsed / budget;
  return Math.min(100, Math.max(0, Math.round(rest * 100)));
}

/** Registry auf Basis der Umgebung (Produktivbetrieb). */
export class EnvProviderRegistry implements ProviderRegistry {
  private descriptors: Map<ProviderId, ProviderDescriptor>;
  private readonly env: Record<string, string | undefined>;

  constructor(env: Record<string, string | undefined> = process.env) {
    this.env = env;
    this.descriptors = new Map(
      buildDefaultRegistry(env).map((d) => [d.id, d] as [ProviderId, ProviderDescriptor])
    );
  }

  list(): ProviderDescriptor[] {
    return PROVIDER_IDS.map((id) => structuredClone(this.descriptors.get(id)!)).filter(Boolean);
  }

  get(id: ProviderId): ProviderDescriptor | undefined {
    const found = this.descriptors.get(id);
    return found ? structuredClone(found) : undefined;
  }

  async refresh(): Promise<ProviderDescriptor[]> {
    const probed = await Promise.all(
      PROVIDER_IDS.map((id) => probeProviderHealth(this.descriptors.get(id)!, { env: this.env }))
    );
    this.descriptors = new Map(probed.map((d) => [d.id, d] as [ProviderId, ProviderDescriptor]));
    return this.list();
  }

  recordUsage(input: { provider: ProviderId; tokens: number; latencyMs?: number }): void {
    const current = this.descriptors.get(input.provider);
    if (!current) return;
    const tokens = Number.isFinite(input.tokens) && input.tokens > 0 ? Math.trunc(input.tokens) : 0;
    const used = current.tokensUsedToday + tokens;
    this.descriptors.set(input.provider, {
      ...current,
      tokensUsedToday: used,
      quotaRest: quotaFromBudget(used, current.tokenBudgetToday),
      latencyEma:
        input.latencyMs !== undefined
          ? nextLatencyEma(current.latencyEma, input.latencyMs)
          : current.latencyEma,
    });
  }

  override(id: ProviderId, patch: ProviderRegistryOverrides): ProviderDescriptor | undefined {
    const current = this.descriptors.get(id);
    if (!current) return undefined;
    const merged: ProviderDescriptor = { ...current, ...patch, id };
    this.descriptors.set(id, merged);
    return structuredClone(merged);
  }
}

export type FakeProviderRegistryOptions = {
  /** Startkarten überschreiben/zusätzliche Provider (Default: alle vier). */
  providers?: Partial<Record<ProviderId, ProviderRegistryOverrides>>;
  /** `refresh()` wirft diese Fehlermeldung (Timeout-Simulation). */
  refreshError?: string;
  /** `refresh()` wartet künstlich (ms) — Timeout-Simulation im Adapter. */
  refreshDelayMs?: number;
  /** Health-Status, den `refresh()` für alle Provider setzt (wenn gesetzt). */
  refreshHealthStatus?: HealthStatus;
  env?: Record<string, string | undefined>;
};

/**
 * Registry für Tests: keine Netzwerkaufrufe, Health/Quota/Latenz/Timeout
 * injizierbar. Default-Zustand: alle Provider `online`, Quota 100 %.
 */
export class FakeProviderRegistry implements ProviderRegistry {
  private descriptors: Map<ProviderId, ProviderDescriptor>;
  readonly options: FakeProviderRegistryOptions;
  refreshCount = 0;

  constructor(opts: FakeProviderRegistryOptions = {}) {
    this.options = opts;
    const env = opts.env ?? {};
    this.descriptors = new Map(
      PROVIDER_IDS.map((id) => {
        const base = buildProviderDescriptor(id, { ...process.env, ...env });
        const patched: ProviderDescriptor = {
          ...base,
          models: [base.defaultModel],
          healthStatus: "online",
          latencyEma: 250,
          quotaRest: 100,
          error: undefined,
          ...(opts.providers?.[id] ?? {}),
          id,
        };
        return [id, patched] as [ProviderId, ProviderDescriptor];
      })
    );
  }

  list(): ProviderDescriptor[] {
    return PROVIDER_IDS.map((id) => structuredClone(this.descriptors.get(id)!)).filter(Boolean);
  }

  get(id: ProviderId): ProviderDescriptor | undefined {
    const found = this.descriptors.get(id);
    return found ? structuredClone(found) : undefined;
  }

  async refresh(): Promise<ProviderDescriptor[]> {
    this.refreshCount += 1;
    if (this.options.refreshDelayMs && this.options.refreshDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.options.refreshDelayMs));
    }
    if (this.options.refreshError) {
      throw new Error(this.options.refreshError);
    }
    if (this.options.refreshHealthStatus) {
      for (const id of PROVIDER_IDS) {
        const current = this.descriptors.get(id)!;
        this.descriptors.set(id, {
          ...current,
          healthStatus: this.options.refreshHealthStatus,
          lastCheckedAt: new Date().toISOString(),
        });
      }
    }
    return this.list();
  }

  recordUsage(input: { provider: ProviderId; tokens: number; latencyMs?: number }): void {
    const current = this.descriptors.get(input.provider);
    if (!current) return;
    const tokens = Number.isFinite(input.tokens) && input.tokens > 0 ? Math.trunc(input.tokens) : 0;
    const used = current.tokensUsedToday + tokens;
    this.descriptors.set(input.provider, {
      ...current,
      tokensUsedToday: used,
      quotaRest: quotaFromBudget(used, current.tokenBudgetToday),
      latencyEma:
        input.latencyMs !== undefined ? nextLatencyEma(current.latencyEma, input.latencyMs) : current.latencyEma,
    });
  }

  override(id: ProviderId, patch: ProviderRegistryOverrides): ProviderDescriptor | undefined {
    const current = this.descriptors.get(id);
    if (!current) return undefined;
    const merged: ProviderDescriptor = { ...current, ...patch, id };
    this.descriptors.set(id, merged);
    return structuredClone(merged);
  }

  /** Direkter Zustands-Setter für Tests (z. B. Gemini-Quota auf 4 %). */
  setHealth(id: ProviderId, status: HealthStatus): void {
    this.override(id, { healthStatus: status });
  }

  setQuota(id: ProviderId, percent: number): void {
    this.override(id, { quotaRest: percent });
  }
}

/** Produktiv-Registry. */
export function createProviderRegistry(
  env: Record<string, string | undefined> = process.env
): EnvProviderRegistry {
  return new EnvProviderRegistry(env);
}

/** Test-Registry ohne echte Provider. */
export function createFakeProviderRegistry(opts: FakeProviderRegistryOptions = {}): FakeProviderRegistry {
  return new FakeProviderRegistry(opts);
}

// ─────────────────────────────────────────────────────────────────────────────
// Health-Poller
// ─────────────────────────────────────────────────────────────────────────────

export type HealthPollerOptions = {
  registry: ProviderRegistry;
  intervalMs: number;
  /** Sofortige erste Prüfung (Default: true). */
  immediate?: boolean;
  onError?: (error: unknown) => void;
  onTick?: (providers: ProviderDescriptor[]) => void;
};

export type HealthPollerHandle = {
  readonly intervalMs: number;
  readonly running: boolean;
  stop(): void;
  /** Manuelle Prüfung (für Admin/API). */
  pollNow(): Promise<ProviderDescriptor[]>;
};

/**
 * Startet den Health-Poller. `intervalMs <= 0` ⇒ kein Poller (aus).
 * Der Timer wird `unref()`ed, damit er den Prozess nie offen hält.
 */
export function startHealthPoller(opts: HealthPollerOptions): HealthPollerHandle {
  const intervalMs = Math.max(0, Math.trunc(opts.intervalMs));
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  const tick = async (): Promise<void> => {
    try {
      const providers = await opts.registry.refresh();
      opts.onTick?.(providers);
    } catch (e) {
      opts.onError?.(e);
    }
  };

  if (intervalMs > 0) {
    running = true;
    timer = setInterval(() => {
      void tick();
    }, intervalMs);
    timer.unref?.();
  }

  if (opts.immediate !== false) {
    void tick();
  }

  return {
    intervalMs,
    get running() {
      return running;
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
      running = false;
    },
    pollNow: () => opts.registry.refresh(),
  };
}
