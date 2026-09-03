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
 * (x-csrf-token), Rate-Limit auf Credential-Versuche — seit C2/v1.36.14
 * geschichtet: pro Client-Identität (5/min, Identität NICHT mehr aus spoofbaren
 * Headern), global IP-unabhängig (20/min) und exponentieller Backoff ab dem
 * 3. fehlgeschlagenen Versuch.
 *
 * Nur POST liefert das Brute-Force-Signal (DELETE transportiert kein
 * Credential): eine von der Venue abgelehnte Probe
 * (`probe.state === "error"`) und ein 422 VALIDATION_ERROR zählen als
 * Fehlversuch (`recordCredentialFailure`), ein akzeptiertes Credential setzt
 * zurück (`recordCredentialSuccess`). Zustandskonflikte (409) und
 * Infrastrukturfehler (5xx) zählen bewusst nicht — ein kaputter Secret-Store
 * darf den Betreiber nicht aussperren.
 */
import { actorAuditId } from "@/auth";
import { getControlPlaneService } from "@/brokers/control-plane/service";
import {
  guardCredentialEndpoint,
  recordCredentialFailure,
  recordCredentialSuccess,
} from "@/brokers/control-plane/guard";
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
    // Brute-Force-Signal (C2): Die Venue beantwortet das Credential in der
    // Read-only-Probe. `probe.state === "error"` heisst „Zugangsdaten abgelehnt“
    // — genau der Fall, für den der exponentielle Backoff da ist. Akzeptiert
    // die Venue, wird die Fehlversuchszählung zurückgesetzt (ein Betreiber mit
    // Tippfehler zuvor soll nicht ausgesperrt bleiben).
    if (result.probe.state === "ok") recordCredentialSuccess(req);
    else recordCredentialFailure(req);
    return Response.json(result, { status: 200 });
  } catch (err) {
    const response = mapControlPlaneError(err);
    // Nur Fehler, die das Credential/den Request selbst betreffen (422
    // VALIDATION_ERROR), zählen als Fehlversuch. Zustandskonflikte (409,
    // z. B. ALREADY_CONNECTED) und Infrastrukturfehler (503 SECRET_STORE_*,
    // 500) sperren niemanden aus — ein kaputter Store ist kein Brute-Force.
    if (response.status === 422) recordCredentialFailure(req);
    return response;
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
