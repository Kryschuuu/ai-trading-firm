/**
 * `GET /api/ops` — Operations Center (Task 10).
 *
 * Read-only, wie die übrigen GET-Routen: ohne Token ladbar, damit der Tab im
 * Dashboard erscheint. Der Payload aggregiert zehn Sektionen aus bestehenden
 * Modulen (Universum, Scanner, Portfolio, Zyklen, Broker, Routing, Agenten,
 * Risiko, Audit, Hilfe) und zeigt Rolle sowie Live-Gate-Status.
 *
 * Jede Sektion ist fail-soft: ist ihre Quelle nicht lesbar, erscheint sie als
 * `unavailable` mit redigierter Meldung — die übrigen Sektionen bleiben
 * lesbar. Keine Secrets, keine Credentials, keine Orders, keine Mutation.
 */
import { resolveActor } from "@/auth";
import { publicErrorMessage } from "@/lib/secrets";
import { buildOperationsCenter } from "@/ops";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  try {
    const actor = resolveActor(req);
    const payload = await buildOperationsCenter(actor);
    return Response.json(payload);
  } catch (err) {
    return Response.json(
      { ok: false, error: "INTERNAL_ERROR", message: publicErrorMessage(err) },
      { status: 500 }
    );
  }
}
