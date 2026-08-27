/**
 * Broker-Feed (Task 03) — delegiert Marktdaten an einen `BrokerAdapter`
 * (vgl. Task 02).
 *
 * Dies ist die primäre Quelle in Modus B (broker-market-data): Der Kurs kommt
 * von der Venue, über die auch die Orders laufen. Der Feed ist damit
 * broker-unabhängig — jeder Adapter mit `marketData`-Capability kann hier
 * hängen (PAPER → Binance/Yahoo, später Alpaca/IBKR).
 *
 * `MarketTicker` kennt nur einen Preis; Bid/Ask werden aus dem Registry-Feld
 * `spread` (bzw. Default) abgeleitet.
 */
import type { MarketInstrument } from "../../../universe/types";
import type { BrokerAdapter } from "../../../contracts/broker";
import { FeedNotSupportedError, type MarketCandle, type MarketDataSource, type MarketFeed, type MarketSnapshot } from "../types";
import { normalizeSnapshot, type RawSnapshotInput } from "../normalization";

export interface BrokerFeedOptions {
  /** Relativer Default-Spread für Bid/Ask-Ableitung. */
  defaultSpread?: number;
}

export class BrokerFeed implements MarketFeed {
  readonly id: string;
  readonly source: MarketDataSource = "broker";
  private readonly defaultSpread: number;

  constructor(
    private readonly adapter: BrokerAdapter,
    opts: BrokerFeedOptions = {}
  ) {
    this.id = `broker:${adapter.id}`;
    this.defaultSpread = opts.defaultSpread ?? 0.0004;
  }

  async getTicker(instrument: MarketInstrument): Promise<MarketSnapshot> {
    if (!this.adapter.getTicker || !this.adapter.capabilities.marketData) {
      throw new FeedNotSupportedError(
        this.id,
        instrument.id,
        "Adapter hat keine marketData-Capability"
      );
    }
    const ticker = await this.adapter.getTicker(instrument.symbol);
    const spread = Number.isFinite(instrument.spread) && (instrument.spread as number) > 0
      ? (instrument.spread as number)
      : this.defaultSpread;
    const half = spread / 2;
    const input: RawSnapshotInput = {
      instrumentId: instrument.id,
      symbol: ticker.symbol,
      base: instrument.base,
      quote: instrument.quote,
      bid: ticker.price * (1 - half),
      ask: ticker.price * (1 + half),
      last: ticker.price,
      ts: ticker.ts,
      source: this.source,
      venue: this.adapter.id,
      feed: this.id,
      volume24h: null,
    };
    return normalizeSnapshot(input);
  }

  async getCandles(instrument: MarketInstrument, interval: string, limit: number): Promise<MarketCandle[]> {
    if (!this.adapter.getCandles || !this.adapter.capabilities.marketData) {
      throw new FeedNotSupportedError(
        this.id,
        instrument.id,
        "Adapter hat keine marketData-Capability"
      );
    }
    const candles = await this.adapter.getCandles(instrument.symbol, interval);
    return candles.slice(-limit);
  }
}
