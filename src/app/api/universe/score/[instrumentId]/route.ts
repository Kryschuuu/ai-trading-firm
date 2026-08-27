/**
 * `GET /api/universe/score/{instrumentId}` — vollständiger Score-Breakdown
 * eines Instruments (read-only).
 *
 * Die ID ist `VENUE:SYMBOL`; das Doppelpunkt-Zeichen darf URL-kodiert sein
 * (`BINANCE%3ABTCUSDT`), zusätzlich wird `~` als Alias für `/` im Symbol
 * akzeptiert (`KRAKEN:BTC~USD`) — analog zu `/api/markets/{venue}/{symbol}`.
 *
 * Antwort 200:
 * ```json
 * {
 *   "ok": true,
 *   "score": { "instrumentId": "BINANCE:BTCUSDT", "score": 78.42, "regime": "NORMAL",
 *              "breakdown": [ { "component": "liquidity", "factorId": "liquidity",
 *                               "raw": 1200000000, "normalized": 0.81, "weight": 0.25,
 *                               "contribution": 20.25 } ],
 *              "factors": { "atr": { … }, "rsi": { … } } },
 *   "levels": { "eligible": true, "interesting": true, "daily": true, "deep": false }
 * }
 * ```
 *
 * 400 bei ungültigem Format, 404 wenn das Instrument nicht gescannt wurde.
 */

import { publicErrorMessage } from "@/lib/secrets";
import { getScannerService } from "@/scanner/service";
import { isValidSymbol, isValidVenue } from "@/universe/validation";

export const dynamic = "force-dynamic";

/** Maximale Länge des Pfadsegments (DoS-/Log-Flut-Schutz). */
export const MAX_ID_LENGTH = 64;

/** Route-Parameter (Next.js 15+: Promise). */
type RouteContext = { params: Promise<{ instrumentId: string }> };

/** Normalisiert und validiert eine Instrument-ID aus dem Pfad. */
export function parseInstrumentId(raw: string): string {
  const decoded = decodeURIComponent(raw ?? "").trim().toUpperCase().replace(/~/g, "/");
  if (!decoded || decoded.length > MAX_ID_LENGTH) throw new Error("instrumentId: ungültige Länge");
  const idx = decoded.indexOf(":");
  if (idx <= 0) throw new Error("instrumentId: erwartet VENUE:SYMBOL");
  const venue = decoded.slice(0, idx);
  const symbol = decoded.slice(idx + 1);
  if (!isValidVenue(venue)) throw new Error("instrumentId: ungültige Venue");
  if (!isValidSymbol(symbol)) throw new Error("instrumentId: ungültiges Symbol");
  return `${venue}:${symbol}`;
}

/** Handler für `GET /api/universe/score/{instrumentId}`. */
export async function GET(_req: Request, ctx: RouteContext): Promise<Response> {
  let instrumentId: string;
  try {
    instrumentId = parseInstrumentId((await ctx.params).instrumentId);
  } catch (e) {
    return Response.json(
      { ok: false, error: "VALIDATION_ERROR", message: e instanceof Error ? e.message : "ungültige ID" },
      { status: 400 }
    );
  }

  try {
    const scan = getScannerService().getScan();
    const score = scan.byId.get(instrumentId);
    if (!score) {
      return Response.json(
        { ok: false, error: "NOT_FOUND", message: `Instrument ${instrumentId} wurde nicht gescannt.` },
        { status: 404 }
      );
    }
    const inLevel = (list: { instrumentId: string }[]) => list.some((s) => s.instrumentId === instrumentId);
    return Response.json({
      ok: true,
      asOf: scan.asOf,
      configVersion: scan.config.version,
      weights: scan.config.weights,
      score,
      levels: {
        eligible: inLevel(scan.funnel.eligible),
        interesting: inLevel(scan.funnel.interesting),
        daily: inLevel(scan.funnel.daily),
        deep: inLevel(scan.funnel.deep),
      },
      rejection: scan.rejections.find((r) => r.instrumentId === instrumentId) ?? null,
    });
  } catch (e) {
    return Response.json({ ok: false, error: "INTERNAL_ERROR", message: publicErrorMessage(e) }, { status: 500 });
  }
}
