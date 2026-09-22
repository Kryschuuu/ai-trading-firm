/**
 * GET /api/firm/prompts/metrics — Per-Version-Metriken (RMA-P3-02, v1.65.0)
 *
 * Eine Version je Aufruf: Forecast-Qualität (Brier, Brier Skill, LogLoss,
 * ECE, HitRate+Wilson, Reliability+Wilson, Brier-SE/95%-CI), Coverage/
 * Abstention, Attribution-PnL (P1.6), Laufzeit (Latenz/Tokens/Kosten).
 *
 * Units klar: latency avg/p50/p95 in ms, Tokens als Anzahl, cost in USD
 * (gebounded Abfragen — keine Instrument-IDs als Metriklabels).
 *
 * Query-Bounded: Forecasts ≤ 20 000, Runs ≤ 5 000 je Version; minSample
 * steuert `status: ok` vs `insufficient-sample`. Unaufgelöste (PENDING)
 * Forecasts zählen nie als Gewinn/Verlust (Coverage meldet sie). UNKNOWN:
 * historische Lücken sichtbar (UNKNOWN-Group).
 *
 * Auth: firm.read (SEC-02).
 */

import { NextResponse } from "next/server";

import { requirePermission } from "@/auth";
import { getPromptVersionMetrics } from "@/promptPerformance/metrics";
import { telemetry } from "@/lib/telemetry";
import { PromptPerfError } from "@/promptPerformance/types";

export const dynamic = "force-dynamic";

function jsonWithCache(body: unknown, status = 200, truncated = false) {
  const res = NextResponse.json(body, { status });
  res.headers.set("Cache-Control", "no-store");
  if (truncated) res.headers.set("X-Truncated", "1");
  return res;
}

export async function GET(req: Request) {
  const denied = requirePermission(req, "firm.read");
  if (denied) return denied;

  const url = new URL(req.url);
  const promptVersionRaw = url.searchParams.get("promptVersion");
  const agentRole = url.searchParams.get("agentRole")?.trim() || url.searchParams.get("role")?.trim() || undefined;
  const horizonId = url.searchParams.get("horizonId")?.trim() || url.searchParams.get("horizon")?.trim() || undefined;
  const entityId = url.searchParams.get("entityId")?.trim() || undefined;
  const regime = url.searchParams.get("regime")?.trim() || undefined;
  const fromAsOf = url.searchParams.get("from")?.trim() || url.searchParams.get("fromAsOf")?.trim() || undefined;
  const toAsOf = url.searchParams.get("to")?.trim() || url.searchParams.get("toAsOf")?.trim() || undefined;
  const minSampleRaw = url.searchParams.get("minSample");
  const limitRaw = url.searchParams.get("limit");

  let promptVersion: number | null | undefined;
  if (promptVersionRaw == null || promptVersionRaw === "") {
    telemetry.prompt.queries.inc({ result: "invalid" });
    return NextResponse.json({ ok: false as const, code: "INVALID_PROMPT_VERSION", error: "promptVersion fehlt (Zahl >=0 oder UNKNOWN)" }, { status: 400 });
  }
  if (promptVersionRaw === "UNKNOWN") {
    promptVersion = null;
  } else {
    const v = Number(promptVersionRaw);
    if (!Number.isFinite(v) || v < 0 || !Number.isInteger(v)) {
      telemetry.prompt.queries.inc({ result: "invalid" });
      return NextResponse.json({ ok: false as const, code: "INVALID_PROMPT_VERSION", error: "promptVersion ungültig" }, { status: 400 });
    }
    promptVersion = v;
  }

  if (horizonId && !["4h", "24h", "72h"].includes(horizonId)) {
    telemetry.prompt.queries.inc({ result: "invalid" });
    return NextResponse.json({ ok: false as const, code: "INVALID_HORIZON", error: "horizonId ungültig (4h|24h|72h)" }, { status: 400 });
  }
  if (regime && !["NORMAL", "ELEVATED", "EXTREME", "PERSISTED", "UNKNOWN"].includes(regime)) {
    telemetry.prompt.queries.inc({ result: "invalid" });
    return NextResponse.json({ ok: false as const, code: "INVALID_REGIME", error: "regime ungültig" }, { status: 400 });
  }

  try {
    const metrics = await getPromptVersionMetrics({
      promptVersion,
      agentRole,
      horizonId,
      entityId,
      regime,
      fromAsOf,
      toAsOf,
      minSample: minSampleRaw != null ? Number(minSampleRaw) : undefined,
      limit: limitRaw != null ? Number(limitRaw) : undefined,
    });
    telemetry.prompt.queries.inc({ result: metrics.forecastQuality.status === "ok" ? "ok" : "insufficient-sample" });
    return jsonWithCache({
      ok: true as const,
      metrics,
      units: { latency: "ms", tokens: "count", cost: "USD", brier: "[0,1] (kleiner=besser)", ece: "[0,1]", hitRate: "[0,1]" },
      notes: [
        "PENDING-Forecasts (unaufgelöst) zählen nie als Gewinn/Verlust; Coverage meldet den Anteil.",
        "Unbekannte Prompt-Versionen als UNKNOWN (nicht als 0) — historische Lücken sichtbar.",
        "Scores nur RESOLVED (VOID/PENDING ausgeschlossen); Reliability/ECE je Forecast-Horizont, Wilson 95 % für Trefferquote.",
        "Attributions-PnL nur bei verfügbarer Trade-Attribution (P1.6), sonst null — nie 0 geraten.",
      ],
    });
  } catch (e) {
    if (e instanceof PromptPerfError) {
      const code = e.code === "INVALID_TIME_WINDOW" ? 400 : 400;
      telemetry.prompt.queries.inc({ result: "invalid" });
      return NextResponse.json({ ok: false as const, code: e.code, error: e.message }, { status: code });
    }
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("DB") || msg.includes("does not exist") || msg.includes("relation")) {
      telemetry.prompt.queries.inc({ result: "unavailable" });
      return NextResponse.json({ ok: false as const, code: "PROMPT_LEDGER_UNAVAILABLE", error: msg.slice(0, 200) }, { status: 503 });
    }
    telemetry.prompt.queries.inc({ result: "error" });
    return NextResponse.json({ ok: false as const, error: msg.slice(0, 240) }, { status: 500 });
  }
}
