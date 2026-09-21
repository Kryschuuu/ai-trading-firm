/**
 * Adapter-Registry (MDSYNC-001) — feature-flag-gesteuerte Factory.
 *
 * DIESE Datei ist die einzige Stelle im Produktivcode, die konkrete
 * `MarketDataAdapter`-Implementierungen instanziiert. Neue Venues werden HIER
 * registriert — niemals im Scanner und niemals in `/api/markets`. Damit
 * bleibt die Richtung der Abhängigkeiten eindeutig:
 *
 *   Venue-Adapter → MarketDataSyncService → Registry / HistoricalStore → Scanner
 *
 * Feature-Gating (fail-closed, identisch zur Broker-Freigabe):
 *
 *   MARKET_SYNC_ENABLED   Globaler Kill-Switch. `false` ⇒ KEIN Adapter, der
 *                         Sync exitiert ohne Request. Default: an.
 *   MARKET_SYNC_VENUES    Kommagetrennte Venue-Allowlist (z. B.
 *                         `BITUNIX,BINANCE`). Leer/nicht gesetzt ⇒ alle
 *                         bekannten Venues, die ihr eigenes Flag anhaben.
 *   <VENUE>_ENABLED       Pro-Venue-Freigabe (`BITUNIX_ENABLED`,
 *                         `BINANCE_ENABLED`, `KRAKEN_ENABLED`,
 *                         `ALPACA_ENABLED`, `IBKR_ENABLED`, `PAPER_ENABLED`;
 *                         nur exakt `"true"` schaltet an). Für Bitunix gilt
 *                         das bestehende `BITUNIX_ENABLED` — der Sync nutzt
 *                         dasselbe Gate wie der Adapter selbst, damit „Venue
 *                         aus“ auch „Sync aus“ bedeutet.
 *
 * Capability-Gate (zwei Ebenen, bewusst getrennt):
 *   - BITUNIX: die Broker-Capability-SSoT (`src/brokers/capabilities.ts`,
 *     `VENUE_CAPABILITIES.BITUNIX.marketData`) — historisch, Test-gepinnt.
 *   - Alle anderen Venues: die Sync-lokale Tabelle
 *     {@link SYNC_VENUE_MARKET_DATA} unten. Die Broker-Matrix beschreibt
 *     BROKER-Fähigkeiten (Execution-Feeds) und darf nicht für Sync-Zwecke
 *     umgebogen werden (`tests/brokerCoverage.test.ts` pinnt sie) — der Sync
 *     hat eigene, credential-freie Public-Pfade (Binance/Kraken-REST, Yahoo).
 * Fehlt Capability oder Flag, bleibt die Map leer und `syncVenue("<VENUE>")`
 * wirft `UnsupportedVenueError` mit Behebungshinweis.
 *
 * Sicherheit im Sync-Kontext: instanziiert werden AUSSCHLIESSLICH
 * credential-freie Public-Clients (Bitunix: `BitunixPublicClient`; sonst die
 * Sync-Clients aus `src/marketdata/adapters/*` über den gemeinsamen
 * `SyncHttpClient`). Es wird bewusst KEIN PrivateClient erzeugt (und kein
 * Broker-Adapter, der Secret-Store/Ledger mitbringt): der Market-Data-Pfad
 * darf niemals private Endpunkte, API-Keys oder Signatur-Code berühren —
 * Live-Trading bleibt allein dem Live-Gate und der Broker-Factory überlassen.
 */

import { VENUE_CAPABILITIES } from "../brokers/capabilities";
import {
  BITUNIX_PUBLIC_RATE_PER_SEC,
  bitunixEnabled,
  loadBitunixConfig,
  type EnvLike,
} from "../brokers/bitunix/config";
import { TokenBucket } from "../brokers/bitunix/http";
import { BitunixPublicClient } from "../brokers/bitunix/publicClient";
import { normalizeVenueSymbol } from "../symbols/normalize";
import { createBitunixMarketDataAdapter } from "./adapters/bitunix";
import {
  BINANCE_SYNC_BASE_URL,
  BINANCE_SYNC_RATE_PER_SEC,
  BinanceSyncClient,
  createBinanceMarketDataAdapter,
} from "./adapters/binance";
import { SyncHttpClient } from "./adapters/http";
import {
  KRAKEN_SYNC_BASE_URL,
  KRAKEN_SYNC_RATE_PER_SEC,
  KrakenSyncClient,
  createKrakenMarketDataAdapter,
} from "./adapters/kraken";
import { createPaperMarketDataAdapter } from "./adapters/paper";
import { seededInstrumentsForVenue } from "./adapters/seeded";
import {
  YAHOO_SYNC_BASE_URL,
  YAHOO_SYNC_RATE_PER_SEC,
  YAHOO_USER_AGENT,
  YahooSyncClient,
  createYahooMarketDataAdapter,
} from "./adapters/yahoo";
import { sanitizeVenue } from "./errors";
import type { MarketDataAdapter } from "./sync";
import type { InstrumentRegistry } from "../universe/registry";

/** Venue-Key, unter dem Bitunix registriert ist. */
export const BITUNIX_VENUE = "BITUNIX" as const;
/** Venue-Keys der Sync-Venues (Schlüssel in `SYNC_VENUE_MARKET_DATA`). */
export const BINANCE_VENUE = "BINANCE" as const;
export const KRAKEN_VENUE = "KRAKEN" as const;
export const ALPACA_VENUE = "ALPACA" as const;
export const IBKR_VENUE = "IBKR" as const;
export const PAPER_VENUE = "PAPER" as const;

/** Env-Flags des Sync-Gatings (Doku: `docs/MARKET_DATA_PIPELINE.md` §10). */
export const MARKET_SYNC_ENABLED_FLAG = "MARKET_SYNC_ENABLED";
export const MARKET_SYNC_VENUES_FLAG = "MARKET_SYNC_VENUES";

/** Zulässige Venue-Keys in `MARKET_SYNC_VENUES` (lineare Regex, ReDoS-sicher). */
const VENUE_KEY_RE = /^[A-Z0-9][A-Z0-9_-]{0,31}$/;

/** Bekannte Sync-Venues — Reihenfolge = Reihenfolge in `syncAll()`. */
export const KNOWN_SYNC_VENUES: readonly string[] = [
  BITUNIX_VENUE,
  BINANCE_VENUE,
  KRAKEN_VENUE,
  ALPACA_VENUE,
  IBKR_VENUE,
  PAPER_VENUE,
];

/**
 * Sync-lokale Market-Data-Capability je Venue (Public-Pfad vorhanden?).
 *
 * BEWUSST getrennt von `VENUE_CAPABILITIES` (Broker-Execution-Semantik, in
 * `tests/brokerCoverage.test.ts` gepinnt): Der Sync spricht eigene,
 * credential-freie Public-Pfade — Binance/Kraken-REST direkt, ALPACA/IBKR
 * via Yahoo, PAPER als Spiegel beider. BITUNIX steht hier NICHT (sein Gate
 * bleibt die Broker-Matrix, historisch + Test-gepinnt).
 */
export const SYNC_VENUE_MARKET_DATA: Readonly<Record<string, boolean>> = {
  [BINANCE_VENUE]: true,
  [KRAKEN_VENUE]: true,
  [ALPACA_VENUE]: true,
  [IBKR_VENUE]: true,
  [PAPER_VENUE]: true,
};

/** Pro-Venue-Freigabe-Flags der Sync-Venues (nur exakt `"true"` schaltet an). */
export const BINANCE_ENABLED_FLAG = "BINANCE_ENABLED";
export const KRAKEN_ENABLED_FLAG = "KRAKEN_ENABLED";
export const ALPACA_ENABLED_FLAG = "ALPACA_ENABLED";
export const IBKR_ENABLED_FLAG = "IBKR_ENABLED";
export const PAPER_ENABLED_FLAG = "PAPER_ENABLED";

/** Venue → Freigabe-Flag (BITUNIX ausgenommen: eigenes `bitunixEnabled`-Gate). */
const SYNC_VENUE_ENABLED_FLAGS: Readonly<Record<string, string>> = {
  [BINANCE_VENUE]: BINANCE_ENABLED_FLAG,
  [KRAKEN_VENUE]: KRAKEN_ENABLED_FLAG,
  [ALPACA_VENUE]: ALPACA_ENABLED_FLAG,
  [IBKR_VENUE]: IBKR_ENABLED_FLAG,
  [PAPER_VENUE]: PAPER_ENABLED_FLAG,
};

export interface RegisterAdaptersOptions {
  /** Env-Lieferant (Default: `process.env`). */
  env?: EnvLike;
  /**
   * Registry für Venue-Adapter, die Discovery-Ergebnisse SELBST persistieren.
   * Der Bitunix-Wrapper nutzt sie nicht — das Registry-Upsert liegt beim
   * `MarketDataSyncService` (Stage „upsert“, Quelle `sync:<VENUE>`), damit
   * genau EIN angereicherter Satz je Instrument entsteht. Die Option bleibt
   * für künftige Venues im Contract.
   */
  registry?: InstrumentRegistry;
  /**
   * Explizite Venue-Liste (CLI `--venue`), ignoriert die Env-Allowlist, aber
   * NICHT das per-Venue-Freigabegate. Unbekannte Venues werden verworfen und
   * als `skipped` gemeldet — kein Wurf, damit ein Tippfehler im Betriebslauf
   * die übrigen Venues nicht abbricht.
   */
  venues?: readonly string[];
  /** `true` ⇒ Ignore aller Env-Flags (isolierte Tests, Mock-Adapter). */
  ignoreEnvGates?: boolean;
}

export interface SkippedAdapter {
  venue: string;
  /** Symbolischer Grund — niemals ein Pfad oder eine URL. */
  reason:
    | "KILL_SWITCH"
    | "NOT_IN_ALLOWLIST"
    | "VENUE_DISABLED"
    | "CAPABILITY_DISABLED"
    | "UNKNOWN_VENUE"
    | "INVALID_VENUE_KEY";
}

export interface RegisterAdaptersResult {
  /** `venue → adapter` — direkt an `new MarketDataSyncService(..., adapters)`. */
  adapters: Map<string, MarketDataAdapter>;
  /** Für jede nicht registrierte Venue ein Grund (CLI-Hinweis, kein Secret). */
  skipped: SkippedAdapter[];
}

/** `MARKET_SYNC_ENABLED === "false"` ⇒ aus (Kill-Switch). Alles andere ⇒ an. */
export function marketSyncEnabled(env: EnvLike = process.env): boolean {
  return env[MARKET_SYNC_ENABLED_FLAG] !== "false";
}

/** Venue-Allowlist aus `MARKET_SYNC_VENUES` (Großbuchstaben, dedupliziert). */
export function marketSyncVenueAllowlist(env: EnvLike = process.env): string[] | null {
  const raw = (env[MARKET_SYNC_VENUES_FLAG] ?? "").trim();
  if (!raw) return null;
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const venue = sanitizeVenue(part).toUpperCase();
    if (!venue || !VENUE_KEY_RE.test(venue) || out.includes(venue)) continue;
    out.push(venue);
  }
  return out.length > 0 ? out : null;
}

/**
 * Baut die Venue→Adapter-Map aus den registrierten Fabriken, gated durch die
 * Env-Flags. Rein: keine Seiteneffekte außer der Adapter-Konstruktion.
 */
export function registerAdapters(options: RegisterAdaptersOptions = {}): RegisterAdaptersResult {
  const env = options.env ?? process.env;
  const adapters = new Map<string, MarketDataAdapter>();
  const skipped: SkippedAdapter[] = [];

  if (!options.ignoreEnvGates && !marketSyncEnabled(env)) {
    return { adapters, skipped: KNOWN_SYNC_VENUES.map((venue) => ({ venue, reason: "KILL_SWITCH" as const })) };
  }

  const allowlist = options.ignoreEnvGates ? null : marketSyncVenueAllowlist(env);
  const requested = options?.venues?.length
    ? options.venues.map((v) => sanitizeVenue(v).toUpperCase())
    : [...KNOWN_SYNC_VENUES];

  // EIN Token-Bucket je Host und Registrierungs-Lauf: Bitunix teilt 8 req/s
  // pro IP, Binance 8/s, Kraken und Yahoo je 2/s. Venues derselben
  // API-Infrastruktur (ALPACA + IBKR + PAPER-Yahoo-Bein; BINANCE +
  // PAPER-Binance-Bein) teilen sich EINEN Bucket — die Rate addiert sich
  // nicht, sondern bleibt pro Host authoritativ.
  const buckets = {
    bitunix: new TokenBucket(BITUNIX_PUBLIC_RATE_PER_SEC, BITUNIX_PUBLIC_RATE_PER_SEC),
    binance: new TokenBucket(BINANCE_SYNC_RATE_PER_SEC, BINANCE_SYNC_RATE_PER_SEC),
    kraken: new TokenBucket(KRAKEN_SYNC_RATE_PER_SEC, KRAKEN_SYNC_RATE_PER_SEC),
    yahoo: new TokenBucket(YAHOO_SYNC_RATE_PER_SEC, YAHOO_SYNC_RATE_PER_SEC),
  };

  for (const venue of requested) {
    if (!venue) continue;
    if (!VENUE_KEY_RE.test(venue)) {
      skipped.push({ venue, reason: "INVALID_VENUE_KEY" });
      continue;
    }
    if (allowlist && !allowlist.includes(venue)) {
      skipped.push({ venue, reason: "NOT_IN_ALLOWLIST" });
      continue;
    }
    if (!KNOWN_SYNC_VENUES.includes(venue)) {
      skipped.push({ venue, reason: "UNKNOWN_VENUE" });
      continue;
    }
    // Capability-Gate (immer wirksam, unabhängig von Env-Gates): BITUNIX
    // prüft die Broker-Matrix (historisch, Test-gepinnt), alle anderen die
    // Sync-lokale Tabelle. Meldet die zuständige Stelle kein marketData,
    // existiert für diese Venue kein öffentlicher Market-Data-Pfad — dann
    // darf auch ein gesetztes Env-Flag keinen Adapter erzeugen.
    if (venue === BITUNIX_VENUE) {
      if (VENUE_CAPABILITIES.BITUNIX.marketData !== true) {
        skipped.push({ venue, reason: "CAPABILITY_DISABLED" });
        continue;
      }
      if (!options.ignoreEnvGates && !bitunixEnabled(env)) {
        skipped.push({ venue, reason: "VENUE_DISABLED" });
        continue;
      }
    } else {
      if (SYNC_VENUE_MARKET_DATA[venue] !== true) {
        skipped.push({ venue, reason: "CAPABILITY_DISABLED" });
        continue;
      }
      const flag = SYNC_VENUE_ENABLED_FLAGS[venue];
      if (!options.ignoreEnvGates && (!flag || env[flag] !== "true")) {
        skipped.push({ venue, reason: "VENUE_DISABLED" });
        continue;
      }
    }
    adapters.set(venue, createAdapter(venue, env, buckets));
  }

  return { adapters, skipped };
}

/**
 * Registriert ausschliesslich Venues, deren Capability-Matrix marketData=true
 * meldet UND deren Feature-Flag aktiv ist. Es wird nur der credential-freie
 * PublicClient instanziiert — der Market-Data-Pfad darf niemals private
 * Endpunkte beruehren (kein PrivateClient, kein Secret-Store, keine Signatur).
 *
 * Ticket-Signatur (P0-Verdrahtung); der Parameter nimmt neben `process.env`
 * jede Env-artige Map (`EnvLike`) an, damit Tests isolierte Env-Objekte
 * übergeben können, ohne den Prozess-Env zu mutieren. Funktional identisch zu
 * `registerAdapters({ env }).adapters`.
 */
export function registerMarketDataAdapters(
  env: NodeJS.ProcessEnv | EnvLike = process.env
): Map<string, MarketDataAdapter> {
  return registerAdapters({ env: env as EnvLike }).adapters;
}

/** Token-Buckets je Host (ein Lauf teilt sie über alle Adapter desselben Hosts). */
interface SyncBuckets {
  bitunix: TokenBucket;
  binance: TokenBucket;
  kraken: TokenBucket;
  yahoo: TokenBucket;
}

/**
 * Einzelne Venue-Fabrik — der einzige Ort, an dem Adapter instanziiert werden.
 *
 * Bewusst KEIN Broker-Adapter (und damit kein Paper-Ledger, kein
 * Secret-Store, kein PrivateClient-Zugriff): der Sync braucht ausschließlich
 * Public-Market-Data. Die dünnen Wrapper aus `src/marketdata/adapters/*`
 * adaptieren die credential-freien Sync-Clients auf das
 * `MarketDataAdapter`-Interface und halten die Broker-Domäne entkoppelt.
 */
function createAdapter(venue: string, env: EnvLike, buckets: SyncBuckets): MarketDataAdapter {
  if (venue === BITUNIX_VENUE) {
    const config = loadBitunixConfig(env);
    const publicClient = new BitunixPublicClient({ config, bucket: buckets.bitunix });
    return createBitunixMarketDataAdapter({
      publicClient,
      symbolNormalizer: normalizeVenueSymbol,
    });
  }
  if (venue === BINANCE_VENUE) {
    const http = new SyncHttpClient({ baseUrl: BINANCE_SYNC_BASE_URL, limiter: buckets.binance });
    return createBinanceMarketDataAdapter({ client: new BinanceSyncClient(http) });
  }
  if (venue === KRAKEN_VENUE) {
    const http = new SyncHttpClient({ baseUrl: KRAKEN_SYNC_BASE_URL, limiter: buckets.kraken });
    return createKrakenMarketDataAdapter({ client: new KrakenSyncClient(http) });
  }
  if (venue === ALPACA_VENUE || venue === IBKR_VENUE) {
    const http = new SyncHttpClient({
      baseUrl: YAHOO_SYNC_BASE_URL,
      headers: { "User-Agent": YAHOO_USER_AGENT },
      limiter: buckets.yahoo,
    });
    return createYahooMarketDataAdapter({
      venue,
      client: new YahooSyncClient(http),
      instruments: seededInstrumentsForVenue(venue),
    });
  }
  if (venue === PAPER_VENUE) {
    const binanceHttp = new SyncHttpClient({ baseUrl: BINANCE_SYNC_BASE_URL, limiter: buckets.binance });
    const yahooHttp = new SyncHttpClient({
      baseUrl: YAHOO_SYNC_BASE_URL,
      headers: { "User-Agent": YAHOO_USER_AGENT },
      limiter: buckets.yahoo,
    });
    return createPaperMarketDataAdapter({
      binance: new BinanceSyncClient(binanceHttp),
      yahoo: new YahooSyncClient(yahooHttp),
      instruments: seededInstrumentsForVenue(venue),
    });
  }
  throw new Error(`registerAdapters: Venue "${venue}" hat keine Fabrik.`);
}

/** Bequemer Direktzugriff: nur die Map (für `new MarketDataSyncService(...)`). */
export function createMarketDataAdapters(options: RegisterAdaptersOptions = {}): Map<string, MarketDataAdapter> {
  return registerAdapters(options).adapters;
}
