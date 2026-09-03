/**
 * `GET /api/auth/me` — aktueller Actor (Task 10).
 *
 * Antwort enthält Rolle, Quelle und Permissions — niemals Token-Werte.
 * Local-open (kein Token konfiguriert, Modus `local-open`) ⇒ 200 als Admin.
 * Tokens konfiguriert, kein Treffer ⇒ 401.
 * Kein Token, Modus `token-required` (Produktion) ⇒ 401 `AUTH_NOT_CONFIGURED`.
 *
 * `authMode` (C1, v1.36.13) projiziert die Modus-Entcheidung, damit Control
 * Panel und Betriebs-Skripte sehen, *warum* offen bzw. zu ist — ohne Credential-Werte.
 */
import {
  describeAuthMode,
  resolveAuthMode,
  resolveAuth,
  toPublicActor,
} from "@/auth";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const resolution = resolveAuth(req);
  const mode = resolveAuthMode();
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
    authMode: {
      mode: mode.mode,
      requested: mode.requested,
      reason: mode.reason,
      production: mode.production,
      tokensConfigured: mode.tokensConfigured,
      summary: describeAuthMode(mode),
    },
  });
}
