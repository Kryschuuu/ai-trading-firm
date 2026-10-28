import { privateNoStore } from "@/lib/apiAuth";
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
import { actorAuditId, requirePermission } from "@/auth";
import { getControlPlaneService } from "@/brokers/control-plane/service";
import { guardMutation, checkRateLimit } from "@/lib/apiAuth";
import { mapControlPlaneError } from "@/brokers/control-plane/http";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ venue: string }> };

export async function POST(req: Request, ctx: RouteContext): Promise<Response> {
  const guarded = guardMutation(req, "broker.test");
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

/** Read-only connectivity probe, available to actors with broker.test. */
export async function GET(req: Request, ctx: RouteContext): Promise<Response> {
  return privateNoStore(await (async () => {
  const denied = requirePermission(req, "broker.test") ?? checkRateLimit(req, { max: 10 });
  if (denied) return denied;
  try {
    const { venue } = await ctx.params;
    const service = await getControlPlaneService();
    const result = await service.testConnection(
      actorAuditId(req),
      decodeURIComponent(venue ?? "")
    );
    return Response.json(result, { status: 200, headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return mapControlPlaneError(err);
  }

  })());
}
