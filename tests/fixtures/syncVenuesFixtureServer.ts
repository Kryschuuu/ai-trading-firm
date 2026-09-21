/**
 * Lokaler Fixture-Server für die Sync-Venue-Adapter (BINANCE, KRAKEN, Yahoo).
 *
 * Bindet ausschließlich 127.0.0.1. Liefert venue-förmige Antworten für einen
 * kleinen, deterministischen Symbol-Schnitt (Seed-Überlappung: BTC/ETH/SOL,
 * AAPL/MSFT/NVDA/SPY/QQQ, EURUSD=X, CL=F, ^GSPC) — genug für
 * Discovery→Enrichment→Backfill-Funnels, klein genug für schnelle Tests.
 *
 * Fehler-Injektion: `statusByPath` (HTTP-Status je Pfad-Präfix),
 * `krakenError` (Umschlag-Fehler bei HTTP 200), `malformedJsonPaths`
 * (ungültiges JSON bei HTTP 200), `emptyChartSymbols` (Yahoo-Chart ohne
 * Ergebnis). Jede Anfrage wird in `requests` protokolliert (Pfad, Query,
 * Auth-Header — der Sync-Pfad darf NIE Credentials senden).
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface SyncFixtureRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  credentialHeaders: string[];
  userAgent: string | undefined;
}

/** Fester Fixture-Stichtag (letzte Kerze endet hier — Determinismus). */
export const SYNC_FIXTURE_NOW_MS = Date.parse("2026-08-29T12:00:00.000Z");

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Trendende OHLC-Reihe (0,02 %/Bar + deterministisches Rauschen), aufsteigend
 * nach Zeit, letzte Bar endet an `SYNC_FIXTURE_NOW_MS`. Ruhiges Profil —
 * genau das, was den Scanner-Eignungstest bestehen lässt.
 */
export function syncFixturePrices(seed: number, count: number, intervalMs: number, startPrice = 100): Array<{
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}> {
  const out: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }> = [];
  let price = startPrice;
  const firstTime = SYNC_FIXTURE_NOW_MS - count * intervalMs;
  for (let i = 0; i < count; i++) {
    const drift = 0.0002;
    const noise = Math.sin((seed + i) * 12.9898) * 0.0009;
    const open = price;
    const close = open * (1 + drift + noise);
    const high = Math.max(open, close) * 1.0004;
    const low = Math.min(open, close) * 0.9996;
    out.push({
      time: firstTime + i * intervalMs,
      open: round(open, 6),
      high: round(high, 6),
      low: round(low, 6),
      close: round(close, 6),
      volume: round(1_000 + (i % 7) * 40, 4),
    });
    price = close;
  }
  return out;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

/** Deterministischer Preis-Sockel je Symbol (stabile, unterscheidbare Kurse). */
function priceBase(symbol: string): number {
  let hash = 0;
  for (const ch of symbol) hash = (hash * 31 + ch.charCodeAt(0)) % 997;
  return 50 + hash / 10;
}

export class SyncVenuesFixtureServer {
  requests: SyncFixtureRequest[] = [];
  /** HTTP-Status-Override je Pfad-Präfix (z. B. `"/api/v3/klines" → 429`). */
  statusByPath = new Map<string, number>();
  /** Kraken-Umschlag-Fehler (`error`-Array bei HTTP 200; `null` = keine). */
  krakenError: string[] | null = null;
  /** Pfade, die HTTP 200 mit ungültigem JSON liefern. */
  malformedJsonPaths = new Set<string>();
  /** Yahoo-Symbole, deren Chart KEIN Ergebnis liefert (`result: null`). */
  emptyChartSymbols = new Set<string>();
  /** Yahoo-Symbole OHNE Bid/Ask (leeres Buch ⇒ Spread null). */
  noQuoteBookSymbols = new Set<string>();
  /** Binance-Katalog (Default: 3 Seed-Symbole; Tests dürfen erweitern). */
  binanceSymbols: Array<{
    symbol: string;
    status: string;
    baseAsset: string;
    quoteAsset: string;
    filters: Array<{ filterType: string; tickSize?: string; minQty?: string; stepSize?: string }>;
  }> = [
    {
      symbol: "BTCUSDT",
      status: "TRADING",
      baseAsset: "BTC",
      quoteAsset: "USDT",
      filters: [
        { filterType: "PRICE_FILTER", tickSize: "0.01" },
        { filterType: "LOT_SIZE", minQty: "0.00001", stepSize: "0.00001" },
      ],
    },
    {
      symbol: "ETHUSDT",
      status: "TRADING",
      baseAsset: "ETH",
      quoteAsset: "USDT",
      filters: [
        { filterType: "PRICE_FILTER", tickSize: "0.01" },
        { filterType: "LOT_SIZE", minQty: "0.0001", stepSize: "0.0001" },
      ],
    },
    {
      symbol: "SOLUSDT",
      status: "TRADING",
      baseAsset: "SOL",
      quoteAsset: "USDT",
      filters: [
        { filterType: "PRICE_FILTER", tickSize: "0.001" },
        { filterType: "LOT_SIZE", minQty: "0.01", stepSize: "0.01" },
      ],
    },
  ];
  /** Kraken-Katalog (Default: 3 Seed-Paare; Tests dürfen erweitern). */
  krakenPairs: Record<
    string,
    {
      altname: string;
      wsname: string;
      base: string;
      quote: string;
      pair_decimals: number;
      lot_decimals: number;
      leverage_buy: number[];
      leverage_sell: number[];
    }
  > = {
    XXBTZUSD: {
      altname: "XBTUSD",
      wsname: "XBT/USD",
      base: "XXBT",
      quote: "ZUSD",
      pair_decimals: 1,
      lot_decimals: 8,
      leverage_buy: [],
      leverage_sell: [],
    },
    XETHZUSD: {
      altname: "ETHUSD",
      wsname: "ETH/USD",
      base: "XETH",
      quote: "ZUSD",
      pair_decimals: 2,
      lot_decimals: 8,
      leverage_buy: [],
      leverage_sell: [],
    },
    SOLUSD: {
      altname: "SOLUSD",
      wsname: "SOL/USD",
      base: "SOL",
      quote: "USD",
      pair_decimals: 3,
      lot_decimals: 6,
      leverage_buy: [],
      leverage_sell: [],
    },
  };
  /** Yahoo-Symbole mit Quote (Default: Seed-Schnitt; Tests dürfen erweitern). */
  yahooSymbols = new Set<string>(["AAPL", "MSFT", "NVDA", "SPY", "QQQ", "EURUSD=X", "CL=F", "^GSPC", "BRK-B"]);

  private server: http.Server | null = null;

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const addr = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${addr.port}`;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) =>
      this.server!.close((err) => (err ? reject(err) : resolve())),
    );
    this.server = null;
  }

  count(pathPrefix: string): number {
    return this.requests.filter((r) => r.path.startsWith(pathPrefix)).length;
  }

  credentialLeaks(): SyncFixtureRequest[] {
    return this.requests.filter((r) => r.credentialHeaders.length > 0);
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    const query: Record<string, string> = {};
    url.searchParams.forEach((value, key) => {
      query[key] = value;
    });
    const credentialHeaders = ["sign", "api-key", "nonce", "timestamp", "authorization", "x-api-key"].filter(
      (h) => req.headers[h] !== undefined,
    );
    this.requests.push({
      method: req.method ?? "GET",
      path,
      query,
      credentialHeaders,
      userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : undefined,
    });

    req.resume();
    req.on("end", () => {
      try {
        for (const [prefix, status] of this.statusByPath) {
          if (path.startsWith(prefix)) {
            json(res, status, { code: -1003, msg: `fixture override ${status}` });
            return;
          }
        }
        if (this.malformedJsonPaths.has(path)) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end("{oops-kein-json");
          return;
        }
        this.route(path, query, res);
      } catch {
        json(res, 500, { code: 1, msg: "fixture error" });
      }
    });
  }

  private route(path: string, query: Record<string, string>, res: http.ServerResponse): void {
    if (path === "/api/v3/exchangeInfo") return json(res, 200, { symbols: this.binanceSymbols });
    if (path === "/api/v3/ticker/24hr") return this.binanceTicker(query, res);
    if (path === "/api/v3/depth") return this.binanceDepth(query, res);
    if (path === "/api/v3/klines") return this.binanceKlines(query, res);
    if (path === "/0/public/AssetPairs") {
      return json(res, 200, { error: this.krakenError ?? [], result: this.krakenPairs });
    }
    if (path === "/0/public/Ticker") return this.krakenTicker(query, res);
    if (path === "/0/public/OHLC") return this.krakenOhlc(query, res);
    if (path === "/0/public/Depth") return this.krakenDepth(query, res);
    if (path === "/v7/finance/quote") return this.yahooQuote(query, res);
    if (path.startsWith("/v8/finance/chart/")) return this.yahooChart(path, query, res);
    json(res, 404, { code: -404, msg: "fixture: unbekannter Pfad" });
  }

  // ── Binance ────────────────────────────────────────────────────────────────

  private binanceTicker(query: Record<string, string>, res: http.ServerResponse): void {
    const row = (symbol: string) => {
      const base = priceBase(symbol);
      const quoteVolume = 42_500_000 + symbol.length * 1000;
      return {
        symbol,
        lastPrice: String(round(base, 2)),
        quoteVolume: String(quoteVolume),
        volume: String(round(quoteVolume / base, 6)),
        highPrice: String(round(base * 1.01, 2)),
        lowPrice: String(round(base * 0.99, 2)),
        closeTime: SYNC_FIXTURE_NOW_MS,
      };
    };
    if (query.symbol) {
      const known = this.binanceSymbols.some((s) => s.symbol === query.symbol);
      if (!known) return json(res, 400, { code: -1121, msg: "Invalid symbol." });
      return json(res, 200, row(query.symbol));
    }
    json(res, 200, this.binanceSymbols.map((s) => row(s.symbol)));
  }

  private binanceDepth(query: Record<string, string>, res: http.ServerResponse): void {
    const symbol = query.symbol ?? "";
    const known = this.binanceSymbols.some((s) => s.symbol === symbol);
    if (!known) return json(res, 400, { code: -1121, msg: "Invalid symbol." });
    const base = priceBase(symbol);
    const limit = Math.min(Math.max(Number(query.limit ?? "5") || 5, 1), 50);
    const bids: Array<[string, string]> = [];
    const asks: Array<[string, string]> = [];
    for (let i = 0; i < limit; i++) {
      bids.push([String(round(base * (1 - 0.0001 * (i + 1)), 6)), "1.5"]);
      asks.push([String(round(base * (1 + 0.0001 * (i + 1)), 6)), "2.5"]);
    }
    json(res, 200, { lastUpdateId: 1, bids, asks });
  }

  private binanceKlines(query: Record<string, string>, res: http.ServerResponse): void {
    const symbol = query.symbol ?? "";
    const known = this.binanceSymbols.some((s) => s.symbol === symbol);
    if (!known) return json(res, 400, { code: -1121, msg: "Invalid symbol." });
    const intervalMs = parseBinanceInterval(query.interval ?? "1h");
    if (intervalMs === null) return json(res, 400, { code: -1120, msg: "Invalid interval." });
    const limit = Math.min(Math.max(Number(query.limit ?? "150") || 150, 1), 1000);
    const seed = [...symbol].reduce((a, c) => a + c.charCodeAt(0), 0);
    const rows = syncFixturePrices(seed, limit, intervalMs, priceBase(symbol));
    json(
      res,
      200,
      rows.map((c) => [
        c.time,
        String(c.open),
        String(c.high),
        String(c.low),
        String(c.close),
        String(c.volume),
        c.time + intervalMs - 1,
        String(round(c.volume * c.close, 6)),
        100,
        "0",
        "0",
        "0",
      ]),
    );
  }

  // ── Kraken ─────────────────────────────────────────────────────────────────

  private krakenTicker(query: Record<string, string>, res: http.ServerResponse): void {
    if (this.krakenError) return json(res, 200, { error: this.krakenError });
    const keys = (query.pair ?? "").split(",").map((k) => k.trim()).filter(Boolean);
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      const pair = this.krakenPairs[key];
      if (!pair) return json(res, 200, { error: [`EQuery:Unknown asset pair: ${key}`] });
      const base = priceBase(key);
      result[key] = {
        a: [String(round(base * 1.0001, 5)), "10", "10.0"],
        b: [String(round(base * 0.9999, 5)), "12", "12.0"],
        c: [String(round(base, 5)), "0.5"],
        v: ["100.0", "5000.0"],
        p: [String(round(base, 5)), String(round(base, 5))],
        t: [10, 500],
        l: [String(round(base * 0.99, 5)), String(round(base * 0.99, 5))],
        h: [String(round(base * 1.01, 5)), String(round(base * 1.01, 5))],
        o: String(round(base * 0.995, 5)),
      };
    }
    json(res, 200, { error: [], result });
  }

  private krakenOhlc(query: Record<string, string>, res: http.ServerResponse): void {
    if (this.krakenError) return json(res, 200, { error: this.krakenError });
    const key = query.pair ?? "";
    if (!this.krakenPairs[key]) return json(res, 200, { error: [`EQuery:Unknown asset pair: ${key}`] });
    const intervalMin = Number(query.interval ?? "60");
    if (![1, 5, 15, 30, 60, 240, 1440, 10080, 21600].includes(intervalMin)) {
      return json(res, 200, { error: ["EGeneral:Invalid arguments"] });
    }
    const seed = [...key].reduce((a, c) => a + c.charCodeAt(0), 0);
    const rows = syncFixturePrices(seed, 200, intervalMin * 60_000, priceBase(key));
    json(res, 200, {
      error: [],
      result: {
        [key]: rows.map((c) => [
          Math.round(c.time / 1000),
          String(c.open),
          String(c.high),
          String(c.low),
          String(c.close),
          String(round((c.open + c.close) / 2, 5)),
          String(c.volume),
          42,
        ]),
        last: 1_700_000_000,
      },
    });
  }

  private krakenDepth(query: Record<string, string>, res: http.ServerResponse): void {
    if (this.krakenError) return json(res, 200, { error: this.krakenError });
    const key = query.pair ?? "";
    if (!this.krakenPairs[key]) return json(res, 200, { error: [`EQuery:Unknown asset pair: ${key}`] });
    const base = priceBase(key);
    const count = Math.min(Math.max(Number(query.count ?? "5") || 5, 1), 50);
    const bids: Array<[string, string, number]> = [];
    const asks: Array<[string, string, number]> = [];
    for (let i = 0; i < count; i++) {
      bids.push([String(round(base * (1 - 0.0001 * (i + 1)), 5)), "1.5", 1700000000]);
      asks.push([String(round(base * (1 + 0.0001 * (i + 1)), 5)), "2.5", 1700000000]);
    }
    json(res, 200, { error: [], result: { [key]: { asks, bids } } });
  }

  // ── Yahoo ──────────────────────────────────────────────────────────────────

  private yahooQuote(query: Record<string, string>, res: http.ServerResponse): void {
    const symbols = (query.symbols ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const result: unknown[] = [];
    for (const symbol of symbols) {
      if (!this.yahooSymbols.has(symbol)) continue;
      const base = priceBase(symbol);
      result.push({
        symbol,
        regularMarketPrice: round(base, 2),
        regularMarketVolume: 1_250_000,
        ...(this.noQuoteBookSymbols.has(symbol)
          ? {}
          : {
              bid: round(base * 0.9999, 2),
              ask: round(base * 1.0001, 2),
              bidSize: 3,
              askSize: 4,
            }),
        regularMarketDayHigh: round(base * 1.01, 2),
        regularMarketDayLow: round(base * 0.99, 2),
        regularMarketTime: Math.round(SYNC_FIXTURE_NOW_MS / 1000),
      });
    }
    json(res, 200, { quoteResponse: { result, error: null } });
  }

  private yahooChart(path: string, query: Record<string, string>, res: http.ServerResponse): void {
    const symbol = decodeURIComponent(path.slice("/v8/finance/chart/".length));
    if (!this.yahooSymbols.has(symbol) || this.emptyChartSymbols.has(symbol)) {
      return json(res, 404, {
        chart: { result: null, error: { code: "Not Found", description: "No data found, symbol may be delisted" } },
      });
    }
    const intervalMs = parseYahooInterval(query.interval ?? "1h");
    if (intervalMs === null) return json(res, 400, { chart: { result: null, error: { code: "Bad Request" } } });
    const seed = [...symbol].reduce((a, c) => a + c.charCodeAt(0), 0);
    const rows = syncFixturePrices(seed, 200, intervalMs, priceBase(symbol));
    json(res, 200, {
      chart: {
        result: [
          {
            timestamp: rows.map((c) => Math.round(c.time / 1000)),
            indicators: {
              quote: [
                {
                  open: rows.map((c) => c.open),
                  high: rows.map((c) => c.high),
                  low: rows.map((c) => c.low),
                  close: rows.map((c) => c.close),
                  volume: rows.map((c) => c.volume),
                },
              ],
            },
          },
        ],
        error: null,
      },
    });
  }
}

function parseBinanceInterval(interval: string): number | null {
  const m = /^(\d+)(m|h|d|w)$/.exec(interval);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2] === "m" ? 60_000 : m[2] === "h" ? 3_600_000 : m[2] === "d" ? 86_400_000 : 604_800_000;
  return n * unit;
}

function parseYahooInterval(interval: string): number | null {
  const table: Record<string, number> = {
    "1m": 60_000,
    "5m": 300_000,
    "15m": 900_000,
    "30m": 1_800_000,
    "1h": 3_600_000,
    "1d": 86_400_000,
    "5d": 432_000_000,
  };
  return table[interval] ?? null;
}
