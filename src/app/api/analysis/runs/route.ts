/**
 * `GET /api/analysis/runs` — Liste der Zyklen-Durchläufe (Daily & Weekly) (read-only).
 *
 * Query-Parameter:
 *   - `type`: "daily" | "weekly" | "all" (Standard: "all")
 *   - `status`: Filter auf Status (z. B. "COMPLETED", "FAILED")
 *   - `page`: Seitennummer, 1-basiert (Standard: 1)
 *   - `pageSize`: Seitengröße, 1 bis 100 (Standard: 20)
 */

import { publicErrorMessage } from "@/lib/secrets";
import { getCycleService } from "@/cycle/service";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const typeParam = (url.searchParams.get("type") ?? "all").toLowerCase();
    const status = url.searchParams.get("status") ?? undefined;
    const rawPage = url.searchParams.get("page");
    const rawPageSize = url.searchParams.get("pageSize");

    const page = rawPage === null ? 1 : Number(rawPage);
    const pageSize = rawPageSize === null ? 20 : Number(rawPageSize);

    if (!Number.isFinite(page) || page < 1) {
      return Response.json(
        { ok: false, error: "VALIDATION_ERROR", message: "page muss eine positive Ganzzahl sein" },
        { status: 400 }
      );
    }
    if (!Number.isFinite(pageSize) || pageSize < 1 || pageSize > 100) {
      return Response.json(
        { ok: false, error: "VALIDATION_ERROR", message: "pageSize muss zwischen 1 und 100 liegen" },
        { status: 400 }
      );
    }

    const type = typeParam === "daily" || typeParam === "weekly" ? typeParam : "all";
    const service = getCycleService();
    const result = service.getRuns({ type, status, page, pageSize });

    return Response.json({ ok: true, ...result });
  } catch (e) {
    return Response.json(
      { ok: false, error: "INTERNAL_ERROR", message: publicErrorMessage(e) },
      { status: 500 }
    );
  }
}
