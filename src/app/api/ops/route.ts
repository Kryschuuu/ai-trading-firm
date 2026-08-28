/**
 * `GET /api/ops` — Operations-Center-Hülle (Task 10, Phase 1).
 *
 * Read-only, wie die übrigen GET-Routen: ohne Token ladbar, damit der
 * leere Tab im Dashboard erscheint. `liveEnabled` ist hart false.
 * Keine Secrets, keine Credentials, keine Orders.
 */
import { buildOpsPayload, resolveActor } from "@/auth";
import { publicErrorMessage } from "@/lib/secrets";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  try {
    const actor = resolveActor(req);
    const payload = buildOpsPayload(actor);
    return Response.json(payload);
  } catch (err) {
    return Response.json(
      { ok: false, error: "INTERNAL_ERROR", message: publicErrorMessage(err) },
      { status: 500 }
    );
  }
}
