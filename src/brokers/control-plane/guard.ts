/**
 * Guards der Broker Control Plane (Task 08 + Task 10):
 *
 *   1. RBAC: Credential-/Connection-Operationen brauchen
 *      `broker.credentials` (Admin, bzw. Operator im Single-Admin-Modell
 *      wenn FIRM_ADMIN_TOKEN ungesetzt ist). Quelle: `src/auth/`.
 *      HTTP-Status bleibt kompatibel: Admin-Token gesetzt → 403,
 *      nur Operator-Token → 401, Offen-Betrieb → durch.
 *
 *   2. CSRF: Alle mutierenden Control-Plane-Endpoints verlangen den
 *      Custom-Header `x-csrf-token` mit dem Wert des Admin-/API-Tokens
 *      (Offen-Betrieb: Konstante "local"). Cross-Site-Formulare koennen
 *      Custom-Header nicht setzen. Fehlt der Header → 403 CSRF_INVALID.
 *
 *   3. Rate-Limit auf Credential-Versuche: eigener Sliding-Window-Bucket,
 *      Default 5/min/IP (BROKER_CREDENTIAL_RATE_LIMIT, 0 = aus) → 429.
 *
 * Reihenfolge: Auth → CSRF → Rate-Limit.
 */
import { requirePermission } from "@/auth";
import { tokenEquals } from "@/lib/apiAuth";
import {
  CREDENTIAL_RATE_LIMIT_WINDOW_MS,
  CSRF_HEADER,
  CSRF_LOCAL_VALUE,
  credentialRateLimitMax,
} from "./config";

export { adminTokenConfigured } from "@/auth";

/** Timing-sicherer Vergleich inkl. Laengen-Padding (Alias auf apiAuth). */
export function tokenEqualsSafe(got: string, expected: string): boolean {
  return tokenEquals(got, expected);
}

function forbidden(code: string, hint: string): Response {
  return Response.json({ ok: false, error: code, hint }, { status: 403 });
}

/**
 * Admin-Guard über den RBAC-Kern. Liefert `null` = erlaubt,
 * sonst eine 401/403-Response.
 */
export function checkAdminGuard(req: Request): Response | null {
  return requirePermission(req, "broker.credentials");
}

/** Erwarteter CSRF-Wert: Admin-Token → Operator-Token → Offen-Konstante. */
export function expectedCsrfValue(): string {
  return (
    process.env.FIRM_ADMIN_TOKEN ?? process.env.FIRM_API_TOKEN ?? CSRF_LOCAL_VALUE
  );
}

/**
 * CSRF-Guard: mutierende Endpoints verlangen `x-csrf-token`.
 * Liefert `null` = ok, sonst 403 CSRF_INVALID.
 */
export function checkCsrfGuard(req: Request): Response | null {
  const got = req.headers.get(CSRF_HEADER) ?? "";
  if (tokenEqualsSafe(got, expectedCsrfValue())) return null;
  return forbidden(
    "CSRF_INVALID",
    `Fehlender/falscher ${CSRF_HEADER}-Header auf mutierendem Endpoint.`
  );
}

// ── Rate-Limit (eigener Bucket, getrennt vom Firm-Schreib-Limit) ─────────────

const credentialHits = new Map<string, number[]>();

function credentialClientKey(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const real = req.headers.get("x-real-ip")?.trim();
  return fwd || real || "local";
}

/** Nur Tests: Bucket leeren. */
export function resetCredentialRateLimiterForTests(): void {
  credentialHits.clear();
}

/**
 * Sliding-Window-Limiter fuer Credential-Versuche (Default 5/min/IP).
 * Liefert `null` = ok, sonst 429 mit Retry-After.
 */
export function checkCredentialRateLimit(
  req: Request,
  opts: {
    max?: number;
    windowMs?: number;
    now?: number;
    env?: Record<string, string | undefined>;
  } = {}
): Response | null {
  const max = opts.max ?? credentialRateLimitMax(opts.env);
  if (!Number.isFinite(max) || max <= 0) return null;

  const windowMs = opts.windowMs ?? CREDENTIAL_RATE_LIMIT_WINDOW_MS;
  const now = opts.now ?? Date.now();
  const key = credentialClientKey(req);
  const recent = (credentialHits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= max) {
    const retryAfter = Math.max(1, Math.ceil((windowMs - (now - recent[0])) / 1000));
    return Response.json(
      {
        ok: false,
        error: "RATE_LIMITED",
        hint: "Zu viele Credential-Versuche (Limit: 5/min/IP). Bitte kurz warten.",
      },
      { status: 429, headers: { "Retry-After": String(retryAfter) } }
    );
  }
  recent.push(now);
  credentialHits.set(key, recent);
  return null;
}

/** Auth → CSRF → Rate-Limit fuer alle mutierenden Control-Plane-Endpoints. */
export function guardCredentialEndpoint(req: Request): Response | null {
  return (
    checkAdminGuard(req) ?? checkCsrfGuard(req) ?? checkCredentialRateLimit(req)
  );
}
