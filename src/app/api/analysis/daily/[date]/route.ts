/**
 * `GET /api/analysis/daily/{date}` — Tageslauf für ein konkretes Datum YYYY-MM-DD (read-only).
 */

import { publicErrorMessage } from "@/lib/secrets";
import { getCycleService } from "@/cycle/service";
import { DATE_FOLDER_RE } from "@/cycle/artifacts";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ date: string }> };

export async function GET(_req: Request, ctx: RouteContext): Promise<Response> {
  try {
    const raw = await ctx.params;
    const date = decodeURIComponent(raw.date ?? "").trim();
    if (!DATE_FOLDER_RE.test(date)) {
      return Response.json(
        { ok: false, error: "VALIDATION_ERROR", message: "Datum muss im Format YYYY-MM-DD sein" },
        { status: 400 }
      );
    }

    const service = getCycleService();
    const data = service.getDailyByDate(date);
    if (!data) {
      return Response.json(
        { ok: false, error: "NOT_FOUND", message: `Kein Tageslauf für ${date} gefunden` },
        { status: 404 }
      );
    }
    return Response.json({ ok: true, date, ...data });
  } catch (e) {
    return Response.json(
      { ok: false, error: "INTERNAL_ERROR", message: publicErrorMessage(e) },
      { status: 500 }
    );
  }
}
