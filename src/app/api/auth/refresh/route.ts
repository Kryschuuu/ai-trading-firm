/**
 * `POST /api/auth/refresh` — Verlaengerung der Browser-Session (v1.39.0, S1).
 *
 * Die Sitzung gilt, bis das Browserfenster geschlossen wird: Das Cookie hat
 * kein `Max-Age`/`Expires` mehr, der Browser wirft es also mit der
 * Browsersession weg. Autorisiert wird dadurch trotzdem nur innerhalb der
 * Idle-Frist — diese Route verschiebt die Idle-Frist nach vorne, und zwar
 * ausschliesslich, wenn
 *
 *   1. eine signierte Session vorhanden ist (auch die Nachfrist nach
 *      Idle-Ablauf als Puffer gilt: `FIRM_SESSION_GRACE_S`, Default 900 s),
 *   2. der Double-Submit-Header `x-csrf-token` exakt zum session-gebundenen
 *      Wert passt — geprueft in `renewSession` selbst, nicht hier, damit kein
 *      Aufrufer die Pruefung vergessen kann (Legacy „Header == Token“ gilt hier
 *      bewusst NICHT),
 *   3. die Session nicht widerrufen ist und die Auth-Konfiguration sich nicht
 *      geaendert hat (`authEpoch`, SEC-01/SEC-08),
 *   4. die absolute Obergrenze `maxExp` (`FIRM_SESSION_MAX_LIFE_S`, Default
 *      24 h) noch nicht erreicht ist — die wird durch keine Verlaengerung
 *      bewegt.
 *
 * Außerhalb des Verlaengerungsfensters (Restzeit über `SESSION_RENEW_WINDOW_S`) passiert nichts:
 * `renewed:false`, kein neues Cookie, keine Signaturarbeit. Der Login-Pfad
 * bleibt davon unberuehrt — eine Session kann sich nie selbst ausstellen, die
 * Authentifizierung gegen die konfigurierten Tokens erfordert immer
 * `POST /api/auth/login`.
 *
 * Antworten:
 *   200 { ok, session:true, renewed, lifetime… }   — verlaengert oder nicht noetig
 *   200 { ok, open:true, renewed:false }           — Offen-Betrieb (keine Session)
 *   400 SESSION_HTTPS_REQUIRED                     — Produktion über plain-HTTP
 *   401 SESSION_REQUIRED / SESSION_INVALID / SESSION_REVOKED /
 *       SESSION_MAX_LIFE_REACHED                   — neu anmelden erforderlich
 *   403 CSRF_INVALID                                — Double-Submit fehlt/falsch
 *   429 RATE_LIMITED                                — Flood-Schutz (30/min)
 *   503 SESSION_SECRET_*                            — Signierung nicht konfiguriert
 */
import { checkRateLimit } from "@/lib/apiAuth";
import { renewSession, sessionRenewWindowS } from "@/lib/authSession";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const denied = checkRateLimit(req, { max: 30 });
  if (denied) return denied;

  const result = renewSession(req, process.env, Date.now());
  if (!result.ok) {
    return Response.json(
      { ok: false, error: result.error, hint: result.hint, session: false },
      { status: result.status }
    );
  }

  const headers = new Headers({ "Cache-Control": "no-store" });
  for (const cookie of result.cookies) headers.append("Set-Cookie", cookie);

  return Response.json(
    {
      ok: true,
      open: result.open,
      session: !result.open,
      renewed: result.renewed,
      actor: result.actor
        ? { role: result.actor.role, effectiveRole: result.actor.effectiveRole, elevated: result.actor.elevated }
        : null,
      expiresAt: result.open ? 0 : new Date(result.lifetime.expiresAt).toISOString(),
      expiresInS: result.lifetime.remainingS,
      renewInS: result.lifetime.renewInS,
      renewWindowS: sessionRenewWindowS(),
      maxLifeRemainingS: result.lifetime.maxLifeRemainingS,
      cookieLifetime: result.lifetime.cookieLifetime,
    },
    { status: 200, headers }
  );
}
