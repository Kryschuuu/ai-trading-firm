/**
 * Adapter-Registrierung der Perpetual-Daten (RMA-P2-02) — Feature-Gates.
 *
 * DIESE Datei ist die einzige Stelle des Produktivcodes, die konkrete
 * `PerpDataAdapter` instanziiert (Muster: `src/marketdata/registerAdapters.ts`):
 *
 *   Venue-Adapter → PerpSyncService → normalisieren → Qualität → Store → Consumer
 *
 * Gates (fail-closed, in dieser Reihenfolge):
 *
 *   PERP_DATA_ENABLED          Konsumenten-Pfad (Scanner/Backtest/Analyst).
 *                              `false` (Default) ⇒ Konsumenten lesen wie zuvor.
 *   PERP_DATA_SYNC_ENABLED     Netzwerk-Ingestion. `false` (Default) ⇒ kein
 *                              Request; das CLI exitiert 2 mit Behebung.
 *   PERP_DATA_VENUES           Venue-Allowlist (Leer = alle freigeschalteten).
 *   <VENUE>_ENABLED            Pro-Venue-Freigabe (Bitunix: `BITUNIX_ENABLED`).
 *   Capability-SSoT            `marketData === true` UND Perp-Reihe supported.
 *
 * Sicherheit: instanziiert wird ausschließlich der credential-freie
 * `BitunixPublicClient`. Kein `BitunixPrivateClient`, kein Secret-Store, keine
 * Signatur — der Perp-Datenpfad berührt niemals private Endpunkte
 * (`tests/perpPipeline.security.test.ts` erzwingt das statisch).
 */
import { VENUE_CAPABILITIES } from "../brokers/capabilities";
import {
  BITUNIX_PERP_RATE_PER_SEC,
  bitunixEnabled,
  loadBitunixConfig,
  type BitunixRuntimeConfig,
} from "../brokers/bitunix/config";
import { TokenBucket } from "../brokers/bitunix/http";
import { BitunixPublicClient } from "../brokers/bitunix/publicClient";
import {
  perpDataEnabled,
  perpDataSyncEnabled,
  perpDataVenueAllowlist,
  PERP_ENV,
  type PerpEnvLike,
} from "./config";
import { PERP_KNOWN_VENUES, perpCapabilitiesFor } from "./capabilities";
import { BitunixPerpAdapter } from "./adapters/bitunix";
import { FixturePerpAdapter, type FixturePerpProfile } from "./adapters/fixture";
import type { PerpDataAdapter } from "./port";
import type { PerpSeriesKind } from "./types";

/** Venue-Key der Bitunix-Registrierung. */
export const BITUNIX_PERP_VENUE = "BITUNIX";
/** Venue-Key des Fixture-Adapters (Tests, Offline-Betrieb). */
export const SIM_PERP_VENUE = "SIM";

/** Bekannte Perp-Daten-Venues (Reihenfolge = `syncAll()`). */
export const KNOWN_PERP_VENUES: readonly string[] = [BITUNIX_PERP_VENUE, SIM_PERP_VENUE];

/** Grund, warum eine Venue nicht registriert wurde (symbolisch, kein Pfad). */
export type SkippedPerpAdapterReason =
  | "KILL_SWITCH"
  | "SYNC_DISABLED"
  | "NOT_IN_ALLOWLIST"
  | "VENUE_DISABLED"
  | "CAPABILITY_DISABLED"
  | "NO_PERP_DATA"
  | "UNKNOWN_VENUE"
  | "INVALID_VENUE_KEY";

export interface SkippedPerpAdapter {
  venue: string;
  reason: SkippedPerpAdapterReason;
  /** Nur für `NO_PERP_DATA`: welche Reihenart geprüft wurde. */
  kind?: PerpSeriesKind;
}

export interface RegisterPerpAdaptersOptions {
  env?: PerpEnvLike;
  /** Explizite Venue-Liste (CLI `--venue`), ignoriert die Allowlist, nicht die Gates. */
  venues?: readonly string[];
  /** `true` ⇒ Env-Gates ignorieren (Tests, Offline-Validierung). */
  ignoreEnvGates?: boolean;
  /** `true` ⇒ Netzwerk-Gate (`PERP_DATA_SYNC_ENABLED`) ignorieren. */
  allowSync?: boolean;
  /** Profil des Fixture-Adapters (nur `SIM`, Tests/Offline). */
  fixtureProfile?: FixturePerpProfile;
  /** Injizierter Client (Tests gegen Mock-Server). */
  bitunixPublicClient?: BitunixPublicClient;
  /** Injizierbare Uhr für Adapter (Determinismus). */
  now?: () => Date;
}

export interface RegisterPerpAdaptersResult {
  adapters: Map<string, PerpDataAdapter>;
  skipped: SkippedPerpAdapter[];
  /** Aufgelöste Runtime-Config des Bitunix-Clients (Diagnose, keine Secrets). */
  bitunixConfig?: Pick<BitunixRuntimeConfig, "restBaseUrl" | "allowedHosts" | "timeoutMs" | "retryMax">;
}

/** Behebungshinweis je Skip-Grund (Betriebsmeldung, leakfrei). */
export function perpGateMessage(venue: string, skipped: readonly SkippedPerpAdapter[]): string {
  const reason = skipped.find((entry) => entry.venue === venue)?.reason ?? "UNKNOWN_VENUE";
  const hints: Record<SkippedPerpAdapterReason, string> = {
    KILL_SWITCH: `${PERP_ENV.ENABLED} steht auf "false" — auf "true" setzen, damit Konsumenten die kanonische Quelle lesen.`,
    SYNC_DISABLED: `${PERP_ENV.SYNC_ENABLED}=true setzen (Netz-Ingestion) oder offline validieren: --fixture.`,
    NOT_IN_ALLOWLIST: `In ${PERP_ENV.VENUES} fehlt "${venue}" — Liste ergänzen oder Flag leer lassen.`,
    VENUE_DISABLED: `${venue}_ENABLED=true setzen. Public Perp-Daten benötigen keine API-Credentials; Live-Trading bleibt durch das Live-Gate gesperrt.`,
    CAPABILITY_DISABLED: `capabilities.${venue}.marketData=false in der Capability-SSoT (src/brokers/capabilities.ts) — es gibt keinen öffentlichen Market-Data-Pfad.`,
    NO_PERP_DATA: `${venue} meldet für keine Perp-Reihe einen öffentlichen Endpunkt (typisiert UNSUPPORTED, nicht leer).`,
    UNKNOWN_VENUE: `Für "${venue}" existiert kein PerpDataAdapter. Bekannte Venues: ${KNOWN_PERP_VENUES.join(", ")}.`,
    INVALID_VENUE_KEY: "Venue-Key verletzt das erlaubte Format [A-Z0-9][A-Z0-9_-]{0,31}.",
  };
  return `${venue} wurde nicht freigeschaltet (Grund: ${reason}). Behebung: ${hints[reason]}`;
}

/**
 * Baut die Venue→Adapter-Map. Rein außer der Adapter-Konstruktion; es geht
 * **kein** Netzwerk-Request ab (der Client wird nur vorbereitet).
 */
export function registerPerpAdapters(
  options: RegisterPerpAdaptersOptions = {}
): RegisterPerpAdaptersResult {
  const env = options.env ?? process.env;
  const adapters = new Map<string, PerpDataAdapter>();
  const skipped: SkippedPerpAdapter[] = [];
  const ignore = options.ignoreEnvGates === true;

  // Gate A — Gesamt-Aus: weder Konsumenten noch Ingestion freigegeben.
  // `PERP_DATA_ENABLED=false` bei `PERP_DATA_SYNC_ENABLED=true` ist ein
  // zulässiger Betriebszustand („Historie aufbauen, aber noch niemanden
  // daran lassen“) und fällt deshalb nicht unter diesen Grund.
  if (!ignore && !options.allowSync && !perpDataEnabled(env) && !perpDataSyncEnabled(env)) {
    return {
      adapters,
      skipped: KNOWN_PERP_VENUES.map((venue) => ({ venue, reason: "KILL_SWITCH" as const })),
    };
  }
  // Gate B — Netz-Ingestion: ohne `PERP_DATA_SYNC_ENABLED` geht kein Request.
  if (!ignore && !options.allowSync && !perpDataSyncEnabled(env)) {
    return {
      adapters,
      skipped: KNOWN_PERP_VENUES.map((venue) => ({ venue, reason: "SYNC_DISABLED" as const })),
    };
  }

  const allowlist = ignore ? null : perpDataVenueAllowlist(env);
  const requested = options.venues?.length
    ? options.venues.map((venue) => String(venue).trim().toUpperCase())
    : [...KNOWN_PERP_VENUES];

  let bitunixConfig: BitunixRuntimeConfig | null = null;
  for (const venue of requested) {
    if (!venue) continue;
    if (!/^[A-Z0-9][A-Z0-9_-]{0,31}$/.test(venue)) {
      skipped.push({ venue, reason: "INVALID_VENUE_KEY" });
      continue;
    }
    if (allowlist && !allowlist.includes(venue)) {
      skipped.push({ venue, reason: "NOT_IN_ALLOWLIST" });
      continue;
    }
    if (!KNOWN_PERP_VENUES.includes(venue)) {
      skipped.push({ venue, reason: "UNKNOWN_VENUE" });
      continue;
    }
    const caps = perpCapabilitiesFor(venue);
    if (!caps.funding.supported && !caps.openInterest.supported && !caps.liquidations.supported) {
      skipped.push({ venue, reason: "NO_PERP_DATA" });
      continue;
    }
    if (!ignore && venue !== SIM_PERP_VENUE) {
      const brokerCaps = (VENUE_CAPABILITIES as Record<string, (typeof VENUE_CAPABILITIES)[keyof typeof VENUE_CAPABILITIES] | undefined>)[venue];
      if (!brokerCaps || brokerCaps.marketData !== true) {
        skipped.push({ venue, reason: "CAPABILITY_DISABLED" });
        continue;
      }
      if (venue === BITUNIX_PERP_VENUE && !bitunixEnabled(env)) {
        skipped.push({ venue, reason: "VENUE_DISABLED" });
        continue;
      }
    }
    if (venue === SIM_PERP_VENUE) {
      adapters.set(venue, new FixturePerpAdapter({ profile: options.fixtureProfile, now: options.now }));
      continue;
    }
    bitunixConfig = loadBitunixConfig(env);
    const publicClient =
      options.bitunixPublicClient ??
      new BitunixPublicClient({
        config: bitunixConfig,
        // Eigener, bewusst untergeordneter Bucket: der Kerzen-Sync fährt 8 req/s
        // auf demselben IP-Limit (10 req/s) — die Summe darf das Limit nicht reißen.
        bucket: new TokenBucket(BITUNIX_PERP_RATE_PER_SEC, BITUNIX_PERP_RATE_PER_SEC),
      });
    adapters.set(
      venue,
      new BitunixPerpAdapter({
        publicClient,
        ...(options.now ? { now: options.now } : {}),
      })
    );
  }

  return {
    adapters,
    skipped,
    ...(bitunixConfig
      ? {
          bitunixConfig: {
            restBaseUrl: bitunixConfig.restBaseUrl,
            allowedHosts: bitunixConfig.allowedHosts,
            timeoutMs: bitunixConfig.timeoutMs,
            retryMax: bitunixConfig.retryMax,
          },
        }
      : {}),
  };
}

/** Nur die Map (für `new PerpSyncService({ adapters, … })`). */
export function createPerpAdapters(
  options: RegisterPerpAdaptersOptions = {}
): Map<string, PerpDataAdapter> {
  return registerPerpAdapters(options).adapters;
}
