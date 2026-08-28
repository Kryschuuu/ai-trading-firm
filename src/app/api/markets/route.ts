/**
 * `GET /api/markets` — Instrument-Universum, nach Venue gruppiert und filterbar.
 *
 * Query-Parameter (alle optional, UND-verknüpft):
 *   venue, assetClass, marketType, status   Mehrfachwerte kommasepariert
 *   base, quote, underlying, q              Ticker bzw. Freitext auf der ID
 *   paperAvailable, liveAvailable,
 *   leverageAvailable, shortAvailable       "true" | "false"
 *   minVolume24h, maxSpread, maxVolatility  Zahlen
 *   page (≥ 1), pageSize (1…500, Default 100)
 *
 * Antwort 200:
 * ```json
 * {
 *   "ok": true, "venue": "BINANCE", "count": 3,
 *   "lastSync": "2026-08-27T00:00:00.000Z",
 *   "instruments": [ … ],
 *   "groups": [ { "venue": "BINANCE", "count": 3, "instruments": [ … ] } ],
 *   "page": 1, "pageSize": 100, "total": 3, "hasMore": false
 * }
 * ```
 *
 * Fehler-Contract: `{ ok: false, error: "<CODE>", message, details? }`
 * mit 400 (Validierung) bzw. 500 (intern, Meldung redigiert).
 *
 * Lesender Endpunkt ⇒ kein Token nötig (wie die übrigen GET-Routen);
 * die Registry wird hier nie mutiert.
 */

import { getRegistry } from "@/universe";
import { MAX_PAGE_SIZE, clampPage, clampPageSize, isValidVenue } from "@/universe/validation";
import { ASSET_CLASSES, INSTRUMENT_STATUSES, MARKET_TYPES } from "@/universe/types";
import type { AssetClass, InstrumentQuery, InstrumentStatus, MarketType } from "@/universe/types";
import { publicErrorMessage } from "@/lib/secrets";

export const dynamic = "force-dynamic";

/** Maximale Länge eines einzelnen Query-Parameters (DoS-/Log-Flut-Schutz). */
const MAX_PARAM_LENGTH = 200;

function badRequest(message: string, details?: unknown): Response {
  return Response.json({ ok: false, error: "VALIDATION_ERROR", message, details }, { status: 400 });
}

function readList(params: URLSearchParams, key: string): string[] | null {
  const raw = params.get(key);
  if (raw === null) return null;
  if (raw.length > MAX_PARAM_LENGTH) throw new Error(`${key}: zu lang (max. ${MAX_PARAM_LENGTH} Zeichen)`);
  const list = raw
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  if (!list.length) throw new Error(`${key}: leerer Wert`);
  if (list.length > 20) throw new Error(`${key}: max. 20 Werte`);
  return list;
}

function readEnum<T extends string>(params: URLSearchParams, key: string, allowed: readonly T[]): T[] | null {
  const list = readList(params, key);
  if (!list) return null;
  const lower = list.map((v) => v.toLowerCase());
  for (const v of lower) {
    if (!(allowed as readonly string[]).includes(v)) {
      throw new Error(`${key}: "${v.slice(0, 20)}" ist keiner von ${allowed.join(" | ")}`);
    }
  }
  return lower as T[];
}

function readBoolean(params: URLSearchParams, key: string): boolean | undefined {
  const raw = params.get(key);
  if (raw === null) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  throw new Error(`${key}: erwartet true|false`);
}

function readNumber(params: URLSearchParams, key: string): number | undefined {
  const raw = params.get(key);
  if (raw === null) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${key}: erwartet endliche Zahl ≥ 0`);
  return n;
}

function readTicker(params: URLSearchParams, key: string): string | undefined {
  const raw = params.get(key);
  if (raw === null) return undefined;
  const v = raw.trim().toUpperCase();
  if (!/^[A-Z0-9]{1,12}$/.test(v)) throw new Error(`${key}: ungültiger Ticker`);
  return v;
}

/** Baut aus der URL eine validierte `InstrumentQuery`. */
export function parseMarketQuery(url: URL): InstrumentQuery {
  const p = url.searchParams;

  const venues = readList(p, "venue");
  if (venues) {
    for (const v of venues) {
      if (!isValidVenue(v.toUpperCase())) throw new Error(`venue: ungültiges Format ("${v.slice(0, 20)}")`);
    }
  }

  const search = p.get("q");
  if (search !== null && search.length > 64) throw new Error("q: max. 64 Zeichen");

  return {
    venue: venues?.map((v) => v.toUpperCase()),
    assetClass: readEnum<AssetClass>(p, "assetClass", ASSET_CLASSES) ?? undefined,
    marketType: readEnum<MarketType>(p, "marketType", MARKET_TYPES) ?? undefined,
    status: readEnum<InstrumentStatus>(p, "status", INSTRUMENT_STATUSES) ?? undefined,
    paperAvailable: readBoolean(p, "paperAvailable"),
    liveTradable: readBoolean(p, "liveTradable"),
    liveAvailable: readBoolean(p, "liveAvailable"),
    leverageAvailable: readBoolean(p, "leverageAvailable"),
    shortAvailable: readBoolean(p, "shortAvailable"),
    base: readTicker(p, "base"),
    quote: readTicker(p, "quote"),
    underlying: readTicker(p, "underlying"),
    minVolume24h: readNumber(p, "minVolume24h"),
    maxSpread: readNumber(p, "maxSpread"),
    maxVolatility: readNumber(p, "maxVolatility"),
    page: p.get("page") !== null ? clampPage(Number(p.get("page"))) : 1,
    pageSize: p.get("pageSize") !== null ? clampPageSize(Number(p.get("pageSize"))) : undefined,
  };
}

/** Handler für `GET /api/markets`. */
export async function GET(req: Request): Promise<Response> {
  let query: InstrumentQuery;
  try {
    query = parseMarketQuery(new URL(req.url));
  } catch (e) {
    return badRequest(e instanceof Error ? e.message : "ungültige Filterparameter", { maxPageSize: MAX_PAGE_SIZE });
  }

  try {
    const registry = getRegistry();
    const result = registry.query(query);
    const groups = registry.groupByVenue(result.items);
    const venueFilter = Array.isArray(query.venue) ? query.venue : query.venue ? [query.venue] : [];

    return Response.json({
      ok: true,
      // Contract: `venue` beschreibt den Ausschnitt — eine konkrete Venue,
      // "ALL" ohne Filter, oder die kommaseparierte Auswahl.
      venue: venueFilter.length === 1 ? venueFilter[0] : venueFilter.length > 1 ? venueFilter.join(",") : "ALL",
      count: result.items.length,
      lastSync: registry.lastSync,
      instruments: result.items,
      groups,
      page: result.page,
      pageSize: result.pageSize,
      total: result.total,
      hasMore: result.hasMore,
    });
  } catch (e) {
    return Response.json(
      { ok: false, error: "INTERNAL_ERROR", message: publicErrorMessage(e) },
      { status: 500 },
    );
  }
}
