/**
 * Forecast-Score-Bericht (RMA-P3-01, v1.55.0).
 *
 *   GET /api/firm/forecasts/scores
 *     ?agent=TECHNICAL_ANALYST&promptVersion=3&horizon=4h&entity=PAPER:BTC
 *     &regime=NORMAL&from=…&to=…&minSample=5..1000&limit=1..20000
 *
 * Liefert Brier Score, Brier Skill Score (Referenz: Segment-Klimatologie),
 * Log Loss, Reliability Bins (Count, mittlere Prognose, beobachtete Rate,
 * Wilson-95-Intervall), Expected Calibration Error, Sample Count, Coverage
 * und Status-Gates — einmal als Gesamt-Aggregat (`overall`) und je Segment
 * (`segments`, deterministisch sortiert).
 *
 * Semantik:
 *   * ausschließlich RESOLVED-Zeilen gehen in Scores ein; VOID und PENDING
 *     zählen nie als 0 oder korrekt, aber in Coverage/Zähler,
 *   * Segmente unter `minSample` tragen `status: "insufficient-sample"` und
 *     dürfen keine Entscheidungen tragen,
 *   * `truncated: true` markiert laut, dass die Quelle das Limit erreichte.
 *
 * Formeln, Einheiten und Zeitsemantik: `docs/FORECASTS.md`.
 * SEC-02-Muster: `firm.read`, `no-store`, harte Mengenlimits.
 */
import { NextResponse } from "next/server";

import { requirePermission } from "@/auth";
import { ForecastReportError } from "@/forecasts/metrics";
import { ForecastLedgerError } from "@/forecasts/ledger";
import { isForecastHorizonId, FORECAST_LIMITS } from "@/forecasts/types";
import { metricLabel, telemetry } from "@/lib/telemetry";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

function badRequest(error: string, message: string): Response {
  telemetry.forecasts.queries.inc({ result: "invalid" });
  return NextResponse.json({ ok: false, error, message }, { status: 400, headers: NO_STORE });
}

export async function GET(req: Request) {
  const denied = requirePermission(req, "firm.read");
  if (denied) return denied;

  const url = new URL(req.url);
  const horizonRaw = url.searchParams.get("horizon");
  if (horizonRaw !== null && !isForecastHorizonId(horizonRaw)) {
    return badRequest("INVALID_HORIZON", `Unbekannter Horizont "${horizonRaw.slice(0, 24)}" (erlaubt: 4h, 24h, 72h).`);
  }

  const promptVersionRaw = url.searchParams.get("promptVersion");
  let promptVersion: number | undefined;
  if (promptVersionRaw !== null) {
    const parsed = Number(promptVersionRaw);
    if (!Number.isInteger(parsed) || parsed < 0) {
      return badRequest("INVALID_PROMPT_VERSION", "promptVersion muss eine nicht-negative Ganzzahl sein.");
    }
    promptVersion = parsed;
  }

  const minSampleRaw = url.searchParams.get("minSample");
  let minSample: number | undefined;
  if (minSampleRaw !== null) {
    const parsed = Number(minSampleRaw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1000) {
      return badRequest("INVALID_MIN_SAMPLE", "minSample muss eine Ganzzahl in [1, 1000] sein.");
    }
    minSample = parsed;
  }

  const limitRaw = url.searchParams.get("limit");
  let limit: number | undefined;
  if (limitRaw !== null) {
    const parsed = Number(limitRaw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > FORECAST_LIMITS.maxScoreForecasts) {
      return badRequest("INVALID_LIMIT", `limit muss eine Ganzzahl in [1, ${FORECAST_LIMITS.maxScoreForecasts}] sein.`);
    }
    limit = parsed;
  }

  const parseDate = (name: string): Date | undefined | { response: Response } => {
    const raw = url.searchParams.get(name);
    if (raw === null || raw.trim() === "") return undefined;
    const ms = Date.parse(raw);
    if (!Number.isFinite(ms)) {
      return { response: badRequest("INVALID_DATE", `Parameter "${name}" ist kein gültiges ISO-8601-Datum.`) };
    }
    return new Date(ms);
  };
  const from = parseDate("from");
  if (typeof from === "object" && from !== null && "response" in from) return from.response;
  const to = parseDate("to");
  if (typeof to === "object" && to !== null && "response" in to) return to.response;

  try {
    const { forecastScoreReport } = await import("@/forecasts/service");
    const report = await forecastScoreReport({
      agentRole: url.searchParams.get("agent") ?? undefined,
      promptVersion,
      horizonId: horizonRaw ?? undefined,
      entityId: url.searchParams.get("entity") ?? undefined,
      regime: url.searchParams.get("regime") ?? undefined,
      fromAsOf: from ?? undefined,
      toAsOf: to ?? undefined,
      minSample,
      limit,
    });
    return NextResponse.json({ ok: true, report }, { headers: NO_STORE });
  } catch (e) {
    if (e instanceof ForecastReportError && e.code === "report:too-many-segments") {
      telemetry.forecasts.queries.inc({ result: "invalid" });
      return NextResponse.json(
        { ok: false, error: "TOO_MANY_SEGMENTS", message: e.message, hint: "Zeitraum (from/to) oder Filter eingrenzen." },
        { status: 400, headers: NO_STORE }
      );
    }
    const code = e instanceof ForecastLedgerError ? e.code : "FORECAST_LEDGER_UNAVAILABLE";
    telemetry.forecasts.queries.inc({ result: "unavailable", reason: metricLabel(code) });
    return NextResponse.json(
      {
        ok: false,
        error: code,
        message: e instanceof Error ? e.message : String(e),
        hint: "Datenbank/`DATABASE_URL` prüfen (`psql \"$DATABASE_URL\" -f drizzle/2026-09-20_forecast_ledger.sql`).",
      },
      { status: 503, headers: NO_STORE }
    );
  }
}
