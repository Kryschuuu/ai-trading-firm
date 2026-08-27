/**
 * Yahoo-Feed (Task 03) — echter Kurs für Aktien/ETFs/FX/Indizes, read-only.
 *
 * Yahoo liefert nur einen letzten Preis (kein echtes Level-1-Bid/Ask), daher
 * wird der Spread aus dem Registry-Feld `spread` (falls gesetzt) bzw. einem
 * dokumentierten Default (`defaultSpread`, 4 bp) abgeleitet. Bid = last·(1−s/2),
 * Ask = last·(1+s/2).
 *
 * Venue-Details (Symbol, REST-Format) leben ausschließlich hier (Regel 2).
 */
import type { MarketInstrument } from "../../../universe/types";
import { FeedNotSupportedError, type MarketCandle, type MarketDataSource, type MarketFeed, type MarketSnapshot } from "../types";
import { httpGetJson, type HttpOptions } from "../http";
import { normalizeSnapshot, type RawSnapshotInput } from "../normalization";

export interface YahooFeedOptions extends HttpOptions {
  baseUrl?: string;
  /** Relativer Default-Spread (0.0004 = 4 bp), wenn Registry-Feld fehlt. */
  defaultSpread?: number;
}

interface ChartResp {
  chart?: { result?: { meta?: { regularMarketPrice?: number } }[] };
}

interface QuoteCandleResp {
  chart?: {
    result?: {
      timestamp?: number[];
      indicators?: {
        quote?: {
          open?: (number | null)[];
          high?: (number | null)[];
          low?: (number | null)[];
          close?: (number | null)[];
          volume?: (number | null)[];
        }[];
      };
    }[];
  };
}

/** True, wenn der Feed dieses Instrument bedienen kann (Nicht-Krypto). */
export function yahooSupports(instrument: MarketInstrument): boolean {
  return instrument.assetClass !== "crypto";
}

export class YahooFeed implements MarketFeed {
  readonly id = "yahoo";
  readonly source: MarketDataSource = "yahoo";
  private readonly baseUrl: string;
  private readonly defaultSpread: number;
  private readonly http: HttpOptions;

  constructor(opts: YahooFeedOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "https://query1.finance.yahoo.com").replace(/\/$/, "");
    this.defaultSpread = opts.defaultSpread ?? 0.0004;
    this.http = {
      timeoutMs: opts.timeoutMs,
      maxRetries: opts.maxRetries,
      baseBackoffMs: opts.baseBackoffMs,
      allowedHosts: opts.allowedHosts,
    };
  }

  private assertSupports(instrument: MarketInstrument): void {
    if (!yahooSupports(instrument)) {
      throw new FeedNotSupportedError(
        this.id,
        instrument.id,
        "Yahoo bedient keine Krypto-Spots (dafür Binance)"
      );
    }
  }

  async getTicker(instrument: MarketInstrument): Promise<MarketSnapshot> {
    this.assertSupports(instrument);
    const sym = encodeURIComponent(instrument.symbol);
    const url = `${this.baseUrl}/v8/finance/chart/${sym}?range=1d&interval=1d`;
    const data = await httpGetJson<ChartResp>(url, this.http);
    const price = data.chart?.result?.[0]?.meta?.regularMarketPrice;
    if (!price || !Number.isFinite(price) || price <= 0) {
      throw new Error("Yahoo: kein regulärer Marktpreis");
    }
    const spread = Number.isFinite(instrument.spread) && (instrument.spread as number) > 0
      ? (instrument.spread as number)
      : this.defaultSpread;
    const half = spread / 2;
    const input: RawSnapshotInput = {
      instrumentId: instrument.id,
      symbol: instrument.symbol,
      base: instrument.base,
      quote: instrument.quote,
      bid: price * (1 - half),
      ask: price * (1 + half),
      last: price,
      ts: Date.now(),
      source: this.source,
      venue: "YAHOO",
      feed: this.id,
      volume24h: null,
    };
    return normalizeSnapshot(input);
  }

  async getCandles(instrument: MarketInstrument, interval: string, limit: number): Promise<MarketCandle[]> {
    this.assertSupports(instrument);
    const range = interval.endsWith("m") ? "5d" : interval === "1d" ? "6mo" : "1mo";
    const sym = encodeURIComponent(instrument.symbol);
    const url = `${this.baseUrl}/v8/finance/chart/${sym}?range=${range}&interval=${interval}`;
    const data = await httpGetJson<QuoteCandleResp>(url, this.http);
    const r = data.chart?.result?.[0];
    const q = r?.indicators?.quote?.[0];
    if (!r?.timestamp || !q?.close) return [];
    const out: MarketCandle[] = [];
    for (let i = 0; i < r.timestamp.length; i++) {
      const c = q.close[i];
      if (c == null || !Number.isFinite(c)) continue;
      out.push({
        time: r.timestamp[i] * 1000,
        open: q.open?.[i] ?? c,
        high: q.high?.[i] ?? c,
        low: q.low?.[i] ?? c,
        close: c,
        volume: q.volume?.[i] ?? 0,
      });
    }
    return out.slice(-limit);
  }
}
