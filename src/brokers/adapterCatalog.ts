/**
 * Statischer Adapter-Katalog für Capability-Projektion.
 *
 * KEINE Adapter-Instanziierung, kein I/O. Der Katalog beschreibt, was der
 * Factory-Code dieses Repos registriert — Stubs vs. echte Adapter.
 *
 * `/api/markets` und die Universe-Registry lesen NUR diesen Katalog, niemals
 * `new BitunixBrokerAdapter()` / `createAdapter()`.
 *
 * Live-Fähigkeit kommt NICHT aus diesem Katalog, sondern aus
 * `capabilities[venue].live` (SSoT: `src/brokers/capabilities.ts`).
 */
import { BROKER_VENUE_IDS, type BrokerVenueId } from "../contracts/broker";

/** Venues, deren Factory-Pfad `StubBrokerAdapter` liefert. */
export const STUB_ADAPTER_VENUES: readonly BrokerVenueId[] = [
  "IBKR",
  "BINANCE",
  "KRAKEN",
  "DYDX",
];

export interface AdapterCatalogEntry {
  venue: BrokerVenueId;
  registered: true;
  /** true = Factory liefert StubBrokerAdapter. */
  isStub: boolean;
}

const STUB = new Set<string>(STUB_ADAPTER_VENUES);

function entry(venue: BrokerVenueId): AdapterCatalogEntry {
  return {
    venue,
    registered: true,
    isStub: STUB.has(venue),
  };
}

/** Single Source of Truth: welche Adapter der Factory-Code kennt. */
export const ADAPTER_CATALOG: Record<BrokerVenueId, AdapterCatalogEntry> = {
  PAPER: entry("PAPER"),
  ALPACA: entry("ALPACA"),
  IBKR: entry("IBKR"),
  BINANCE: entry("BINANCE"),
  KRAKEN: entry("KRAKEN"),
  DYDX: entry("DYDX"),
  BITUNIX: entry("BITUNIX"),
};

/** Lookup ohne Instanziierung — fail-closed bei unbekanntem Venue. */
export function lookupAdapter(venue: string): AdapterCatalogEntry | undefined {
  const key = venue.trim().toUpperCase();
  if (!(BROKER_VENUE_IDS as readonly string[]).includes(key)) return undefined;
  return ADAPTER_CATALOG[key as BrokerVenueId];
}

export interface ProjectionAdapterView {
  has(venue: string): boolean;
  get(venue: string): { isStub: boolean } | undefined;
}

/** Adapter-View für den Availability-Projektor (kein I/O, keine Instanziierung). */
export function adaptersFromCatalog(): ProjectionAdapterView {
  return {
    has(venue: string): boolean {
      return lookupAdapter(venue) !== undefined;
    },
    get(venue: string) {
      const found = lookupAdapter(venue);
      if (!found) return undefined;
      return { isStub: found.isStub };
    },
  };
}
