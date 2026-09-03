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
 *
 * `rateLimitIdentity` (C2, v1.36.14) projiziert dieselbe Transparenz für die
 * Rate-Limit-Identität: welche IP der Limiter für **diesen Aufrufer** verwendet,
 * woher sie stammt (`verified-header` | `trusted-forwarded-for` | `peer` |
 * `local-fallback`) und welche client-gesetzten Header dafür **ignoriert**
 * wurden. Damit ist ein falsch konfigurierter Reverse Proxy in einem `curl`
 * sichtbar, statt sich als wirkungsloses Rate-Limit zu tarnen. Secret-frei:
 * enthalten sind höchstens die Adresse des Aufrufers selbst und Flag-Namen.
 */
import {
  describeAuthMode,
  resolveAuthMode,
  resolveAuth,
  toPublicActor,
} from "@/auth";
import { describeClientIpPolicy, resolveClientIp } from "@/lib/clientIp";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const resolution = resolveAuth(req);
  const mode = resolveAuthMode();
  const identity = resolveClientIp(req);
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
    rateLimitIdentity: {
      key: identity.key,
      ip: identity.ip,
      source: identity.source,
      peerAvailable: identity.peerIp !== null,
      trustedProxiesConfigured: identity.trustedProxiesConfigured,
      ignoredHeaders: identity.ignoredHeaders,
      policy: describeClientIpPolicy(),
    },
  });
}
