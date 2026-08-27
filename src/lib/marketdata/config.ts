/**
 * Konfiguration der Market-Data-Schicht & des Fill-Simulators (Task 03).
 *
 * Alle Parameter sind dokumentiert und über Env-Variablen konfigurierbar;
 * die Defaults bilden den Produktivbetrieb (Paper-Modus B = echte Kurse).
 * Vollständige Parameter-Tabelle: docs/PAPER_TRADING.md.
 */
import { PaperConfigError, type PaperMode } from "./types";
import { normalizeSeed } from "./prng";

/** Env-Namen (zentral, für Doku/Tests). */
export const ENV = {
  PAPER_MODE: "PAPER_MODE",
  PAPER_STATIC_FALLBACK: "PAPER_STATIC_FALLBACK",
  PAPER_ALLOW_SYNTHETIC_FALLBACK: "PAPER_ALLOW_SYNTHETIC_FALLBACK",
  PAPER_BROKER_API_VENUE: "PAPER_BROKER_API_VENUE",
  PAPER_MODE_C_ENABLED: "PAPER_MODE_C_ENABLED",
  // Simulator
  PAPER_SIM_LATENCY_MS: "PAPER_SIM_LATENCY_MS",
  PAPER_SIM_SLIPPAGE_BPS_BASE: "PAPER_SIM_SLIPPAGE_BPS_BASE",
  PAPER_SIM_SLIPPAGE_PER_PARTICIPATION: "PAPER_SIM_SLIPPAGE_PER_PARTICIPATION",
  PAPER_SIM_PARTIAL_FILL: "PAPER_SIM_PARTIAL_FILL",
  PAPER_SIM_PARTIAL_MAX_FRACTION: "PAPER_SIM_PARTIAL_MAX_FRACTION",
  PAPER_SIM_SEED: "PAPER_SIM_SEED",
  // Normalisierung / Feeds
  PAPER_ANOMALY_MAX_JUMP_PCT: "PAPER_ANOMALY_MAX_JUMP_PCT",
  PAPER_STALE_AFTER_MS: "PAPER_STALE_AFTER_MS",
  PAPER_FEED_TIMEOUT_MS: "PAPER_FEED_TIMEOUT_MS",
  PAPER_FEED_RETRY_MAX: "PAPER_FEED_RETRY_MAX",
  PAPER_FEED_ALLOWED_HOSTS: "PAPER_FEED_ALLOWED_HOSTS",
  PAPER_HISTORY_DIR: "PAPER_HISTORY_DIR",
  // Test/Fixture-Override (nicht für Produktion, nur Tests)
  PAPER_BINANCE_BASE_URL: "PAPER_BINANCE_BASE_URL",
  PAPER_YAHOO_BASE_URL: "PAPER_YAHOO_BASE_URL",
  PAPER_SYNTHETIC_BASE_PRICE: "PAPER_SYNTHETIC_BASE_PRICE",
} as const;

export type EnvLike = Record<string, string | undefined>;

function num(env: EnvLike, name: string, fallback: number, min: number, max: number): number {
  const n = Number(env[name]);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function bool(env: EnvLike, name: string, fallback: boolean): boolean {
  const v = env[name];
  if (v === undefined) return fallback;
  const s = v.trim().toLowerCase();
  if (s === "true" || s === "1") return true;
  if (s === "false" || s === "0") return false;
  return fallback;
}

/** Gültige Paper-Modi. */
export const PAPER_MODES: readonly PaperMode[] = [
  "synthetic",
  "broker-market-data",
  "broker-paper-api",
];

/** Normalisiert eine Paper-Mode-Eingabe oder wirft einen klaren Fehler. */
export function parsePaperMode(raw: unknown): PaperMode {
  // undefined/null → Default (Modus B); leere Strings → Default.
  if (raw === undefined || raw === null) return "broker-market-data";
  if (typeof raw !== "string") {
    throw new PaperConfigError(
      `Ungültiger paperMode ${JSON.stringify(raw)}. Erlaubt: ${PAPER_MODES.join(" | ")}.`
    );
  }
  const s = raw.trim().toLowerCase();
  if (!s) return "broker-market-data";
  if ((PAPER_MODES as readonly string[]).includes(s)) return s as PaperMode;
  throw new PaperConfigError(
    `Ungültiger paperMode "${String(raw ?? "").slice(0, 40)}". ` +
      `Erlaubt: ${PAPER_MODES.join(" | ")}.`
  );
}

/** Statisches Preisbuch nur als expliziter Offline-Fallback (Default AUS). */
export function staticFallbackEnabled(env: EnvLike = process.env): boolean {
  return bool(env, ENV.PAPER_STATIC_FALLBACK, false);
}

/** Synthetic als Failover erlauben (Default AUS — nur explizit). */
export function allowSyntheticFallback(env: EnvLike = process.env): boolean {
  return bool(env, ENV.PAPER_ALLOW_SYNTHETIC_FALLBACK, false);
}

/** Venue, gegen die Modus C (broker-paper-api) ausgeführt wird. */
export function brokerApiVenue(env: EnvLike = process.env): string | null {
  const v = env[ENV.PAPER_BROKER_API_VENUE];
  if (!v || !v.trim()) return null;
  return v.trim().toUpperCase();
}

/** Flag für Modus C. */
export function modeCEnabled(env: EnvLike = process.env): boolean {
  return bool(env, ENV.PAPER_MODE_C_ENABLED, false);
}

/** SSRF-Allowlist aus Env (Komma-getrennt) + Defaults. */
export function feedAllowedHosts(env: EnvLike = process.env): string[] {
  const raw = env[ENV.PAPER_FEED_ALLOWED_HOSTS];
  if (!raw || !raw.trim()) return [];
  return raw
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0);
}

/** Historien-Verzeichnis (Standard `data/history`). */
export function historyDir(env: EnvLike = process.env): string {
  return env[ENV.PAPER_HISTORY_DIR] || "data/history";
}

/** Konfiguration des Fill-Simulators (Parameter-Tabelle in PAPER_TRADING.md). */
export interface FillSimulatorConfig {
  /** Maker-Gebühr-Fallback in Dezimalanteil, falls Registry-Feld fehlt. */
  makerFeeFallback: number;
  /** Taker-Gebühr-Fallback in Dezimalanteil. */
  takerFeeFallback: number;
  /** Simulierte Ausführungslatenz in ms. */
  latencyMs: number;
  /** Basis-Slippage in Basispunkten (Ordergröße → 0 relativ zum 24h-Volumen). */
  slippageBpsBase: number;
  /** Zusätzliche Slippage (Basispunkte) je 100 % Teilnahme am 24h-Volumen. */
  slippageBpsPerParticipation: number;
  /** Slippage-Streuung (Basispunkte, deterministisch via Seed). 0 = deterministisch. */
  slippageJitterBps: number;
  /** Partial Fills modellieren? */
  partialFillEnabled: boolean;
  /** Max. gefüllter Anteil einer Order (0..1). */
  partialFillMaxFraction: number;
  /** Seed für deterministische Streuung. */
  seed: number;
  /** 24h-Volumen-Fallback (Quote-Währung), falls Registry-Feld null. */
  volume24hFallback: number;
}

/** Lädt die Simulator-Konfiguration aus Env (mit dokumentierten Defaults). */
export function loadSimulatorConfig(env: EnvLike = process.env): FillSimulatorConfig {
  return {
    makerFeeFallback: num(env, "PAPER_SIM_MAKER_FEE", 0.0004, 0, 0.1),
    takerFeeFallback: num(env, "PAPER_SIM_TAKER_FEE", 0.001, 0, 0.1),
    latencyMs: num(env, ENV.PAPER_SIM_LATENCY_MS, 25, 0, 60_000),
    slippageBpsBase: num(env, ENV.PAPER_SIM_SLIPPAGE_BPS_BASE, 1, 0, 10_000),
    slippageBpsPerParticipation: num(
      env,
      ENV.PAPER_SIM_SLIPPAGE_PER_PARTICIPATION,
      30,
      0,
      100_000
    ),
    slippageJitterBps: num(env, "PAPER_SIM_SLIPPAGE_JITTER_BPS", 0, 0, 1000),
    partialFillEnabled: bool(env, ENV.PAPER_SIM_PARTIAL_FILL, false),
    partialFillMaxFraction: num(env, ENV.PAPER_SIM_PARTIAL_MAX_FRACTION, 1, 0, 1),
    seed: normalizeSeed(env[ENV.PAPER_SIM_SEED]),
    volume24hFallback: num(env, "PAPER_SIM_VOLUME_FALLBACK", 10_000_000, 1, 1e15),
  };
}

/** Gesamtkonfiguration der Market-Data-Schicht. */
export interface MarketDataConfig {
  paperMode: PaperMode;
  staticFallbackEnabled: boolean;
  allowSyntheticFallback: boolean;
  brokerApiVenue: string | null;
  modeCEnabled: boolean;
  /** Max. prozentualer Sprung zwischen aufeinanderfolgenden Kursen (Anomalie). */
  anomalyMaxJumpPct: number;
  /** Max. Alter eines Kurses, bevor er als stale verworfen wird (ms). */
  staleAfterMs: number;
  /** Feed-Timeout in ms. */
  feedTimeoutMs: number;
  /** Feed-Retry-Maximum (inkl. Erstversuch). */
  feedRetryMax: number;
  /** SSRF-Allowlist (Feed-Hosts). */
  allowedHosts: string[];
  historyDir: string;
  /** Test/Override-URLs (nur Tests; leer = Produktion). */
  binanceBaseUrl: string;
  yahooBaseUrl: string;
  /** Basis-Preis für Synthetic-Feed (Tests; sonst Registry/Seed). */
  syntheticBasePrice: number | null;
  simulator: FillSimulatorConfig;
}

/** Lädt die vollständige Konfiguration und validiert die Paper-Mode-Kombination. */
export function loadMarketDataConfig(env: EnvLike = process.env): MarketDataConfig {
  const paperMode = parsePaperMode(env[ENV.PAPER_MODE]);
  const cfg: MarketDataConfig = {
    paperMode,
    staticFallbackEnabled: staticFallbackEnabled(env),
    allowSyntheticFallback: allowSyntheticFallback(env),
    brokerApiVenue: brokerApiVenue(env),
    modeCEnabled: modeCEnabled(env),
    anomalyMaxJumpPct: num(env, ENV.PAPER_ANOMALY_MAX_JUMP_PCT, 50, 0, 1000),
    staleAfterMs: num(env, ENV.PAPER_STALE_AFTER_MS, 30_000, 100, 24 * 3600_000),
    feedTimeoutMs: num(env, ENV.PAPER_FEED_TIMEOUT_MS, 8000, 100, 60_000),
    feedRetryMax: Math.max(1, Math.trunc(num(env, ENV.PAPER_FEED_RETRY_MAX, 2, 1, 6))),
    allowedHosts: feedAllowedHosts(env),
    historyDir: historyDir(env),
    binanceBaseUrl: env[ENV.PAPER_BINANCE_BASE_URL] || "https://api.binance.com",
    yahooBaseUrl: env[ENV.PAPER_YAHOO_BASE_URL] || "https://query1.finance.yahoo.com",
    syntheticBasePrice: (() => {
      const n = Number(env[ENV.PAPER_SYNTHETIC_BASE_PRICE]);
      return Number.isFinite(n) && n > 0 ? n : null;
    })(),
    simulator: loadSimulatorConfig(env),
  };

  validatePaperMode(cfg);
  return cfg;
}

/**
 * Validiert die Paper-Mode-Kombination (Akzeptanz: falsche Kombinationen →
 * klarer Fehler).
 *
 *   - Modus C (`broker-paper-api`) erfordert: Flag `PAPER_MODE_C_ENABLED=true`
 *     UND ein gesetztes Venue (`PAPER_BROKER_API_VENUE`), dessen Venue eine
 *     Paper-/Testnet-Capability deklariert. Heute deklariert kein Venue
 *     `testnet=true` (alle Stubs false) → klarer Konfigurationsfehler.
 *   - Synthetic (`synthetic`) ist nur Modus A; als globaler Fallback nur wenn
 *     `PAPER_ALLOW_SYNTHETIC_FALLBACK=true`.
 */
export function validatePaperMode(cfg: MarketDataConfig): void {
  if (cfg.paperMode === "broker-paper-api") {
    if (!cfg.modeCEnabled) {
      throw new PaperConfigError(
        `paperMode "broker-paper-api" erfordert ${ENV.PAPER_MODE_C_ENABLED}=true.`
      );
    }
    if (!cfg.brokerApiVenue) {
      throw new PaperConfigError(
        `paperMode "broker-paper-api" erfordert ${ENV.PAPER_BROKER_API_VENUE} (z. B. "ALPACA").`
      );
    }
    // Venue-Capability-Check wird vom Manager (mit den echten Capabilities)
    // durchgeführt — hier der reine Flag-/Format-Check.
  }
}
