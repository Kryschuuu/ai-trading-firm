/**
 * Broker-Health: Feature-Flag + read-only Remote-Checks (Task 02).
 *
 * SICHERHEITS-SEMANTIK (Regel 4):
 *   - Remote-Checks sind DEFAULT OFF (`BROKER_HEALTHCHECK_REMOTE=false`).
 *   - Sie sind read-only, Credential-frei und greifen nur auf öffentlich
 *     zugängliche Venue-/Datenquellen-Endpunkte zu. Es werden KEINE
 *     Credentials gelesen, verlangt oder übergeben.
 *   - ALPACA/IBKR haben keine credential-freie **Trading**-API (Alpaca:
 *     Paper-API verlangt Keys; IBKR: dauerhaft laufendes TWS/Gateway). Geprüft
 *     wird deshalb die dokumentierte **Sync-/Datenquelle** beider Venues
 *     (Yahoo Finance, s. `src/marketdata/adapters/yahoo.ts`) — der Endpunkt,
 *     von dem Kerzen und Ticker für den Warmup kommen. Das Ergebnis ist
 *     ausdrücklich als `scope: "market-data-source"` gekennzeichnet; die
 *     Trading-API bleibt ohne Credentials ungeprüft.
 *   - DYDX → für v4 steht in diesem Stadium kein verifizierter read-only
 *     Status-Endpunkt zur Verfügung (meldet `degraded` + Grund statt zu raten).
 *
 * BEDIENUNG: Der Schalter ist ohne Prozess-Neustart über die UI änderbar
 * (`provider`-unabhängiger Runtime-Flag `broker.healthcheck.remote`,
 * `src/lib/runtimeFlags.ts`). Auflösung: Runtime-Flag → Env → Default `false`.
 */
import type { BrokerHealthStatus, BrokerVenueId } from "../contracts/broker";
import { publicErrorMessage } from "../lib/secrets";
import {
  type RuntimeFlagSource,
  type RuntimeFlagSpec,
  resolveRuntimeFlag,
} from "../lib/runtimeFlags";

export const REMOTE_HEALTHCHECK_FLAG = "BROKER_HEALTHCHECK_REMOTE";

/** Runtime-Schalter (UI) für die Remote-Checks. */
export const REMOTE_HEALTHCHECK_SPEC: RuntimeFlagSpec = {
  key: "broker.healthcheck.remote",
  label: "Broker-Remote-Checks",
  description:
    "Erlaubt read-only Netzpings an öffentliche Venue-/Datenquellen-Endpunkte (keine Credentials, keine Orders). Aus = ausschließlich lokaler Health-Status.",
  envVar: REMOTE_HEALTHCHECK_FLAG,
  defaultValue: false,
};

/**
 * Effektiver Zustand + Quelle (`runtime` = UI-Schalter, `env` = .env,
 * `default` = aus). Primär für API/UI-Transparenz.
 */
export function resolveRemoteHealthcheck(
  env: Record<string, string | undefined> = process.env
): { enabled: boolean; source: RuntimeFlagSource } {
  const resolved = resolveRuntimeFlag(REMOTE_HEALTHCHECK_SPEC, env);
  return { enabled: resolved.value, source: resolved.source };
}

/** Default: "false" (oder nicht gesetzt) → kein Netzwerkverkehr. */
export function remoteHealthCheckEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  return resolveRemoteHealthcheck(env).enabled;
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
  /** Bitunix Public REST — tickers, kein Key. */
  BITUNIX: async () => {
    const res = await fetchReadOnly("https://fapi.bitunix.com/api/v1/futures/market/tickers?symbols=BTCUSDT");
    if (res.ok) {
      return { status: "online", details: { endpoint: "public-tickers", httpStatus: res.status } };
    }
    return { status: "degraded", details: { httpStatus: res.status } };
  },
  /**
   * ALPACA — Sync-/Datenquellen-Check (Yahoo Finance, credential-frei).
   *
   * Alpacas Trading-API verlangt API-Keys und ist damit kein Scope dieses
   * read-only Health-Pfads. Geprüft wird die Quelle, aus der der Warmup die
   * Kerzen/Ticker für die ALPACA-Instrumente zieht: ohne sie bleibt der
   * Datenstand „0 Kerzen" und Equity-Mandate können nicht handeln.
   *
   * WICHTIG: Das Ergebnis ist NIE `online` — ein erreichbarer Datenpfad sagt
   * nichts über die Handelbarkeit. Der Status bleibt `degraded` mit
   * maschinenlesbarem Grund; `details.syncSourceReachable` trägt die
   * eigentliche Information.
   */
  ALPACA: () => syncSourceCheck("SPY", "Trading-API bleibt ohne Credentials ungeprüft."),
  /** IBKR — derselbe credential-freie Datenquellen-Pfad wie ALPACA (Yahoo). */
  IBKR: () => syncSourceCheck("SPX", "Trading-Pfad (TWS/IB-Gateway) bleibt ungeprüft."),
};

/** Ergebnis der Datenquellen-Prüfung (Fakten, ohne Status-Bewertung). */
export interface SyncSourceProbe {
  /** `true` = die Quelle liefert Kerzen (Warmup-Datenpfad funktioniert). */
  syncSourceReachable: boolean;
  /** Maschinenlesbarer Grund — closed enum. */
  syncSourceReason: "TRADING_API_UNVERIFIED" | "SYNC_SOURCE_EMPTY" | "SYNC_SOURCE_UNREACHABLE";
  /** Immer `market-data-source`: es wird NICHT die Trading-API geprüft. */
  syncSourceScope: "market-data-source";
  /** Endpunkt-Bezeichnung (heute immer Yahoo-Chart) oder `null`. */
  syncSourceEndpoint: string | null;
  /** Gelieferte Kerzen (nur bei erreichbarer Quelle). */
  syncSourceBars: number | null;
  /** HTTP-Status bei Fehlantwort, sonst `null`. */
  syncSourceHttpStatus: number | null;
}

/**
 * Read-only Probe der dokumentierten Sync-Quelle (Yahoo Finance).
 *
 * Alpaca/IBKR haben keine credential-freie Trading-API. Geprüft wird deshalb
 * der Datenpfad des Warmups — und zwar als **Fakten** (`syncSourceReachable`),
 * nicht als Venue-Urteli: erreichbar heißt nicht handelbar. Genau deshalb
 * bleibt der Venue-Status `degraded` (siehe {@link syncSourceCheck}).
 */
export async function probeSyncSource(symbol: string): Promise<SyncSourceProbe> {
  const res = await fetchReadOnly(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`
  );
  if (!res.ok) {
    return {
      syncSourceReachable: false,
      syncSourceReason: "SYNC_SOURCE_UNREACHABLE",
      syncSourceScope: "market-data-source",
      syncSourceEndpoint: "yahoo-chart",
      syncSourceBars: null,
      syncSourceHttpStatus: res.status,
    };
  }
  let bars = 0;
  try {
    const data = (await res.json()) as { chart?: { result?: { timestamp?: unknown[] }[] } };
    bars = Array.isArray(data.chart?.result?.[0]?.timestamp) ? data.chart!.result![0].timestamp!.length : 0;
  } catch {
    bars = 0;
  }
  if (bars <= 0) {
    return {
      syncSourceReachable: false,
      syncSourceReason: "SYNC_SOURCE_EMPTY",
      syncSourceScope: "market-data-source",
      syncSourceEndpoint: "yahoo-chart",
      syncSourceBars: 0,
      syncSourceHttpStatus: res.status,
    };
  }
  return {
    syncSourceReachable: true,
    syncSourceReason: "TRADING_API_UNVERIFIED",
    syncSourceScope: "market-data-source",
    syncSourceEndpoint: "yahoo-chart",
    syncSourceBars: bars,
    syncSourceHttpStatus: res.status,
  };
}

/**
 * Remote-Check-Ergebnis für die Sync-Quelle: immer `degraded` (nie `online`),
 * mit den Fakten aus {@link probeSyncSource} in `details`.
 */
async function syncSourceCheck(symbol: string, note: string): Promise<RemoteCheckResult> {
  const probe = await probeSyncSource(symbol);
  return {
    status: "degraded",
    details: {
      reason: probe.syncSourceReason,
      scope: probe.syncSourceScope,
      endpoint: probe.syncSourceEndpoint,
      syncSourceReachable: probe.syncSourceReachable,
      ...(probe.syncSourceBars !== null ? { bars: probe.syncSourceBars } : {}),
      ...(probe.syncSourceHttpStatus !== null && !probe.syncSourceReachable
        ? { httpStatus: probe.syncSourceHttpStatus }
        : {}),
      note,
    },
  };
}

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
