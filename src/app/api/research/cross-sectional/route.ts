/**
 * `GET /api/research/cross-sectional` — Point-in-Time Cross-Sectional
 * Momentum Ranking (RMA-P2-04, v1.63.0; read-only).
 *
 * Query-Parameter:
 *   `asOf`           ISO-8601-Zeitpunkt (optional; Default: jetzt). Es wird
 *                    der JÜNGSTE Snapshot mit `as_of ≤ asOf` geliefert —
 *                    spätere Snapshots sind für frühere Zeitpunkte
 *                    strukturell unsichtbar (kein Look-ahead).
 *   `instrumentId`   Kanonische ID (optional) ⇒ genau dieses Mitglied.
 *   `timeframe`      Kerzen-Periodizität (optional; Allowlist `1m…5d`) —
 *                    nur Snapshots dieses Timeframes werden berücksichtigt.
 *   `top`            1…200 (Default 25) — Anzahl gelieferter RANKED-Mitglieder.
 *   `exclusions`     `true` (Default) | `false` — Ausschluss-Zusammenfassung.
 *
 * Antwort 200:
 * ```json
 * {
 *   "ok": true,
 *   "snapshot": {
 *     "snapshotId": "xs1:…", "asOf": "…", "computedAt": "…",
 *     "timeframe": "1h", "availabilityPolicy": "ingested",
 *     "codeVersion": "cross-sectional@1", "configVersion": 1,
 *     "provenance": { "universeHash": "xu1:…", "dataHash": "xd1:…", "configHash": "xc1:…" },
 *     "universeSize": 250, "rankedCount": 240, "excludedCount": 10,
 *     "coverage": 0.96,
 *     "exclusionCounts": { "BELOW_MIN_VOLUME": 7, "STALE_DATA": 3 },
 *     "stability": { "prevSnapshotId": "xs1:…", "topK": 10, "topKOverlap": 0.9, "rankShiftMean": 4.2, "commonCount": 238 },
 *     "survivorshipNote": "…"
 *   },
 *   "items": [ { "rank": 1, "instrumentId": "BITUNIX:BTCUSDT",
 *                "percentile": 1.0, "composite": 2.31,
 *                "horizonCoverage": 1.0,
 *                "rawReturns": { "h72": { "total": 0.05, "volAdjusted": 0.8 }, … } } ],
 *   "member": null
 * }
 * ```
 * Ohne Snapshot: `{ "ok": true, "snapshot": null, "reason": "NO_SNAPSHOT", … }`.
 *
 * Lesender Endpunkt: keine Token-Pflicht, keine Mutation, keine externen
 * Aufrufe; DB-Fehler ⇒ 503 mit generischer Meldung (keine Interna).
 */

import { publicErrorMessage } from "@/lib/secrets";
import { loadLatestSnapshot } from "@/crossSectional/store";
import { roundTo } from "@/crossSectional/math";
import { SUPPORTED_TIMEFRAMES, isSupportedTimeframe, type SupportedTimeframe } from "@/lib/marketdata/historicalStore";

export const dynamic = "force-dynamic";

/** Harte Obergrenze der gelieferten Mitglieder (DoS-Schutz). */
export const MAX_TOP = 200;
/** Standard-Tiefe der Top-Liste. */
export const DEFAULT_TOP = 25;

/** Liest und validiert die Query-Parameter (wirft bei ungültiger Eingabe). */
export function parseCrossSectionalQuery(url: URL): {
  asOfMs: number | undefined;
  instrumentId: string | null;
  top: number;
  exclusions: boolean;
  timeframe: SupportedTimeframe | null;
} {
  const p = url.searchParams;

  let asOfMs: number | undefined;
  const rawAsOf = p.get("asOf");
  if (rawAsOf !== null && rawAsOf.trim().length > 0) {
    const ms = Date.parse(rawAsOf.trim());
    if (Number.isNaN(ms)) throw new Error("asOf: erwartet ISO-8601 (z. B. 2026-09-22T00:00:00.000Z)");
    asOfMs = ms;
  }

  let timeframe: SupportedTimeframe | null = null;
  const rawTimeframe = p.get("timeframe");
  if (rawTimeframe !== null && rawTimeframe.trim().length > 0) {
    const tf = rawTimeframe.trim();
    if (!isSupportedTimeframe(tf)) {
      throw new Error(`timeframe: erlaubt ${SUPPORTED_TIMEFRAMES.join(" | ")}`);
    }
    timeframe = tf;
  }

  const rawInstrument = p.get("instrumentId");
  const instrumentId =
    rawInstrument !== null && rawInstrument.trim().length > 0
      ? rawInstrument.trim().slice(0, 128)
      : null;
  if (instrumentId !== null && !/^[A-Za-z0-9:_\-/]{1,128}$/.test(instrumentId)) {
    throw new Error("instrumentId: unerlaubtes Format");
  }

  let top = DEFAULT_TOP;
  const rawTop = p.get("top");
  if (rawTop !== null && rawTop.trim().length > 0) {
    top = Number(rawTop);
    if (!Number.isInteger(top) || top < 1 || top > MAX_TOP) {
      throw new Error(`top: Ganzzahl 1…${MAX_TOP} erwartet`);
    }
  }

  const rawExclusions = (p.get("exclusions") ?? "true").trim().toLowerCase();
  if (rawExclusions !== "true" && rawExclusions !== "false") {
    throw new Error("exclusions: true | false erwartet");
  }

  return { asOfMs, instrumentId, top, exclusions: rawExclusions === "true", timeframe };
}

/** Baut die Antwort aus einer geladenen Snapshot-Zeile (rein, testbar). */
export function buildCrossSectionalResponse(
  loaded:
    | Awaited<ReturnType<typeof loadLatestSnapshot>>
    | null,
  opts: { instrumentId: string | null; top: number; exclusions: boolean },
): Record<string, unknown> {
  if (!loaded) {
    return {
      ok: true,
      snapshot: null,
      reason: "NO_SNAPSHOT",
      items: [],
      member: null,
    };
  }
  const ranked = loaded.members
    .filter((m) => m.status === "RANKED")
    .slice(0, opts.top);
  const member = opts.instrumentId
    ? (loaded.members.find((m) => m.instrumentId === opts.instrumentId) ?? null)
    : null;
  return {
    ok: true,
    snapshot: {
      snapshotId: loaded.snapshotId,
      asOf: loaded.asOf.toISOString(),
      computedAt: loaded.computedAt.toISOString(),
      schemaVersion: loaded.schemaVersion,
      codeVersion: loaded.codeVersion,
      configVersion: loaded.configVersion,
      timeframe: loaded.timeframe,
      availabilityPolicy: loaded.availabilityPolicy,
      provenance: {
        universeHash: loaded.universeHash,
        dataHash: loaded.dataHash,
        configHash: loaded.configHash,
      },
      universeSize: loaded.universeSize,
      rankedCount: loaded.rankedCount,
      excludedCount: loaded.excludedCount,
      coverage: roundTo(loaded.coverage),
      exclusionCounts: opts.exclusions ? loaded.exclusionCounts : {},
      stability: loaded.stability,
      survivorshipNote: loaded.survivorshipNote,
    },
    items: ranked.map((m) => ({
      rank: m.rank,
      instrumentId: m.instrumentId,
      percentile: m.percentile === null ? null : roundTo(m.percentile),
      composite: m.composite === null ? null : roundTo(m.composite),
      horizonCoverage: roundTo(m.horizonCoverage),
      barsUsed: m.barsUsed,
      lastBarTs: m.lastBarTs ? m.lastBarTs.toISOString() : null,
      lastAvailableAt: m.lastAvailableAt ? m.lastAvailableAt.toISOString() : null,
      rawReturns: m.rawReturns,
      zScores: m.zScores,
      winsorized: m.winsorized,
    })),
    member: member
      ? {
          status: member.status,
          instrumentId: member.instrumentId,
          rank: member.rank,
          percentile: member.percentile === null ? null : roundTo(member.percentile),
          composite: member.composite === null ? null : roundTo(member.composite),
          horizonCoverage: roundTo(member.horizonCoverage),
          barsUsed: member.barsUsed,
          exclusionReason: member.exclusionReason,
          rawReturns: member.rawReturns,
          zScores: member.zScores,
          winsorized: member.winsorized,
        }
      : null,
  };
}

/** GET-Handler: PIT-Load + Antwort (DB-Fehler ⇒ 503, Validierung ⇒ 400). */
export async function GET(request: Request): Promise<Response> {
  let parsed;
  try {
    parsed = parseCrossSectionalQuery(new URL(request.url));
  } catch (error) {
    return Response.json(
      { ok: false, error: "VALIDATION_ERROR", message: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
  try {
    const loaded = await loadLatestSnapshot({
      asOfMs: parsed.asOfMs,
      timeframe: parsed.timeframe ?? undefined,
    });
    return Response.json(buildCrossSectionalResponse(loaded, parsed));
  } catch (error) {
    return Response.json(
      { ok: false, error: "STORAGE_UNAVAILABLE", message: publicErrorMessage(error) },
      { status: 503 },
    );
  }
}
