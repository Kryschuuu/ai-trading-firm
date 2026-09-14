/**
 * `POST /api/auth/login` — W1 (v1.36.23): Token-Session statt localStorage.
 *
 * Der Browser sendet den (einmal eingegebenen) FIRM_API_TOKEN/FIRM_ADMIN_TOKEN
 * hierher. Der Server verifiziert ihn über die RBAC-Auflösung und antwortet
 * ausschließlich mit:
 *   - Set-Cookie `firm_session`  (HttpOnly, Secure, SameSite=Strict — seit
 *     v1.39.0 OHNE `Max-Age`: Browser-Session-Cookie, der Browser wirft sie
 *     beim Schließen des Fensters weg)
 *   - Set-Cookie `firm_csrf`     (non-HttpOnly für Double-Submit, gleiche Flags)
 * Der rohe Token wird NIE zurückgegeben und NIE in localStorage gelegt.
 *
 * Autorisiert wird damit nur innerhalb der Idle-Frist (`exp`, Default 900 s);
 * `POST /api/auth/refresh` verschiebt sie, die absolute Grenze (`maxExp`,
 * Default 24 h) bleibt. Die Antwort nennt beide Fristen, damit der Client den
 * Takt selbst stellen kann — ohne die Laufzeit raten zu müssen.
 *
 * Antworten:
 *   200 { ok, actor, session, expiresInS, lifetime, open? }  — Session gesetzt
 *   400 SESSION_HTTPS_REQUIRED  — Produktion über plain-HTTP (fail-closed)
 *   400 MISSING_TOKEN           — leeres Feld
 *   401/403                    — falscher Token (resolveAuth entscheidet)
 *   503 SESSION_SECRET_*       — Session-Signierung nicht sicher konfiguriert
 *
 * Der Login-Pfad ist Rate-limitiert (geteilter Firm-Limiter), damit
 * Token-Raten über Versuche messbar/gebremst werden.
 */
import { resolveAuth, toPublicActor } from "@/auth";
import { resolveAuthMode } from "@/auth/authMode";
import { checkRateLimit } from "@/lib/apiAuth";
import { issueSession, sessionIdleTtlS } from "@/lib/authSession";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const denied = checkRateLimit(req, { max: 20 });
  if (denied) return denied;

  const body: unknown = await req.json().catch(() => null);
  const token =
    typeof body === "object" && body !== null && "token" in body && typeof body.token === "string"
      ? body.token.trim()
      : "";
  if (!token) {
    return Response.json(
      {
        ok: false,
        error: "MISSING_TOKEN",
        hint: 'Body {"token": "<FIRM_API_TOKEN|FIRM_ADMIN_TOKEN|FIRM_VIEWER_TOKEN>"} fehlt oder ist leer.',
      },
      { status: 400 }
    );
  }

  // Verifikation serverseitig gegen die konfigurierten Tokens — deckt Admin-,
  // Operator- und Viewer-Token über resolveAuth ab (x-firm-token-Weg).
  const probe = new Request(req.url, {
    method: "POST",
    headers: { "x-firm-token": token },
  });
  const resolution = resolveAuth(probe);
  if (!resolution.ok) {
    return Response.json(
      { ok: false, error: resolution.error, hint: resolution.hint },
      { status: resolution.status }
    );
  }

  const session = issueSession(req, resolution.actor);
  if (!session.ok) {
    return Response.json(
      { ok: false, error: session.error, hint: session.hint },
      { status: session.status }
    );
  }

  const headers = new Headers({ "Cache-Control": "no-store" });
  for (const cookie of session.cookies) headers.append("Set-Cookie", cookie);

  return Response.json(
    {
      ok: true,
      actor: toPublicActor(resolution.actor),
      session: !session.open,
      open: session.open,
      // Idle-Frist des frischen Cookies; der Client verlängert über
      // POST /api/auth/refresh, bevor sie abläuft (siehe lifetime.renewInS).
      expiresInS: session.open ? 0 : session.lifetime.remainingS || sessionIdleTtlS(),
      cookieLifetime: session.lifetime.cookieLifetime,
      lifetime: session.open
        ? null
        : {
            expiresAt: new Date(session.lifetime.expiresAt).toISOString(),
            maxExpiresAt: new Date(session.lifetime.maxExpiresAt).toISOString(),
            remainingS: session.lifetime.remainingS,
            maxLifeRemainingS: session.lifetime.maxLifeRemainingS,
            renewInS: session.lifetime.renewInS,
            idleTtlS: session.lifetime.idleTtlS,
            maxLifeS: session.lifetime.maxLifeS,
            graceS: session.lifetime.graceS,
          },
      authMode: resolveAuthMode().mode,
    },
    { status: 200, headers }
  );
}