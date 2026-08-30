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

/** REST-Pfade (Single Source of Truth für Client + Mock + Doku). */
export const BITUNIX_PATHS = {
  tradingPairs: "/api/v1/futures/market/trading_pairs",
  tickers: "/api/v1/futures/market/tickers",
  kline: "/api/v1/futures/market/kline",
  depth: "/api/v1/futures/market/depth",
  account: "/api/v1/futures/account",
  positions: "/api/v1/futures/position/get_pending_positions",
  placeOrder: "/api/v1/futures/trade/place_order",
} as const;
