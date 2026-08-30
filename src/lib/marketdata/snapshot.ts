/**
 * Snapshot-Builder (Task 03 / Paper-Vereinheitlichung).
 *
 * Wandelt einen reinen Last-Preis-Ticker (z. B. Bitunix Public-Ticker ohne
 * Level-1-Orderbuch) in einen normalisierten `MarketSnapshot` um, damit ALLE
 * Paper-Ausführungspfade durch DIESELBE zentrale Fill-Engine (`FillSimulator`)
 * laufen — statt eigener, abweichender Ledger-Logik.
 *
 * Bid/Ask werden symmetrisch aus einem synthetischen Spread (Basispunkte,
 * `FillSimulatorConfig.syntheticSpreadBps`) um den Last-Preis konstruiert.
 * Rein deterministisch, kein IO.
 */
import type { MarketInstrument } from "../../universe/types";
import { applyAvailabilityProjection } from "../../universe/capabilityProjection";
import type { MarketSnapshot, MarketDataSource } from "./types";

export interface LastPriceSnapshotInput {
  /** Venue-natives Symbol, z. B. `"BTCUSDT"`. */
  symbol: string;
  /** Zuletzt gehandelter Preis (> 0). */
  last: number;
  /** Synthetischer relativer Spread als Dezimalanteil (0.0002 = 2 bp). */
  spread: number;
  /** 24-h-Volumen in Quote-Währung, falls bekannt (sonst null). */
  volume24h?: number | null;
  /** Venue, an der der Kurs beobachtet wurde (z. B. `"BITUNIX"`). */
  venue: string;
  /** Basis-Asset (null bei Aktien/ETFs/FX). */
  base?: string | null;
  /** Quote-/Abrechnungswährung. */
  quote?: string;
  /** Kanonische Instrument-ID; Default `"<VENUE>:<SYMBOL>"`. */
  instrumentId?: string;
  /** Kurs-Zeitpunkt (epoch ms); Default `Date.now()`. */
  ts?: number;
  /** Herkunft; Default `"broker"`. */
  source?: MarketDataSource;
  /** Feed-Instanz-Provenienz; Default `"broker"`. */
  feed?: string;
}

/**
 * Baut einen `MarketSnapshot` aus einem Last-Preis. Bid/Ask werden symmetrisch
 * um den Last-Preis erzeugt: `bid = last·(1 − s/2)`, `ask = last·(1 + s/2)`,
 * wobei `s` der relative Spread ist. Damit füllt der zentrale Simulator LONG am
 * Ask und SHORT am Bid — identische Semantik wie bei echten Level-1-Feeds.
 */
export function snapshotFromLastPrice(input: LastPriceSnapshotInput): MarketSnapshot {
  const symbol = input.symbol.toUpperCase();
  const spread = Number.isFinite(input.spread) && input.spread > 0 ? input.spread : 0;
  const half = spread / 2;
  const last = input.last;
  const bid = last * (1 - half);
  const ask = last * (1 + half);
  return {
    instrumentId: input.instrumentId ?? `${input.venue.toUpperCase()}:${symbol}`,
    symbol,
    base: input.base ?? null,
    quote: input.quote ?? "USDT",
    bid,
    ask,
    last,
    ts: input.ts ?? Date.now(),
    source: input.source ?? "broker",
    venue: input.venue.toUpperCase(),
    feed: input.feed ?? "broker",
    spread,
    volume24h: input.volume24h ?? null,
  };
}

/**
 * Minimales Fallback-Instrument für Symbole, die (noch) nicht in der Registry
 * stehen. Trägt nur die für den Simulator relevanten Felder (Gebühren, IDs);
 * die restlichen Felder sind konservative, neutrale Defaults. Der Simulator
 * nutzt daraus ausschließlich `makerFee`/`takerFee`.
 */
export function fallbackInstrument(
  venue: string,
  symbol: string,
  overrides: Partial<MarketInstrument> = {}
): MarketInstrument {
  const v = venue.toUpperCase();
  const s = symbol.toUpperCase();
  return {
    id: `${v}:${s}`,
    venue: v,
    symbol: s,
    base: null,
    quote: "USDT",
    assetClass: "crypto",
    marketType: "perpetual",
    status: "active",
    minQuantity: 0,
    priceStep: 0,
    quantityStep: 0,
    makerFee: 0,
    takerFee: 0,
    leverageAvailable: false,
    shortAvailable: false,
    paperAvailable: true,
    liveTradable: false,
    liveAvailable: applyAvailabilityProjection({
      venue: v,
      symbol: s,
      liveTradable: false,
      paperAvailable: true,
    }).liveAvailable,
    volume24h: null,
    spread: null,
    volatility: null,
    lastSeen: new Date(0).toISOString(),
    ...overrides,
  };
}
