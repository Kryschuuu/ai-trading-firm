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
 *   3. Rate-Limit auf Credential-Versuche — seit C2 (v1.36.14) geschichtet:
 *      a) pro Client-Identitaet: Sliding-Window, Default 5/min
 *         (BROKER_CREDENTIAL_RATE_LIMIT, 0 = aus) → 429. Die Identitaet kommt
 *         aus `src/lib/clientIp.ts` (`resolveClientIp`) und ist ohne
 *         Proxy-Vertrauenskonfiguration nicht client-setzbar — ein
 *         `X-Forwarded-For` pro Request erzeugt keinen neuen Bucket mehr.
 *      b) global, IP-unabhaengig: Default 20/min ueber alle Clients
 *         (BROKER_CREDENTIAL_GLOBAL_RATE_LIMIT, 0 = aus) → 429. Faengt
 *         verteiltes Raten (Proxy-Wechsel, NAT, Botnet), weil der Bucket
 *         bewusst NICHT aus der Request-Identitaet stammt.
 *      c) exponentieller Backoff: ab dem 3. fehlgeschlagenen Versuch
 *         (`recordCredentialFailure`, von der Credential-Route bei 422
 *         VALIDATION_ERROR und abgelehnter Venue-Probe gemeldet) wachsende
 *         Sperre 2 s → 4 s → 8 s … max. 15 min;
 *         Ruecksetzung nach 15 min Ruhe oder einem erfolgreichen Versuch.
 *
 * Reihenfolge: Auth → CSRF → Backoff → Limit (Identitaet) → Limit (global).
 * Die Live-Gate-Routen (`/api/live/kill`, `/api/live/transition`) nutzen
 * weiterhin NUR (a): Der Kill-Switch darf weder durch einen globalen
 * Credential-Flood noch durch einen Backoff blockierbar sein.
 */
import { requirePermission } from "@/auth";
import { tokenEquals } from "@/lib/apiAuth";
import { clientRateLimitKey, type ClientIpOptions } from "@/lib/clientIp";
import {
  CREDENTIAL_BACKOFF_RESET_MS,
  CREDENTIAL_RATE_LIMIT_WINDOW_MS,
  CSRF_HEADER,
  CSRF_LOCAL_VALUE,
  GLOBAL_CREDENTIAL_BUCKET_KEY,
  credentialBackoffConfig,
  credentialBackoffMs,
  credentialGlobalRateLimitMax,
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

// ── Rate-Limit (eigene Buckets, getrennt vom Firm-Schreib-Limit) ─────────────

/** Treffer pro Client-Identitaet (Schluessel aus `resolveClientIp`). */
const credentialHits = new Map<string, number[]>();
/** Treffer des globalen, IP-unabhaengigen Buckets (fester Schluessel). */
const globalHits = new Map<string, number[]>();
/** Fehlversuche + aktive Backoff-Sperre pro Client-Identitaet. */
const credentialFailures = new Map<
  string,
  { count: number; lastAt: number; blockedUntil: number }
>();

/**
 * Bucket-Schluessel = **dieselbe** Aufloesung wie im Firm-Schreib-Limit
 * (`src/lib/apiAuth.ts`): geteiltes `resolveClientIp()` statt einer zweiten,
 * eigenbaeulichen Header-Logik (Befund C2, Punkt 3).
 */
function credentialClientKey(req: Request, opts: ClientIpOptions = {}): string {
  return clientRateLimitKey(req, opts);
}

/** Nur Tests: alle Buckets (Identitaet, global, Backoff) leeren. */
export function resetCredentialRateLimiterForTests(): void {
  credentialHits.clear();
  globalHits.clear();
  credentialFailures.clear();
}

export type CredentialLimitOptions = ClientIpOptions & {
  max?: number;
  windowMs?: number;
  now?: number;
  env?: Record<string, string | undefined>;
};

export type CredentialGlobalLimitOptions = {
  max?: number;
  windowMs?: number;
  now?: number;
  env?: Record<string, string | undefined>;
};

function rateLimited(code: string, hint: string, retryAfterS: number): Response {
  return Response.json(
    { ok: false, error: "RATE_LIMITED", code, hint },
    { status: 429, headers: { "Retry-After": String(retryAfterS) } }
  );
}

/**
 * Sliding-Window-Kern. Liefert `null` = erlaubt (Treffer zaehlt), sonst die
 * `Retry-After`-Sekunden. `max <= 0` bzw. NaN deaktiviert den Layer.
 */
function windowHit(
  store: Map<string, number[]>,
  key: string,
  max: number,
  windowMs: number,
  now: number
): number | null {
  if (!Number.isFinite(max) || max <= 0) return null;
  if (!Number.isFinite(windowMs) || windowMs <= 0) return null;
  const recent = (store.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= max) {
    store.set(key, recent);
    const oldest = recent[0] ?? now;
    return Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000));
  }
  recent.push(now);
  store.set(key, recent);
  return null;
}

/**
 * Layer (a): Sliding-Window-Limiter pro Client-Identitaet (Default 5/min).
 * Liefert `null` = ok, sonst 429 mit Retry-After.
 */
export function checkCredentialRateLimit(
  req: Request,
  opts: CredentialLimitOptions = {}
): Response | null {
  const max = opts.max ?? credentialRateLimitMax(opts.env);
  if (!Number.isFinite(max) || max <= 0) return null;

  const windowMs = opts.windowMs ?? CREDENTIAL_RATE_LIMIT_WINDOW_MS;
  const now = opts.now ?? Date.now();
  const key = credentialClientKey(req, { peerIp: opts.peerIp, env: opts.env });
  const retryAfter = windowHit(credentialHits, key, max, windowMs, now);
  if (retryAfter === null) return null;
  return rateLimited(
    "CREDENTIAL_RATE_LIMITED",
    `Zu viele Credential-Versuche pro Client (Limit: ${max}/${Math.round(
      windowMs / 60000
    )} min). Bitte kurz warten.`,
    retryAfter
  );
}

/**
 * Layer (b): globales Credential-Limit — **IP-unabhaengig** (fester
 * Bucket-Schluessel `global`, Default 20/min). Verteiltes Raten mit
 * wechselnden Identitaeten laeuft trotzdem in eine Deckelung; umgekehrt kann
 * ein einzelner Flooder den Kill-Switch nicht blockieren, weil die
 * Live-Gate-Routen diesen Layer nicht nutzen.
 */
export function checkCredentialGlobalRateLimit(
  opts: CredentialGlobalLimitOptions = {}
): Response | null {
  const max = opts.max ?? credentialGlobalRateLimitMax(opts.env);
  if (!Number.isFinite(max) || max <= 0) return null;

  const windowMs = opts.windowMs ?? CREDENTIAL_RATE_LIMIT_WINDOW_MS;
  const now = opts.now ?? Date.now();
  const retryAfter = windowHit(
    globalHits,
    GLOBAL_CREDENTIAL_BUCKET_KEY,
    max,
    windowMs,
    now
  );
  if (retryAfter === null) return null;
  return rateLimited(
    "CREDENTIAL_GLOBAL_RATE_LIMITED",
    `Zu viele Credential-Versuche insgesamt (globales Limit: ${max}/${Math.round(
      windowMs / 60000
    )} min). Bitte kurz warten.`,
    retryAfter
  );
}

/**
 * Meldet einen **fehlgeschlagenen** Credential-Versuch (von der Route bei 422
 * VALIDATION_ERROR bzw. `probe.state === "error"` aufgerufen) und berechnet die
 * exponentielle Sperre. Zaehlung beginnt nach
 * `CREDENTIAL_BACKOFF_RESET_MS` Ruhe neu; unterhalb des Schwellwerts (3)
 * passiert nichts — ein Tippfehler sperrt niemanden aus.
 */
export function recordCredentialFailure(
  req: Request,
  opts: ClientIpOptions & { now?: number } = {}
): { failures: number; backoffMs: number } {
  const key = credentialClientKey(req, { peerIp: opts.peerIp, env: opts.env });
  const now = opts.now ?? Date.now();
  const prev = credentialFailures.get(key);
  const fresh = prev === undefined || now - prev.lastAt > CREDENTIAL_BACKOFF_RESET_MS;
  const count = fresh ? 1 : (prev?.count ?? 0) + 1;
  const backoffMs = credentialBackoffMs(count, credentialBackoffConfig(opts.env));
  credentialFailures.set(key, {
    count,
    lastAt: now,
    blockedUntil: backoffMs > 0 ? now + backoffMs : 0,
  });
  return { failures: count, backoffMs };
}

/** Erfolgsfall: Backoff-Zaehlung der Identitaet loeschen. */
export function recordCredentialSuccess(
  req: Request,
  opts: ClientIpOptions = {}
): void {
  credentialFailures.delete(
    credentialClientKey(req, { peerIp: opts.peerIp, env: opts.env })
  );
}

/** Backoff-Zustand einer Identitaet (Diagnose/Tests, secret-frei). */
export function credentialBackoffState(
  req: Request,
  opts: ClientIpOptions & { now?: number } = {}
): { key: string; failures: number; blockedUntil: number; retryAfterMs: number } {
  const key = credentialClientKey(req, { peerIp: opts.peerIp, env: opts.env });
  const now = opts.now ?? Date.now();
  const state = credentialFailures.get(key);
  if (!state || state.blockedUntil <= now) {
    return { key, failures: state?.count ?? 0, blockedUntil: 0, retryAfterMs: 0 };
  }
  return {
    key,
    failures: state.count,
    blockedUntil: state.blockedUntil,
    retryAfterMs: state.blockedUntil - now,
  };
}

/**
 * Layer (c): exponentieller Backoff. Liefert 429, solange eine Sperre aus
 * frueheren Fehlversuchen laeuft — `Retry-After` ist die Restsperre.
 */
export function checkCredentialBackoff(
  req: Request,
  opts: ClientIpOptions & { now?: number } = {}
): Response | null {
  const state = credentialBackoffState(req, opts);
  if (state.retryAfterMs <= 0) return null;
  return rateLimited(
    "CREDENTIAL_BACKOFF",
    `Zu viele fehlgeschlagene Credential-Versuche (${state.failures}) — exponentielle Sperre, bitte ${Math.ceil(
      state.retryAfterMs / 1000
    )} s warten.`,
    Math.max(1, Math.ceil(state.retryAfterMs / 1000))
  );
}

/**
 * Auth → CSRF → Backoff → Limit (Identitaet) → Limit (global) fuer alle
 * mutierenden Control-Plane-Endpoints.
 *
 * Reihenfolge mit Absicht: Was bereits an Auth/CSRF scheitert, verbraucht kein
 * Budget, und was am Identitaets-Limit scheitert, verbraucht kein globales
 * Budget — sonst koennte ein einzelner Angreifer die globale Deckelung fuellen
 * und damit legitime Admins aussperren (DoS auf die Sicherheitsschicht).
 */
export function guardCredentialEndpoint(
  req: Request,
  opts: CredentialLimitOptions = {}
): Response | null {
  return (
    checkAdminGuard(req) ??
    checkCsrfGuard(req) ??
    checkCredentialBackoff(req, opts) ??
    checkCredentialRateLimit(req, opts) ??
    checkCredentialGlobalRateLimit(opts)
  );
}
