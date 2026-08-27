/**
 * `GET /api/markets/{venue}/{symbol}` — ein einzelnes Instrument.
 *
 * Symbole mit Schrägstrich (`KRAKEN:BTC/USD`) müssen URL-kodiert werden
 * (`/api/markets/KRAKEN/BTC%2FUSD`); zusätzlich wird `~` als Alias für `/`
 * akzeptiert (`/api/markets/KRAKEN/BTC~USD`), weil manche Clients kodierte
 * Schrägstriche in Pfaden normalisieren.
 *
 * Antworten:
 *   200 `{ ok: true, instrument: { …, assetId, underlyingId }, related: [ … ] }`
 *   400 `{ ok: false, error: "VALIDATION_ERROR", message }`
 *   404 `{ ok: false, error: "NOT_FOUND", message }`
 *   500 `{ ok: false, error: "INTERNAL_ERROR", message }`
 *
 * `related` listet die IDs aller Instrumente mit demselben Underlying —
 * die venue-übergreifende Sicht („BTC existiert dreifach“).
 */

import { getRegistry } from "@/universe";
import { assetIdOf, withRelations } from "@/universe/normalization";
import { isValidSymbol, isValidVenue } from "@/universe/validation";
import { publicErrorMessage } from "@/lib/secrets";

export const dynamic = "force-dynamic";

/** Route-Parameter (Next.js 15+: Promise). */
type RouteContext = { params: Promise<{ venue: string; symbol: string }> };

/** Handler für `GET /api/markets/{venue}/{symbol}`. */
export async function GET(_req: Request, ctx: RouteContext): Promise<Response> {
  try {
    const raw = await ctx.params;
    const venue = decodeURIComponent(raw.venue ?? "").trim().toUpperCase();
    const symbol = decodeURIComponent(raw.symbol ?? "")
      .trim()
      .toUpperCase()
      .replace(/~/g, "/");

    if (!isValidVenue(venue)) {
      return Response.json(
        { ok: false, error: "VALIDATION_ERROR", message: "venue: ungültiges Format" },
        { status: 400 },
      );
    }
    if (!isValidSymbol(symbol)) {
      return Response.json(
        { ok: false, error: "VALIDATION_ERROR", message: "symbol: ungültiges Format" },
        { status: 400 },
      );
    }

    const registry = getRegistry();
    const found = registry.get(`${venue}:${symbol}`);
    if (!found) {
      return Response.json(
        { ok: false, error: "NOT_FOUND", message: `Instrument ${venue}:${symbol} ist nicht im Universum.` },
        { status: 404 },
      );
    }

    const related = registry
      .instrumentsForUnderlying(assetIdOf(found))
      .map((i) => i.id)
      .filter((id) => id !== found.id);

    return Response.json({ ok: true, instrument: withRelations(found), related, lastSync: registry.lastSync });
  } catch (e) {
    return Response.json(
      { ok: false, error: "INTERNAL_ERROR", message: publicErrorMessage(e) },
      { status: 500 },
    );
  }
}
