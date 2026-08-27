/**
 * Synthetic-Feed (Task 03) — seeded, deterministisch.
 *
 * NUR für Modus A (Synthetic/Replay) oder als EXPLIZITER Offline-Fallback
 * (Regel 3: niemals stiller Kursquellwechsel). Erzeugt einen Random-Walk um
 * eine deterministische Basis, mit deterministischem Spread/Volumen.
 *
 * Gleiche Seed + gleiche Aufruffolge → identische Kursfolge (bit-identisch).
 */
import type { MarketInstrument } from "../../../universe/types";
import { createRng, normalizeSeed } from "../prng";
import { type MarketCandle, type MarketDataSource, type MarketFeed, type MarketSnapshot } from "../types";
import { normalizeSnapshot, type RawSnapshotInput } from "../normalization";

export interface SyntheticFeedOptions {
  /** Seed (deterministisch). Default 0. */
  seed?: number | string;
  /** Basis-Preis (Tests). Fehlt er, wird deterministisch aus der Instrument-ID abgeleitet. */
  basePrice?: number | null;
  /** Relativer Spread (0.0005 = 5 bp). */
  spread?: number;
  /** Volatilität je Schritt (0.002 = 0,2 %). */
  volatility?: number;
  /** Standardabweichung des Random-Walks in % (dokumentiert). */
}

interface InstrumentState {
  price: number;
  rng: () => number;
  spread: number;
  volume24h: number;
}

/** Deterministische Basis-Preis-Ableitung aus der Instrument-ID (hash-basiert). */
export function deterministicBasePrice(instrument: MarketInstrument): number {
  const seed = normalizeSeed(instrument.id);
  const rng = createRng(seed ^ 0x5e9a);
  // Mapping auf 10..1000 in plausiblen Stufen (dokumentiert als Startwert).
  const u = rng();
  return Math.round((10 + u * 990) * 100) / 100;
}

export class SyntheticFeed implements MarketFeed {
  readonly id = "synthetic";
  readonly source: MarketDataSource = "synthetic";
  private readonly basePrice: number | null;
  private readonly spread: number;
  private readonly volatility: number;
  private readonly state = new Map<string, InstrumentState>();

  constructor(opts: SyntheticFeedOptions = {}) {
    this.basePrice = opts.basePrice ?? null;
    this.spread = opts.spread ?? 0.0005;
    this.volatility = opts.volatility ?? 0.002;
    this._seed = normalizeSeed(opts.seed);
  }

  private readonly _seed: number;

  private stateFor(instrument: MarketInstrument): InstrumentState {
    let s = this.state.get(instrument.id);
    if (s) return s;
    const instSeed = normalizeSeed(`${this._seed}:${instrument.id}`);
    const rng = createRng(instSeed);
    const price = this.basePrice ?? deterministicBasePrice(instrument);
    const spread = Number.isFinite(instrument.spread) && (instrument.spread as number) > 0
      ? (instrument.spread as number)
      : this.spread;
    const volumeRng = createRng(normalizeSeed(`${instSeed}:vol`));
    const volume24h = Number.isFinite(instrument.volume24h) && (instrument.volume24h as number) > 0
      ? (instrument.volume24h as number)
      : Math.round(1_000_000 * (0.1 + volumeRng() * 10));
    s = { price, rng, spread, volume24h };
    this.state.set(instrument.id, s);
    return s;
  }

  /** Einen synthetischen Snapshot erzeugen (Schritt des Random-Walks). */
  snapshot(instrument: MarketInstrument): MarketSnapshot {
    const st = this.stateFor(instrument);
    const next = st.price * (1 + (st.rng() - 0.5) * 2 * this.volatility);
    st.price = Math.max(next, 0.00000001);
    const half = st.spread / 2;
    const input: RawSnapshotInput = {
      instrumentId: instrument.id,
      symbol: instrument.symbol,
      base: instrument.base,
      quote: instrument.quote,
      bid: st.price * (1 - half),
      ask: st.price * (1 + half),
      last: st.price,
      ts: Date.now(),
      source: this.source,
      venue: instrument.venue,
      feed: this.id,
      volume24h: st.volume24h,
    };
    return normalizeSnapshot(input, { maxAgeMs: Infinity, maxJumpPct: 0, maxSpread: 1 });
  }

  getTicker(instrument: MarketInstrument): Promise<MarketSnapshot> {
    return Promise.resolve(this.snapshot(instrument));
  }

  async getCandles(instrument: MarketInstrument, _interval: string, limit: number): Promise<MarketCandle[]> {
    const st = this.stateFor(instrument);
    const candles: MarketCandle[] = [];
    let price = st.price;
    for (let i = 0; i < limit; i++) {
      const open = price;
      const close = open * (1 + (st.rng() - 0.5) * 2 * this.volatility);
      const high = Math.max(open, close) * (1 + st.rng() * this.volatility);
      const low = Math.min(open, close) * (1 - st.rng() * this.volatility);
      candles.push({
        time: Date.now() - (limit - i) * 60_000,
        open,
        high,
        low,
        close,
        volume: 0,
      });
      price = close;
    }
    return candles;
  }
}
