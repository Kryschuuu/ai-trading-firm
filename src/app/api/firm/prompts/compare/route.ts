/**
 * GET /api/firm/prompts/compare — Baseline vs Candidate (RMA-P3-02, v1.65.0)
 *
 * Fairer Vergleich: beide Versionen mit identischen Segmentfiltern
 * (agentRole, horizonId, entityId, regime, fromAsOf, toAsOf, minSample,
 * limit). Ungleiche Filterung wird als MISMATCHED_FILTERS verworfen.
 * Jede Seite trägt Coverage/Abstention/Stichprobe — unaufgelöste Forecasts
 * zählen nie als Gewinn/Verlust (void/pending ausgeschlossen).
 *
 * Promotion nur als Empfehlung hinter Human-Gate (`gateRequired: human-review`):
 * eine schlechter kalibrierte Variante darf nicht allein wegen PnLs bevorzugt
 * werden (ECE-Wächter ±0.02). Bei knapper Stichprobe: INSUFFICIENT_EVIDENCE
 * statt stiller Empfehlung.
 *
 * Auth: firm.read (SEC-02). Bounded Queries (wie Forecast-Scores/List).
 */

import { NextResponse } from "next/server";

import { requirePermission } from "@/auth";
import { comparePromptVersions } from "@/promptPerformance/compare";
import { telemetry } from "@/lib/telemetry";
import { PromptPerfError } from "@/promptPerformance/types";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = requirePermission(req, "firm.read");
  if (denied) return denied;

  const url = new URL(req.url);
  const baselineRaw = url.searchParams.get("baseline") ?? url.searchParams.get("baselineVersion");
  const candidateRaw = url.searchParams.get("candidate") ?? url.searchParams.get("candidateVersion");
  const agentRole = url.searchParams.get("agentRole")?.trim() || url.searchParams.get("role")?.trim() || undefined;
  const horizonId = url.searchParams.get("horizonId")?.trim() || url.searchParams.get("horizon")?.trim() || undefined;
  const entityId = url.searchParams.get("entityId")?.trim() || undefined;
  const regime = url.searchParams.get("regime")?.trim() || undefined;
  const fromAsOf = url.searchParams.get("from")?.trim() || url.searchParams.get("fromAsOf")?.trim() || undefined;
  const toAsOf = url.searchParams.get("to")?.trim() || url.searchParams.get("toAsOf")?.trim() || undefined;
  const minSampleRaw = url.searchParams.get("minSample");
  const limitRaw = url.searchParams.get("limit");

  if (baselineRaw == null || candidateRaw == null) {
    telemetry.prompt.queries.inc({ result: "invalid" });
    return NextResponse.json({ ok: false as const, code: "MISSING_VERSIONS", error: "baseline und candidate (promptVersion) erforderlich" }, { status: 400 });
  }
  const baselineVersion = Number(baselineRaw);
  const candidateVersion = Number(candidateRaw);
  if (!Number.isFinite(baselineVersion) || baselineVersion < 0 || !Number.isInteger(baselineVersion) ||
      !Number.isFinite(candidateVersion) || candidateVersion < 0 || !Number.isInteger(candidateVersion)) {
    telemetry.prompt.queries.inc({ result: "invalid" });
    return NextResponse.json({ ok: false as const, code: "INVALID_VERSIONS", error: "baseline/candidate ungültig (Integer >=0)" }, { status: 400 });
  }
  if (baselineVersion === candidateVersion) {
    telemetry.prompt.queries.inc({ result: "invalid" });
    return NextResponse.json({ ok: false as const, code: "SAME_VERSION", error: "baseline und candidate dürfen nicht identisch sein" }, { status: 400 });
  }
  if (horizonId && !["4h", "24h", "72h"].includes(horizonId)) {
    telemetry.prompt.queries.inc({ result: "invalid" });
    return NextResponse.json({ ok: false as const, code: "INVALID_HORIZON", error: "horizonId ungültig" }, { status: 400 });
  }
  if (regime && !["NORMAL", "ELEVATED", "EXTREME", "PERSISTED", "UNKNOWN"].includes(regime)) {
    telemetry.prompt.queries.inc({ result: "invalid" });
    return NextResponse.json({ ok: false as const, code: "INVALID_REGIME", error: "regime ungültig" }, { status: 400 });
  }

  try {
    const report = await comparePromptVersions({
      baselineVersion: Math.trunc(baselineVersion),
      candidateVersion: Math.trunc(candidateVersion),
      agentRole,
      horizonId,
      entityId,
      regime,
      fromAsOf,
      toAsOf,
      minSample: minSampleRaw != null ? Number(minSampleRaw) : undefined,
      limit: limitRaw != null ? Number(limitRaw) : undefined,
    });
    telemetry.prompt.queries.inc({ result: report.recommendation.action === "INSUFFICIENT_EVIDENCE" ? "insufficient-sample" : "ok" });
    const res = NextResponse.json({
      ok: true as const,
      report,
      provenance: {
        identicalFilters: true,
        coverageReported: true,
        units: { latencyDelta: "ms", costDelta: "USD", brierDelta: "[0,1]", eceDelta: "[0,1]" },
        warnings: report.warnings,
      },
      notes: [
        "Vergleich nutzt identische Filter für beide Versionen (Zeitraum/Horizont/Regime/Entity) — ungleiche Filter als Fehler, nicht still.",
        "PENDING-Forecasts (unaufgelöst) nie als Sieg/Niederlage gewertet; Coverage-Abweichung >15pp als Warnung.",
        "Promotion nur als Empfehlung hinter Human-Gate; ECE-Wächter (±0.02) blockt besser PnL allein nicht.",
      ],
    });
    res.headers.set("Cache-Control", "no-store");
    return res;
  } catch (e) {
    if (e instanceof PromptPerfError) {
      telemetry.prompt.queries.inc({ result: "invalid" });
      return NextResponse.json({ ok: false as const, code: e.code, error: e.message }, { status: 400 });
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
