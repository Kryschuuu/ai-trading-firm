/**
 * Persistenz für Prompt-Artefakte & Runs (RMA-P3-02, v1.65.0)
 *
 * ── Verträge ───────────────────────────────────────────────────────────────
 * * Append-only: Artefakte werden nur eingefügt, nie aktualisiert/gelöscht.
 *   Ein Prompt-Update erzeugt eine neue Version (id = agentId+version); ein
 *   Retry mit identischem Inhalt liefert das bestehende Artefakt zurück
 *   (Idempotenz via hash).
 * * Fail-closed: Schreibfehler werfen keinen Callstack-Prozessfehler —
 *   die aufrufende Hot-Path-Prosedur fängt sie und loggt sie, ohne den
 *   Geschäftsvorgang zu verwerfen.
 * * Keine Secrets: kanonischer Prompttext wird gespeichert, aber nie in
 *   Metriken/Labels/Logs emitiert; keine API-Keys, keine Rohtranskripte.
 * * Bounded queries: alle Listen sind limitiert, Paginierung über `limit`
 *   + `offset`, keine unbeschränkten Scans.
 */

import { eq, and, sql, desc, asc } from "drizzle-orm";
import { createHash } from "node:crypto";

import { getDb } from "@/db";
import { promptArtifacts, agentPromptRuns } from "@/db/schema";
import {
  canonicalizePrompt,
  promptHash,
  PROMPT_TEMPLATE_SCHEMA_VERSION,
} from "./canonical";
import { PromptPerfError, PROMPT_PERF_LIMITS } from "./types";
import { structuredLog } from "@/lib/logger";
import { telemetry } from "@/lib/telemetry";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Bounded limit (wie Forecast-Scores: Default 50, hartes Max 200). */
export function clampLimit(value: unknown, def = PROMPT_PERF_LIMITS.defaultListLimit): number {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  if (!Number.isFinite(n)) return def;
  return Math.min(PROMPT_PERF_LIMITS.maxListLimit, Math.max(1, Math.trunc(n)));
}

function clampPromptText(raw: string): string {
  const canon = canonicalizePrompt(raw ?? "");
  if (canon.length > PROMPT_PERF_LIMITS.maxPromptTextLength) {
    return canon.slice(0, PROMPT_PERF_LIMITS.maxPromptTextLength);
  }
  return canon;
}

function artifactIdempotencyKey(agentId: string | null, canonical: string, version: number): string {
  // Nicht in DB persistiert — nur für Logging/Debug deterministisch.
  return createHash("sha256").update(`${agentId ?? "null"}:${version}:${canonical}`, "utf8").digest("hex").slice(0, 16);
}

function successKey(success: boolean): string {
  return success ? "ok" : "error";
}

// ── Artefakte ─────────────────────────────────────────────────────────────

/**
 * Stellt sicher, dass ein Artefakt für (agentId, version, promptText) existiert.
 * Idempotent: liefert bestehendes Artefakt bei gleichem agentId+version oder
 * agentId+hash zurück. Neue Versionen werden atomar eingefügt.
 *
 * @throws {PromptPerfError} bei ungültigen Eingaben (fail-closed nutzt Code, nicht HTTP)
 */
export async function ensurePromptArtifact(opts: {
  agentId: string | null;
  role: string;
  version: number;
  promptText: string;
  templateSchemaVersion?: string;
}): Promise<{ artifact: typeof promptArtifacts.$inferSelect; created: boolean }> {
  if (process.env.PROMPT_PERFORMANCE_ENABLED === "false") {
    throw new PromptPerfError("DISABLED", "Prompt-Performance-Ledger deaktiviert (PROMPT_PERFORMANCE_ENABLED=false)");
  }
  const role = String(opts.role ?? "").trim();
  if (!role) throw new PromptPerfError("INVALID_ROLE", "role fehlt oder leer");
  if (!Number.isFinite(opts.version) || opts.version < 1) throw new PromptPerfError("INVALID_VERSION", "version muss >=1 sein");
  const version = Math.trunc(opts.version);
  const templateSchemaVersion = String(opts.templateSchemaVersion ?? PROMPT_TEMPLATE_SCHEMA_VERSION).slice(0, 16);
  const canonical = clampPromptText(opts.promptText ?? "");
  if (!canonical) throw new PromptPerfError("INVALID_PROMPT", "promptText fehlt oder leer");
  const hash = promptHash(canonical);

  let db: ReturnType<typeof getDb>;
  try {
    db = getDb();
  } catch {
    throw new PromptPerfError("DB_UNAVAILABLE", "Datenbank nicht verfügbar");
  }

  // 1) Exaktes Match agent+version vorhanden? → return
  try {
    const existingByVersion = await db
      .select()
      .from(promptArtifacts)
      .where(
        opts.agentId
          ? and(eq(promptArtifacts.agentId, opts.agentId), eq(promptArtifacts.version, version))
          : sql`false`
      )
      .limit(1);
    if (existingByVersion.length > 0) {
      const row = existingByVersion[0]!;
      // Wenn der Hash derselbe ist, ist es die gleiche Version (Idempotenz);
      // wenn er abweicht, hat der Aufrufer eine Versionszahl wiederverwendet —
      // das verhindern wir: bereits bestehende Versionszahl ist immutable.
      if (row.promptHash !== hash) {
        // Fail-closed: nicht still überschreiben, Fehler sichtbar machen.
        throw new PromptPerfError(
          "VERSION_CONFLICT",
          `Artefakt v${version} existiert bereits mit anderem Hash (immutable)`,
          { existingHash: row.promptHash, incomingHash: hash }
        );
      }
      return { artifact: row, created: false };
    }

    // 2) Gleicher agent+hash vorhanden (andere Version)? → darf nicht doppelt existieren (unique index), aber
    // ein Retry mit gleicher Version würde oben schon abgefangen. Wenn ein anderer Versionseintrag denselben Inhalt hat,
    // ist das ein Programmierfehler (Version wurde nicht erhöht) — wir geben das bestehende Artefakt zurück ohne doppelte Zeile.
    if (opts.agentId) {
      const existingByHash = await db
        .select()
        .from(promptArtifacts)
        .where(and(eq(promptArtifacts.agentId, opts.agentId), eq(promptArtifacts.promptHash, hash)))
        .limit(1);
      if (existingByHash.length > 0) {
        // Hinweis: unterschiedliche Version, gleicher Inhalt — nur loggen, nicht als Fehler werfen (Restart-Fall)
        structuredLog("warn", "prompt_artifact_duplicate_content", {
          agentId: opts.agentId,
          incomingVersion: version,
          existingVersion: existingByHash[0]!.version,
        });
        try { telemetry.prompt.artifacts.inc({ result: "duplicate" }); } catch { /* ignore */ }
        return { artifact: existingByHash[0]!, created: false };
      }
    }
  } catch (e) {
    if (e instanceof PromptPerfError) throw e;
    // Lesepfad-Fehler: weiter zum Insert-Versuch, aber loggen
    structuredLog("warn", "prompt_artifact_read_failed", { agentId: opts.agentId, version });
  }

  // 3) Neu einfügen (append-only)
  try {
    const [row] = await db
      .insert(promptArtifacts)
      .values({
        agentId: opts.agentId,
        role,
        version,
        promptHash: hash,
        canonicalPrompt: canonical,
        templateSchemaVersion,
      })
      .returning();
    if (!row) throw new PromptPerfError("DB_INSERT_FAILED", "Artefakt-Insert lieferte keine Zeile");
    structuredLog("info", "prompt_artifact_created", {
      agentId: opts.agentId,
      role,
      version,
      hash,
      key: artifactIdempotencyKey(opts.agentId, canonical, version),
    });
    try { telemetry.prompt.artifacts.inc({ result: "created" }); } catch { /* telemetry optional */ }
    return { artifact: row, created: true };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    // Unique-Verletzung → konkurrierender Insert, einmal erneut lesen.
    if (msg.includes("duplicate") || msg.includes("unique") || (e as { code?: string })?.code === "23505") {
      try {
        const retry = await db
          .select()
          .from(promptArtifacts)
          .where(opts.agentId ? and(eq(promptArtifacts.agentId, opts.agentId), eq(promptArtifacts.promptHash, hash)) : eq(promptArtifacts.promptHash, hash))
          .limit(1);
        if (retry.length > 0) return { artifact: retry[0]!, created: false };
        const byVer = await db
          .select()
          .from(promptArtifacts)
          .where(opts.agentId ? and(eq(promptArtifacts.agentId, opts.agentId), eq(promptArtifacts.version, version)) : sql`false`)
          .limit(1);
        if (byVer.length > 0) return { artifact: byVer[0]!, created: false };
      } catch {
        // fallthrough
      }
    }
    if (e instanceof PromptPerfError) throw e;
    throw new PromptPerfError("DB_WRITE_FAILED", `Artefakt-Insert fehlgeschlagen: ${msg.slice(0, 200)}`);
  }
}

/**
 * Lädt ein Artefakt je Hash (+ optionaler Agent-Bindung).
 */
export async function getArtifactByHash(promptHashValue: string, agentId?: string | null) {
  if (!promptHashValue || !promptHashValue.match(/^pp1:[0-9a-f]{64}$/)) return null;
  try {
    const db = getDb();
    const rows = await db
      .select()
      .from(promptArtifacts)
      .where(
        agentId ? and(eq(promptArtifacts.promptHash, promptHashValue), eq(promptArtifacts.agentId, agentId)) : eq(promptArtifacts.promptHash, promptHashValue)
      )
      .limit(1);
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Listet Artefakte eines Agenten / einer Rolle (bounded, paginiert).
 */
export async function listArtifacts(opts: { agentId?: string; role?: string; limit?: number; offset?: number }) {
  const db = getDb();
  const limit = clampLimit(opts.limit);
  const offset = Math.max(0, Math.trunc(Number(opts.offset ?? 0) || 0));
  const conditions: ReturnType<typeof eq>[] = [];
  if (opts.agentId) conditions.push(eq(promptArtifacts.agentId, opts.agentId));
  if (opts.role) conditions.push(eq(promptArtifacts.role, opts.role));
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const rows = await db
    .select()
    .from(promptArtifacts)
    .where(where)
    .orderBy(desc(promptArtifacts.version))
    .limit(limit + 1)
    .offset(offset);
  const truncated = rows.length > limit;
  return { artifacts: truncated ? rows.slice(0, limit) : rows, truncated, limit, offset };
}

// ── Runs ───────────────────────────────────────────────────────────────────

/**
 * Persistiert einen Agenten-Run-Provenanz-Datensatz.
 *
 * Idempotent über `idempotencyKey` (`pr1:<sha256>`). Retries/Restarts desselben
 * Aufrufs werden coalesced (bestehender Run zurückgeliefert, kein zweiter Insert).
 *
 * Geheimnisse werden nie gespeichert: `temperature`/`maxTokens`/`toolSchemaVersion`
 * sind die einzigen Parameter — keine API-Keys, keine Authorization-Header,
 * keine Roh-Transkripte.
 */
export async function recordPromptRun(opts: {
  artifactId: string | null;
  agentId: string | null;
  role: string;
  promptHash: string;
  promptVersion: number | null;
  provider: string;
  model: string;
  temperature?: number | null;
  maxTokens?: number | null;
  toolSchemaVersion?: string | null;
  startedAt: Date;
  endedAt: Date;
  latencyMs: number;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  costUsd?: number | null;
  costStatus?: string;
  success: boolean;
  errorCode?: string | null;
  idempotencyKey: string;
}): Promise<{ run: typeof agentPromptRuns.$inferSelect; created: boolean }> {
  if (process.env.PROMPT_PERFORMANCE_ENABLED === "false") {
    throw new PromptPerfError("DISABLED", "Prompt-Performance-Ledger deaktiviert");
  }
  // Bounded-Label-Wächter
  const allowedProviders = new Set(["ollama", "openai", "gemini", "anthropic", "fallback", "unknown"]);
  const provider = allowedProviders.has(opts.provider) ? opts.provider : "unknown";
  const model = String(opts.model ?? "").slice(0, 200) || "unknown";
  const promptHashVal = opts.promptHash === "UNKNOWN" ? "UNKNOWN" : String(opts.promptHash ?? "").slice(0, 80);
  if (promptHashVal !== "UNKNOWN" && !promptHashVal.match(/^pp1:[0-9a-f]{64}$/)) {
    throw new PromptPerfError("INVALID_HASH", `promptHash ungültig: ${promptHashVal.slice(0, 20)}`);
  }
  if (!opts.idempotencyKey || !opts.idempotencyKey.match(/^pr1:[0-9a-f]{64}$/)) {
    throw new PromptPerfError("INVALID_IDEMPOTENCY_KEY", "idempotencyKey muss pr1:<sha256> sein");
  }

  const db = getDb();

  // Idempotenz-Vorabprüfung
  try {
    const existing = await db
      .select()
      .from(agentPromptRuns)
      .where(eq(agentPromptRuns.idempotencyKey, opts.idempotencyKey))
      .limit(1);
    if (existing.length > 0) return { run: existing[0]!, created: false };
  } catch {
    // Lesefehler → Insert-Versuch trotzdem
  }

  const latencyMs = Math.max(0, Math.trunc(Number(opts.latencyMs) || 0));
  const costStatus: string = ["billed", "free", "unknown"].includes(String(opts.costStatus)) ? String(opts.costStatus) : "unknown";

  try {
    const [row] = await db
      .insert(agentPromptRuns)
      .values({
        artifactId: opts.artifactId,
        agentId: opts.agentId,
        role: opts.role,
        promptHash: promptHashVal,
        promptVersion: opts.promptVersion,
        provider,
        model,
        temperature: opts.temperature != null ? String(opts.temperature) : null,
        maxTokens: opts.maxTokens != null ? Math.trunc(opts.maxTokens) : null,
        toolSchemaVersion: opts.toolSchemaVersion ? String(opts.toolSchemaVersion).slice(0, 32) : null,
        startedAt: opts.startedAt,
        endedAt: opts.endedAt,
        latencyMs,
        promptTokens: opts.promptTokens != null ? Math.trunc(opts.promptTokens) : null,
        completionTokens: opts.completionTokens != null ? Math.trunc(opts.completionTokens) : null,
        totalTokens: opts.totalTokens != null ? Math.trunc(opts.totalTokens) : null,
        costUsd: opts.costUsd != null ? String(opts.costUsd) : null,
        costStatus,
        success: opts.success,
        errorCode: opts.errorCode ? String(opts.errorCode).slice(0, 64) : null,
        idempotencyKey: opts.idempotencyKey,
      })
      .returning();
    if (!row) throw new PromptPerfError("DB_INSERT_FAILED", "Run-Insert lieferte keine Zeile");
    try { telemetry.prompt.runs.inc({ result: successKey(opts.success), provider }); } catch { /* ignore */ }
    return { run: row, created: true };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("duplicate") || msg.includes("unique") || (e as { code?: string })?.code === "23505") {
      const retry = await db.select().from(agentPromptRuns).where(eq(agentPromptRuns.idempotencyKey, opts.idempotencyKey)).limit(1);
      if (retry.length > 0) return { run: retry[0]!, created: false };
    }
    if (e instanceof PromptPerfError) throw e;
    throw new PromptPerfError("DB_WRITE_FAILED", `Run-Insert fehlgeschlagen: ${msg.slice(0, 200)}`);
  }
}

/**
 * Bounded Abfrage der Runs (für Metriken/Diagnose). Limit hart geklemmt.
 */
export async function listRuns(opts: {
  role?: string;
  promptVersion?: number;
  promptHash?: string;
  agentId?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
}) {
  const db = getDb();
  const limit = Math.min(PROMPT_PERF_LIMITS.maxRunsPerQuery, clampLimit(opts.limit, 50));
  const offset = Math.max(0, Math.trunc(Number(opts.offset ?? 0) || 0));
  const predicates: ReturnType<typeof eq>[] = [];
  if (opts.role) predicates.push(eq(agentPromptRuns.role, opts.role));
  if (opts.promptVersion != null) predicates.push(eq(agentPromptRuns.promptVersion, opts.promptVersion));
  else if (opts.promptHash) predicates.push(eq(agentPromptRuns.promptHash, opts.promptHash));
  if (opts.agentId) predicates.push(eq(agentPromptRuns.agentId, opts.agentId));
  if (opts.from) predicates.push(sql`${agentPromptRuns.startedAt} >= ${opts.from.toISOString()}::timestamptz` as unknown as ReturnType<typeof eq>);
  if (opts.to) predicates.push(sql`${agentPromptRuns.startedAt} < ${opts.to.toISOString()}::timestamptz` as unknown as ReturnType<typeof eq>);
  const where = predicates.length > 0 ? and(...predicates) : undefined;
  const rows = await db
    .select()
    .from(agentPromptRuns)
    .where(where)
    .orderBy(asc(agentPromptRuns.startedAt))
    .limit(limit + 1)
    .offset(offset);
  const truncated = rows.length > limit;
  return { runs: truncated ? rows.slice(0, limit) : rows, truncated };
}

/**
 * Erzeugt einen stabilen Idempotenz-Schlüssel `pr1:<sha256>` für einen Run.
 *
 * Eingaben: promptHash + agentId + startedAt (ms) + Modell + Versuchszähler.
 * Der Schlüssel ist stabil für Retries desselben Aufrufs (gleicher startedAt,
 * gleicher Versuch), aber unterschiedlich für getrennte Aufrufe.
 */
export function runIdempotencyKey(opts: {
  promptHash: string;
  agentId: string | null;
  startedAt: Date;
  model: string;
  attempt?: number;
}): string {
  const payload = JSON.stringify({
    ph: opts.promptHash,
    aid: opts.agentId ?? "null",
    ts: opts.startedAt.toISOString(),
    model: opts.model ?? "unknown",
    att: opts.attempt ?? 0,
  });
  const hex = createHash("sha256").update(payload, "utf8").digest("hex");
  return `pr1:${hex}`;
}
