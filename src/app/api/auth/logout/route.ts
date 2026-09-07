/**
 * `POST /api/auth/logout` — SEC-08 (v1.36.35): Server-side Session-Revocation und Logout.
 *
 * Beendet eine aktive Browser-Session vor Ablauf der TTL (15 min):
 *   - Revokiert die Session serverseitig in der Revocation-Registry (`state.revokedSessions`),
 *     sodass gestohlene/gespeicherte Cookies sofort ungueltig werden (401/403).
 *   - Loescht die Cookies im Browser (`Set-Cookie: Max-Age=0`).
 *   - Optionale administrative Global-Revocation: Body `{"all": true}` erfordert Admin-
 *     Berechtigung und invalidiert alle bestehenden Sessions via `revokeAllSessions()`.
 *   - Idempotent: Aufrufe ohne aktive Session oder mit bereits abgelaufenen Cookies
 *     liefern ebenfalls 200 und loeschen vorhandene Cookies sicher.
 *
 * Antworten:
 *   200 { ok: true, session: false, revoked: boolean, allRevoked?: boolean }
 *   403 FORBIDDEN — wenn unberechtigte Akteure versuchen `all: true` aufzurufen.
 *   429 RATE_LIMITED — bei Flood-Versuchen.
 */
import { requirePermission } from "@/auth";
import { checkRateLimit } from "@/lib/apiAuth";
import {
  clearSessionCookies,
  readSession,
  revokeAllSessions,
  revokeSession,
} from "@/lib/authSession";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const denied = checkRateLimit(req, { max: 30 });
  if (denied) return denied;

  const session = readSession(req);
  let body: unknown = null;
  try {
    const text = await req.text();
    if (text.trim().length > 0) {
      body = JSON.parse(text);
    }
  } catch {
    // Ungueltiges JSON wird als leerer Body behandelt (normaler Single-Session Logout)
  }

  const wantsAll =
    typeof body === "object" &&
    body !== null &&
    "all" in body &&
    (body as { all: unknown }).all === true;

  if (wantsAll) {
    const adminCheck = requirePermission(req, "broker.credentials");
    if (adminCheck) {
      return adminCheck;
    }
    revokeAllSessions();
  } else if (session) {
    revokeSession(session);
  }

  const headers = new Headers({ "Cache-Control": "no-store" });
  for (const cookie of clearSessionCookies()) {
    headers.append("Set-Cookie", cookie);
  }

  return Response.json(
    {
      ok: true,
      session: false,
      revoked: Boolean(session || wantsAll),
      ...(wantsAll ? { allRevoked: true } : {}),
    },
    { status: 200, headers }
  );
}
