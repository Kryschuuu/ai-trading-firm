/**
 * Broker-Health: Feature-Flag + read-only Remote-Checks (Task 02).
 *
 * SICHERHEITS-SEMANTIK (Regel 4):
 *   - Remote-Checks sind DEFAULT OFF (`BROKER_HEALTHCHECK_REMOTE=false`).
 *   - Sie sind read-only, Credential-frei und greifen nur auf öffentlich
 *     zugängliche Venue-Endpunkte zu. Es werden KEINE Credentials gelesen,
 *     verlangt oder übergeben.
 *   - ALPACA/IBKR/DYDX führen bewusst KEINEN Remote-Check aus:
 *       ALPACA → Paper-API verlangt API-Keys (Credentials = kein Scope hier).
 *       IBKR   → benötigt dauerhaft laufendes TWS/IB-Gateway (kein Scope hier).
 *       DYDX   → für v4 steht in diesem Stadium kein verifizierter
 *                read-only Status-Endpunkt zur Verfügung.
 *     Sie melden `degraded` mit dem maschinenlesbaren Grund — statt zu raten.
 */
import type { BrokerHealthStatus, BrokerVenueId } from "../contracts/broker";
import { publicErrorMessage } from "../lib/secrets";

export const REMOTE_HEALTHCHECK_FLAG = "BROKER_HEALTHCHECK_REMOTE";

/** Default: "false" (oder nicht gesetzt) → kein Netzwerkverkehr. */
export function remoteHealthCheckEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  return env[REMOTE_HEALTHCHECK_FLAG] === "true";
}

/** Timeout je Remote-Check — Health-Endpunkte dürfen nicht hängen. */
export const REMOTE_HEALTH_TIMEOUT_MS = 4000;

export interface RemoteCheckResult {
  status: BrokerHealthStatus;
  details: Record<string, unknown>;
}

async function fetchReadOnly(url: string, timeoutMs = REMOTE_HEALTH_TIMEOUT_MS): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // Read-only GET, kein Body, keine Auth-Header, keine Cookies.
    return await fetch(url, { signal: ctrl.signal, cache: "no-store" });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read-only Remote-Checks je Venue. NUR öffentlich, credential-frei.
 * Fehlender Eintrag = keine Remote-Check-Möglichkeit in diesem Stadium
 * (der Stub meldet `degraded` + Grund).
 */
export const REMOTE_HEALTH_CHECKERS: Partial<
  Record<BrokerVenueId, () => Promise<RemoteCheckResult>>
> = {
  /** Binance Public REST — kein Key erforderlich. */
  BINANCE: async () => {
    const res = await fetchReadOnly("https://api.binance.com/api/v3/ping");
    if (res.ok) {
      return { status: "online", details: { endpoint: "public-ping", httpStatus: res.status } };
    }
    return { status: "degraded", details: { httpStatus: res.status } };
  },
  /** Kraken Public REST — kein Key erforderlich. */
  KRAKEN: async () => {
    const res = await fetchReadOnly("https://api.kraken.com/0/public/Time");
    let ok = false;
    try {
      const data = (await res.json()) as { error?: unknown[] };
      ok = res.ok && Array.isArray(data.error) && data.error.length === 0;
    } catch {
      ok = false;
    }
    return ok
      ? { status: "online", details: { endpoint: "public-time", httpStatus: res.status } }
      : { status: "degraded", details: { reason: "UNEXPECTED_RESPONSE", httpStatus: res.status } };
  },
};

/**
 * Führt den Remote-Check eines Venue aus (nur wenn der Flag aktiv ist).
 * @returns Ergebnis oder null, wenn das Venue keinen Remote-Check hat.
 */
export async function runRemoteHealthCheck(
  venue: BrokerVenueId,
  env: Record<string, string | undefined> = process.env
): Promise<RemoteCheckResult | null> {
  if (!remoteHealthCheckEnabled(env)) return null;
  const checker = REMOTE_HEALTH_CHECKERS[venue];
  if (!checker) return null;
  try {
    const t0 = performance.now();
    const result = await checker();
    result.details.latencyMs = Math.max(0, Math.round(performance.now() - t0));
    return result;
  } catch (e) {
    // Fehlermeldung redigieren — kein Host-/Infrastruktur-Leak.
    return {
      status: "offline",
      details: { reason: "REMOTE_CHECK_FAILED", error: publicErrorMessage(e, "Remote-Check fehlgeschlagen") },
    };
  }
}
