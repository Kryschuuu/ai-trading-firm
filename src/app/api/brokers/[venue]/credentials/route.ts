/**
 * `POST|DELETE /api/brokers/{venue}/credentials` — Broker Control Plane
 * (Task 08).
 *
 * Der EINZIGE Punkt, an dem ein Secret ins System gelangt — und zwar nur
 * einmalig (Form → Store). Danach existiert ausschliesslich die
 * verschluesselte Referenz (AES-256-GCM, AAD = Venue-ID).
 *
 * Response-Contract (strikt status-only, niemals Secret-Inhalte):
 *   POST   200 { ok, venue, configured, connected, permissions[], liveEnabled,
 *                probe{state,at,errorCode,message}, layers{} } — KEIN keyHint.
 *   DELETE 200 { ok, venue, configured:false, connected:false,
 *                permissions:[], liveEnabled:false }
 *   Fehler  { ok:false, error, message } (SAFE, redigiert) — 403/404/409/422/429/503.
 *
 * Sicherheit: RBAC (`broker.credentials`, Task 10), CSRF
 * (x-csrf-token), Rate-Limit auf Credential-Versuche (5/min/IP).
 */
import { actorAuditId } from "@/auth";
import { getControlPlaneService } from "@/brokers/control-plane/service";
import { guardCredentialEndpoint } from "@/brokers/control-plane/guard";
import { mapControlPlaneError, readJsonBody } from "@/brokers/control-plane/http";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ venue: string }> };

export async function POST(req: Request, ctx: RouteContext): Promise<Response> {
  const guarded = guardCredentialEndpoint(req);
  if (guarded) return guarded;

  try {
    const { venue } = await ctx.params;
    const body = await readJsonBody(req);
    const service = await getControlPlaneService();
    const result = await service.saveCredentials(
      actorAuditId(req),
      decodeURIComponent(venue ?? ""),
      body
    );
    return Response.json(result, { status: 200 });
  } catch (err) {
    return mapControlPlaneError(err);
  }
}

export async function DELETE(req: Request, ctx: RouteContext): Promise<Response> {
  const guarded = guardCredentialEndpoint(req);
  if (guarded) return guarded;

  try {
    const { venue } = await ctx.params;
    const service = await getControlPlaneService();
    const result = await service.deleteCredentials(
      actorAuditId(req),
      decodeURIComponent(venue ?? "")
    );
    return Response.json(result, { status: 200 });
  } catch (err) {
    return mapControlPlaneError(err);
  }
}
