/**
 * `GET /api/universe/weekly` — deterministische Weekly-Klassifikation (read-only).
 *
 * Query-Parameter:
 *   `class`     `CORE` | `ROTATION` | `DISCOVERY` | `EXCLUDED` (optional, mehrfach kommasepariert)
 *   `page`      1-basiert
 *   `pageSize`  1…200 (Default 50)
 *
 * Antwort 200:
 * ```json
 * {
 *   "ok": true, "asOf": "…", "configVersion": 1,
 *   "summary": { "CORE": 12, "ROTATION": 48, "DISCOVERY": 20, "EXCLUDED": 900 },
 *   "changes": { "newListings": [ … ], "delistings": [ … ] },
 *   "items": [ { "instrumentId": "BINANCE:BTCUSDT", "class": "CORE",
 *                "reasons": [ … ], "score": 78.42, "asOf": "…" } ],
 *   "page": 1, "pageSize": 50, "total": 980, "hasMore": true
 * }
 * ```
 *
 * Jeder Eintrag entspricht exakt dem validierten Contract
 * `{ instrumentId, class, reasons[], score, asOf }`.
 */

import { publicErrorMessage } from "@/lib/secrets";
import { getScannerService } from "@/scanner/service";
import { UNIVERSE_CLASSES, type UniverseClass } from "@/scanner/weekly";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "../daily/route";

export const dynamic = "force-dynamic";

function badRequest(message: string): Response {
  return Response.json({ ok: false, error: "VALIDATION_ERROR", message }, { status: 400 });
}

/** Liest und validiert die Query-Parameter. */
export function parseWeeklyQuery(url: URL): { classes: UniverseClass[] | null; page: number; pageSize: number } {
  const p = url.searchParams;

  const rawClass = p.get("class");
  let classes: UniverseClass[] | null = null;
  if (rawClass !== null) {
    if (rawClass.length > 100) throw new Error("class: zu lang");
    const list = rawClass
      .split(",")
      .map((v) => v.trim().toUpperCase())
      .filter(Boolean);
    if (!list.length || list.length > UNIVERSE_CLASSES.length) throw new Error("class: 1…4 Werte erwartet");
    for (const c of list) {
      if (!UNIVERSE_CLASSES.includes(c as UniverseClass)) {
        throw new Error(`class: erwartet ${UNIVERSE_CLASSES.join(" | ")}`);
      }
    }
    classes = list as UniverseClass[];
  }

  const rawPage = p.get("page");
  const page = rawPage === null ? 1 : Number(rawPage);
  if (!Number.isFinite(page) || page < 1 || page > 100_000) throw new Error("page: erwartet Ganzzahl ≥ 1");

  const rawSize = p.get("pageSize");
  const pageSize = rawSize === null ? DEFAULT_PAGE_SIZE : Number(rawSize);
  if (!Number.isFinite(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw new Error(`pageSize: erwartet 1…${MAX_PAGE_SIZE}`);
  }

  return { classes, page: Math.trunc(page), pageSize: Math.trunc(pageSize) };
}

/** Handler für `GET /api/universe/weekly`. */
export async function GET(req: Request): Promise<Response> {
  let query: ReturnType<typeof parseWeeklyQuery>;
  try {
    query = parseWeeklyQuery(new URL(req.url));
  } catch (e) {
    return badRequest(e instanceof Error ? e.message : "ungültige Parameter");
  }

  try {
    const review = getScannerService().getWeekly();
    const filtered = query.classes ? review.entries.filter((e) => query.classes?.includes(e.class)) : review.entries;
    const start = (query.page - 1) * query.pageSize;
    const items = filtered.slice(start, start + query.pageSize);

    return Response.json({
      ok: true,
      asOf: review.asOf,
      schemaVersion: review.schemaVersion,
      configVersion: review.configVersion,
      summary: review.summary,
      changes: review.changes,
      items,
      page: query.page,
      pageSize: query.pageSize,
      total: filtered.length,
      hasMore: start + items.length < filtered.length,
    });
  } catch (e) {
    return Response.json({ ok: false, error: "INTERNAL_ERROR", message: publicErrorMessage(e) }, { status: 500 });
  }
}
