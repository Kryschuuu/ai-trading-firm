/**
 * `GET /api/analysis/weekly/latest` — Jüngster wöchentlicher Universe Review (read-only).
 */

import { publicErrorMessage } from "@/lib/secrets";
import { getCycleService } from "@/cycle/service";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const service = getCycleService();
    const review = service.getWeeklyLatest();
    if (!review) {
      return Response.json(
        { ok: false, error: "NOT_FOUND", message: "Kein wöchentlicher Universe Review gefunden" },
        { status: 404 }
      );
    }
    return Response.json({ ok: true, review });
  } catch (e) {
    return Response.json(
      { ok: false, error: "INTERNAL_ERROR", message: publicErrorMessage(e) },
      { status: 500 }
    );
  }
}
