import { NextResponse } from "next/server";

import { requirePermission } from "@/auth";
import { getSliceRegistry } from "@/features/definitions";
import { FEATURE_LIMITS } from "@/features/types";
import { featureStoreStatus } from "@/features/service";
import { getFeatureStore } from "@/features/store";
import { isSupportedTimeframe } from "@/lib/marketdata/historicalStore";

export const dynamic = "force-dynamic";

/**
 * Feature-Registry + Materialisierungsstatus lesen (RMA-P6-01, v1.53.0).
 *
 * Query: `?timeframe=1h` (optional), `?feature=scanner.rsi` (optional, filtert
 * die Definitionsliste), `?runs=1..50` (Default 10).
 *
 * Antwortet mit den **immutablen** Definitionen (inklusive Fingerprints), der
 * Abdeckung je Reihe (Zeilen, Entities, NULL-Anteil, UNKNOWN-Qualität, Lag) und
 * den jüngsten Materialisierungsläufen bzw. protokollierten Datenrevisionen.
 *
 * SEC-02-Muster: sensibler Dashboard-Read — `firm.read` erforderlich, no-store,
 * reines Lesen (es gibt bewusst keinen POST-Endpunkt: Materialisierung läuft
 * ausschließlich über die CLI `npm run features:materialize`).
 */
export async function GET(req: Request) {
  const denied = requirePermission(req, "firm.read");
  if (denied) return denied;

  const url = new URL(req.url);
  const timeframeRaw = url.searchParams.get("timeframe");
  const registry = getSliceRegistry();
  const timeframe = timeframeRaw === null ? registry.definitions()[0]?.timeframe ?? "1h" : timeframeRaw;
  if (!isSupportedTimeframe(timeframe)) {
    return NextResponse.json(
      { ok: false, error: "INVALID_TIMEFRAME", message: `Timeframe "${timeframe.slice(0, 20)}" ist nicht erlaubt.` },
      { status: 400, headers: { "Cache-Control": "private, no-store" } }
    );
  }
  const featureFilter = url.searchParams.get("feature");
  if (featureFilter !== null && !registry.latest(featureFilter)) {
    return NextResponse.json(
      { ok: false, error: "UNKNOWN_FEATURE", message: `Feature "${featureFilter.slice(0, 64)}" ist nicht registriert.` },
      { status: 404, headers: { "Cache-Control": "private, no-store" } }
    );
  }
  const runsRaw = url.searchParams.get("runs");
  const runs = runsRaw === null || runsRaw === "" ? 10 : Number(runsRaw);
  if (!Number.isInteger(runs) || runs < 1 || runs > 50) {
    return NextResponse.json(
      { ok: false, error: `INVALID_LIMIT: erwartet 1..50, erhalten ${String(runsRaw).slice(0, 20)}` },
      { status: 400, headers: { "Cache-Control": "private, no-store" } }
    );
  }

  try {
    const status = await featureStoreStatus({
      store: getFeatureStore(),
      registry,
      timeframe,
      runLimit: runs,
      revisionLimit: runs,
    });
    const series = featureFilter === null ? status.series : status.series.filter((row) => row.featureId === featureFilter);
    return NextResponse.json(
      {
        ok: true,
        codeVersion: status.codeVersion,
        generatedAt: status.generatedAt,
        timeframe: status.timeframe,
        definitions: status.definitions,
        series,
        runs: status.runs,
        revisions: status.revisions,
        limits: {
          pitEntities: FEATURE_LIMITS.pitEntities,
          pitFeatures: FEATURE_LIMITS.pitFeatures,
          pitRows: FEATURE_LIMITS.pitRows,
          materializeEntities: FEATURE_LIMITS.materializeEntities,
        },
      },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: "FEATURE_STORE_UNAVAILABLE",
        message: e instanceof Error ? e.message : String(e),
        hint: "PostgreSQL prüfen oder `npx drizzle-kit push` ausführen (feature_definitions/feature_values).",
      },
      { status: 503, headers: { "Cache-Control": "private, no-store" } }
    );
  }
}
