/**
 * Binance-Feed (Task 03) — echter Krypto-Kurs, read-only, ohne API-Key.
 *
 * Bid/Ask aus `/api/v3/ticker/bookTicker`, last + 24h-Volumen aus
 * `/api/v3/ticker/24hr`, Kerzen aus `/api/v3/klines`.
 *
 * Venue-Details (Symbol-Mapping, REST-Formate) leben ausschließlich hier
 * (Decoupling-Regel 2). HTTP über `httpGetJson` mit Timeout/Retry/SSRF.
 */
import type { MarketInstrument } from "../../../universe/types";
import { FeedNotSupportedError, type MarketCandle, type MarketFeed, type MarketSnapshot, type MarketDataSource } from "../types";
import { httpGetJson, type HttpOptions } from "../http";
import { normalizeSnapshot, type RawSnapshotInput } from "../normalization";

export interface BinanceFeedOptions extends HttpOptions {
  baseUrl?: string;
}

interface BookTicker {
  symbol: string;
  bidPrice: string;
  askPrice: string;
}

interface Ticker24h {
  lastPrice: string;
  quoteVolume?: string;
}

interface Kline {
  0: number; 1: string; 2: string; 3: string; 4: string; 5: string;
}

/**
 * Liefert den Binance-Spot-Pair-Namen aus einem Instrument (z. B. `BTC` → `BTCUSDT`).
 * Crypto-Spot-Paare: Base-Asset + `USDT`.
 */
export function binancePairOf(instrument: MarketInstrument): string {
  if (instrument.assetClass !== "crypto" || !instrument.base) {
    throw new FeedNotSupportedError(
      "binance",
      instrument.id,
      `erwartet crypto mit base-Asset (bekam ${instrument.assetClass}/${instrument.base ?? "kein-base"})`
    );
  }
  return `${instrument.base.toUpperCase()}USDT`;
}

/**
 * Deterministischer Binance-Feed. `baseUrl`/`allowedHosts` sind für Tests
 * überschreibbar (lokaler Fixture-Server, kein echtes Netz).
 */
export class BinanceFeed implements MarketFeed {
  readonly id = "binance";
  readonly source: MarketDataSource = "binance";
  private readonly baseUrl: string;
  private readonly http: HttpOptions;

  constructor(opts: BinanceFeedOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "https://api.binance.com").replace(/\/$/, "");
    this.http = {
      timeoutMs: opts.timeoutMs,
      maxRetries: opts.maxRetries,
      baseBackoffMs: opts.baseBackoffMs,
      allowedHosts: opts.allowedHosts,
    };
  }

  async getTicker(instrument: MarketInstrument): Promise<MarketSnapshot> {
    const pair = binancePairOf(instrument);
    const url = `${this.baseUrl}/api/v3/ticker/bookTicker?symbol=${encodeURIComponent(pair)}`;
    const book = await httpGetJson<BookTicker>(url, this.http);

    const lastUrl = `${this.baseUrl}/api/v3/ticker/24hr?symbol=${encodeURIComponent(pair)}`;
    let last = Number(book.bidPrice);
    let volume24h: number | null = null;
    try {
      const t = await httpGetJson<Ticker24h>(lastUrl, this.http);
      last = Number(t.lastPrice);
      const qv = Number(t.quoteVolume);
      volume24h = Number.isFinite(qv) && qv > 0 ? qv : null;
    } catch {
      /* last fällt auf bookTicker-Preis zurück */
    }

    const input: RawSnapshotInput = {
      instrumentId: instrument.id,
      symbol: pair,
      base: instrument.base,
      quote: "USDT",
      bid: Number(book.bidPrice),
      ask: Number(book.askPrice),
      last,
      ts: Date.now(),
      source: this.source,
      venue: "BINANCE",
      feed: this.id,
      volume24h,
    };
    return normalizeSnapshot(input);
  }

  async getCandles(instrument: MarketInstrument, interval: string, limit: number): Promise<MarketCandle[]> {
    const pair = binancePairOf(instrument);
    const url = `${this.baseUrl}/api/v3/klines?symbol=${encodeURIComponent(pair)}&interval=${encodeURIComponent(interval)}&limit=${limit}`;
    const raw = await httpGetJson<Kline[]>(url, this.http);
    return raw.map((k) => ({
      time: Number(k[0]),
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[5]),
    }));
  }
}
