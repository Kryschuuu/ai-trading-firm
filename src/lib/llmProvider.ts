/**
 * Abstrakte LLM-Provider-Schnittstelle.
 *
 * Standardisiert alle API-Calls über EIN Interface (LlmChatRequest → LlmChatResult),
 * egal ob Ollama, ein OpenAI-kompatibler Server (llama.cpp, LM Studio, vLLM,
 * LocalAI, ChatGPT), Google Gemini oder Anthropic Claude dahinter liegt.
 *
 * Bausteine:
 *   1. Provider-Clients (createLlmClient) — kapseln URL, Headers, Body, Parsing
 *   2. chatWithRetry() — Fehlerbehandlung mit exponentiellem Backoff + Jitter
 *   3. chatLlm() — Provider-Kette: LLM_PROVIDER (primär) + LLM_FALLBACK_PROVIDERS
 *   4. estimateCostUsd() — Kosten-/Performance-Trade-off (pro Token approximiert)
 *
 * Design:
 *   - Alle Builder/Parser sind reine Funktionen → offline unit-testbar.
 *   - `fetchFn` ist injizierbar (Tests) und defaultet auf globales fetch.
 *   - Netzwerkfehler, HTTP 429 und 5xx gelten als retryable; 4xx nicht.
 */

import { publicErrorMessage } from "./secrets";

export type LlmProviderName = "ollama" | "openai" | "gemini" | "anthropic";

export type LlmMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

/**
 * Standardisierter Chat-Request — identisch für alle Provider.
 * - `json`/`schema` erzwingen strukturierte Ausgabe, wo der Provider es kann.
 * - `maxTokens` begrenzt die Antwortlänge (Performance- und Kostenhebel).
 */
export type LlmChatRequest = {
  model: string;
  messages: LlmMessage[];
  temperature?: number;
  maxTokens?: number;
  json?: boolean;
  schema?: Record<string, unknown>;
  timeoutMs?: number;
};

export type LlmUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

export type LlmChatResult = {
  content: string;
  provider: LlmProviderName;
  model: string;
  usage: LlmUsage;
  latencyMs: number;
  attempt: number;
  /** Geschätzte Kosten in USD (0 bei lokalen Providern, sonst Preisrechnung). */
  costUsd?: number;
};

/** Fehler mit Provider-Kontext; `retryable` steuert das Backoff-Verhalten. */
export class LlmProviderError extends Error {
  readonly provider: LlmProviderName;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(
    message: string,
    provider: LlmProviderName,
    opts: { retryable?: boolean; status?: number } = {}
  ) {
    super(message);
    this.name = "LlmProviderError";
    this.provider = provider;
    this.retryable = opts.retryable ?? false;
    this.status = opts.status;
  }
}

export type LlmClientConfig = {
  provider: LlmProviderName;
  baseUrl: string;
  apiKey?: string;
  /** Modell-Override (z. B. LLM_MODEL für OpenAI-kompatible Server). */
  model?: string;
  numCtx?: number;
  keepAlive?: string;
  maxTokens?: number;
  fetchFn?: typeof fetch;
};

export type LlmClient = {
  readonly name: LlmProviderName;
  chat(req: LlmChatRequest, attempt?: number): Promise<LlmChatResult>;
  listModels(): Promise<string[]>;
};

// ─────────────────────────────────────────────────────────────────────────────
// Provider-Konfiguration aus der Umgebung
// ─────────────────────────────────────────────────────────────────────────────

export const PROVIDER_NAMES: LlmProviderName[] = ["ollama", "openai", "gemini", "anthropic"];

export function normalizeProvider(raw: string | undefined): LlmProviderName | null {
  const p = (raw ?? "").trim().toLowerCase();
  return (PROVIDER_NAMES as string[]).includes(p) ? (p as LlmProviderName) : null;
}

/**
 * Provider-Kette: primärer Provider + optionale Fallbacks
 * (`LLM_FALLBACK_PROVIDERS=gemini,anthropic`). Duplikate und Ungültiges werden
 * entfernt — die Reihenfolge bleibt stabil.
 */
export function resolveProviderChain(env: Record<string, string | undefined> = process.env): LlmProviderName[] {
  const primary = normalizeProvider(env.LLM_PROVIDER) ?? "ollama";
  const fallbacks = (env.LLM_FALLBACK_PROVIDERS ?? "")
    .split(",")
    .map(normalizeProvider)
    .filter((p): p is LlmProviderName => p !== null && p !== primary);
  return [primary, ...fallbacks];
}

export function resolveMaxTokens(req: LlmChatRequest, env: Record<string, string | undefined> = process.env): number {
  const n = Number(req.maxTokens ?? env.LLM_MAX_TOKENS ?? 512);
  if (!Number.isFinite(n) || n <= 0) return 512;
  return Math.min(Math.floor(n), 32_768);
}

export function resolveTimeoutMs(req: LlmChatRequest, env: Record<string, string | undefined> = process.env): number {
  const n = Number(req.timeoutMs ?? env.LLM_TIMEOUT_MS ?? env.OLLAMA_TIMEOUT_MS ?? 180_000);
  if (!Number.isFinite(n) || n <= 0) return 180_000;
  return Math.min(n, 600_000);
}

const DEFAULT_BASE_URLS: Record<LlmProviderName, string> = {
  ollama: "http://127.0.0.1:11434",
  openai: "http://127.0.0.1:8080/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
  anthropic: "https://api.anthropic.com/v1",
};

const API_KEY_ENV: Record<LlmProviderName, string> = {
  ollama: "",
  openai: "LLM_API_KEY",
  gemini: "GEMINI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};

/** Baut die Client-Konfiguration aus der Umgebung (injizierbar für Tests). */
export function providerConfigFromEnv(
  provider: LlmProviderName,
  env: Record<string, string | undefined> = process.env
): LlmClientConfig {
  const baseEnv =
    provider === "ollama"
      ? "OLLAMA_BASE_URL"
      : provider === "gemini"
        ? "GEMINI_BASE_URL"
        : provider === "anthropic"
          ? "ANTHROPIC_BASE_URL"
          : "LLM_BASE_URL";
  return {
    provider,
    baseUrl: sanitizeBaseUrl(env[baseEnv] ?? DEFAULT_BASE_URLS[provider], DEFAULT_BASE_URLS[provider]),
    apiKey: env[API_KEY_ENV[provider]] || undefined,
    // KORRIGIERT (v1.4.0): LLM_MODEL gilt für alle Cloud-/kompatiblen Provider,
    // nicht nur openai — sonst ignorieren Gemini/Claude den konfigurierten Tag.
    model: provider === "ollama" ? undefined : env.LLM_MODEL || undefined,
    numCtx: Number(env.OLLAMA_NUM_CTX || 4096),
    keepAlive: env.OLLAMA_KEEP_ALIVE || undefined,
    maxTokens: resolveMaxTokens({ model: "", messages: [] }, env),
    fetchFn: undefined,
  };
}

/**
 * Nur http/https, keine Userinfo (Credentials in der URL würden in Logs/Fehler
 * und in `new URL().href` landen). Ungültige Werte fallen auf den Default zurück.
 */
export function sanitizeBaseUrl(raw: string, fallback: string): string {
  const tryParse = (value: string): string | null => {
    try {
      const u = new URL(value);
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      if (u.username || u.password) return null;
      const path = u.pathname === "/" ? "" : u.pathname.replace(/\/+$/, "");
      return `${u.protocol}//${u.host}${path}`;
    } catch {
      return null;
    }
  };
  return tryParse(raw) ?? tryParse(fallback) ?? "http://127.0.0.1:11434";
}

// ─────────────────────────────────────────────────────────────────────────────
// Reine Request-Builder und Response-Parser (offline testbar)
// ─────────────────────────────────────────────────────────────────────────────

function systemAndMessages(messages: LlmMessage[]) {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const rest = messages.filter((m) => m.role !== "system");
  return { system, rest };
}

export function buildOllamaBody(
  req: LlmChatRequest,
  cfg: LlmClientConfig
): Record<string, unknown> {
  // KORRIGIERT (v1.4.0): keep_alive ist ein Top-Level-Feld der Ollama-API,
  // nicht options.keep_alive (wurde stillschweigend ignoriert).
  // Token-Limit kommt aus dem Request (req.maxTokens / LLM_MAX_TOKENS), nicht
  // aus einem bei Client-Erzeugung eingefrorenen cfg.maxTokens.
  return {
    model: req.model,
    messages: req.messages,
    stream: false,
    options: {
      temperature: req.temperature ?? 0.2,
      num_ctx: cfg.numCtx ?? Number(process.env.OLLAMA_NUM_CTX || 4096),
      num_predict: resolveMaxTokens(req, process.env),
    },
    ...(cfg.keepAlive ? { keep_alive: cfg.keepAlive } : {}),
    ...(req.json !== false ? { format: req.schema ?? "json" } : {}),
  };
}

export function parseOllamaResponse(data: unknown): { content: string; usage: LlmUsage } {
  const d = data as {
    message?: { content?: string };
    prompt_eval_count?: number;
    eval_count?: number;
  };
  const prompt = d.prompt_eval_count;
  const completion = d.eval_count;
  const hasUsage = Number.isFinite(prompt) || Number.isFinite(completion);
  return {
    content: d.message?.content ?? "",
    usage: hasUsage
      ? {
          promptTokens: Number.isFinite(prompt) ? prompt : undefined,
          completionTokens: Number.isFinite(completion) ? completion : undefined,
          totalTokens: (Number(prompt) || 0) + (Number(completion) || 0),
        }
      : {},
  };
}

export function buildOpenaiBody(
  req: LlmChatRequest,
  _cfg: LlmClientConfig
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    model: req.model,
    messages: req.messages,
    temperature: req.temperature ?? 0.2,
    max_tokens: resolveMaxTokens(req, process.env),
    stream: false,
  };
  if (req.json !== false) {
    base.response_format = req.schema
      ? { type: "json_schema", json_schema: { name: "decision", schema: req.schema } }
      : { type: "json_object" };
  }
  return base;
}

export function parseOpenaiResponse(data: unknown): { content: string; usage: LlmUsage } {
  const d = data as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };
  const u = d.usage;
  return {
    content: d.choices?.[0]?.message?.content ?? "",
    usage: u
      ? {
          promptTokens: u.prompt_tokens,
          completionTokens: u.completion_tokens,
          totalTokens: u.total_tokens,
        }
      : {},
  };
}

export function buildGeminiBody(
  req: LlmChatRequest,
  _cfg: LlmClientConfig
): Record<string, unknown> {
  const { system, rest } = systemAndMessages(req.messages);
  const contents = rest.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
  const generationConfig: Record<string, unknown> = {
    temperature: req.temperature ?? 0.2,
    maxOutputTokens: resolveMaxTokens(req, process.env),
  };
  if (req.json !== false) generationConfig.responseMimeType = "application/json";
  if (req.json !== false && req.schema) generationConfig.responseSchema = req.schema;

  return {
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    contents,
    generationConfig,
  };
}

export function parseGeminiResponse(data: unknown): { content: string; usage: LlmUsage } {
  const d = data as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      totalTokenCount?: number;
    };
  };
  const parts = d.candidates?.[0]?.content?.parts ?? [];
  const u = d.usageMetadata;
  return {
    content: parts.map((p) => p.text ?? "").join(""),
    usage: u
      ? {
          promptTokens: u.promptTokenCount,
          completionTokens: u.candidatesTokenCount,
          totalTokens: u.totalTokenCount,
        }
      : {},
  };
}

export function buildAnthropicBody(
  req: LlmChatRequest,
  _cfg: LlmClientConfig
): Record<string, unknown> {
  const { system, rest } = systemAndMessages(req.messages);
  return {
    model: req.model,
    ...(system ? { system } : {}),
    messages: rest,
    max_tokens: resolveMaxTokens(req, process.env),
    temperature: req.temperature ?? 0.2,
  };
}

export function parseAnthropicResponse(data: unknown): { content: string; usage: LlmUsage } {
  const d = data as {
    content?: { type?: string; text?: string }[];
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const text = (d.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
  const u = d.usage;
  return {
    content: text,
    usage: u
      ? { promptTokens: u.input_tokens, completionTokens: u.output_tokens }
      : {},
  };
}

/**
 * Normalisiert Modelllisten aller Provider.
 * Gemini liefert `name: "models/gemini-2.0-flash"` — Prefix muss weg, sonst
 * wird `/models/models/gemini-…:generateContent` aufgerufen.
 * Anthropic nutzt wie OpenAI `{ data: [{ id }] }`, nicht `{ models: [{ name }] }`.
 */
export function parseModelList(provider: LlmProviderName, data: unknown): string[] {
  const d = (data ?? {}) as {
    models?: { name?: string; id?: string }[];
    data?: { id?: string; name?: string }[];
  };
  const stripGemini = (name: string) => name.replace(/^models\//, "");
  if (provider === "openai" || provider === "anthropic") {
    return (d.data ?? d.models ?? [])
      .map((m) => String(m.id ?? m.name ?? "").trim())
      .filter(Boolean);
  }
  if (provider === "gemini") {
    return (d.models ?? d.data ?? [])
      .map((m) => stripGemini(String(m.name ?? m.id ?? "").trim()))
      .filter(Boolean);
  }
  return (d.models ?? []).map((m) => String(m.name ?? "").trim()).filter(Boolean);
}

/** Gemini-Auth ausschließlich per Header — Keys gehören nicht in die URL. */
export function geminiAuthHeaders(apiKey?: string): Record<string, string> {
  return apiKey ? { "x-goog-api-key": apiKey } : {};
}

// ─────────────────────────────────────────────────────────────────────────────
// Client-Implementierungen
// ─────────────────────────────────────────────────────────────────────────────

type Parsed = { content: string; usage: LlmUsage };

async function doFetch(
  cfg: LlmClientConfig,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number
): Promise<Response> {
  const fetchFn = cfg.fetchFn ?? globalThis.fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
      cache: "no-store",
    });
  } catch (e) {
    // Netzwerkfehler (refused, timeout, DNS) sind immer retryable.
    throw new LlmProviderError(
      `Netzwerkfehler bei ${cfg.provider}: ${publicErrorMessage(e, "Netzwerkfehler")}`,
      cfg.provider,
      { retryable: true }
    );
  } finally {
    clearTimeout(timer);
  }
}

async function doChat(
  cfg: LlmClientConfig,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  parse: (data: unknown) => Parsed,
  req: LlmChatRequest,
  attempt: number
): Promise<LlmChatResult> {
  const started = Date.now();
  const timeoutMs = resolveTimeoutMs(req, process.env);
  const res = await doFetch(cfg, url, headers, body, timeoutMs);

  if (!res.ok) {
    // 429/5xx sind vorübergehend → Retry. 4xx sind Programmier-/Konfigfehler.
    const retryable = res.status === 429 || res.status >= 500;
    throw new LlmProviderError(
      `${cfg.provider} chat failed: HTTP ${res.status}`,
      cfg.provider,
      { retryable, status: res.status }
    );
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new LlmProviderError(`${cfg.provider}: Antwort war kein gültiges JSON`, cfg.provider);
  }
  const parsed = parse(data);
  return {
    content: parsed.content,
    provider: cfg.provider,
    model: cfg.model ?? req.model,
    usage: parsed.usage,
    latencyMs: Date.now() - started,
    attempt,
    costUsd: estimateCostUsd(cfg.provider, parsed.usage, process.env),
  };
}

/**
 * Modelle des Servers auflisten (Ollama: /api/tags, OpenAI: /models, …).
 * Wirft bei Fehler — die Aufrufer (getOllamaStatus) entscheiden über Fallback,
 * damit "available" nie fälschlich true ist.
 */
async function listModels(cfg: LlmClientConfig, timeoutMs = 2500): Promise<string[]> {
  const fetchFn = cfg.fetchFn ?? globalThis.fetch;
  const urls: Record<LlmProviderName, string> = {
    ollama: `${cfg.baseUrl}/api/tags`,
    openai: `${cfg.baseUrl}/models`,
    gemini: `${cfg.baseUrl}/models`,
    anthropic: `${cfg.baseUrl}/models`,
  };
  const headers: Record<string, string> = { Accept: "application/json" };
  if (cfg.apiKey) {
    if (cfg.provider === "anthropic") {
      headers["x-api-key"] = cfg.apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else if (cfg.provider === "gemini") {
      headers["x-goog-api-key"] = cfg.apiKey;
    } else {
      headers.Authorization = `Bearer ${cfg.apiKey}`;
    }
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(urls[cfg.provider], { headers, cache: "no-store", signal: ctrl.signal });
    if (!res.ok) throw new LlmProviderError(`list models: HTTP ${res.status}`, cfg.provider);
    return parseModelList(cfg.provider, await res.json());
  } catch (e) {
    if (e instanceof LlmProviderError) throw e;
    throw new LlmProviderError(
      `list models: ${publicErrorMessage(e, "unbekannt")}`,
      cfg.provider,
      { retryable: true }
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Kurzer Cache für installierte Modelle (Status + Ollama-Tag-Auflösung). */
const MODEL_LIST_CACHE = new Map<string, { at: number; models: string[] }>();
const MODEL_LIST_TTL_MS = 15_000;

/** Nur für Tests/Diagnose: Cache leeren. */
export function clearModelListCache(): void {
  MODEL_LIST_CACHE.clear();
}

async function listModelsCached(cfg: LlmClientConfig): Promise<string[] | null> {
  const cached = MODEL_LIST_CACHE.get(cfg.provider);
  if (cached && Date.now() - cached.at < MODEL_LIST_TTL_MS) return cached.models;
  try {
    const models = await listModels(cfg);
    MODEL_LIST_CACHE.set(cfg.provider, { at: Date.now(), models });
    return models;
  } catch {
    return null;
  }
}

/** Findet installierten Tag auch bei Modellfamilien-Angabe (Ollama-Kompatibilität). */
function resolveInstalledTag(models: string[], wanted: string): string | null {
  if (models.includes(wanted)) return wanted;
  const family = wanted.split(":")[0];
  return models.find((m) => m === family || m.startsWith(`${family}:`)) ?? null;
}

/**
 * Erzeugt einen konkreten Provider-Client. `cfg.fetchFn` erlaubt Tests ohne
 * Netzwerk; alle Laufzeitaufrufe nutzen das globale fetch.
 */
export function createLlmClient(
  name: LlmProviderName,
  opts: { env?: Record<string, string | undefined>; fetchFn?: typeof fetch } = {}
): LlmClient {
  const cfg: LlmClientConfig = { ...providerConfigFromEnv(name, opts.env ?? process.env) };
  if (opts.fetchFn) cfg.fetchFn = opts.fetchFn;

  /**
   * Modellauflösung:
   *  - LLM_MODEL (cfg.model) hat Vorrang bei OpenAI-kompatibel/Gemini/Claude
   *    (dort benennen die Agenten-Tags aus der DB oft keinen Cloud-Typ).
   *  - Ollama: installierten Tag auch bei Familien-Angabe finden
   *    (qwen2.5 → qwen2.5:3b-instruct-…), sonst Original-Tag (Server antwortet
   *    dann 404 → Fallback-Kette/Regel-Engine).
   */
  async function resolveModel(reqModel: string): Promise<string> {
    if (name === "ollama") {
      // Familien-Auflösung: "qwen2.5:3b-…" bzw. "qwen2.5" → installierter Tag.
      const installed = await listModelsCached(cfg);
      if (installed && installed.length > 0) {
        return resolveInstalledTag(installed, reqModel) ?? reqModel;
      }
      return reqModel;
    }
    if (name === "openai") {
      // Kompatibilität zum alten Verhalten: LLM_MODEL → passender Tag →
      // erstes angebotenes Modell → Agenten-Tag.
      if (cfg.model) return cfg.model;
      const installed = await listModelsCached(cfg);
      if (installed && installed.length > 0) {
        return resolveInstalledTag(installed, reqModel) ?? installed[0];
      }
      return reqModel;
    }
    // Gemini/Anthropic: LLM_MODEL (= cfg.model) oder Agenten-Tag direkt nutzen.
    return cfg.model ?? reqModel;
  }

  const chat = async (req: LlmChatRequest, attempt = 1): Promise<LlmChatResult> => {
    const model = await resolveModel(req.model);
    const effective = { ...req, model };
    switch (name) {
      case "ollama":
        return doChat(
          cfg,
          `${cfg.baseUrl}/api/chat`,
          {},
          buildOllamaBody(effective, cfg),
          parseOllamaResponse,
          effective,
          attempt
        );
      case "openai":
        return doChat(
          cfg,
          `${cfg.baseUrl}/chat/completions`,
          cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {},
          buildOpenaiBody(effective, cfg),
          parseOpenaiResponse,
          effective,
          attempt
        );
      case "gemini":
        return doChat(
          cfg,
          `${cfg.baseUrl}/models/${encodeURIComponent(model)}:generateContent`,
          geminiAuthHeaders(cfg.apiKey),
          buildGeminiBody(effective, cfg),
          parseGeminiResponse,
          effective,
          attempt
        );
      case "anthropic":
        return doChat(
          cfg,
          `${cfg.baseUrl}/messages`,
          {
            "x-api-key": cfg.apiKey ?? "",
            "anthropic-version": "2023-06-01",
          },
          buildAnthropicBody(effective, cfg),
          parseAnthropicResponse,
          effective,
          attempt
        );
    }
  };

  return {
    name,
    chat: (req, attempt = 1) => chat(req, attempt),
    // Wirft bei Fehler — getOllamaStatus entscheidet über available/fallback.
    listModels: () => listModels(cfg),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Retry mit exponentiellem Backoff + Jitter
// ─────────────────────────────────────────────────────────────────────────────

export type RetryOptions = {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Deterministisch injizierbar für Tests; Default: Math.random (Jitter). */
  jitter?: () => number;
  sleep?: (ms: number) => Promise<void>;
  shouldRetry?: (e: unknown) => boolean;
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
};

/** Backoff: base * 2^(attempt-1), gekappt bei maxDelay, plus Jitter (0..baseMs). */
export function backoffDelayMs(
  attempt: number,
  baseMs = 500,
  maxMs = 8000,
  jitter: () => number = Math.random
): number {
  const a = Math.max(1, Math.floor(attempt));
  const exp = Math.min(baseMs * 2 ** (a - 1), maxMs);
  return Math.round(exp + jitter() * Math.min(baseMs, maxMs));
}

/**
 * Führt `fn` mit bis zu `maxAttempts` Versuchen aus. Retry nur bei
 * retryable Fehlern (Netzwerk, 429, 5xx). Nach dem letzten Versuch wird der
 * Originalfehler geworfen — nie stillschweigend geschluckt.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions = {}
): Promise<T> {
  const maxAttempts = Math.max(1, Math.floor(opts.maxAttempts ?? 3));
  const sleepFn = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      lastError = e;
      const retryable = opts.shouldRetry
        ? opts.shouldRetry(e)
        : e instanceof LlmProviderError
          ? e.retryable
          : true;
      if (attempt >= maxAttempts || !retryable) throw e;
      const delay = backoffDelayMs(attempt, opts.baseDelayMs, opts.maxDelayMs, opts.jitter);
      opts.onRetry?.(attempt, e, delay);
      await sleepFn(delay);
    }
  }
  throw lastError;
}

// ─────────────────────────────────────────────────────────────────────────────
// Kosten-Einschätzung (Cost/Performance-Trade-off)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Referenzpreise je 1 Mio. Token (US-Dollar, approximativ, Stand 2026-08).
 * Lokale Provider kosten 0. Überschreibbar per Env z. B.:
 *   LLM_COST_OPENAI_INPUT_PER_MTOK=2.5
 */
export const COST_USD_PER_MTOK: Record<LlmProviderName, { input: number; output: number }> = {
  ollama: { input: 0, output: 0 },
  openai: { input: 0.15, output: 0.6 },
  gemini: { input: 0.125, output: 0.5 },
  anthropic: { input: 0.8, output: 4.0 },
};

export function costPerMTok(
  provider: LlmProviderName,
  side: "input" | "output",
  env: Record<string, string | undefined> = process.env
): number {
  const key = `LLM_COST_${provider.toUpperCase()}_${side.toUpperCase()}_PER_MTOK`;
  const n = Number(env[key]);
  return Number.isFinite(n) && n >= 0 ? n : COST_USD_PER_MTOK[provider][side];
}

/** Geschätzte Kosten eines Aufrufs in USD (undefined ohne Verbrauchszahlen). */
export function estimateCostUsd(
  provider: LlmProviderName,
  usage: LlmUsage,
  env: Record<string, string | undefined> = process.env
): number | undefined {
  const input = usage.promptTokens ?? 0;
  const output = usage.completionTokens ?? 0;
  if (input <= 0 && output <= 0) return undefined;
  return Number(
    (
      (input / 1_000_000) * costPerMTok(provider, "input", env) +
      (output / 1_000_000) * costPerMTok(provider, "output", env)
    ).toFixed(6)
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrierung: Provider-Kette mit Retry
// ─────────────────────────────────────────────────────────────────────────────

export type ChatLlmOptions = {
  providers?: LlmProviderName[];
  env?: Record<string, string | undefined>;
  fetchFn?: typeof fetch;
  maxAttempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Standardisierter Einstiegspunkt für alle Agenten:
 *   - versucht die Provider-Kette der Reihe nach (primär → Fallbacks)
 *   - pro Provider Retry mit Backoff (LLM_MAX_ATTEMPTS, Standard 2)
 *   - wirft den letzten Fehler, wenn ALLE Provider scheitern
 */
export async function chatLlm(
  req: LlmChatRequest,
  opts: ChatLlmOptions = {}
): Promise<LlmChatResult> {
  const env = opts.env ?? process.env;
  const providers = opts.providers ?? resolveProviderChain(env);
  // Explizite Option hat Vorrang, sonst Env (Standard 2), immer geklemmt 1–5.
  const envAttempts = Number(env.LLM_MAX_ATTEMPTS);
  const maxAttempts = Math.min(
    5,
    Math.max(1, Number.isFinite(envAttempts) ? envAttempts : 2)
  );
  const effectiveMaxAttempts = Math.min(5, Math.max(1, opts.maxAttempts ?? maxAttempts));
  const sleep = opts.sleep;

  let lastError: unknown;
  for (const provider of providers) {
    try {
      const client = createLlmClient(provider, { env, fetchFn: opts.fetchFn });
      return await withRetry((attempt) => client.chat({ ...req, maxTokens: resolveMaxTokens(req, env) }, attempt), {
        maxAttempts: effectiveMaxAttempts,
        baseDelayMs: opts.baseDelayMs ?? 250,
        sleep,
        onRetry: (attempt, error, delay) => {
          console.warn(
            `[llm] ${provider} Versuch ${attempt} fehlgeschlagen, Retry in ${delay}ms:`,
            publicErrorMessage(error)
          );
        },
      });
    } catch (e) {
      lastError = e;
      console.warn(
        `[llm] Provider ${provider} nicht verfügbar:`,
        publicErrorMessage(e)
      );
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new LlmProviderError(String(lastError), providers[0] ?? "ollama", { retryable: false });
}
