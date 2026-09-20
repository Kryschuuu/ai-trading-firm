import { NextResponse } from "next/server";

import { requirePermission } from "@/auth";
import { getSliceRegistry } from "@/features/definitions";
import { pitQuery } from "@/features/service";
import { validatePitQuery } from "@/features/pitQuery";
import { getFeatureStore } from "@/features/store";
import { FeatureStoreError } from "@/features/types";
import { metricLabel, telemetry } from "@/lib/telemetry";

export const dynamic = "force-dynamic";

/**
 * Point-in-Time-Featurewerte lesen (RMA-P6-01, v1.53.0).
 *
 * Query (alle Pflicht außer `targetTime`/`timeframe`):
 *   - `asOf`      ISO-8601 — „nur Informationen bis hierhin“ (Pflicht)
 *   - `targetTime`ISO-8601 — Zielzeit (Default `asOf`); **darf nicht** nach
 *     `asOf` liegen (das wäre Look-ahead, ⇒ 400)
 *   - `entities`  CSV kanonischer Instrument-IDs
 *   - `features`  CSV, je `featureId` oder `featureId:version`
 *   - `timeframe` erlaubter Timeframe (Default `1h`)
 *
 * Semantik: geliefert wird je Entity/Feature der **jüngste** Wert mit
 * `event_time <= targetTime` **und** `available_at <= asOf`. Fehlende Werte sind
 * `MISSING`, unbekannte Werte `NULL_VALUE` — beide mit `value: null`; es gibt
 * **keine** Null-Ersatzwerte (`0`/`false`/`""`). `stale` markiert Werte, deren
 * Eventzeit älter als der Timeframe ist.
 *
 * SEC-02-Muster: `firm.read`, `no-store`, harte Mengenlimits
 * (`entities ≤ 200`, `features ≤ 25`, Ergebnis ≤ 2000) und eine
 * Quellgrenze, deren Erreichen als `FEATURE_PIT_SOURCE_TRUNCATED` (503)
 * gemeldet wird — niemals stillschweigend gekürzt.
 */
export async function GET(req: Request) {
  const denied = requirePermission(req, "firm.read");
  if (denied) return denied;

  const url = new URL(req.url);
  const timeframeRaw = url.searchParams.get("timeframe");
  const checked = validatePitQuery({
    asOf: url.searchParams.get("asOf") ?? undefined,
    targetTime: url.searchParams.get("targetTime") ?? undefined,
    entities: url.searchParams.get("entities") ?? undefined,
    features: url.searchParams.get("features") ?? undefined,
    timeframe: timeframeRaw === null ? "1h" : timeframeRaw,
  });
  if (!checked.ok) {
    telemetry.features.pitQueries.inc({ result: "invalid" });
    return NextResponse.json(
      { ok: false, error: checked.error.split(":")[0], message: checked.error },
      { status: 400, headers: { "Cache-Control": "private, no-store" } }
    );
  }

  try {
    const result = await pitQuery(checked.request, { store: getFeatureStore(), registry: getSliceRegistry() });
    telemetry.features.pitQueries.inc({ result: "ok" });
    for (const value of result.values) {
      telemetry.features.pitOutcomes.inc({
        status: metricLabel(value.status),
        stale: value.stale ? "true" : "false",
      });
    }
    return NextResponse.json(
      { ok: true, ...result },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  } catch (e) {
    const code = e instanceof FeatureStoreError ? e.code : "FEATURE_STORE_UNAVAILABLE";
    telemetry.features.pitQueries.inc({
      result: code === "FEATURE_PIT_SOURCE_TRUNCATED" ? "truncated" : code === "FEATURE_UNKNOWN" ? "invalid" : "unavailable",
    });
    const status = code === "FEATURE_UNKNOWN" ? 400 : 503;
    return NextResponse.json(
      {
        ok: false,
        error: code,
        message: e instanceof Error ? e.message : String(e),
        hint:
          status === 503
            ? "PostgreSQL/DATABASE_URL prüfen (`npx drizzle-kit push`) oder Zeitraum/Entitys eingrenzen."
            : "Feature-ID gegen `GET /api/firm/features` prüfen.",
      },
      { status, headers: { "Cache-Control": "private, no-store" } }
    );
  }
}
