/**
 * Mock-Public-Client für Bitunix-Unit-Tests (FEHLER-2-Verdrahtung).
 *
 * - 0 echtes Netz: optional in-prozess `fetch`-Mock gegen das öffentliche
 *   Bitunix-REST-Schema (trading_pairs / tickers / kline / depth).
 * - 0 Credentials: nie signiert, nie Private-Calls, nie API-Keys.
 * - `baseUrl` vorhanden → Client gegen echten (lokalen) Fixture-HTTP-Server
 *   (s. `bitunixFixtureServer.ts`), sonst deterministischer In-Memory-Mock.
 */
import { BITUNIX_PATHS, loadBitunixConfig } from "../../src/brokers/bitunix/config";
import { TokenBucket } from "../../src/brokers/bitunix/http";
import { BitunixPublicClient } from "../../src/brokers/bitunix/publicClient";

/** Deterministische Discovery-Fixture (2 valide Zeilen + 1 kaputte). */
const TRADING_PAIRS = [
  {
    symbol: "BTCUSDT",
    base: "BTC",
    quote: "USDT",
    minTradeVolume: "0.001",
    basePrecision: 3,
    quotePrecision: 1,
    maxLeverage: 125,
    symbolStatus: "OPEN",
  },
  {
    symbol: "ETHUSDT",
    base: "ETH",
    quote: "USDT",
    minTradeVolume: "0.01",
    basePrecision: 2,
    quotePrecision: 2,
    maxLeverage: 50,
    symbolStatus: "OPEN",
  },
  { symbol: "??", base: "X", quote: "Y" },
];

const TICKERS = [
  {
    symbol: "BTCUSDT",
    lastPrice: "65000.5",
    markPrice: "65001",
    quoteVol: "120000000",
    baseVol: "1846",
    high: "66100",
    low: "64000",
  },
  {
    symbol: "ETHUSDT",
    lastPrice: "3200.5",
    markPrice: "3201",
    quoteVol: "80000000",
    baseVol: "25000",
    high: "3280",
    low: "3150",
  },
];

const KLINES = [
  { time: 1_700_000_000_000, open: "64000", high: "66100", low: "63900", close: "65000", baseVol: "10" },
  { time: 1_700_000_060_000, open: "65000", high: "65200", low: "64900", close: "65100", baseVol: "8" },
  { time: 1_700_000_120_000, open: "65100", high: "65400", low: "65050", close: "65300", baseVol: "12" },
];

const DEPTH = {
  bids: [
    ["64999", "1.2"],
    ["64998", "0.5"],
  ],
  asks: [
    ["65001", "0.8"],
    ["65002", "2"],
  ],
};

export interface MockBitunixFetchOptions {
  /** `trading_pairs` liefert ein leeres Array (Edge-Case-Tests). */
  emptyTradingPairs?: boolean;
  /** `depth` antwortet mit diesem HTTP-Status. */
  depthStatus?: number;
  /** `depth` liefert `depthStatus` genau so oft, dann 200 (Retry-Tests). */
  depth429BeforeSuccess?: number;
}

export interface MockBitunixCall {
  path: string;
  query: Record<string, string>;
}

/**
 * In-prozess `fetch`-Implementierung gegen das Bitunix-Public-Schema.
 * Zählt Requests (Pfad + Query) für Retry-/Isolations-Assertions.
 */
export function createMockBitunixFetch(
  opts: MockBitunixFetchOptions = {}
): { fetchImpl: typeof fetch; calls: MockBitunixCall[] } {
  const calls: MockBitunixCall[] = [];
  const ok = (status: number, data: unknown): Response =>
    new Response(
      JSON.stringify({ code: status === 200 ? 0 : status, msg: status === 200 ? "ok" : "forced", data }),
      { status, headers: { "content-type": "application/json" } }
    );

  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    calls.push({ path: url.pathname, query: Object.fromEntries(url.searchParams) });

    if (url.pathname === BITUNIX_PATHS.tradingPairs) {
      return ok(200, opts.emptyTradingPairs ? [] : TRADING_PAIRS);
    }
    if (url.pathname === BITUNIX_PATHS.tickers) {
      const filter = url.searchParams.get("symbols");
      const rows = filter
        ? TICKERS.filter((t) =>
            filter.split(",").map((s) => s.trim().toUpperCase()).includes(t.symbol.toUpperCase())
          )
        : TICKERS;
      return ok(200, rows);
    }
    if (url.pathname === BITUNIX_PATHS.kline) {
      return ok(200, KLINES);
    }
    if (url.pathname === BITUNIX_PATHS.depth) {
      if (opts.depthStatus && opts.depth429BeforeSuccess !== undefined) {
        const depthCalls = calls.filter((c) => c.path === BITUNIX_PATHS.depth).length;
        if (depthCalls <= opts.depth429BeforeSuccess) return ok(opts.depthStatus, null);
      }
      return ok(200, DEPTH);
    }
    return ok(404, { code: 1, msg: "not found", data: null });
  };

  return { fetchImpl, calls };
}

export interface MockBitunixPublicClientOptions {
  /** Present → Client gegen echten (lokalen) Fixture-HTTP-Server. */
  baseUrl?: string;
  /** Eigener `fetch` (Default: In-Memory-Mock). */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Retry-Versuche (Default: Produktion-Default 3). */
  retryMax?: number;
}

/**
 * Public-Client ohne Credentials und ohne echtes Netz (Default).
 * NUR Public-Endpunkte — nie Private, nie signiert.
 */
export function mockBitunixPublicClient(
  opts: MockBitunixPublicClientOptions = {}
): BitunixPublicClient {
  const config = loadBitunixConfig({
    BITUNIX_ENABLED: "true",
    BITUNIX_ALLOW_INSECURE_HTTP: "true",
    BITUNIX_BASE_URL: opts.baseUrl ?? "http://127.0.0.1:9",
    BITUNIX_RETRY_MAX: String(opts.retryMax ?? 3),
    BITUNIX_TIMEOUT_MS: String(opts.timeoutMs ?? 2000),
    BITUNIX_ALLOWED_HOSTS: "127.0.0.1,localhost",
  });
  return new BitunixPublicClient({
    config,
    bucket: new TokenBucket(config.publicRatePerSec, config.publicRatePerSec),
    fetchImpl: opts.fetchImpl ?? createMockBitunixFetch().fetchImpl,
  });
}
