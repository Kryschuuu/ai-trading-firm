/**
 * Bitunix-Konfiguration (Task 07) — sichere Defaults.
 *
 * Gate-Flags (alle Default OFF / restriktiv):
 *   BITUNIX_ENABLED          Adapter/Market-Data frei
 *   BITUNIX_LIVE_ENABLED     Venue-Live-Flag (allein wirkungslos)
 *   LIVE_TRADING_ENABLED     Plattform-Live-Flag (allein wirkungslos)
 *   REQUIRE_HUMAN_APPROVAL   für Live nur `"false"` öffnet diese Teilbedingung
 *
 * Eine Live-Order braucht zusätzlich den Live-Gate-Service (task-11) —
 * der existiert nicht, daher wirft der Live-Pfad IMMER.
 */
import { envInt } from "../../lib/env";

export type EnvLike = Record<string, string | undefined>;

/** Offizielle REST-Domain (SSRF-Allowlist). */
export const BITUNIX_REST_HOST = "fapi.bitunix.com";
/** Offizielle Public-WS-Domain. */
export const BITUNIX_WS_HOST = "fapi.bitunix.com";

export const DEFAULT_REST_BASE = `https://${BITUNIX_REST_HOST}`;
export const DEFAULT_WS_URL = `wss://${BITUNIX_WS_HOST}/public/`;

/**
 * Dokumentierte Default-Gebühren (VIP0 Futures), weil `trading_pairs`
 * keine maker/taker-Felder liefert. MarketInstrument erlaubt kein `null`
 * für Fees — Abweichung zur Aufgaben-Formulierung „sonst null“ ist in
 * docs/BITUNIX.md festgehalten.
 */
export const BITUNIX_DEFAULT_MAKER_FEE = 0.0002;
export const BITUNIX_DEFAULT_TAKER_FEE = 0.0006;

/** Öffentliche Rate-Limits laut Doku: 10 req/s/IP — konservativ 8. */
export const BITUNIX_PUBLIC_RATE_PER_SEC = 8;
/** Private: 10 req/s/uid — konservativ 8. */
export const BITUNIX_PRIVATE_RATE_PER_SEC = 8;

export const BITUNIX_TIMEOUT_MS_DEFAULT = 8000;
export const BITUNIX_RETRY_MAX_DEFAULT = 3;
export const BITUNIX_RETRY_BASE_MS = 200;

export function envFlagTrue(env: EnvLike, name: string): boolean {
  return env[name] === "true";
}

/** REQUIRE_HUMAN_APPROVAL: nur exakt "false" hebt die Live-Teilbedingung. */
export function humanApprovalRequired(env: EnvLike): boolean {
  return env.REQUIRE_HUMAN_APPROVAL !== "false";
}

export function bitunixEnabled(env: EnvLike = process.env): boolean {
  return envFlagTrue(env, "BITUNIX_ENABLED");
}

export function bitunixLiveEnabled(env: EnvLike = process.env): boolean {
  return envFlagTrue(env, "BITUNIX_LIVE_ENABLED");
}

export function liveTradingEnabled(env: EnvLike = process.env): boolean {
  return envFlagTrue(env, "LIVE_TRADING_ENABLED");
}

export interface BitunixRuntimeConfig {
  enabled: boolean;
  liveFlag: boolean;
  platformLive: boolean;
  requireHumanApproval: boolean;
  restBaseUrl: string;
  wsUrl: string;
  allowedHosts: readonly string[];
  allowInsecureHttp: boolean;
  timeoutMs: number;
  retryMax: number;
  publicRatePerSec: number;
  privateRatePerSec: number;
}

function extraHosts(env: EnvLike): string[] {
  const raw = env.BITUNIX_ALLOWED_HOSTS ?? "";
  return raw
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0);
}

/**
 * Lädt die Runtime-Config. `BITUNIX_BASE_URL` / `BITUNIX_WS_URL` sind
 * Test-Overrides (Mock-Server); Produktion bleibt auf der Allowlist.
 */
export function loadBitunixConfig(env: EnvLike = process.env): BitunixRuntimeConfig {
  const restBaseUrl = (env.BITUNIX_BASE_URL || DEFAULT_REST_BASE).replace(/\/+$/, "");
  const wsUrl = env.BITUNIX_WS_URL || DEFAULT_WS_URL;
  const allowInsecureHttp = env.BITUNIX_ALLOW_INSECURE_HTTP === "true";
  const allowed = new Set<string>([BITUNIX_REST_HOST, BITUNIX_WS_HOST, ...extraHosts(env)]);
  // Loopback nur zusammen mit dem expliziten Insecure-Flag (lokale Mock-Tests).
  if (allowInsecureHttp) {
    allowed.add("127.0.0.1");
    allowed.add("localhost");
    allowed.add("::1");
  }
  return {
    enabled: bitunixEnabled(env),
    liveFlag: bitunixLiveEnabled(env),
    platformLive: liveTradingEnabled(env),
    requireHumanApproval: humanApprovalRequired(env),
    restBaseUrl,
    wsUrl,
    allowedHosts: [...allowed],
    allowInsecureHttp,
    timeoutMs: envInt("BITUNIX_TIMEOUT_MS", BITUNIX_TIMEOUT_MS_DEFAULT, 200, 30_000, env),
    retryMax: envInt("BITUNIX_RETRY_MAX", BITUNIX_RETRY_MAX_DEFAULT, 1, 5, env),
    publicRatePerSec: BITUNIX_PUBLIC_RATE_PER_SEC,
    privateRatePerSec: BITUNIX_PRIVATE_RATE_PER_SEC,
  };
}

/**
 * Kappe für die Größe EINER REST-Antwort (Bytes, am Stream durchgesetzt).
 *
 * `fetchImpl` ist injectbar (Tests/Mocks) — deshalb gilt die Kappe auch dort:
 * ein zu großer Payload wird abgebrochen, bevor er im Prozess puffert. Selbst
 * `limit=2000` Kerzen (≈ 2000 × ~120 Bytes) bleiben deutlich darunter.
 */
export const BITUNIX_MAX_RESPONSE_BYTES = 5_242_880;

/**
 * Maximale Symbolzahl je `GET /market/tickers?symbols=…`-Request. 50 Symbole
 * à ≤ 20 Zeichen ergeben < 1,1 KB Query — weit unter jeder Gateway-Grenze.
 * Der volle Katalog (≈ 750 Symbole, > 6 KB URL) wurde vom Venue-Gateway
 * abgelehnt und ließ die gesamte Ticker-Stage des Market-Syncs scheitern.
 */
export const BITUNIX_TICKER_SYMBOLS_PER_REQUEST = 50;

/** REST-Pfade (Single Source of Truth für Client + Mock + Doku). */
export const BITUNIX_PATHS = {
  tradingPairs: "/api/v1/futures/market/trading_pairs",
  tickers: "/api/v1/futures/market/tickers",
  kline: "/api/v1/futures/market/kline",
  depth: "/api/v1/futures/market/depth",
  account: "/api/v1/futures/account",
  positions: "/api/v1/futures/position/get_pending_positions",
  placeOrder: "/api/v1/futures/trade/place_order",
  /** H3: Order-Detail (Status NEW/PART_FILLED/FILLED/CANCELED + tradeQty). */
  orderDetail: "/api/v1/futures/trade/get_order_detail",
  /** H3: Ausführungen (Trades) — Basis des echten avgPrice. */
  historyTrades: "/api/v1/futures/trade/get_history_trades",
  /**
   * RMA-P4-02 (v1.70.0): Einzel-/Batch-Cancel (`symbol` + `orderList` mit
   * `orderId` ODER `clientId`). Die Erfolgsantwort beweist NICHT den Cancel
   * (Venue-Doku: „please use the websocket push message as an accurate
   * judgment“) — der Venue-Port verifiziert via `orderDetail`, bis dahin gilt
   * der Status als UNKNOWN und blockiert jeden Market-Fallback.
   */
  cancelOrders: "/api/v1/futures/trade/cancel_orders",
  /** H7 (v1.36.20): Alle offenen Orders stornieren (Not-Halt). */
  cancelAllOrders: "/api/v1/futures/trade/cancel_all_orders",
  /** H7 (v1.36.20): Alle Positionen schließen (Not-Halt). */
  closeAllPositions: "/api/v1/futures/trade/close_all_position",
  /**
   * RMA-P2-02 (v1.54.0): aktuelle Funding-Rate je Symbol (public, keine
   * Credentials). Liefert `markPrice`/`indexPrice`/`fundingRate`/
   * `fundingInterval`/`nextFundingTime` sowie die Venue-Bounds
   * `maxFundingRate`/`minFundingRate`.
   */
  fundingRate: "/api/v1/futures/market/funding_rate",
  /**
   * RMA-P2-02 (v1.54.0): **Historie** der Funding-Rates (public).
   * `limit` default 100, Maximum 200 (Venue-Doku). Die Doku nennt das
   * Start-Parameter-Feld an einer Stelle `starTime` (Tippfehler der Venue),
   * `/market/kline` nutzt `startTime`; der Perp-Adapter sendet `startTime`
   * und filtert zusätzlich client-seitig (siehe
   * `src/perpdata/adapters/bitunix.ts`).
   */
  fundingRateHistory: "/api/v1/futures/market/get_funding_rate_history",
} as const;

/**
 * Rate-Limit des Perp-Daten-Syncs (RMA-P2-02).
 *
 * Der Kerzen-Sync nutzt bereits 8 req/s des dokumentierten Limits von
 * 10 req/s/IP. Beide Syncs können parallel laufen (getrennte Prozesse,
 * getrennte Token-Buckets) — der Perp-Pfad fährt deshalb bewusst
 * **untergeordnet** (4 req/s), damit die Summe das Venue-Limit auch bei
 * gleichzeitigem Lauf nicht reißt.
 */
export const BITUNIX_PERP_RATE_PER_SEC = 4;

/** Maximale Zeilen je Funding-History-Request (Venue-Doku: Maximum 200). */
export const BITUNIX_FUNDING_HISTORY_MAX_LIMIT = 200;
