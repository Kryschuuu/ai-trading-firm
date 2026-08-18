/**
 * Lokaler LLM-Client für Ollama.
 *
 * Hält die KI-Schicht vollständig lokal und open source: keine Cloud, keine API-Keys,
 * kein Datenabfluss. Ist Ollama (oder das gewünschte Modell) nicht erreichbar, greift
 * eine deterministische Regel-Engine, damit die komplette Orchestrierungs- und
 * Guardrail-Pipeline auch ohne GPU/Modell nachvollziehbar bleibt.
 */

export type LlmProvider = "ollama" | "openai";

/**
 * Provider-Wahl:
 *   ollama  → nativer Ollama-Server (Standard, Variante A und B-CPU)
 *   openai  → jeder OpenAI-kompatible Endpunkt: llama.cpp `llama-server`,
 *             LM Studio, vLLM, LocalAI — nötig für die RX 480 per Vulkan,
 *             und zugleich der Weg für einen optionalen Cloud-Fallback.
 */
export function getProvider(): LlmProvider {
  return (process.env.LLM_PROVIDER || "ollama").toLowerCase() === "openai" ? "openai" : "ollama";
}

export function getBaseUrl(): string {
  if (getProvider() === "openai") {
    return process.env.LLM_BASE_URL || "http://127.0.0.1:8080/v1";
  }
  return process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
}

export type OllamaStatus = {
  available: boolean;
  provider: LlmProvider;
  baseUrl: string;
  models: string[];
  error?: string;
  checkedAt: string;
};

const GLOBAL = globalThis as typeof globalThis & {
  __ollamaCache?: OllamaStatus;
};

/** Statuscache, damit das Dashboard nicht bei jedem Poll blockiert. */
const CACHE_TTL_MS = 15_000;

export async function getOllamaStatus(force = false): Promise<OllamaStatus> {
  const cached = GLOBAL.__ollamaCache;
  if (
    !force &&
    cached &&
    Date.now() - new Date(cached.checkedAt).getTime() < CACHE_TTL_MS
  ) {
    return cached;
  }

  const provider = getProvider();
  const baseUrl = getBaseUrl();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    const url = provider === "openai" ? `${baseUrl}/models` : `${baseUrl}/api/tags`;
    const res = await fetch(url, {
      signal: ctrl.signal,
      cache: "no-store",
      headers: process.env.LLM_API_KEY
        ? { Authorization: `Bearer ${process.env.LLM_API_KEY}` }
        : undefined,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = (await res.json()) as {
      models?: { name: string }[];
      data?: { id: string }[];
    };
    const models =
      provider === "openai"
        ? (data.data ?? []).map((m) => m.id)
        : (data.models ?? []).map((m) => m.name);

    const status: OllamaStatus = {
      available: true,
      provider,
      baseUrl,
      models,
      checkedAt: new Date().toISOString(),
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
    };
    GLOBAL.__ollamaCache = status;
    return status;
  }
}

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

/** Findet einen installierten Tag, auch wenn nur die Modellfamilie angegeben wurde. */
export function resolveModelTag(models: string[], wanted: string): string | null {
  if (models.includes(wanted)) return wanted;
  const family = wanted.split(":")[0];
  return models.find((m) => m === family || m.startsWith(`${family}:`)) ?? null;
}

export async function ollamaChat(opts: {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  numCtx?: number;
  json?: boolean;
  timeoutMs?: number;
}): Promise<string> {
  const provider = getProvider();
  const baseUrl = getBaseUrl();
  const wantJson = opts.json !== false;

  const ctrl = new AbortController();
  const timer = setTimeout(
    () => ctrl.abort(),
    opts.timeoutMs ?? Number(process.env.LLM_TIMEOUT_MS || process.env.OLLAMA_TIMEOUT_MS || 180_000)
  );

  try {
    if (provider === "openai") {
      // llama.cpp `llama-server`, LM Studio, vLLM, LocalAI oder Cloud-Fallback.
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(process.env.LLM_API_KEY
            ? { Authorization: `Bearer ${process.env.LLM_API_KEY}` }
            : {}),
        },
        body: JSON.stringify({
          model: opts.model,
          messages: opts.messages,
          temperature: opts.temperature ?? 0.2,
          stream: false,
          ...(wantJson ? { response_format: { type: "json_object" } } : {}),
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`LLM chat failed: HTTP ${res.status}`);
      const data = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      return data.choices?.[0]?.message?.content ?? "";
    }

    const body: Record<string, unknown> = {
      model: opts.model,
      messages: opts.messages,
      stream: false,
      options: {
        temperature: opts.temperature ?? 0.2,
        num_ctx: opts.numCtx ?? Number(process.env.OLLAMA_NUM_CTX || 4096),
      },
    };
    // Erzwingt valides JSON — der wichtigste Zuverlässigkeitshebel bei kleinen Modellen.
    if (wantJson) body.format = "json";

    const res = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Ollama chat failed: HTTP ${res.status}`);
    const data = (await res.json()) as { message?: { content?: string } };
    return data.message?.content ?? "";
  } finally {
    clearTimeout(timer);
  }
}

export type ReasonResult = {
  raw: string;
  source: "ollama" | "fallback";
  model: string;
  latencyMs: number;
};

/**
 * Das „lokale Gehirn“ der Agenten. Nutzt Ollama wenn verfügbar, sonst die
 * deterministische Regel-Engine.
 */
export async function localReason(
  model: string,
  systemPrompt: string,
  userPrompt: string,
  role: string
): Promise<ReasonResult> {
  const started = Date.now();
  const status = await getOllamaStatus();

  // Bei OpenAI-kompatiblen Servern (llama.cpp/LM Studio) heißt das Modell oft anders
  // als der Ollama-Tag → explizites LLM_MODEL oder das erste angebotene Modell nutzen.
  const tag = !status.available
    ? null
    : status.provider === "openai"
      ? process.env.LLM_MODEL || resolveModelTag(status.models, model) || status.models[0] || model
      : resolveModelTag(status.models, model);

  if (!status.available || !tag) {
    return {
      raw: fallbackReason(role, userPrompt),
      source: "fallback",
      model: `${model} (nicht geladen → Regel-Engine)`,
      latencyMs: Date.now() - started,
    };
  }

  try {
    const raw = await ollamaChat({
      model: tag,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      json: true,
    });
    return { raw, source: "ollama", model: tag, latencyMs: Date.now() - started };
  } catch (e) {
    console.warn("[localReason] LLM-Aufruf fehlgeschlagen, nutze Regel-Engine:", e);
    return {
      raw: fallbackReason(role, userPrompt),
      source: "fallback",
      model: `${tag} (Fehler → Regel-Engine)`,
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
