import { privateNoStore } from "@/lib/apiAuth";
import { requirePermission } from "@/auth";
/**
 * `GET /api/analysis/daily/latest` — Jüngster Tageslauf (read-only).
 */

import { publicErrorMessage } from "@/lib/secrets";
import { getCycleService } from "@/cycle/service";

export const dynamic = "force-dynamic";

export async function GET(req: Request = new Request("http://localhost/api")): Promise<Response> {
  return privateNoStore(await (async () => {
  const denied = requirePermission(req, "firm.read");
  if (denied) return denied;

  try {
    const service = getCycleService();
    const data = service.getDailyLatest();
    if (!data) {
      return Response.json(
        { ok: false, error: "NOT_FOUND", message: "Kein Tageslauf gefunden" },
        { status: 404 }
      );
    }
    return Response.json({ ok: true, ...data });
  } catch (e) {
    return Response.json(
      { ok: false, error: "INTERNAL_ERROR", message: publicErrorMessage(e) },
      { status: 500 }
    );
  }

  })());
}
