/**
 * `GET /api/auth/status` — authentifizierungsfreier, secret-freier Status des
 * Anmelde-Zustands (v1.39.0, S1).
 *
 * Antwortet auf die zwei Fragen, die das Dashboard bisher nicht zeigen konnte:
 *
 *   1. **Ist die Firm-API ueberhaupt eingetragen?** `firmApi.configured` und
 *      die drei Slots (`admin`/`operator`/`viewer`) nennen nur, OB ein Wert
 *      gesetzt ist — nie einen Wert, seine Laenge oder einen Hash.
 *   2. **Laeuft meine Browser-Session gerade?** `session.state` unterscheidet
 *      `active` / `expiring` / `renewable` / `missing` / `expired` /
 *      `max-life` / `revoked` / `invalid` / `open`, damit die UI zwischen
 *      „anmelden“, „verlaengern“ und „Neustart des Dienstes“ trennen kann.
 *
 * Die Session-Felder beschreiben ausschliesslich das Cookie des Anrufers
 * (Signaturpruefung gegen das serverseitige Secret); ohne gueltige Signatur
 * gibt es keinerlei Detail. Bewusst nicht enthalten — im Gegensatz zu
 * `GET /api/auth/me`, das Authentifizierung verlangt: Permissions-Listen,
 * Audit-IDs und die Rate-Limit-Identitaet (`rateLimitIdentity`).
 *
 * Antworten: 200 immer (auch ohne Session) — `ok:true`; ein Statusabruf darf
 * nie selbst ein 401 werfen, sonst kann die UI ihn nicht von einem echten
 * Authentifizierungsfehler unterscheiden.
 */
import { anyTokenConfigured, resolveAuthMode } from "@/auth/authMode";
import { sessionStatus } from "@/lib/authSession";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const mode = resolveAuthMode();
  const status = sessionStatus(req);
  const env = process.env;
  return Response.json(
    {
      ok: true,
      authMode: {
        mode: mode.mode,
        requested: mode.requested,
        reason: mode.reason,
        production: mode.production,
        tokensConfigured: mode.tokensConfigured,
      },
      firmApi: {
        configured: anyTokenConfigured(env),
        admin: Boolean(env.FIRM_ADMIN_TOKEN),
        operator: Boolean(env.FIRM_API_TOKEN),
        viewer: Boolean(env.FIRM_VIEWER_TOKEN),
        /** Sessions sind moeglich: unabhaengiges FIRM_SESSION_SECRET gueltig. */
        sessionsAvailable: status.signable,
      },
      session: {
        active: status.active,
        state: status.state,
        role: status.role,
        elevated: status.elevated,
        open: status.open,
        remainingS: status.lifetime.remainingS,
        idleTtlS: status.lifetime.idleTtlS,
        maxLifeS: status.lifetime.maxLifeS,
        graceS: status.lifetime.graceS,
        renewInS: status.lifetime.renewInS,
        maxLifeRemainingS: status.lifetime.maxLifeRemainingS,
        expiresAt: status.lifetime.expiresAt > 0 ? new Date(status.lifetime.expiresAt).toISOString() : null,
        maxExpiresAt:
          status.lifetime.maxExpiresAt > 0 ? new Date(status.lifetime.maxExpiresAt).toISOString() : null,
        cookieLifetime: status.lifetime.cookieLifetime,
      },
      timestamp: new Date().toISOString(),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
