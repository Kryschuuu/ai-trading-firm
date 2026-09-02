/**
 * Alpaca Public-Client (Task 12) — Market-Data-Endpunkte.
 *
 * Verwendet NUR die Data-API (kein Auth, keine Credentials). Der Public-Client
 * wird auch im Live-Pfad genutzt (für Live-Trading braucht man trotzdem
 * Echtzeit-Market-Data); die Credentials werden hier NICHT gesetzt.
 *
 * Endpunkte (Doku: https://alpaca.markets/docs/api-references/market-data-api/):
 *   GET /v2/stocks/{symbol}/trades/latest   — letzter Trade (kein Auth für Free-Tier IEX)
 *   GET /v2/stocks/{symbol}/quotes/latest   — letzter Quote
 *   GET /v2/stocks/{symbol}/bars            — historische Bars
 *   GET /v2/stocks/{symbol}/snapshot        — Snapshot (Trade+Quote+Bar)
 *   GET /v1/crypto/{symbol}/trades/latest   — Crypto (kein Auth, separate URL)
 *   GET /v1beta1/news?symbols=...           — News (Auth erforderlich, hier übersprungen)
 */
import { ALPACA_DATA_PATHS } from "./config";
import type { AlpacaRuntimeConfig } from "./config";
import { AlpacaApiError, safeSnippet } from "./errors";
import { AlpacaHttp } from "./http";
import type { AlpacaBar, AlpacaBarsResponse, AlpacaSnapshot } from "./types";
import { mapBars, mapBar } from "./mapping";
import type { MarketCandle, MarketTicker } from "../../contracts/broker";

export interface AlpacaPublicClientDeps {
  config: AlpacaRuntimeConfig;
  http: AlpacaHttp;
}

export class AlpacaPublicClient {
  constructor(private readonly deps: AlpacaPublicClientDeps) {}

  /** Letzter Trade für ein Aktien-Symbol. */
  async fetchLatestStockTrade(symbol: string): Promise<{ price: number; ts: number } | null> {
    const res = await this.deps.http.request({
      method: "GET",
      base: this.deps.config.dataBaseUrl,
      path: ALPACA_DATA_PATHS.stockLatestTrade(symbol),
      idempotent: true,
    });
    if (!res.json || typeof res.json !== "object") return null;
    const obj = res.json as { trade?: { t?: string; p?: number; s?: number } };
    const trade = obj.trade;
    if (!trade || typeof trade.p !== "number" || typeof trade.t !== "string") return null;
    return { price: trade.p, ts: Date.parse(trade.t) };
  }

  /** Snapshot (Stock oder Crypto) — bevorzugter Single-Symbol-Endpoint. */
  async fetchSnapshot(symbol: string, assetClass: "equity" | "crypto" = "equity"): Promise<AlpacaSnapshot | null> {
    const path =
      assetClass === "crypto"
        ? ALPACA_DATA_PATHS.cryptoSnapshot(symbol)
        : ALPACA_DATA_PATHS.stockSnapshot(symbol);
    const res = await this.deps.http.request({
      method: "GET",
      base: this.deps.config.dataBaseUrl,
      path,
      idempotent: true,
    });
    if (!res.json || typeof res.json !== "object") return null;
    return res.json as AlpacaSnapshot;
  }

  /** Historische Bars (Stock). */
  async fetchStockBars(symbol: string, timeframe = "1Day", limit = 120): Promise<MarketCandle[]> {
    const res = await this.deps.http.request({
      method: "GET",
      base: this.deps.config.dataBaseUrl,
      path: ALPACA_DATA_PATHS.stockBars(symbol),
      query: { timeframe, limit, adjustment: "raw" },
      idempotent: true,
    });
    if (!res.json || typeof res.json !== "object") return [];
    const obj = res.json as AlpacaBarsResponse;
    const raw = obj.bars?.[symbol];
    if (!Array.isArray(raw)) return [];
    return mapBars(raw);
  }

  /** Crypto-Latest-Trade. */
  async fetchLatestCryptoTrade(symbol: string): Promise<{ price: number; ts: number } | null> {
    const res = await this.deps.http.request({
      method: "GET",
      base: this.deps.config.dataBaseUrl,
      path: ALPACA_DATA_PATHS.cryptoLatestTrade(symbol),
      idempotent: true,
    });
    if (!res.json || typeof res.json !== "object") return null;
    const obj = res.json as { trade?: { t?: string; p?: number; s?: number } };
    const trade = obj.trade;
    if (!trade || typeof trade.p !== "number" || typeof trade.t !== "string") return null;
    return { price: trade.p, ts: Date.parse(trade.t) };
  }

  /**
   * Universeller Ticker-Fetcher. Versucht zuerst Snapshot (enthält sowohl
   * Trade als auch Daily-Bar), fällt auf latest-trade zurück.
   */
  async fetchTicker(symbol: string, assetClass: "equity" | "crypto" = "equity"): Promise<MarketTicker | null> {
    try {
      const snap = await this.fetchSnapshot(symbol, assetClass);
      if (snap?.latestTrade?.p != null && snap.latestTrade.t) {
        return {
          symbol: snap.symbol ?? symbol,
          price: snap.latestTrade.p,
          source: "alpaca",
          ts: Date.parse(snap.latestTrade.t),
        };
      }
    } catch (e) {
      if (e instanceof AlpacaApiError && e.kind === "ssrf") throw e;
      // Fallback unten.
    }
    const trade = assetClass === "crypto"
      ? await this.fetchLatestCryptoTrade(symbol)
      : await this.fetchLatestStockTrade(symbol);
    if (!trade) return null;
    return { symbol, price: trade.price, source: "alpaca", ts: trade.ts };
  }

  /** Universeller Candle-Fetcher. */
  async fetchCandles(symbol: string, assetClass: "equity" | "crypto", timeframe = "1Day", limit = 120): Promise<MarketCandle[]> {
    if (assetClass === "crypto") {
      const res = await this.deps.http.request({
        method: "GET",
        base: this.deps.config.dataBaseUrl,
        path: ALPACA_DATA_PATHS.cryptoLatestBar(symbol),
        query: { timeframe, limit },
        idempotent: true,
      });
      if (!res.json || typeof res.json !== "object") return [];
      const obj = res.json as { bars?: AlpacaBar[] | Record<string, AlpacaBar[]> };
      const arr = Array.isArray(obj.bars) ? obj.bars : obj.bars?.[symbol];
      if (!Array.isArray(arr)) return [];
      return mapBars(arr);
    }
    return this.fetchStockBars(symbol, timeframe, limit);
  }
}
