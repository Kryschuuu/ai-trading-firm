/**
 * Adapter-Registry — zentrale Venue→MarketDataAdapter-Mapping.
 *
 * Diese Registry ist die einzige Stelle, die konkrete
 * MarketDataAdapter-Implementierungen instanziiert. Neue Venues (Binance,
 * Bitfinex, ...) werden hier registriert, NICHT im Scanner oder in /api/markets.
 *
 * Architektur-Trennung:
 * - `MarketDataSyncService` konsumiert nur das venue-agnostische
 *   `MarketDataAdapter`-Interface (`./sync.ts`) + diese Map.
 * - Der Scanner (`src/scanner/`) kennt ausschließlich `InstrumentRegistry`
 *   und `HistoricalStore` — er importiert keine Adapter-Klasse.
 * - Order-Ausführung läuft über `getBroker()` (`src/brokers/factory.ts`)
 *   und ist von diesem Sync-Pfad komplett getrennt.
 *
 * Sicherheit (Sync-Kontext): `BitunixBrokerAdapter` wird hier immer im
 * Modus `"paper"` und **ohne** PrivateClient/credentials erzeugt. Discovery
 * und Enrichment nutzen ausschließlich den internen Public-Client
 * (trading_pairs / tickers / depth / kline) — niemals signierte Requests.
 */
import { BitunixBrokerAdapter } from "../brokers/bitunix/adapter";
import type { EnvLike } from "../brokers/bitunix/config";
import type { InstrumentRegistry } from "../universe/registry";
import { sanitizeVenue } from "./errors";
import type { MarketDataAdapter } from "./sync";

/** Venue-Key unter dem Bitunix registriert ist. */
export const BITUNIX_VENUE = "BITUNIX" as const;

export interface AdapterRegistryOptions {
  /** Registry, in die Discovery-Ergebnisse beim Sync upsertet werden. */
  registry?: InstrumentRegistry;
  /** Env für die Adapter-Instanz (Default: `process.env`). */
  env?: EnvLike;
  /** `false` → keine Venues registrieren (isolierte Tests). */
  registerVenues?: boolean;
}

export class AdapterRegistry {
  private readonly adapters = new Map<string, MarketDataAdapter>();

  constructor(options: AdapterRegistryOptions = {}) {
    if (options.registerVenues === false) return;
    this.adapters.set(BITUNIX_VENUE, this.createBitunixAdapter(options));
  }

  /**
   * Die Venue→Adapter-Map, die `MarketDataSyncService` direkt konsumiert:
   * `new MarketDataSyncService(registry, history, adapters.entries)`.
   */
  readonly entries: Map<string, MarketDataAdapter> = this.adapters;

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

  /**
   * Bitunix im Sync-Kontext: Modus `"paper"`, kein PrivateClient, keine
   * Credentials. Der interne Public-Client trägt den Token-Bucket
   * (8 req/s) — ein zweiter Limiter auf Orchestrier-Ebene wäre doppelt.
   */
  private createBitunixAdapter(options: AdapterRegistryOptions): MarketDataAdapter {
    return new BitunixBrokerAdapter("paper", {
      env: options.env ?? process.env,
      registry: options.registry,
    });
  }
}

/** Factory-Wrapper — die einzige öffentliche Instanzierungsstufe für Sync-Adapter. */
export function createAdapterRegistry(options: AdapterRegistryOptions = {}): AdapterRegistry {
  return new AdapterRegistry(options);
}
