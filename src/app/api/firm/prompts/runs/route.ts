/**
 * GET /api/firm/prompts/runs — Agent-Prompt-Lauf-Provenanz (RMA-P3-02, v1.65.0)
 *
 * Listet gefilterte LLM-Aufrufsprovenanzen (append-only Ledger) mit exakter
 * Prompt-Artefakt-Bindung. Jede Zeile enthält **genau ein** Artefakt (oder
 * UNKNOWN), Provider/Modell/Sampling, Zeitstempel, Tokenverbrauch, Kosten und
 * Erfolg. Geheimnisse/Rohtranskripte werden nie ausgeliefert. Bounded: limit
 * hart geklemmt, Paginierung via offset. Reihenfolge chronological (startedAt).
 *
 * Auth: firm.read (SEC-02). Einheiten klar: latencyMs = ms, Tokens = Anzahl,
 * costUsd = USD.
 */

import { NextResponse } from "next/server";

import { requirePermission } from "@/auth";
import { listRuns } from "@/promptPerformance/store";
import { telemetry } from "@/lib/telemetry";
import { PROMPT_PERF_LIMITS } from "@/promptPerformance/types";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = requirePermission(req, "firm.read");
  if (denied) return denied;

  const url = new URL(req.url);
  const role = url.searchParams.get("role")?.trim() || undefined;
  const promptVersionRaw = url.searchParams.get("promptVersion");
  const promptHash = url.searchParams.get("promptHash")?.trim() || undefined;
  const agentId = url.searchParams.get("agentId")?.trim() || undefined;
  const from = url.searchParams.get("from")?.trim() || undefined;
  const to = url.searchParams.get("to")?.trim() || undefined;
  const limit = url.searchParams.get("limit");
  const offset = url.searchParams.get("offset");

  let promptVersion: number | undefined;
  if (promptVersionRaw != null && promptVersionRaw !== "" && promptVersionRaw !== "UNKNOWN") {
    const v = Number(promptVersionRaw);
    if (!Number.isFinite(v) || v < 0) {
      telemetry.prompt.queries.inc({ result: "invalid" });
      return NextResponse.json({ ok: false as const, code: "INVALID_PROMPT_VERSION", error: "promptVersion ungültig" }, { status: 400 });
    }
    promptVersion = Math.trunc(v);
  } else if (promptVersionRaw === "UNKNOWN") {
    // UNKNOWN als expliziter Filter: nur historische Lücken
    // (store listet promptVersion IS NULL)
  }

  const parsedFrom = from ? new Date(from) : undefined;
  if (from && (!parsedFrom || Number.isNaN(parsedFrom.getTime()))) {
    telemetry.prompt.queries.inc({ result: "invalid" });
    return NextResponse.json({ ok: false as const, code: "INVALID_TIME_WINDOW", error: "`from` ungültig (ISO-8601 erwartet)" }, { status: 400 });
  }
  const parsedTo = to ? new Date(to) : undefined;
  if (to && (!parsedTo || Number.isNaN(parsedTo.getTime()))) {
    telemetry.prompt.queries.inc({ result: "invalid" });
    return NextResponse.json({ ok: false as const, code: "INVALID_TIME_WINDOW", error: "`to` ungültig" }, { status: 400 });
  }
  if (parsedFrom && parsedTo && parsedFrom.getTime() >= parsedTo.getTime()) {
    telemetry.prompt.queries.inc({ result: "invalid" });
    return NextResponse.json({ ok: false as const, code: "INVALID_TIME_WINDOW", error: "`from` muss vor `to` liegen" }, { status: 400 });
  }

  try {
    const res = await listRuns({
      role,
      promptVersion,
      promptHash,
      agentId,
      from: parsedFrom,
      to: parsedTo,
      limit: limit != null ? Number(limit) : undefined,
      offset: offset != null ? Number(offset) : undefined,
    });
    telemetry.prompt.queries.inc({ result: res.truncated ? "truncated" : "ok" });
    const items = res.runs.map((r: (typeof res.runs)[number]) => ({
      id: r.id,
      artifactId: r.artifactId,
      agentId: r.agentId,
      role: r.role,
      promptHash: r.promptHash,
      promptVersion: r.promptVersion,
      provider: r.provider,
      model: r.model,
      startedAt: r.startedAt.toISOString(),
      endedAt: r.endedAt.toISOString(),
      latencyMs: r.latencyMs, // Einheit: ms
      promptTokens: r.promptTokens,
      completionTokens: r.completionTokens,
      totalTokens: r.totalTokens,
      costUsd: r.costUsd != null ? Number(r.costUsd) : null, // Einheit: USD
      costStatus: r.costStatus,
      success: r.success,
      errorCode: r.errorCode,
      idempotencyKey: r.idempotencyKey,
    }));
    const out = NextResponse.json({
      ok: true as const,
      truncated: res.truncated,
      count: items.length,
      runs: items,
      units: { latency: "ms", tokens: "count", cost: "USD" },
      note: "Jede Zeile referenziert exakt ein Artefakt (oder UNKNOWN). Secrets/Rohtranskripte nie ausgeliefert.",
    });
    out.headers.set("Cache-Control", "no-store");
    if (res.truncated) out.headers.set("X-Truncated", "1");
    return out;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("DB") || msg.includes("does not exist") || msg.includes("relation")) {
      telemetry.prompt.queries.inc({ result: "unavailable" });
      return NextResponse.json({ ok: false as const, code: "PROMPT_LEDGER_UNAVAILABLE", error: msg.slice(0, 200) }, { status: 503 });
    }
    telemetry.prompt.queries.inc({ result: "error" });
    return NextResponse.json({ ok: false as const, error: msg.slice(0, 240) }, { status: 500 });
  }
}
