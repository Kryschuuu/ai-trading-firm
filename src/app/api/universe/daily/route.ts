/**
 * `GET /api/universe/daily` — Trichter-Ebenen des Tagesscans (read-only).
 *
 * Query-Parameter:
 *   `level`            `deep` | `daily` (Default) | `interesting` | `eligible`
 *   `page`             1-basiert, ≥ 1
 *   `pageSize`         1…200 (Default 50) — harte Obergrenze gegen DoS
 *   `breakdown`        `true` (Default für deep/daily) | `false`
 *
 * Antwort 200:
 * ```json
 * {
 *   "ok": true, "asOf": "2026-08-27T00:00:00.000Z", "configVersion": 1,
 *   "level": "daily",
 *   "funnel": { "scanned": 10000, "eligible": 2000, "interesting": 500, "daily": 100, "deep": 25 },
 *   "items": [ { "rank": 1, "instrumentId": "BINANCE:BTCUSDT", "score": 78.42,
 *                "regime": "NORMAL", "breakdown": [ … ] } ],
 *   "page": 1, "pageSize": 50, "total": 100, "hasMore": true
 * }
 * ```
 *
 * Lesender Endpunkt: keine Token-Pflicht, keine Mutation, keine externen Aufrufe.
 */

import { publicErrorMessage } from "@/lib/secrets";
import { getScannerService } from "@/scanner/service";
import type { InstrumentScore } from "@/scanner/types";

export const dynamic = "force-dynamic";

/** Erlaubte Trichter-Ebenen. */
export const LEVELS = ["deep", "daily", "interesting", "eligible"] as const;
/** Typ einer Ebene. */
export type Level = (typeof LEVELS)[number];
/** Harte Obergrenze der Seitengröße (DoS-Schutz). */
export const MAX_PAGE_SIZE = 200;
/** Standard-Seitengröße. */
export const DEFAULT_PAGE_SIZE = 50;

function badRequest(message: string): Response {
  return Response.json({ ok: false, error: "VALIDATION_ERROR", message }, { status: 400 });
}

/** Liest und validiert `page`/`pageSize`/`level`/`breakdown`. */
export function parseDailyQuery(url: URL): { level: Level; page: number; pageSize: number; breakdown: boolean } {
  const p = url.searchParams;

  const rawLevel = (p.get("level") ?? "daily").trim().toLowerCase();
  if (!(LEVELS as readonly string[]).includes(rawLevel)) {
    throw new Error(`level: erwartet ${LEVELS.join(" | ")}`);
  }
  const level = rawLevel as Level;

  const rawPage = p.get("page");
  const page = rawPage === null ? 1 : Number(rawPage);
  if (!Number.isFinite(page) || page < 1 || page > 100_000) throw new Error("page: erwartet Ganzzahl ≥ 1");

  const rawSize = p.get("pageSize");
  const pageSize = rawSize === null ? DEFAULT_PAGE_SIZE : Number(rawSize);
  if (!Number.isFinite(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw new Error(`pageSize: erwartet 1…${MAX_PAGE_SIZE}`);
  }

  const rawBreakdown = p.get("breakdown");
  if (rawBreakdown !== null && !["true", "false", "1", "0"].includes(rawBreakdown)) {
    throw new Error("breakdown: erwartet true|false");
  }
  const detailedLevel = level === "deep" || level === "daily";
  const breakdown =
    rawBreakdown === null ? detailedLevel : (rawBreakdown === "true" || rawBreakdown === "1") && detailedLevel;

  return { level, page: Math.trunc(page), pageSize: Math.trunc(pageSize), breakdown };
}

function serialize(score: InstrumentScore, rank: number, breakdown: boolean) {
  return {
    rank,
    instrumentId: score.instrumentId,
    assetClass: score.assetClass,
    score: score.score,
    regime: score.regime,
    ...(breakdown ? { breakdown: score.breakdown } : {}),
  };
}

/** Handler für `GET /api/universe/daily`. */
export async function GET(req: Request): Promise<Response> {
  let query: ReturnType<typeof parseDailyQuery>;
  try {
    query = parseDailyQuery(new URL(req.url));
  } catch (e) {
    return badRequest(e instanceof Error ? e.message : "ungültige Parameter");
  }

  try {
    const scan = getScannerService().getScan();
    const source: InstrumentScore[] = scan.funnel[query.level];
    const total = source.length;
    const start = (query.page - 1) * query.pageSize;
    const items = source
      .slice(start, start + query.pageSize)
      .map((s, i) => serialize(s, start + i + 1, query.breakdown));

    return Response.json({
      ok: true,
      asOf: scan.asOf,
      configVersion: scan.config.version,
      level: query.level,
      funnel: {
        scanned: scan.funnel.scanned,
        eligible: scan.funnel.eligible.length,
        interesting: scan.funnel.interesting.length,
        daily: scan.funnel.daily.length,
        deep: scan.funnel.deep.length,
        thresholds: {
          interestingMinScore: scan.config.funnel.interestingMinScore,
          maxPerAssetClass: scan.config.funnel.maxPerAssetClass,
        },
        diversificationRelaxed: scan.funnel.diversificationRelaxed,
      },
      weights: scan.config.weights,
      items,
      page: query.page,
      pageSize: query.pageSize,
      total,
      hasMore: start + items.length < total,
    });
  } catch (e) {
    return Response.json({ ok: false, error: "INTERNAL_ERROR", message: publicErrorMessage(e) }, { status: 500 });
  }
}
