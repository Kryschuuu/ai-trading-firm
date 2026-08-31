/**
 * Adapter-Registry — dünner Wrapper um {@link registerAdapters}.
 *
 * Die Fabrik selbst (welche Venues existieren, welche Feature-Flags gelten)
 * lebt in `./registerAdapters.ts`. Diese Klasse hält die daraus entstandene
 * Venue→Adapter-Map als objekttragenden Zugriff für CLI und Tests; sie
 * instanziiert selbst keine Adapter.
 *
 * Architektur-Trennung:
 * - `MarketDataSyncService` konsumiert nur das venue-agnostische
 *   `MarketDataAdapter`-Interface (`./sync.ts`) + diese Map.
 * - Die registrierten Adapter sind dünne Wrapper um credential-freie
 *   Public-Clients (Bitunix: `./adapters/bitunix.ts` um `BitunixPublicClient`)
 *   — kein BrokerAdapter, kein PrivateClient, kein Ledger.
 * - Der Scanner (`src/scanner/`) kennt ausschließlich `InstrumentRegistry`
 *   und `HistoricalStore` — er importiert keine Adapter-Klasse.
 * - Order-Ausführung läuft über `getBroker()` (`src/brokers/factory.ts`)
 *   und ist von diesem Sync-Pfad komplett getrennt.
 */

import {
  KNOWN_SYNC_VENUES,
  registerAdapters,
  type RegisterAdaptersResult,
  type SkippedAdapter,
} from "./registerAdapters";
import type { EnvLike } from "../brokers/bitunix/config";
import type { InstrumentRegistry } from "../universe/registry";
import { sanitizeVenue } from "./errors";
import type { MarketDataAdapter } from "./sync";

export { BITUNIX_VENUE, KNOWN_SYNC_VENUES } from "./registerAdapters";
export type { SkippedAdapter } from "./registerAdapters";

export interface AdapterRegistryOptions {
  /**
   * Registry für Venue-Adapter mit eigener Persistenz. Der Bitunix-Wrapper
   * nutzt sie nicht (Upsert liegt beim `MarketDataSyncService`); die Option
   * bleibt im Contract für künftige Venues.
   */
  registry?: InstrumentRegistry;
  /** Env für die Adapter-Instanzen und das Feature-Gating (Default: `process.env`). */
  env?: EnvLike;
  /** `false` → keine Venues registrieren (isolierte Tests). */
  registerVenues?: boolean;
  /** Explizite Venues (CLI `--venue`), sonst alle bekannten. */
  venues?: readonly string[];
  /** Ignore Env-Gates (Mock-Adapter in Tests). */
  ignoreEnvGates?: boolean;
}

export class AdapterRegistry {
  private readonly adapters: Map<string, MarketDataAdapter>;
  /** Venues, die bewusst NICHT registriert wurden — mit symbolischem Grund. */
  readonly skipped: readonly SkippedAdapter[];

  constructor(options: AdapterRegistryOptions = {}) {
    const result: RegisterAdaptersResult =
      options.registerVenues === false
        ? { adapters: new Map(), skipped: [] }
        : registerAdapters({
            env: options.env,
            registry: options.registry,
            venues: options.venues,
            ignoreEnvGates: options.ignoreEnvGates,
          });
    this.adapters = result.adapters;
    this.skipped = result.skipped;
  }

  /**
   * Die Venue→Adapter-Map, die `MarketDataSyncService` direkt konsumiert:
   * `new MarketDataSyncService(registry, history, adapters.entries)`.
   */
  get entries(): Map<string, MarketDataAdapter> {
    return this.adapters;
  }

  /** Adapter für eine Venue (venue-Key wird normalisiert, case-insensitiv). */
  get(venue: string): MarketDataAdapter | undefined {
    const key = sanitizeVenue(venue).toUpperCase();
    return this.adapters.get(key) ?? this.adapters.get(venue);
  }

  has(venue: string): boolean {
    return this.get(venue) !== undefined;
  }

  /** Registrierte Venue-Keys (sortiert). */
  list(): string[] {
    return [...this.adapters.keys()].sort();
  }

  /** Bekannte Sync-Venues unabhängig vom Gate (Diagnose/Help-Text). */
  known(): readonly string[] {
    return KNOWN_SYNC_VENUES;
  }
}

/** Factory-Wrapper — die einzige öffentliche Instanzierungsstufe für Sync-Adapter. */
export function createAdapterRegistry(options: AdapterRegistryOptions = {}): AdapterRegistry {
  return new AdapterRegistry(options);
}
