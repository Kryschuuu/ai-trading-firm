/**
 * Fixtures für die Scanner-Tests (Task 04).
 *
 * Alles deterministisch: Kerzen werden aus expliziten Kursreihen oder aus einem
 * geseedeten PRNG (`createRng`, Task 03) erzeugt — kein `Math.random`, keine Uhr.
 */
import { createRng } from "../../src/lib/marketdata/prng";
import type { MarketCandle } from "../../src/lib/marketdata/types";
import type { AssetClass, MarketInstrument, MarketType } from "../../src/universe/types";
import type { ScanDataProvider } from "../../src/scanner/pipeline";

/** Fester Auswertungszeitpunkt aller Tests. */
export const AS_OF = "2026-08-27T00:00:00.000Z";
/** `AS_OF` in Millisekunden. */
export const AS_OF_MS = Date.parse(AS_OF);
/** Eine Tageskerze in Millisekunden. */
export const DAY_MS = 86_400_000;

/** Baut ein vollständiges `MarketInstrument` mit sinnvollen Defaults. */
export function instrument(overrides: Partial<MarketInstrument> = {}): MarketInstrument {
  const venue = overrides.venue ?? "BINANCE";
  const symbol = overrides.symbol ?? "BTCUSDT";
  const base: MarketInstrument = {
    id: `${venue}:${symbol}`,
    venue,
    symbol,
    base: "BTC",
    quote: "USDT",
    assetClass: "crypto",
    marketType: "spot",
    status: "active",
    minQuantity: 0.0001,
    priceStep: 0.01,
    quantityStep: 0.0001,
    makerFee: 0.0002,
    takerFee: 0.0004,
    leverageAvailable: false,
    shortAvailable: false,
    paperAvailable: true,
    liveAvailable: false,
    volume24h: 1_000_000_000,
    spread: 0.0002,
    volatility: 0.5,
    lastSeen: AS_OF,
  };
  const merged: MarketInstrument = { ...base, ...overrides };
  merged.id = `${merged.venue}:${merged.symbol}`;
  return merged;
}

/** Optionen für {@link candlesFromCloses}. */
export interface CandleOptions {
  /** Zeitstempel der letzten Kerze (Default `AS_OF_MS`). */
  endTime?: number;
  /** Abstand zweier Kerzen (Default 1 Tag). */
  stepMs?: number;
  /** Volumen je Kerze (Zahl oder Liste, Default 1000). */
  volume?: number | number[];
  /** High/Low als Anteil des Closes (Default 0 ⇒ high = low = close). */
  wickPct?: number;
}

/** Baut eine Kerzenserie aus Schlusskursen (aufsteigende Zeitstempel). */
export function candlesFromCloses(closes: readonly number[], options: CandleOptions = {}): MarketCandle[] {
  const step = options.stepMs ?? DAY_MS;
  const end = options.endTime ?? AS_OF_MS;
  const wick = options.wickPct ?? 0;
  return closes.map((close, i) => {
    const volume = Array.isArray(options.volume) ? (options.volume[i] ?? 0) : (options.volume ?? 1000);
    const open = i === 0 ? close : closes[i - 1];
    return {
      time: end - (closes.length - 1 - i) * step,
      open,
      high: close * (1 + wick),
      low: close * (1 - wick),
      close,
      volume,
    };
  });
}

/** Kursreihe mit konstanter Wachstumsrate (`start × growth^i`). */
export function growthSeries(start: number, growth: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => start * growth ** i);
}

/**
 * Ein „gesundes“ Kursbild mit ausreichender Historie für alle Faktoren:
 * gleichmäßiger Aufwärtstrend plus eine deterministische Schwankung von 1,5 %
 * im Wechsel — damit liegt die realisierte Volatilität im NORMAL-Regime
 * (reiner Wachstumspfad hätte σ = 0).
 */
export function healthyCandles(count = 80): MarketCandle[] {
  const closes = growthSeries(100, 1.004, count).map((c, i) => (i % 2 === 0 ? c : c * 1.015));
  return candlesFromCloses(closes, { wickPct: 0.01, volume: 1000 });
}

/** Deterministische synthetische Instrumente für Benchmark-/Trichter-Tests. */
export function syntheticInstruments(count: number, seed = 42): MarketInstrument[] {
  const rng = createRng(seed);
  const classes: AssetClass[] = ["crypto", "equity", "etf", "fx", "commodity", "index"];
  const types: MarketType[] = ["spot", "spot", "perpetual", "future"];
  const venues = ["BINANCE", "KRAKEN", "ALPACA", "IBKR", "BITUNIX"];
  const out: MarketInstrument[] = [];
  for (let i = 0; i < count; i++) {
    const venue = venues[Math.floor(rng() * venues.length)];
    const assetClass = classes[Math.floor(rng() * classes.length)];
    const marketType = types[Math.floor(rng() * types.length)];
    const volume = 10 ** (5 + rng() * 5);
    const spread = 0.00005 + rng() * 0.004;
    out.push(
      instrument({
        venue,
        symbol: `SYN${String(i).padStart(5, "0")}`,
        base: `SYN${i}`.slice(0, 12).toUpperCase(),
        quote: "USDT",
        assetClass,
        marketType,
        makerFee: 0.0001 + rng() * 0.0005,
        takerFee: 0.0003 + rng() * 0.0008,
        volume24h: volume,
        spread,
        volatility: 0.1 + rng() * 1.5,
      })
    );
  }
  return out;
}

/**
 * Datenanbindung für synthetische Instrumente: erzeugt je Instrument eine
 * geseedete Kursreihe (Random Walk) — gleiche Seed ⇒ gleiche Serie.
 */
export function syntheticProvider(seed = 7, candleCount = 120): ScanDataProvider {
  const seriesFor = (id: string, offset: number): MarketCandle[] => {
    let hash = 0;
    for (let i = 0; i < id.length; i++) hash = (Math.imul(hash, 31) + id.charCodeAt(i)) | 0;
    const rng = createRng((hash ^ (seed + offset)) >>> 0);
    const closes: number[] = [];
    let price = 50 + rng() * 200;
    const drift = (rng() - 0.5) * 0.004;
    const vol = 0.005 + rng() * 0.04;
    for (let i = 0; i < candleCount; i++) {
      price = Math.max(0.01, price * (1 + drift + (rng() - 0.5) * vol));
      closes.push(price);
    }
    const volumes = closes.map(() => 500 + rng() * 1500);
    return candlesFromCloses(closes, { wickPct: 0.008, volume: volumes });
  };

  const benchmark = seriesFor("BENCHMARK", 0);
  return {
    candles: (i) => seriesFor(i.id, 1),
    benchmarkCandles: () => benchmark,
    derivatives: (i) =>
      i.marketType === "perpetual"
        ? { fundingRate: 0.0001, fundingIntervalHours: 8, openInterest: 25_000_000, openInterestChange24h: 0.01 }
        : null,
    news: () => ({ events24h: 1, events7d: 4, highImpact24h: 0, scheduledEventInHours: null }),
  };
}
