/**
 * `GET /api/brokers/{venue}/status` — Control-Plane-Status (Task 08).
 *
 * Antwort ist strikt status-only: configured/connected/permissions[]/
 * liveEnabled (IMMER false, Quelle = Gate-Service-Meldung), discovery
 * {state,count,lastSync}, health und die 6 Zustands-Ebenen
 * (connection, marketDiscovery, permissions, paper, testnet, live) je
 * off/pending/active/error. NIE ein Secret, NIE ein keyHint.
 *
 * Read-only ⇒ kein Admin-Token erforderlich (konsistent mit den uebrigen
 * GET-Endpunkten des Projekts).
 */
import { getControlPlaneService } from "@/brokers/control-plane/service";
import { mapControlPlaneError } from "@/brokers/control-plane/http";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ venue: string }> };

export async function GET(_req: Request, ctx: RouteContext): Promise<Response> {
  try {
    const { venue } = await ctx.params;
    const service = await getControlPlaneService();
    const result = await service.getStatus(decodeURIComponent(venue ?? ""));
    return Response.json(result, { status: 200 });
  } catch (err) {
    return mapControlPlaneError(err);
  }
}
