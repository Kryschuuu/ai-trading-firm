/**
 * `GET /api/firm/kill/challenge` — Disarm-Challenge (Befund C3, v1.36.15).
 *
 * Ein Disarm des Firm-Kill-Switch darf nicht mehr mit einem gestohlenen
 * Operator-Token ausgelöst werden können. Der Client holt hier zunächst einen
 * kurzlebigen, single-use **Nonce** und echot ihn im Disarm-Body
 * (`POST /api/firm/kill` mit `{ arm: false, nonce }`) zurück.
 *
 * Antwort: `{ ok: true, nonce, expiresAt }` (Nonce läuft in 60 s ab).
 *
 * Die Challenge selbst ist ADMIN-gated (`live.gate`) + CSRF-geschützt, damit
 * nur ein berechtigter Admin sie anfordern kann — dieselbe Guard-Kette wie beim
 * Disarm. `live.gate` wird in `src/auth` ausschließlich der Admin-Rolle gewährt.
 */
import { requirePermission } from "@/auth";
import { checkCsrfGuard } from "@/brokers/control-plane/guard";
import { issueDisarmNonce } from "@/lib/disarmChallenge";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const denied = requirePermission(req, "live.gate") ?? checkCsrfGuard(req);
  if (denied) return denied;

  const { nonce, expiresAt } = issueDisarmNonce();
  return Response.json({ ok: true, nonce, expiresAt });
}
