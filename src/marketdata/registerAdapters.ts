/**
 * Adapter-Registry (MDSYNC-001) — feature-flag-gesteuerte Factory.
 *
 * DIESE Datei ist die einzige Stelle im Produktivcode, die konkrete
 * `MarketDataAdapter`-Implementierungen instanziiert. Neue Venues (Binance,
 * Bitfinex, …) werden HIER registriert — niemals im Scanner und niemals in
 * `/api/markets`. Damit bleibt die Richtung der Abhängigkeiten eindeutig:
 *
 *   Venue-Adapter → MarketDataSyncService → Registry / HistoricalStore → Scanner
 *
 * Feature-Gating (fail-closed, identisch zur Broker-Freigabe):
 *
 *   MARKET_SYNC_ENABLED   Globaler Kill-Switch. `false` ⇒ KEIN Adapter, der
 *                         Sync exitiert ohne Request. Default: an.
 *   MARKET_SYNC_VENUES    Kommagetrennte Venue-Allowlist (z. B. `BITUNIX`).
 *                         Leer/nicht gesetzt ⇒ alle bekannten Venues, die ihr
 *                         eigenes Flag eingeschaltet hat.
 *   <VENUE>_ENABLED       Pro-Venue-Freigabe. Für Bitunix gilt das bestehende
 *                         `BITUNIX_ENABLED` (nur exakt `"true"` schaltet an) —
 *                         der Sync nutzt dasselbe Gate wie der Adapter selbst,
 *                         damit „Venue aus“ auch „Sync aus“ bedeutet.
 *
 * Zusätzliches Capability-Gate (P0-Verdrahtung): eine Venue wird nur
 * registriert, wenn die Capability-SSoT (`src/brokers/capabilities.ts`)
 * `marketData === true` meldet UND ihr Feature-Flag aktiv ist. Fehlt eines
 * von beiden, bleibt die Map leer und `syncVenue("<VENUE>")` wirft
 * `UnsupportedVenueError` mit Behebungshinweis.
 *
 * Sicherheit im Sync-Kontext: instanziiert wird AUSSCHLIESSLICH der
 * credential-freie `BitunixPublicClient`, adaptiert über den Wrapper
 * `src/marketdata/adapters/bitunix.ts`. Es wird bewusst KEIN
 * `BitunixPrivateClient` erzeugt (und kein `BitunixBrokerAdapter`, der
 * Secret-Store/Ledger mitbringt): der Market-Data-Pfad darf niemals private
 * Endpunkte, API-Keys oder Signatur-Code berühren — Live-Trading bleibt
 * allein dem Live-Gate und der Broker-Factory überlassen.
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
import { sanitizeVenue } from "./errors";
import type { MarketDataAdapter } from "./sync";
import type { InstrumentRegistry } from "../universe/registry";

/** Venue-Key, unter dem Bitunix registriert ist. */
export const BITUNIX_VENUE = "BITUNIX" as const;

/** Env-Flags des Sync-Gatings (Doku: `docs/MARKET_DATA_PIPELINE.md` §10). */
export const MARKET_SYNC_ENABLED_FLAG = "MARKET_SYNC_ENABLED";
export const MARKET_SYNC_VENUES_FLAG = "MARKET_SYNC_VENUES";

/** Zulässige Venue-Keys in `MARKET_SYNC_VENUES` (lineare Regex, ReDoS-sicher). */
const VENUE_KEY_RE = /^[A-Z0-9][A-Z0-9_-]{0,31}$/;

/** Bekannte Sync-Venues — Reihenfolge = Reihenfolge in `syncAll()`. */
export const KNOWN_SYNC_VENUES: readonly string[] = [BITUNIX_VENUE];

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

  // EIN geteilter Token-Bucket pro Registrierungs-Lauf: das dokumentierte
  // Bitunix-Limit gilt pro IP (10 req/s/IP; Code 8 req/s) — selbst wenn
  // später mehrere Venues derselben API-Infrastruktur in EINEM Lauf
  // registriert sind, bleibt die 8 req/s authoritativ statt sich zu
  // addieren. Der Bucket wird an jeden erzeugten PublicClient durchgereicht.
  const sharedBucket = new TokenBucket(BITUNIX_PUBLIC_RATE_PER_SEC, BITUNIX_PUBLIC_RATE_PER_SEC);

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
    // Capability-SSoT (immer wirksam, unabhängig von Env-Gates): meldet die
    // Matrix kein marketData, existiert für diese Venue kein öffentlicher
    // Market-Data-Pfad — dann darf auch ein gesetztes Env-Flag keinen
    // Adapter erzeugen.
    if (venue === BITUNIX_VENUE && VENUE_CAPABILITIES.BITUNIX.marketData !== true) {
      skipped.push({ venue, reason: "CAPABILITY_DISABLED" });
      continue;
    }
    if (!options.ignoreEnvGates && venue === BITUNIX_VENUE && !bitunixEnabled(env)) {
      skipped.push({ venue, reason: "VENUE_DISABLED" });
      continue;
    }
    adapters.set(venue, createAdapter(venue, env, sharedBucket));
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

/**
 * Einzelne Venue-Fabrik — der einzige Ort, an dem Adapter instanziiert werden.
 *
 * Bewusst KEIN `BitunixBrokerAdapter` (und damit kein Paper-Ledger, kein
 * Secret-Store, kein PrivateClient-Zugriff): der Sync braucht ausschließlich
 * Public-Market-Data. Der dünne Wrapper
 * `createBitunixMarketDataAdapter()` adaptiert den PublicClient auf das
 * `MarketDataAdapter`-Interface und hält die Broker-Domäne entkoppelt.
 */
function createAdapter(venue: string, env: EnvLike, sharedBucket: TokenBucket): MarketDataAdapter {
  if (venue === BITUNIX_VENUE) {
    const config = loadBitunixConfig(env);
    const publicClient = new BitunixPublicClient({ config, bucket: sharedBucket });
    return createBitunixMarketDataAdapter({
      publicClient,
      symbolNormalizer: normalizeVenueSymbol,
    });
  }
  throw new Error(`registerAdapters: Venue "${venue}" hat keine Fabrik.`);
}

/** Bequemer Direktzugriff: nur die Map (für `new MarketDataSyncService(...)`). */
export function createMarketDataAdapters(options: RegisterAdaptersOptions = {}): Map<string, MarketDataAdapter> {
  return registerAdapters(options).adapters;
}
