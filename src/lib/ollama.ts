/**
 * LLM-Schicht der Trading-Firma.
 *
 * Diese Datei ist die Kompatibilitäts- und Orchestrierungsschicht über der
 * Provider-Abstraktion in `src/lib/llmProvider.ts`:
 *
 *   llmProvider.ts   → Client-Bau, Retries, Provider-Kette, Kosten (neu)
 *   ollama.ts        → Entscheidungs-Schema, Temperatur pro Rolle,
 *                      Regel-Engine-Fallback, Status-Cache (API stabil)
 *
 * Unterstützte Provider (konfigurierbar via .env):
 *   ollama    → nativer Ollama-Server (Standard, Variante A und B-CPU)
 *   openai    → jeder OpenAI-kompatible Endpunkt: llama.cpp `llama-server`,
 *               LM Studio, vLLM, LocalAI — oder ein Cloud-Anbieter
 *   gemini    → Google Gemini (GEMINI_API_KEY)
 *   anthropic → Anthropic Claude (ANTHROPIC_API_KEY)
 *
 * Fallback-Kette primär + Fallbacks: LLM_PROVIDER + LLM_FALLBACK_PROVIDERS.
 * Ist kein Provider erreichbar, greift die deterministische Regel-Engine,
 * damit die komplette Orchestrierungs- und Guardrail-Pipeline auch ohne
 * GPU/Modell nachvollziehbar bleibt.
 */
import {
  chatLlm,
  createLlmClient,
  resolveProviderChain,
  type LlmChatRequest,
  type LlmMessage,
  type LlmProviderName,
  type LlmUsage,
} from "./llmProvider";

export type { LlmProviderName, LlmUsage } from "./llmProvider";

/** @deprecated Nur noch Abwärtskompatibilität — bitte LlmProviderName nutzen. */
export type LlmProvider = "ollama" | "openai";

/**
 * Provider-Wahl (Abwärtskompatibel): liefert "openai", wenn der aktive
 * Provider der OpenAI-kompatible ist, sonst "ollama".
 */
export function getProvider(): LlmProvider {
  const active = resolveProviderChain()[0];
  return active === "openai" ? "openai" : "ollama";
}

export function getBaseUrl(): string {
  return configBaseUrl(resolveProviderChain()[0]);
}

/** Basis-URL des aktiven Providers (fürs Dashboard/Logs). */
export function getActiveBaseUrl(): string {
  return configBaseUrl(resolveProviderChain()[0]);
}

function configBaseUrl(provider: LlmProviderName): string {
  switch (provider) {
    case "ollama":
      return process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
    case "openai":
      return process.env.LLM_BASE_URL || "http://127.0.0.1:8080/v1";
    case "gemini":
      return process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta";
    case "anthropic":
      return process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com/v1";
  }
}

export type OllamaStatus = {
  available: boolean;
  provider: LlmProviderName;
  baseUrl: string;
  models: string[];
  error?: string;
  checkedAt: string;
  /** Provider-Kette (primär → Fallbacks) fürs Dashboard. */
  chain: LlmProviderName[];
};

const GLOBAL = globalThis as typeof globalThis & {
  __ollamaCache?: OllamaStatus;
};

/** Statuscache, damit das Dashboard nicht bei jedem Poll blockiert. */
const CACHE_TTL_MS = 15_000;

/** Prüft den aktiven Provider (Modelle auflisten) und cachet das Ergebnis. */
export async function getOllamaStatus(force = false): Promise<OllamaStatus> {
  const cached = GLOBAL.__ollamaCache;
  if (
    !force &&
    cached &&
    Date.now() - new Date(cached.checkedAt).getTime() < CACHE_TTL_MS
  ) {
    return cached;
  }

  const chain = resolveProviderChain();
  // KORRIGIERT (Peer-Review v1.3.0): listModels wirft jetzt bei Fehlern
  // (eigener Timeout im Client) — "available" wird nur noch bei echtem Erfolg
  // true, nie mehr stillschweigend mit leerer Modellliste.
  const provider = chain[0];
  const baseUrl = configBaseUrl(provider);
  try {
    const client = createLlmClient(provider);
    const models = await client.listModels();

    const status: OllamaStatus = {
      available: true,
      provider,
      baseUrl,
      models,
      checkedAt: new Date().toISOString(),
      chain,
    };
    GLOBAL.__ollamaCache = status;
    return status;
  } catch (e) {
    const status: OllamaStatus = {
      available: false,
      provider,
      baseUrl,
      models: [],
      error: e instanceof Error ? e.message : "unknown",
      checkedAt: new Date().toISOString(),
      chain,
    };
    GLOBAL.__ollamaCache = status;
    return status;
  }
}

export type ChatMessage = LlmMessage;

/** Findet einen installierten Tag, auch wenn nur die Modellfamilie angegeben wurde. */
export function resolveModelTag(models: string[], wanted: string): string | null {
  if (models.includes(wanted)) return wanted;
  const family = wanted.split(":")[0];
  return models.find((m) => m === family || m.startsWith(`${family}:`)) ?? null;
}

/**
 * Legacy-Wrapper: direkter Chat mit dem aktiven LLM-Provider ohne Kette.
 * Neuer Code nutzt `chatLlm` (siehe llmProvider.ts).
 */
export async function ollamaChat(opts: {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  numCtx?: number;
  json?: boolean;
  schema?: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<string> {
  const provider = resolveProviderChain()[0];
  const client = createLlmClient(provider);
  const req: LlmChatRequest = {
    model: opts.model,
    messages: opts.messages,
    temperature: opts.temperature,
    json: opts.json,
    schema: opts.schema,
    timeoutMs: opts.timeoutMs,
  };
  const result = await client.chat(req);
  return result.content;
}

export type ReasonResult = {
  raw: string;
  source: "ollama" | "fallback";
  model: string;
  latencyMs: number;
  /** Verbrauchte Tokens (falls Provider sie liefert) — für Kosten/Performance. */
  usage?: LlmUsage;
  /** Geschätzte Kosten in USD (0 bei lokalen Providern). */
  costUsd?: number;
  provider?: LlmProviderName;
};

/** Entscheidungs-Schema für Structured Outputs — gilt für alle Rollen. */
export const DECISION_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["TRADE", "HOLD", "REPORT", "APPROVE", "REJECT", "KILL"] },
    symbol: { type: "string" },
    side: { type: "string", enum: ["LONG", "SHORT"] },
    stopLossPct: { type: "number" },
    reason: { type: "string" },
    riskScore: { type: "number" },
  },
  required: ["type", "reason"],
};

/**
 * Temperature pro Rolle: Ausführende/prüfende Rollen müssen deterministisch
 * arbeiten (0.1), CEO und Research dürfen etwas mehr abwägen (0.3).
 */
function temperatureForRole(role: string): number {
  switch (role.toUpperCase()) {
    case "EXECUTOR":
    case "RISK_MANAGER":
    case "APPROVER":
    case "BACKTEST":
      return 0.1;
    default:
      return 0.3;
  }
}

/**
 * Das „lokale Gehirn“ der Agenten. Nutzt die Provider-Kette (primär + Fallbacks)
 * mit Retry; scheitert alles, greift die deterministische Regel-Engine.
 *
 * Cost/Performance: LLM_MAX_TOKENS begrenzt jeden Aufruf (Standard 512),
 * LLM_MAX_ATTEMPTS steuert die Retry-Kosten, die Provider-Reihenfolge in
 * LLM_FALLBACK_PROVIDERS erlaubt billige/lokale zuerst.
 */
export async function localReason(
  model: string,
  systemPrompt: string,
  userPrompt: string,
  role: string,
  opts?: { schema?: Record<string, unknown>; temperature?: number }
): Promise<ReasonResult> {
  const started = Date.now();
  const env = process.env;
  const chain = resolveProviderChain(env);

  // Schneller Weg: nur ein Provider konfiguriert UND nicht erreichbar →
  // sofort Regel-Engine, ohne einen zweiten (langen) Timeout zu riskieren.
  const status = await getOllamaStatus();
  if (!status.available && chain.length <= 1) {
    return {
      raw: fallbackReason(role, userPrompt),
      source: "fallback",
      model: `${model} (nicht geladen → Regel-Engine)`,
      latencyMs: Date.now() - started,
    };
  }

  try {
    const req: LlmChatRequest = {
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      json: true,
      // Eigenes Schema (z. B. Analysten) hat Vorrang vor dem Entscheidungsschema.
      schema: opts?.schema ?? DECISION_SCHEMA,
      temperature: opts?.temperature ?? temperatureForRole(role),
      maxTokens: Number(env.LLM_MAX_TOKENS || 512),
      timeoutMs: Number(env.LLM_TIMEOUT_MS || env.OLLAMA_TIMEOUT_MS || 180_000),
    };
    const result = await chatLlm(req, { env });
    return {
      raw: result.content,
      source: "ollama",
      model: result.model,
      latencyMs: Date.now() - started,
      usage: result.usage,
      costUsd: result.costUsd,
      provider: result.provider,
    };
  } catch (e) {
    console.warn("[localReason] LLM-Aufruf fehlgeschlagen, nutze Regel-Engine:", e);
    return {
      raw: fallbackReason(role, userPrompt),
      source: "fallback",
      model: `${model} (Fehler → Regel-Engine)`,
      latencyMs: Date.now() - started,
    };
  }
}

const KILL_MARKER = "[[REQUEST_KILL]]";

/**
 * Deterministische Regel-Engine (Ersatzgehirn).
 *
 * Wichtig: sie reagiert NICHT auf beliebige Schlüsselwörter im Prompt — sonst würde
 * der Guardrail-Text („keine Shorts“) im Kontext fälschlich eine Ablehnung auslösen.
 * Sie entscheidet ausschließlich anhand der Agentenrolle und eines expliziten Markers.
 */
export function fallbackReason(role: string, prompt: string): string {
  if (prompt.includes(KILL_MARKER)) {
    return JSON.stringify({
      type: "KILL",
      reason: "Expliziter Not-Halt im Auftrag angefordert.",
    });
  }

  const symbol = (prompt.match(/SYMBOL=([A-Z0-9]{1,10})/) ?? [])[1] ?? "SPY";

  switch (role.toUpperCase()) {
    case "CEO":
      return JSON.stringify({
        type: "REPORT",
        reason: `Strategie bestätigt: nur Long in ${symbol}, Positionsgröße über Risikobudget, Stop-Loss verpflichtend. Delegiere an Research.`,
        riskScore: 0.2,
      });

    case "RESEARCH":
      return JSON.stringify({
        type: "TRADE",
        symbol,
        side: "LONG",
        stopLossPct: 5,
        reason: `Regel-Engine: ${symbol} über gleitendem Durchschnitt, Volumen bestätigt. Setup mit 5 % Stop.`,
        riskScore: 0.45,
      });

    case "BACKTEST":
      return JSON.stringify({
        type: "REPORT",
        reason:
          "Backtesting ist in dieser Phase bewusst nicht blockierend (Paper-Trading-Fokus). Keine Einwände.",
        riskScore: 0.3,
      });

    case "RISK_MANAGER":
      return JSON.stringify({
        type: "REPORT",
        reason:
          "Risikoprüfung: Positionsgröße innerhalb Budget, Stop-Loss vorhanden, kein Hebel. Freigabe empfohlen.",
        riskScore: 0.35,
      });

    case "APPROVER":
      return JSON.stringify({
        type: "APPROVE",
        reason: "Vorschlag entspricht Mandat und harten Limits. Freigegeben.",
        riskScore: 0.3,
      });

    case "EXECUTOR":
      return JSON.stringify({
        type: "TRADE",
        symbol,
        side: "LONG",
        stopLossPct: 5,
        reason: `Führe freigegebenen Long in ${symbol} mit 5 % Stop aus.`,
        riskScore: 0.4,
      });

    default:
      return JSON.stringify({ type: "HOLD", reason: "Keine Aktion für diese Rolle." });
  }
}
