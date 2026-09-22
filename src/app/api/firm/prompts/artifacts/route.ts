/**
 * GET /api/firm/prompts/artifacts — Prompt-Artefakte (RMA-P3-02, v1.65.0)
 *
 * Listet immutable Prompt-Versionen (append-only Ledger) je Agent/Rolle.
 * Antwort enthält nie Prompt-Inhalte selbst, nur Metadaten (Hash, Rolle,
 * Version, created_at) — Prompt-Text nur über berechtigten Artefakt-Detail-
 * Pfad zugänglich (nie als Metriklabel). Bounded: limit hart geklemmt.
 *
 * Auth: firm.read (SEC-02, wie Forecast-Scores/List).
 */

import { NextResponse } from "next/server";

import { requirePermission } from "@/auth";
import { listArtifacts } from "@/promptPerformance/store";
import { telemetry } from "@/lib/telemetry";
import { PROMPT_PERF_LIMITS } from "@/promptPerformance/types";

export const dynamic = "force-dynamic";

function jsonWithCache(body: unknown, truncated: boolean) {
  const res = NextResponse.json(body);
  res.headers.set("Cache-Control", "no-store");
  if (truncated) res.headers.set("X-Truncated", "1");
  return res;
}

export async function GET(req: Request) {
  const denied = requirePermission(req, "firm.read");
  if (denied) return denied;

  const url = new URL(req.url);
  const agentId = url.searchParams.get("agentId")?.trim() || undefined;
  const role = url.searchParams.get("role")?.trim() || undefined;
  const limitRaw = url.searchParams.get("limit");
  const offsetRaw = url.searchParams.get("offset");

  const limit = (() => {
    const n = limitRaw != null ? Number(limitRaw) : PROMPT_PERF_LIMITS.defaultListLimit;
    if (!Number.isFinite(n)) return PROMPT_PERF_LIMITS.defaultListLimit;
    return Math.min(PROMPT_PERF_LIMITS.maxListLimit, Math.max(1, Math.trunc(n)));
  })();
  const offset = (() => {
    const n = offsetRaw != null ? Number(offsetRaw) : 0;
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.trunc(n));
  })();

  try {
    const { artifacts, truncated } = await listArtifacts({ agentId, role, limit, offset });
    telemetry.prompt.queries.inc({ result: truncated ? "truncated" : "ok" });
    // Prompt-Text wird in der Liste NIE ausgeliefert — nur Metadaten (bounded).
    const items = artifacts.map((a: (typeof artifacts)[number]) => ({
      id: a.id,
      agentId: a.agentId,
      role: a.role,
      version: a.version,
      promptHash: a.promptHash,
      templateSchemaVersion: a.templateSchemaVersion,
      createdAt: a.createdAt.toISOString(),
    }));
    return jsonWithCache(
      {
        ok: true as const,
        truncated,
        limit,
        offset,
        count: items.length,
        artifacts: items,
        note:
          "Prompt-Text nur über autorisierten Detail-Pfad abrufbar; Metriken verwenden ausschließlich bounded Labels (Rolle/Hash), nie Prompt-/Instrument-IDs.",
      },
      truncated
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("DB") || msg.includes("does not exist") || msg.includes("relation")) {
      telemetry.prompt.queries.inc({ result: "unavailable" });
      return NextResponse.json({ ok: false as const, code: "PROMPT_LEDGER_UNAVAILABLE", error: msg.slice(0, 200), hint: "`npx drizzle-kit push` bzw. psql drizzle/2026-09-22_prompt_performance.sql ausführen." }, { status: 503 });
    }
    telemetry.prompt.queries.inc({ result: "error" });
    return NextResponse.json({ ok: false as const, error: msg.slice(0, 240) }, { status: 500 });
  }
}
