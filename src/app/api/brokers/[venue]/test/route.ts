/**
 * `POST /api/brokers/{venue}/test` — Verbindungstest der Control Plane
 * (Task 08).
 *
 * Fuehrt healthCheck + read-only Account-Probe aus und leitet daraus
 * `permissions[]` ab (z. B. READ, TRADE). Antwort status-only:
 *   { ok, venue, configured, connected, permissions[], liveEnabled:false,
 *     health{status,latencyMs,details} }
 * Fehler → Zustand error mit SAFE-Meldung (kein Secret-Leak).
 *
 * Sicherheit: Admin-Guard, CSRF, Credential-Rate-Limit (wie alle
 * mutierenden Control-Plane-Endpoints).
 */
import { actorAuditId } from "@/auth";
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
    const result = await service.testConnection(
      actorAuditId(req),
      decodeURIComponent(venue ?? "")
    );
    return Response.json(result, { status: 200 });
  } catch (err) {
    return mapControlPlaneError(err);
  }
}
