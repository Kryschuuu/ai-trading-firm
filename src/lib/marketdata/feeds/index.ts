/**
 * Feed-Registry (Task 03).
 *
 * Baut die konkreten Feeds aus der Konfiguration. Feeds sind rein deterministisch
 * und venue-unabhängig über `MarketFeed` — Venue-Details leben in den Implementierungen.
 */
import type { BrokerAdapter } from "../../../contracts/broker";
import { BinanceFeed } from "./binance";
import { YahooFeed } from "./yahoo";
import { SyntheticFeed } from "./synthetic";
import { ReplayFeed } from "./replay";
import { BrokerFeed } from "./brokerFeed";
import { HistoricalStore } from "../historicalStore";
import type { MarketFeed } from "../types";
import type { MarketDataConfig } from "../config";

export { BinanceFeed } from "./binance";
export { YahooFeed } from "./yahoo";
export { SyntheticFeed, deterministicBasePrice } from "./synthetic";
export { ReplayFeed } from "./replay";
export { BrokerFeed } from "./brokerFeed";

/** Baut alle Feeds aus der Konfiguration (einmal pro Manager). */
export function buildFeeds(
  cfg: MarketDataConfig,
  opts: { brokerAdapter?: BrokerAdapter; store: HistoricalStore }
): { broker?: BrokerFeed; binance: BinanceFeed; yahoo: YahooFeed; synthetic: SyntheticFeed; replay: ReplayFeed } {
  const baseHttp = {
    timeoutMs: cfg.feedTimeoutMs,
    maxRetries: cfg.feedRetryMax,
    allowedHosts: cfg.allowedHosts,
  };
  const binance = new BinanceFeed({ ...baseHttp, baseUrl: cfg.binanceBaseUrl });
  const yahoo = new YahooFeed({ ...baseHttp, baseUrl: cfg.yahooBaseUrl });
  const synthetic = new SyntheticFeed({ seed: cfg.simulator.seed, basePrice: cfg.syntheticBasePrice });
  const replay = new ReplayFeed(opts.store);
  const broker = opts.brokerAdapter
    ? new BrokerFeed(opts.brokerAdapter)
    : undefined;
  return { broker, binance, yahoo, synthetic, replay };
}

export type FeedSet = ReturnType<typeof buildFeeds>;
export type { MarketFeed };
