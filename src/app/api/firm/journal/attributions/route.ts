/**
 * Trade-PnL-Attribution — Detailliste (RMA-P1-06, v1.57.0).
 *
 *   GET /api/firm/journal/attributions
 *     ?symbol=BTC&regime=NORMAL&status=ATTRIBUTED&methodVersion=1
 *     &from=…&to=…&limit=1..200&entries=true
 *
 * Liefert Attributionen geschlossener Trades (Kopfdaten; mit `entries=true`
 * zusätzlich die Beitragsposten je Zeile) plus Totals, Coverage gegen das
 * Journal und die Reconciliation der Seite. Alle Parameter bounded; `limit`
 * ist hart auf 200 geklemmt (Default 50); `truncated: true` markiert das
 * Erreichen der Grenze laut.
 *
 * Zeitraum-Filter (`from`/`to`) wirken auf die EREIGNISZEIT des Closes
 * (`closed_at`), nicht auf die Berechnungszeit — keine Look-ahead-Schieflage
 * in der Auswertung.
 *
 * SEC-02-Muster: `firm.read`, `no-store`, harte Mengenlimits. Reines Lesen.
 */
import { NextResponse } from "next/server";

import { requirePermission } from "@/auth";
import {
  ATTRIBUTION_LIMITS,
  aggregateTradeAttributions,
  queryTradeAttributions,
  type AttributionFilter,
  type AttributionStatus,
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

function parseLimit(raw: string | null): { ok: true; limit: number } | { ok: false; response: Response } {
  if (raw === null) return { ok: true, limit: ATTRIBUTION_LIMITS.defaultListLimit };
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > ATTRIBUTION_LIMITS.maxListLimit) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          ok: false,
          error: "INVALID_LIMIT",
          message: `limit muss eine Ganzzahl in [1, ${ATTRIBUTION_LIMITS.maxListLimit}] sein.`,
        },
        { status: 400, headers: NO_STORE }
      ),
    };
  }
  return { ok: true, limit: parsed };
}

export async function GET(req: Request) {
  const denied = requirePermission(req, "firm.read");
  if (denied) return denied;

  const url = new URL(req.url);
  const statusRaw = url.searchParams.get("status");
  if (statusRaw !== null && statusRaw !== "ATTRIBUTED" && statusRaw !== "UNATTRIBUTABLE") {
    telemetry.attribution.queries.inc({ result: "invalid" });
    return NextResponse.json(
      {
        ok: false,
        error: "INVALID_STATUS",
        message: 'status muss "ATTRIBUTED" oder "UNATTRIBUTABLE" sein.',
      },
      { status: 400, headers: NO_STORE }
    );
  }
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
  const limit = parseLimit(url.searchParams.get("limit"));
  if (!limit.ok) {
    telemetry.attribution.queries.inc({ result: "invalid" });
    return limit.response;
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
    symbol: url.searchParams.get("symbol") ?? undefined,
    regime: url.searchParams.get("regime") ?? undefined,
    status: (statusRaw as AttributionStatus | null) ?? undefined,
    methodVersion,
    from: from.date,
    to: to.date,
  };
  const includeEntries = url.searchParams.get("entries") === "true";

  try {
    const { rows, truncated } = await queryTradeAttributions(filter, limit.limit, includeEntries);
    // Coverage + Totals über dieselbe Filtermenge (Scheingenauigkeitsschutz).
    const aggregate = await aggregateTradeAttributions("agent", filter);
    telemetry.attribution.queries.inc({ result: truncated ? "truncated" : "ok" });
    return NextResponse.json(
      {
        ok: true,
        declaration: aggregate.declaration,
        method: "deterministic allocation (normierte Aufteilung, keine Kausalanalyse)",
        attributions: rows,
        totals: aggregate.totals,
        coverage: aggregate.coverage,
        reconciliation: aggregate.reconciliation,
        truncated,
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
