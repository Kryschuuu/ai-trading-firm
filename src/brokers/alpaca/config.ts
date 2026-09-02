/**
 * Alpaca-Konfiguration (Task 12) — sichere Defaults.
 *
 * Alpaca bietet zwei API-Endpunkte (gleicher Vertrag, andere URL):
 *   - Paper-API: https://paper-api.alpaca.markets   (Test-Konto, kein Geld)
 *   - Live-API:  https://api.alpaca.markets         (reale Orders, Geld!)
 *
 * Plus eine separate Market-Data-API (paper und live haben eigene Endpunkte):
 *   - Market Data (live):  https://data.alpaca.markets
 *   - Market Data (paper): https://data.sandbox.alpaca.markets
 *
 * Authentifizierung: Basic Auth (API-Key als Username, Secret als Passwort).
 * Optional OAuth — wird hier NICHT verwendet.
 *
 * Gate-Flags (alle Default OFF / restriktiv):
 *   ALPACA_ENABLED          Adapter/Market-Data frei
 *   ALPACA_LIVE_ENABLED     Venue-Live-Flag (allein wirkungslos)
 *   LIVE_TRADING_ENABLED    Plattform-Live-Flag (allein wirkungslos)
 *   REQUIRE_HUMAN_APPROVAL  für Live nur "false" öffnet diese Teilbedingung
 *
 * Eine Live-Order braucht zusätzlich den Live-Gate-Service (Task 11) —
 * der existiert, wirft aber im Default-Zustand immer (kein State-File,
 * keine Suite-Stamp → DENY).
 */
import { envInt } from "../../lib/env";

export type EnvLike = Record<string, string | undefined>;

/** Offizielle Live-Trade-API (SSRF-Allowlist). */
export const ALPACA_TRADE_HOST = "api.alpaca.markets";
/** Offizielle Paper-Trade-API (SSRF-Allowlist). */
export const ALPACA_PAPER_TRADE_HOST = "paper-api.alpaca.markets";
/** Offizielle Live-Market-Data-API. */
export const ALPACA_DATA_HOST = "data.alpaca.markets";
/** Offizielle Paper-Market-Data-API. */
export const ALPACA_PAPER_DATA_HOST = "data.sandbox.alpaca.markets";

export const DEFAULT_TRADE_BASE = `https://${ALPACA_TRADE_HOST}`;
export const DEFAULT_PAPER_TRADE_BASE = `https://${ALPACA_PAPER_TRADE_HOST}`;
export const DEFAULT_DATA_BASE = `https://${ALPACA_DATA_HOST}`;
export const DEFAULT_PAPER_DATA_BASE = `https://${ALPACA_PAPER_DATA_HOST}`;

/**
 * Alpaca-Free-Tier Rate-Limits (IEX): 200 req/min für Market Data, ohne
 * Tageslimit. Trade-API: 200 req/min. Wir bleiben konservativ.
 */
export const ALPACA_PUBLIC_RATE_PER_SEC = 3; // ≈ 180 req/min
export const ALPACA_PRIVATE_RATE_PER_SEC = 3; // ≈ 180 req/min

export const ALPACA_TIMEOUT_MS_DEFAULT = 8000;
export const ALPACA_RETRY_MAX_DEFAULT = 3;
export const ALPACA_RETRY_BASE_MS = 200;

/**
 * Alpaca-Konto-Defaults (Doku: Stock/ETF/Crypto Broker, USD-Default).
 */
export const ALPACA_ACCOUNT_CURRENCY = "USD";

export function envFlagTrue(env: EnvLike, name: string): boolean {
  return env[name] === "true";
}

export function alpacaEnabled(env: EnvLike = process.env): boolean {
  return envFlagTrue(env, "ALPACA_ENABLED");
}

export function alpacaLiveEnabled(env: EnvLike = process.env): boolean {
  return envFlagTrue(env, "ALPACA_LIVE_ENABLED");
}

export function liveTradingEnabled(env: EnvLike = process.env): boolean {
  return envFlagTrue(env, "LIVE_TRADING_ENABLED");
}

export function humanApprovalRequired(env: EnvLike): boolean {
  return env.REQUIRE_HUMAN_APPROVAL !== "false";
}

export interface AlpacaRuntimeConfig {
  enabled: boolean;
  liveFlag: boolean;
  platformLive: boolean;
  requireHumanApproval: boolean;
  /**
   * True, wenn aktuell die Paper-Endpunkte genutzt werden (entweder weil
   * der Adapter im Modus paper/testnet betrieben wird ODER weil der
   * `ALPACA_USE_Paper`-Override gesetzt ist). Steuert die URL-Auswahl.
   */
  usePaperEndpoints: boolean;
  tradeBaseUrl: string;
  dataBaseUrl: string;
  allowedHosts: readonly string[];
  allowInsecureHttp: boolean;
  timeoutMs: number;
  retryMax: number;
  publicRatePerSec: number;
  privateRatePerSec: number;
}

function extraHosts(env: EnvLike): string[] {
  const raw = env.ALPACA_ALLOWED_HOSTS ?? "";
  return raw
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0);
}

function buildConfig(env: EnvLike, usePaper: boolean): AlpacaRuntimeConfig {
  const allowInsecureHttp = env.ALPACA_ALLOW_INSECURE_HTTP === "true";
  const tradeBaseUrl = (env.ALPACA_TRADE_BASE_URL
    || (usePaper ? DEFAULT_PAPER_TRADE_BASE : DEFAULT_TRADE_BASE)
  ).replace(/\/+$/, "");
  const dataBaseUrl = (env.ALPACA_DATA_BASE_URL
    || (usePaper ? DEFAULT_PAPER_DATA_BASE : DEFAULT_DATA_BASE)
  ).replace(/\/+$/, "");
  const allowed = new Set<string>([
    ALPACA_TRADE_HOST,
    ALPACA_PAPER_TRADE_HOST,
    ALPACA_DATA_HOST,
    ALPACA_PAPER_DATA_HOST,
    ...extraHosts(env),
  ]);
  // Loopback nur zusammen mit dem expliziten Insecure-Flag (lokale Mock-Tests).
  if (allowInsecureHttp) {
    allowed.add("127.0.0.1");
    allowed.add("localhost");
    allowed.add("::1");
  }
  return {
    enabled: alpacaEnabled(env),
    liveFlag: alpacaLiveEnabled(env),
    platformLive: liveTradingEnabled(env),
    requireHumanApproval: humanApprovalRequired(env),
    usePaperEndpoints: usePaper,
    tradeBaseUrl,
    dataBaseUrl,
    allowedHosts: [...allowed],
    allowInsecureHttp,
    timeoutMs: envInt("ALPACA_TIMEOUT_MS", ALPACA_TIMEOUT_MS_DEFAULT, 200, 30_000, env),
    retryMax: envInt("ALPACA_RETRY_MAX", ALPACA_RETRY_MAX_DEFAULT, 1, 5, env),
    publicRatePerSec: ALPACA_PUBLIC_RATE_PER_SEC,
    privateRatePerSec: ALPACA_PRIVATE_RATE_PER_SEC,
  };
}

/**
 * Lädt die Config für den Public-Market-Data-Pfad. Nutzt IMMER die
 * Paper-Data-Endpunkte, weil der Adapter in den Modi paper/testnet läuft
 * — Live-Market-Data wäre im Live-Modus freigeschaltet.
 */
export function loadAlpacaPublicConfig(env: EnvLike = process.env): AlpacaRuntimeConfig {
  return buildConfig(env, true);
}

/**
 * Lädt die Config für den Trade-/Account-Pfad. Default: Paper-Trade-Endpunkte
 * (Modus B). Wenn `ALPACA_USE_LIVE_ENDPOINTS=true`, werden die Live-URLs
 * verwendet — dies ist nur ein HINT, die eigentliche Freigabe entscheidet
 * der Live-Gate-Enforcer.
 */
export function loadAlpacaTradeConfig(env: EnvLike = process.env): AlpacaRuntimeConfig {
  const useLive = env.ALPACA_USE_LIVE_ENDPOINTS === "true";
  return buildConfig(env, !useLive);
}

/**
 * Kappe für die Größe EINER REST-Antwort (Bytes).
 */
export const ALPACA_MAX_RESPONSE_BYTES = 5_242_880;

/**
 * REST-Pfade (Single Source of Truth für Client + Mock + Doku).
 * Alpaca-Trade-API v2:  https://alpaca.markets/docs/api-references/trading-api/
 * Alpaca-Data-API v2:   https://alpaca.markets/docs/api-references/market-data-api/
 */
export const ALPACA_TRADE_PATHS = {
  account: "/v2/account",
  orders: "/v2/orders",
  positions: "/v2/positions",
  // Alpaca unterstützt generische Market-Data-Assets per `assets` Endpoint.
  assets: "/v2/assets",
  clock: "/v2/clock",
  calendar: "/v2/calendar",
} as const;

export const ALPACA_DATA_PATHS = {
  // Stock latest trade/quote/bar
  stockLatestTrade: (symbol: string) => `/v2/stocks/${encodeURIComponent(symbol)}/trades/latest`,
  stockLatestQuote: (symbol: string) => `/v2/stocks/${encodeURIComponent(symbol)}/quotes/latest`,
  stockLatestBar: (symbol: string) => `/v2/stocks/${encodeURIComponent(symbol)}/bars`,
  stockBars: (symbol: string) => `/v2/stocks/${encodeURIComponent(symbol)}/bars`,
  // Crypto latest trade
  cryptoLatestTrade: (symbol: string) => `/v1/crypto/${encodeURIComponent(symbol)}/trades/latest`,
  cryptoLatestQuote: (symbol: string) => `/v1/crypto/${encodeURIComponent(symbol)}/quotes/latest`,
  cryptoLatestBar: (symbol: string) => `/v1/crypto/${encodeURIComponent(symbol)}/bars`,
  // Snapshots (Stock + Crypto)
  stockSnapshot: (symbol: string) => `/v2/stocks/${encodeURIComponent(symbol)}/snapshot`,
  cryptoSnapshot: (symbol: string) => `/v1/crypto/${encodeURIComponent(symbol)}/snapshot`,
  // News
  news: (symbol: string) => `/v1beta1/news?symbols=${encodeURIComponent(symbol)}`,
} as const;
