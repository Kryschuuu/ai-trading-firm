/**
 * `GET /api/marketdata/perpetual/series` (RMA-P2-02, v1.54.0) — read-only.
 *
 * as-of-Abfrage über die kanonischen Perp-Reihen (Funding, Open Interest,
 * Liquidationen). **Additiv** zu `/api/marketdata/status` und
 * `/api/marketdata/snapshot`: neue Route, keine Änderung bestehender Verträge.
 *
 * Query:
 *   - `instruments` CSV kanonischer IDs oder Symbole (`BITUNIX:BTCUSDT`,
 *                 `BTCUSDT`) — Pflicht, ≤ 200 Einträge
 *   - `venue`     optionaler Venue-Filter (`BITUNIX`)
 *   - `kinds`     `funding,openInterest,liquidations` (Default: alle)
 *   - `from`/`to` ISO-Grenzen der **Ereigniszeit**
 *   - `asOf`      ISO-As-of-Punkt (Default: jetzt) — liefert nur Zeilen mit
 *                 `event_time <= asOf` **und** `available_at <= asOf`
 *   - `limit`     Zeilen je Instrument/Reihe (Default 500, max 2 000)
 *
 * Antwort 200:
 * ```json
 * {
 *   "ok": true,
 *   "asOf": "2026-09-20T10:00:00.000Z",
 *   "qualityMode": "log",
 *   "counts": { "AVAILABLE": 2, "MISSING": 1 },
 *   "series": [
 *     { "kind": "funding", "venue": "BITUNIX", "instrumentId": "BITUNIX:BTCUSDT",
 *       "availability": "AVAILABLE", "reason": "OK", "ageMs": 1200000,
 *       "truncated": false, "rows": [ … ] }
 *   ]
 * }
 * ```
 * `availability` ist Teil jedes Reihenergebnisses: `MISSING`/`STALE`/
 * `UNSUPPORTED`/`UNAVAILABLE` sind **keine** `rows: []`-Erfolge mit 0-Werten,
 * sondern klassifizierte Zustände mit `reason`.
 *
 * Fehler-Contract: `{ ok:false, error, message, hint }` — 400 bei
 * Anfrageablehnung (fehlendes Instrument, invertiertes Fenster, `asOf` in der
 * Zukunft, Limit überschritten), 503, wenn die Ablage nicht erreichbar ist
 * (`perp:store_unavailable`) — nie 200 mit leerem Bestand.
 */
import { publicErrorMessage } from "@/lib/secrets";
import { getPerpDataService } from "@/perpdata/service";
import { PerpQueryError } from "@/perpdata/errors";
import { PERP_SERIES_KINDS, type PerpSeriesKind } from "@/perpdata/types";
import { metricLabel, telemetry } from "@/lib/telemetry";

export const dynamic = "force-dynamic";

function csv(value: string | null): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim().toUpperCase())
    .filter(Boolean);
}

function parseTimeMs(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const trimmed = value.trim();
  const parsed = /^\d+$/.test(trimmed) ? Number(trimmed) : Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const instruments = csv(url.searchParams.get("instruments"));
  if (instruments.length === 0) {
    return Response.json(
      {
        ok: false,
        error: "query:instruments_required",
        message: "Parameter 'instruments' fehlt (CSV kanonischer IDs oder Symbole).",
        hint: "Beispiel: ?instruments=BITUNIX:BTCUSDT oder ?instruments=BTCUSDT&venue=BITUNIX",
      },
      { status: 400, headers: { "Cache-Control": "private, no-store" } }
    );
  }
  const kindsRaw = csv(url.searchParams.get("kinds"));
  const kinds = kindsRaw.filter((kind): kind is PerpSeriesKind => (PERP_SERIES_KINDS as readonly string[]).includes(kind));
  if (kindsRaw.length > 0 && kinds.length !== kindsRaw.length) {
    return Response.json(
      {
        ok: false,
        error: "query:kind_invalid",
        message: `unbekannte Reihenart — erlaubt: ${PERP_SERIES_KINDS.join(", ")}.`,
      },
      { status: 400, headers: { "Cache-Control": "private, no-store" } }
    );
  }
  let fromMs: number | null = null;
  let toMs: number | null = null;
  let asOfMs: number | null = null;
  fromMs = parseTimeMs(url.searchParams.get("from"));
  toMs = parseTimeMs(url.searchParams.get("to"));
  asOfMs = parseTimeMs(url.searchParams.get("asOf"));
  if ([fromMs, toMs, asOfMs].some((value) => Number.isNaN(value as number))) {
    return Response.json(
      { ok: false, error: "query:time_invalid", message: "Zeitparameter ist kein ISO-Zeitpunkt oder Epoch-ms." },
      { status: 400, headers: { "Cache-Control": "private, no-store" } }
    );
  }
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw === null || limitRaw.trim() === "" ? null : Number(limitRaw);
  if (limit !== null && (!Number.isFinite(limit) || limit < 1)) {
    return Response.json(
      { ok: false, error: "query:limit_invalid", message: "limit muss eine ganze Zahl >= 1 sein." },
      { status: 400, headers: { "Cache-Control": "private, no-store" } }
    );
  }

  const service = getPerpDataService();
  try {
    const response = await service.query({
      instruments,
      venue: url.searchParams.get("venue")?.trim().toUpperCase() || null,
      ...(kinds.length > 0 ? { kinds } : {}),
      fromMs,
      toMs,
      asOfMs,
      limit,
    });
    for (const serie of response.series) {
      telemetry.perp.asOfQueries.inc({
        result: metricLabel(serie.availability),
        kind: metricLabel(serie.kind),
      });
    }
    return Response.json({ ok: true, ...response }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    const code = e instanceof PerpQueryError ? e.code : "perp:store_unavailable";
    const status = code.startsWith("query:") ? 400 : 503;
    return Response.json(
      {
        ok: false,
        error: code,
        message: publicErrorMessage(e),
        hint:
          status === 503
            ? "PostgreSQL/DATABASE_URL prüfen und Migration anwenden: `psql \"$DATABASE_URL\" -f drizzle/2026-09-20_perpetual_data.sql` (oder `npx drizzle-kit push`)."
            : `Instrument-Angaben gegen die Universe-Registry prüfen (GET /api/universe).`,
      },
      { status, headers: { "Cache-Control": "private, no-store" } }
    );
  }
}
