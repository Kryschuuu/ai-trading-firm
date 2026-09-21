/**
 * Trade-PnL-Attribution — dimensionale Aggregation (RMA-P1-06, v1.57.0).
 *
 *   GET /api/firm/journal/attributions/aggregate
 *     ?dimension=agent|rule|regime|cost&from=…&to=…&regime=…&methodVersion=1
 *
 * Aggregiert Beiträge über den Zeitraum (Ereigniszeit `closed_at`): nach
 * Agent (AGENT-Posten), Regel (RULE-Posten), Regime (Kopf) oder Kostenart
 * (COST-Posten). Liefert IMMER: Gruppen mit Beiträgen und Trade-Zahlen,
 * Totals, Coverage gegen die geschlossenen Journal-Zeilen desselben
 * Zeitraums sowie die serverseitig geprüfte Reconciliation
 * (Σ Quellen + Σ Kosten + Σ Residual = Σ Netto, Δ ≤ 1e-6).
 *
 * SEC-02-Muster: `firm.read`, `no-store`. Reines Lesen.
 */
import { NextResponse } from "next/server";

import { requirePermission } from "@/auth";
import {
  ATTRIBUTION_DIMENSIONS,
  aggregateTradeAttributions,
  type AttributionDimension,
  type AttributionFilter,
} from "@/attribution/store";
import { telemetry } from "@/lib/telemetry";

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
  const dimensionRaw = url.searchParams.get("dimension") ?? "agent";
  if (!(ATTRIBUTION_DIMENSIONS as readonly string[]).includes(dimensionRaw)) {
    telemetry.attribution.queries.inc({ result: "invalid" });
    return NextResponse.json(
      {
        ok: false,
        error: "INVALID_DIMENSION",
        message: `dimension muss eine von ${ATTRIBUTION_DIMENSIONS.join(", ")} sein.`,
      },
      { status: 400, headers: NO_STORE }
    );
  }
  const dimension = dimensionRaw as AttributionDimension;

  const methodVersionRaw = url.searchParams.get("methodVersion");
  let methodVersion: number | undefined;
  if (methodVersionRaw !== null) {
    const parsed = Number(methodVersionRaw);
    if (!Number.isInteger(parsed) || parsed < 1) {
      telemetry.attribution.queries.inc({ result: "invalid" });
      return NextResponse.json(
        { ok: false, error: "INVALID_METHOD_VERSION", message: "methodVersion muss eine Ganzzahl ≥ 1 sein." },
        { status: 400, headers: NO_STORE }
      );
    }
    methodVersion = parsed;
  }
  const from = parseIso(url.searchParams.get("from"), "from");
  if (!from.ok) {
    telemetry.attribution.queries.inc({ result: "invalid" });
    return from.response;
  }
  const to = parseIso(url.searchParams.get("to"), "to");
  if (!to.ok) {
    telemetry.attribution.queries.inc({ result: "invalid" });
    return to.response;
  }

  const filter: AttributionFilter = {
    regime: url.searchParams.get("regime") ?? undefined,
    methodVersion,
    from: from.date,
    to: to.date,
  };

  try {
    const aggregate = await aggregateTradeAttributions(dimension, filter);
    telemetry.attribution.queries.inc({ result: "ok" });
    return NextResponse.json(
      {
        ok: true,
        ...aggregate,
        method: "deterministic allocation (normierte Aufteilung, keine Kausalanalyse)",
      },
      { headers: NO_STORE }
    );
  } catch (e) {
    telemetry.attribution.queries.inc({ result: "unavailable" });
    return NextResponse.json(
      {
        ok: false,
        error: "ATTRIBUTION_UNAVAILABLE",
        message: e instanceof Error ? e.message : String(e),
        hint: "PostgreSQL prüfen oder Migration drizzle/2026-09-21_trade_attribution.sql anwenden.",
      },
      { status: 503, headers: NO_STORE }
    );
  }
}
