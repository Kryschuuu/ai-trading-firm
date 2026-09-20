/**
 * Forecast-Ledger — Liste (RMA-P3-01, v1.55.0).
 *
 *   GET /api/firm/forecasts
 *     ?agent=TECHNICAL_ANALYST&entity=PAPER:BTC&horizon=4h
 *     &regime=NORMAL&promptVersion=3&from=…&to=…&limit=1..200
 *
 * Liefert Forecasts mit Wirksstatus (PENDING/RESOLVED/VOID) und jüngster
 * Resolution — die Auswertung ist unabhängig vom Trade-Journal. Alle
 * Parameter sind bounded; `limit` ist hart auf 200 geklemmt (Default 50).
 * Das Erreichen des Quellenlimits wird als `truncated: true` laut markiert.
 *
 * SEC-02-Muster: `firm.read`, `no-store`, harte Mengenlimits.
 */
import { NextResponse } from "next/server";

import { requirePermission } from "@/auth";
import { ForecastLedgerError } from "@/forecasts/ledger";
import { forecastOperationsStatus } from "@/forecasts/service";
import { isForecastHorizonId, FORECAST_LIMITS } from "@/forecasts/types";
import { metricLabel, telemetry } from "@/lib/telemetry";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

function parseIso(value: string | null, field: string): { ok: true; date?: Date } | { ok: false; response: Response } {
  if (value === null || value.trim() === "") return { ok: true };
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    return {
      ok: false,
      response: NextResponse.json(
        { ok: false, error: "INVALID_DATE", message: `Parameter "${field}" ist kein gültiges ISO-8601-Datum.` },
        { status: 400, headers: NO_STORE }
      ),
    };
  }
  return { ok: true, date: new Date(ms) };
}

export async function GET(req: Request) {
  const denied = requirePermission(req, "firm.read");
  if (denied) return denied;

  const url = new URL(req.url);
  const horizonRaw = url.searchParams.get("horizon");
  if (horizonRaw !== null && !isForecastHorizonId(horizonRaw)) {
    telemetry.forecasts.queries.inc({ result: "invalid" });
    return NextResponse.json(
      { ok: false, error: "INVALID_HORIZON", message: `Unbekannter Horizont "${horizonRaw.slice(0, 24)}" (erlaubt: 4h, 24h, 72h).` },
      { status: 400, headers: NO_STORE }
    );
  }
  const promptVersionRaw = url.searchParams.get("promptVersion");
  let promptVersion: number | undefined;
  if (promptVersionRaw !== null) {
    const parsed = Number(promptVersionRaw);
    if (!Number.isInteger(parsed) || parsed < 0) {
      telemetry.forecasts.queries.inc({ result: "invalid" });
      return NextResponse.json(
        { ok: false, error: "INVALID_PROMPT_VERSION", message: "promptVersion muss eine nicht-negative Ganzzahl sein." },
        { status: 400, headers: NO_STORE }
      );
    }
    promptVersion = parsed;
  }
  const limitRaw = url.searchParams.get("limit");
  let limit: number = FORECAST_LIMITS.defaultListLimit;
  if (limitRaw !== null) {
    const parsed = Number(limitRaw);
    if (!Number.isInteger(parsed) || parsed < 1) {
      telemetry.forecasts.queries.inc({ result: "invalid" });
      return NextResponse.json(
        { ok: false, error: "INVALID_LIMIT", message: `limit muss eine Ganzzahl in [1, ${FORECAST_LIMITS.maxListLimit}] sein.` },
        { status: 400, headers: NO_STORE }
      );
    }
    limit = Math.min(FORECAST_LIMITS.maxListLimit, parsed);
  }
  const from = parseIso(url.searchParams.get("from"), "from");
  if (!from.ok) return from.response;
  const to = parseIso(url.searchParams.get("to"), "to");
  if (!to.ok) return to.response;

  try {
    const { forecastList } = await import("@/forecasts/service");
    const { rows, truncated } = await forecastList(
      {
        agentRole: url.searchParams.get("agent") ?? undefined,
        entityId: url.searchParams.get("entity") ?? undefined,
        horizonId: horizonRaw ?? undefined,
        regime: url.searchParams.get("regime") ?? undefined,
        promptVersion,
        fromAsOf: from.date,
        toAsOf: to.date,
      },
      limit
    );
    const operations = await forecastOperationsStatus();
    telemetry.forecasts.queries.inc({ result: truncated ? "truncated" : "ok" });
    return NextResponse.json(
      {
        ok: true,
        truncated,
        count: rows.length,
        operations: {
          enabled: operations.enabled,
          watermarkDeadline: operations.cursor?.watermarkDeadline.toISOString() ?? null,
          overdue: operations.overdue
            ? {
                forecastId: operations.overdue.forecastId,
                availabilityDeadline: operations.overdue.availabilityDeadline.toISOString(),
                lagMs: operations.overdue.lagMs,
              }
            : null,
        },
        forecasts: rows.map((row) => ({
          forecastId: row.forecastId,
          agentRole: row.contract.agentRole,
          promptVersion: row.contract.promptVersion,
          model: row.contract.model,
          entityId: row.contract.entityId,
          symbol: row.contract.symbol,
          targetKind: row.contract.targetKind,
          categories: row.contract.categories,
          probabilities: row.contract.probabilities,
          targetCategory: row.contract.targetCategory,
          horizonId: row.contract.horizonId,
          asOf: row.contract.asOf.toISOString(),
          referenceTime: row.contract.referenceTime.toISOString(),
          resolvesAt: row.contract.resolvesAt.toISOString(),
          availabilityDeadline: row.contract.availabilityDeadline.toISOString(),
          regime: row.contract.regime,
          policyVersion: row.contract.policyVersion,
          status: row.status,
          resolution:
            row.latestResolution === null
              ? null
              : {
                  resolutionVersion: row.latestResolution.resolutionVersion,
                  status: row.latestResolution.status,
                  outcomeLabel: row.latestResolution.outcome?.outcomeLabel ?? null,
                  outcomeBinary: row.latestResolution.outcome?.outcomeBinary ?? null,
                  voidReason: row.latestResolution.voidReason,
                  resolutionKind: row.latestResolution.resolutionKind,
                  resolvedAt: row.latestResolution.resolvedAt.toISOString(),
                  policyVersion: row.latestResolution.policyVersion,
                },
        })),
      },
      { headers: NO_STORE }
    );
  } catch (e) {
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
