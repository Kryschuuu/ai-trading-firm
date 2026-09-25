/**
 * Lauf-Provenanz-Helfer: exakt einmal je LLM-Aufruf (RMA-P3-02, v1.65.0)
 *
 * ── Ziel ─────────────────────────────────────────────────────────────────
 * Jeder Agentenaufruf referenziert **genau ein** Prompt-Artefakt
 * (role + version + hash). Die Provenanz enthält zusätzlich Provider/Modell,
 * Sampling-Parameter, Tool-/Schema-Version, Start/Ende, Tokenverbrauch und
 * Erfolg/Misserfolg — aber **nie** Geheimnisse, Roh-Transkripte oder
 * unbegrenzte Labels.
 *
 * ── Verwendung ────────────────────────────────────────────────────────────
 * Prototypischer Aufruf nach einem erledigten (oder gefallenen) Agentencall:
 *
 *   const artifact = await resolveArtifact(agentId, role, version, promptText);
 *   await emitAgentRun({
 *     agent: { id: agentId, role, version, promptText },
 *     llmResult: { provider, model, temperature, maxTokens, usage, cost, success },
 *     timing: { startedAt, endedAt, latencyMs },
 *   });
 *
 * Fehler im Store sind **nicht** geschäftsschädigend: die Entscheidung des
 * Agenten bleibt gültig, nur die Provenanz-Lücke wird sichtbar (fail-closed).
 */

import { createHash } from "node:crypto";

import { canonicalizePrompt, promptHash } from "./canonical";
import { ensurePromptArtifact, recordPromptRun, runIdempotencyKey } from "./store";
import { structuredLog } from "@/lib/logger";
import { redactSecrets } from "@/lib/secrets";

export type ProviderLabel =
  | "ollama"
  | "openai"
  | "gemini"
  | "anthropic"
  | "opencode"
  | "fallback"
  | "unknown";

const ALLOWED_PROVIDERS = new Set<string>([
  "ollama",
  "openai",
  "gemini",
  "anthropic",
  "opencode",
  "fallback",
  "unknown",
]);

function normalizeProvider(raw: string | undefined | null): ProviderLabel {
  const v = String(raw ?? "").trim().toLowerCase();
  if (ALLOWED_PROVIDERS.has(v)) return v as ProviderLabel;
  if (v === "" || v === "null" || v === "undefined") return "unknown";
  return "unknown";
}

/**
 * Totales Kosten-Signal aus einer LLM-Rückgabe.
 * Ollama (lokal) ⇒ free, OpenAI/Anthropic/Gemini ⇒ billed/unknown je Rückgabe.
 */
export function classifyCost(provider: string, costUsd: number | null | undefined): { costStatus: "billed"|"free"|"unknown"; costUsd: number | null } {
  const n = typeof costUsd === "number" && Number.isFinite(costUsd) ? costUsd : null;
  const p = normalizeProvider(provider);
  if (p === "ollama") return { costStatus: "free", costUsd: 0 };
  if (n == null) return { costStatus: "unknown", costUsd: null };
  if (n === 0) return { costStatus: "free", costUsd: 0 };
  return { costStatus: "billed", costUsd: n };
}

/**
 * Stellt sicher, dass ein Artefakt existiert — versucht es, aber wirft nicht,
 * wenn die DB gerade nicht erreichbar ist (Hot-Path darf nicht sterben).
 * Liefert `null`, wenn kein Artefakt hergestellt werden konnte (UNKNOWN-Fall);
 * der Run wird dann mit `UNKNOWN` markiert und die Lücke ist sichtbar.
 */
export async function resolveArtifactIdempotent(opts: {
  agentId: string | null;
  role: string;
  version: number | null | undefined;
  promptText: string;
}): Promise<{ artifactId: string | null; promptHash: string; version: number | null }> {
  const canonical = canonicalizePrompt(opts.promptText ?? "");
  const hash = canonical ? promptHash(canonical) : "UNKNOWN";
  const version = typeof opts.version === "number" && Number.isFinite(opts.version) && opts.version >= 0 ? Math.trunc(opts.version) : null;

  if (!canonical || hash === "UNKNOWN" || version == null || version < 1) {
    return { artifactId: null, promptHash: hash === "UNKNOWN" ? "UNKNOWN" : hash, version: null };
  }

  try {
    const { artifact } = await ensurePromptArtifact({
      agentId: opts.agentId,
      role: opts.role,
      version,
      promptText: opts.promptText,
    });
    return { artifactId: artifact.id, promptHash: artifact.promptHash, version: artifact.version };
  } catch (e) {
    structuredLog("warn", "prompt_provenance_artifact_failed", {
      agentId: opts.agentId,
      role: opts.role,
      version,
      reason: redactSecrets(e instanceof Error ? e.message : String(e)).slice(0, 200),
    });
    return { artifactId: null, promptHash: hash, version };
  }
}

/**
 * Emberfängt Provenanz genau einmal je LLM-Aufruf (idempotent).
 *
 * Alle Idempotenzschlüssel werden aus (promptHash, agentId, startedAt, model)
 * abgeleitet — ein Retry mit identischem startedAt schreibt keinen zweiten Run.
 *
 * **Nie** werden Secrets, Roh-Payloads oder unbegrenzte Labels gespeichert
 * (Whitelist: role/promptHash/provider/model/temperature/maxTokens/toolSchemaVersion).
 */
export async function emitAgentRun(opts: {
  artifact: { artifactId: string | null; promptHash: string; version: number | null };
  agent: { id: string | null; role: string };
  llm: {
    provider: string;
    model: string;
    temperature?: number | null;
    maxTokens?: number | null;
    toolSchemaVersion?: string | null;
    promptTokens?: number | null;
    completionTokens?: number | null;
    totalTokens?: number | null;
    costUsd?: number | null;
  };
  timing: { startedAt: Date; endedAt: Date; latencyMs: number };
  outcome: { success: boolean; errorCode?: string | null };
}): Promise<void> {
  const provider = normalizeProvider(opts.llm.provider);
  const model = String(opts.llm.model ?? "unknown").slice(0, 200) || "unknown";
  const role = String(opts.agent.role ?? "UNKNOWN").slice(0, 64);
  const promptHashVal = opts.artifact.promptHash === "UNKNOWN" ? "UNKNOWN" : String(opts.artifact.promptHash);
  const { costStatus, costUsd } = classifyCost(provider, opts.llm.costUsd ?? null);

  const startedAt = opts.timing.startedAt instanceof Date ? opts.timing.startedAt : new Date(opts.timing.startedAt);
  const endedAt = opts.timing.endedAt instanceof Date ? opts.timing.endedAt : new Date(opts.timing.endedAt);
  const latencyMs = Math.max(0, Math.trunc(Number(opts.timing.latencyMs) || (endedAt.getTime() - startedAt.getTime())));

  const idempotencyKey = opts.artifact.promptHash === "UNKNOWN"
    ? `pr1:${createHash("sha256").update(JSON.stringify({ ph: "UNKNOWN", aid: opts.agent.id ?? "null", ts: startedAt.toISOString(), model }), "utf8").digest("hex")}`
    : runIdempotencyKey({ promptHash: promptHashVal, agentId: opts.agent.id, startedAt, model });

  try {
    await recordPromptRun({
      artifactId: opts.artifact.artifactId,
      agentId: opts.agent.id,
      role,
      promptHash: promptHashVal,
      promptVersion: opts.artifact.version,
      provider,
      model,
      temperature: opts.llm.temperature ?? null,
      maxTokens: opts.llm.maxTokens ?? null,
      toolSchemaVersion: opts.llm.toolSchemaVersion ? String(opts.llm.toolSchemaVersion).slice(0, 32) : null,
      startedAt,
      endedAt,
      latencyMs,
      promptTokens: opts.llm.promptTokens ?? null,
      completionTokens: opts.llm.completionTokens ?? null,
      totalTokens: opts.llm.totalTokens ?? null,
      costUsd,
      costStatus,
      success: Boolean(opts.outcome.success),
      errorCode: opts.outcome.errorCode ? String(opts.outcome.errorCode).slice(0, 64) : null,
      idempotencyKey,
    });
  } catch (e) {
    structuredLog("warn", "prompt_provenance_run_failed", {
      agentId: opts.agent.id,
      role,
      promptHash: promptHashVal,
      provider,
      model,
      reason: redactSecrets(e instanceof Error ? e.message : String(e)).slice(0, 200),
    });
    // Provenanz darf niemals den Agentenlauf fehlschlagen lassen (fail-closed):
    // der Aufrufer hat seine Entscheidung bereits getroffen; die Lücke ist
    // sichtbar (fehlender Run), nicht versteckt.
  }
}
