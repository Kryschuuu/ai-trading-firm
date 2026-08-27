/**
 * Guards der Broker Control Plane (Task 08, Regeln 3 + Security):
 *
 *   1. RBAC (minimaler Admin-Guard): Alle Credential-/Connection-Operationen
 *      sind NUR fuer die Admin-Rolle. Es existiert noch kein Session-/
 *      Rollensystem → der Guard ist ein Token-basierter Platzhalter.
 *      Modell:
 *        - FIRM_ADMIN_TOKEN gesetzt  → Header `x-admin-token` (timing-safe)
 *          ODER `x-firm-token` muss matchen, sonst 403 FORBIDDEN.
 *        - nur FIRM_API_TOKEN gesetzt → bestehender Operator-Token-Guard
 *          (x-firm-token, 401) wirkt als Admin-Ersatz (Single-Admin-Modell).
 *        - beides ungesetzt          → lokaler Offen-Betrieb (Standard,
 *          Single-User, Dienst lauscht nur lokal).
 *      TODO(task-10): zentrale RBAC/Sessions ersetzen diesen Guard.
 *
 *   2. CSRF: Alle mutierenden Control-Plane-Endpoints verlangen den
 *      Custom-Header `x-csrf-token` mit dem Wert des Admin-/API-Tokens
 *      (Offen-Betrieb: Konstante "local"). Cross-Site-Formulare koennen
 *      Custom-Header nicht setzen (kein CORS, kein SameSite-Cookie-Fallback
 *      noetig — die API nutzt bewusst KEINE Cookies). Fehlt der Header →
 *      403 CSRF_INVALID.
 *
 *   3. Rate-Limit auf Credential-Versuche: eigener Sliding-Window-Bucket,
 *      Default 5/min/IP (BROKER_CREDENTIAL_RATE_LIMIT, 0 = aus) → 429.
 *
 * Reihenfolge: Auth → CSRF → Rate-Limit.
 */
import { timingSafeEqual } from "node:crypto";
import { checkApiToken } from "@/lib/apiAuth";
import {
  ADMIN_HEADER,
  ADMIN_TOKEN_FLAG,
  CREDENTIAL_RATE_LIMIT_WINDOW_MS,
  CSRF_HEADER,
  CSRF_LOCAL_VALUE,
  credentialRateLimitMax,
} from "./config";

export function adminTokenConfigured(): boolean {
  return Boolean(process.env.FIRM_ADMIN_TOKEN);
}

/** Timing-sicherer Vergleich inkl. Laengen-Padding. */
export function tokenEqualsSafe(got: string, expected: string): boolean {
  const a = Buffer.from(got, "utf8");
  const b = Buffer.from(expected, "utf8");
  const n = Math.max(a.length, b.length, 1);
  const pa = Buffer.alloc(n);
  const pb = Buffer.alloc(n);
  a.copy(pa);
  b.copy(pb);
  const lengthOk = a.length === b.length && b.length > 0;
  const bodyOk = timingSafeEqual(pa, pb);
  return lengthOk && bodyOk;
}

function forbidden(code: string, hint: string): Response {
  return Response.json({ ok: false, error: code, hint }, { status: 403 });
}

/**
 * Admin-Guard (RBAC-Platzhalter). Liefert `null` = erlaubt,
 * sonst eine 401/403-Response.
 */
export function checkAdminGuard(req: Request): Response | null {
  const adminToken = process.env[ADMIN_TOKEN_FLAG];
  if (adminToken) {
    const gotAdmin = req.headers.get(ADMIN_HEADER) ?? "";
    const gotFirm = req.headers.get("x-firm-token") ?? "";
    if (tokenEqualsSafe(gotAdmin, adminToken) || tokenEqualsSafe(gotFirm, adminToken)) {
      return null;
    }
    return forbidden(
      "FORBIDDEN",
      "Credential-/Connection-Operationen sind nur fuer die Admin-Rolle erlaubt (x-admin-token)."
    );
  }
  // Fallback auf den bestehenden Operator-Token-Guard (Single-Admin-Modell).
  return checkApiToken(req);
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
