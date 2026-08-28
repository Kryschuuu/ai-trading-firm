/**
 * `GET /api/auth/me` — aktueller Actor (Task 10).
 *
 * Antwort enthält Rolle, Quelle und Permissions — niemals Token-Werte.
 * Local-open (kein Token konfiguriert) ⇒ 200 als Admin.
 * Tokens konfiguriert, kein Treffer ⇒ 401.
 */
import { resolveAuth, toPublicActor } from "@/auth";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const resolution = resolveAuth(req);
  if (!resolution.ok) {
    return Response.json(
      { ok: false, error: resolution.error, hint: resolution.hint },
      { status: resolution.status }
    );
  }
  return Response.json({
    ok: true,
    actor: toPublicActor(resolution.actor),
    tokensConfigured: {
      admin: Boolean(process.env.FIRM_ADMIN_TOKEN),
      operator: Boolean(process.env.FIRM_API_TOKEN),
      viewer: Boolean(process.env.FIRM_VIEWER_TOKEN),
    },
  });
}
