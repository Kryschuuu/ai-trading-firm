/**
 * Bitunix public market-data adapter.
 *
 * Wraps `BitunixPublicClient` only — never `BitunixPrivateClient`, never
 * credentials, never signed requests. Rate limiting is the Token-Bucket
 * already attached to `BitunixHttp` (conservative 8 req/s vs. documented
 * 10 req/s/IP).
 */

import { BitunixPublicClient, mapTicker } from "../../brokers/bitunix/publicClient";
import { loadBitunixConfig, type BitunixRuntimeConfig } from "../../brokers/bitunix/config";
import { TokenBucket } from "../../brokers/bitunix/http";
import type { MarketDataAdapter } from "../sync";
import type { MarketCandle, MarketInstrument, MarketOrderBook, MarketTicker } from "../types";

export class BitunixMarketDataAdapter implements MarketDataAdapter {
  constructor(private readonly client: BitunixPublicClient) {}

  async discoverInstruments(): Promise<MarketInstrument[]> {
    return this.client.fetchTradingPairs();
  }

  async getTicker(symbol: string): Promise<MarketTicker> {
    return this.client.fetchTicker(symbol);
  }

  /** 1 × tickers — Bitunix returns the full public ticker set when unfiltered. */
  async getTickers(symbols?: string[]): Promise<MarketTicker[]> {
    const query = symbols?.length ? symbols.join(",") : undefined;
    const rows = await this.client.fetchTickers(query);
    return rows.map(mapTicker);
  }

  async getOrderBook(symbol: string): Promise<MarketOrderBook> {
    return this.client.fetchOrderBook(symbol);
  }

  async getCandles(symbol: string, timeframe: string, limit: number): Promise<MarketCandle[]> {
    return this.client.fetchKlines(symbol, timeframe, limit);
  }
}

export interface BitunixAdapterFactoryOptions {
  config?: BitunixRuntimeConfig;
  client?: BitunixPublicClient;
  bucket?: TokenBucket;
}

/** Public-only Bitunix adapter. Callers must not pass a private client. */
export function createBitunixMarketDataAdapter(
  options: BitunixAdapterFactoryOptions = {},
): BitunixMarketDataAdapter {
  if (options.client) return new BitunixMarketDataAdapter(options.client);
  const config = options.config ?? loadBitunixConfig();
  const bucket = options.bucket ?? new TokenBucket(config.publicRatePerSec, config.publicRatePerSec);
  return new BitunixMarketDataAdapter(new BitunixPublicClient({ config, bucket }));
}

/**
 * Test helper: public client against a local fixture / mock HTTP server.
 * Never attaches credentials; only `BITUNIX_ALLOW_INSECURE_HTTP` + allowlist
 * are required so loopback HTTP is accepted by the SSRF guard.
 */
export function mockBitunixPublicClient(opts: {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): BitunixPublicClient {
  const config = loadBitunixConfig({
    BITUNIX_ENABLED: "true",
    BITUNIX_ALLOW_INSECURE_HTTP: "true",
    BITUNIX_BASE_URL: opts.baseUrl,
    BITUNIX_RETRY_MAX: "1",
    BITUNIX_TIMEOUT_MS: String(opts.timeoutMs ?? 2000),
    BITUNIX_ALLOWED_HOSTS: "127.0.0.1,localhost",
  });
  return new BitunixPublicClient({
    config,
    bucket: new TokenBucket(config.publicRatePerSec, config.publicRatePerSec),
    fetchImpl: opts.fetchImpl,
  });
}
