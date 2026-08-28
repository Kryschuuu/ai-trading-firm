/**
 * `POST /api/brokers/{venue}/discover` — Market Discovery der Control Plane
 * (Task 08).
 *
 * Definierte Aktion "discover" der Zustandsmaschine: nur nach aktiver
 * Verbindung und nur bei capabilities.discovery=true — sonst 409/422.
 * Antwort status-only: { ok, venue, discovery{state,count,lastSync}, layers{} }.
 *
 * PAPER nutzt die lokale Universe-Registry (offline). Echte Venue-Discovery
 * folgt mit den Adapter-Aufgaben (TODO(task-02/07)) — bis dahin lehnt der
 * Endpunkt fuer nicht implementierte Venues mit
 * 422 DISCOVERY_NOT_IMPLEMENTED ab (ehrlich statt Fake).
 */
import { getControlPlaneService } from "@/brokers/control-plane/service";
import { guardCredentialEndpoint } from "@/brokers/control-plane/guard";
import { mapControlPlaneError } from "@/brokers/control-plane/http";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ venue: string }> };

export async function POST(req: Request, ctx: RouteContext): Promise<Response> {
  const guarded = guardCredentialEndpoint(req);
  if (guarded) return guarded;

  try {
    const { venue } = await ctx.params;
    const service = await getControlPlaneService();
    const result = await service.discover("admin", decodeURIComponent(venue ?? ""));
    return Response.json(result, { status: 200 });
  } catch (err) {
    return mapControlPlaneError(err);
  }
}
