/**
 * Forecast-Resolver — manueller Lauf (RMA-P3-01, v1.55.0).
 *
 *   POST /api/firm/forecasts/resolve   { "limit"?: 1..250 }
 *
 * Löst fällige Forecasts auf (dieselbe Logik wie der Scheduler-Job). Der Lauf
 * ist idempotent: identische Outcomes werden nicht doppelt geschrieben,
 * Wiederholungen setzen am Wasserstand auf. Bei `FORECAST_LEDGER_ENABLED=false`
 * antwortet der Endpunkt 503 mit Hinweis (Rollback-Pfad).
 *
 * Guard: `firm.write` (operative Aktion), kein Einfluss auf Risikopfade.
 */
import { NextResponse } from "next/server";

import { requirePermission } from "@/auth";
import { FORECAST_LIMITS } from "@/forecasts/types";
import { metricLabel, telemetry } from "@/lib/telemetry";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

export async function POST(req: Request) {
  const denied = requirePermission(req, "firm.write");
  if (denied) return denied;

  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const limitRaw = (body as Record<string, unknown>).limit;
  let limit: number | undefined;
  if (limitRaw !== undefined) {
    const parsed = Number(limitRaw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > FORECAST_LIMITS.resolverBatchLimit) {
      return NextResponse.json(
        { ok: false, error: "INVALID_LIMIT", message: `limit muss eine Ganzzahl in [1, ${FORECAST_LIMITS.resolverBatchLimit}] sein.` },
        { status: 400, headers: NO_STORE }
      );
    }
    limit = parsed;
  }

  try {
    const { runForecastResolverJob, forecastLedgerEnabled } = await import("@/forecasts/service");
    if (!forecastLedgerEnabled()) {
      return NextResponse.json(
        {
          ok: false,
          error: "FORECAST_LEDGER_DISABLED",
          message: "Forecast-Ledger ist deaktiviert (FORECAST_LEDGER_ENABLED=false).",
          hint: "Flag in der Umgebung setzen und Instanz neu starten (Rollback-Pfad, siehe docs/FORECASTS.md).",
        },
        { status: 503, headers: NO_STORE }
      );
    }
    const result = await runForecastResolverJob({ limit });
    if (result === null) {
      return NextResponse.json(
        {
          ok: false,
          error: "RESOLVER_BUSY",
          message: "Ein Resolver-Lauf ist bereits aktiv.",
          hint: "Abwarten und erneut versuchen — Läufe sind idempotent.",
        },
        { status: 409, headers: NO_STORE }
      );
    }
    return NextResponse.json(
      {
        ok: true,
        runId: result.runId,
        counts: result.counts,
        fed: result.fed,
        watermarkDeadline: result.watermarkDeadline?.toISOString() ?? null,
        lagMs: result.lagMs,
      },
      { headers: NO_STORE }
    );
  } catch (e) {
    const code =
      e instanceof Error && "code" in e && typeof (e as { code: unknown }).code === "string"
        ? (e as { code: string }).code
        : "RESOLVER_FAILED";
    telemetry.forecasts.runs.inc({ result: "failed", mode: metricLabel("API") });
    return NextResponse.json(
      {
        ok: false,
        error: code,
        message: e instanceof Error ? e.message : String(e),
        hint: "Datenbank/`DATABASE_URL` und Kerzen-Store prüfen; der Scheduler wiederholt den Lauf automatisch.",
      },
      { status: 503, headers: NO_STORE }
    );
  }
}
