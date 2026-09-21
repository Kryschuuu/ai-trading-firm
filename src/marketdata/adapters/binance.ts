/**
 * Binance-Spot-Wrapper: öffentlicher Sync-Client → `MarketDataAdapter`.
 *
 * DOMÄNENTRENNUNG wie beim Bitunix-Wrapper (`./bitunix.ts`): Diese Datei ist
 * die einzige Kopplung zwischen der Marketdata-Domäne und der Binance-REST-
 * API — und sie spricht ausschließlich ÖFFENTLICHE Endpunkte (kein Key, keine
 * Signatur, kein Private-Pfad). Der HTTP-Transport liegt im gemeinsamen
 * Sync-Client (`./http.ts`: SSRF-Allowlist, Timeout, 429/5xx-Retry, Bucket).
 *
 * Endpunkte (Binance Spot-API, öffentlich):
 *   Discovery  `GET /api/v3/exchangeInfo` — alle Symbole + Filter (Ticks,
 *              Min-Mengen). Nur `status` wird als Handelszustand übernommen.
 *   Ticker     `GET /api/v3/ticker/24hr` — OHNE Parameter = alle Ticker in
 *              EINEM Request (~150 KB, Gewicht 80 — bewusst kein
 *              `?symbols=[…]`, dessen Gewicht mit der Anzahl skaliert).
 *   Depth      `GET /api/v3/depth?symbol=X&limit=5` — Top-of-Book für Spread.
 *   Klines     `GET /api/v3/klines?symbol=X&interval=1h&limit=150` — OHLCV.
 *
 * SICHERHEIT: Symbol-Allowlist vor URL (`normalizeSyncSymbol`), numerische
 * Felder per `Number.isFinite()` geprüft, Arrays gekappt. Fehler bleiben
 * typisiert (`MarketDataHttpError` & Co.), damit der Sync ehrlich
 * klassifiziert (429/5xx retryable) statt pauschal SCHEMA_MISMATCH.
 */

import type { SupportedTimeframe } from "../../lib/marketdata/historicalStore";
import { normalizeSyncSymbol } from "../errors";
import { UnsupportedTimeframeError } from "../errors";
import type { MarketDataAdapter } from "../sync";
import type { MarketCandle, MarketInstrument, MarketOrderBook, MarketTicker } from "../types";
import type { InstrumentStatus } from "../../universe/types";
import { SyncHttpClient } from "./http";

/** Venue-Key, unter dem der Wrapper registriert wird (`registerAdapters.ts`). */
export const BINANCE_MARKET_DATA_VENUE = "BINANCE" as const;

/** Öffentliche Binance-Spot-Basis (kein Key nötig; Rate-Limit pro IP). */
export const BINANCE_SYNC_BASE_URL = "https://api.binance.com" as const;

/** Konservative Sync-Rate (Binance-Limit: 6000 Gewicht/Min/IP; wir bleiben weit darunter). */
export const BINANCE_SYNC_RATE_PER_SEC = 8;

/**
 * Vollständiges Timeframe-Mapping `SupportedTimeframe → Binance-Intervall`.
 * Binance kennt `5d` nicht (`1w` ≠ 5d — kein stiller Ersatz, dokumentierte
 * Lücke als `null`, vgl. Bitunix-Wrapper).
 */
export const BINANCE_TIMEFRAME_MAP: Readonly<Record<SupportedTimeframe, string | null>> = {
  "1m": "1m",
  "3m": "3m",
  "5m": "5m",
  "15m": "15m",
  "30m": "30m",
  "1h": "1h",
  "2h": "2h",
  "4h": "4h",
  "1d": "1d",
  "5d": null, // Binance bietet kein 5d-Intervall (dokumentierte Lücke; 1w ≠ 5d).
};

/** Von Binance nachweislich bediente Kline-Intervalle (abgeleitet aus der Map). */
export const BINANCE_SUPPORTED_INTERVALS: readonly string[] = Object.values(BINANCE_TIMEFRAME_MAP).filter(
  (v): v is string => v !== null,
);

/**
 * Liefert das Binance-Intervall für einen Store-Timeframe.
 *
 * @throws {UnsupportedTimeframeError} bei Lücke (`null`) oder Unbekannt.
 */
export function toBinanceInterval(timeframe: string): string {
  const mapped = (BINANCE_TIMEFRAME_MAP as Record<string, string | null>)[timeframe];
  if (mapped === undefined || mapped === null) {
    throw new UnsupportedTimeframeError(timeframe, BINANCE_MARKET_DATA_VENUE);
  }
  return mapped;
}

// ── Roh-Typen (Binance Spot-API, öffentlich dokumentiert) ────────────────────

/** Eine `exchangeInfo.symbols`-Zeile (nur genutzte Felder). */
export interface BinanceExchangeSymbol {
  symbol: string;
  status: string;
  baseAsset: string;
  quoteAsset: string;
  filters?: Array<{ filterType?: string; tickSize?: string; minQty?: string; stepSize?: string }>;
}

/** Eine `ticker/24hr`-Zeile (nur genutzte Felder). */
export interface BinanceTicker24h {
  symbol: string;
  lastPrice: string;
  quoteVolume: string;
  volume?: string;
  highPrice?: string;
  lowPrice?: string;
  closeTime?: number;
}

/** `depth`-Antwort (Preis/Menge als Strings). */
export interface BinanceDepth {
  bids: Array<[string, string]>;
  asks: Array<[string, string]>;
}

/** `klines`-Zeile: `[openTime, o, h, l, c, volume(base), closeTime, quoteVolume, …]`. */
export type BinanceKlineRow = [number, string, string, string, string, string, ...unknown[]];

/** Credentials-freier Binance-Spot-Client (nur die vier Sync-Endpunkte). */
export class BinanceSyncClient {
  private readonly http: SyncHttpClient;

  constructor(http: SyncHttpClient) {
    this.http = http;
  }

  async exchangeInfo(): Promise<BinanceExchangeSymbol[]> {
    const raw = await this.http.getJson<{ symbols?: unknown }>("/api/v3/exchangeInfo");
    return Array.isArray(raw.symbols) ? (raw.symbols as BinanceExchangeSymbol[]) : [];
  }

  /** ALLE 24h-Ticker in einem Request (Bulk; Filterung beim Aufrufer). */
  async tickers24h(): Promise<BinanceTicker24h[]> {
    const raw = await this.http.getJson<unknown>("/api/v3/ticker/24hr");
    return Array.isArray(raw) ? (raw as BinanceTicker24h[]) : [];
  }

  async ticker24h(symbol: string): Promise<BinanceTicker24h> {
    return this.http.getJson<BinanceTicker24h>("/api/v3/ticker/24hr", { symbol });
  }

  async depth(symbol: string, limit = 5): Promise<BinanceDepth> {
    return this.http.getJson<BinanceDepth>("/api/v3/depth", { symbol, limit: String(limit) });
  }

  async klines(symbol: string, interval: string, limit: number): Promise<BinanceKlineRow[]> {
    const raw = await this.http.getJson<unknown>("/api/v3/klines", {
      symbol,
      interval,
      limit: String(limit),
    });
    return Array.isArray(raw) ? (raw as BinanceKlineRow[]) : [];
  }
}

/** Dependencies des Wrappers (alles injizierbar → deterministische Tests). */
export interface BinanceMarketAdapterDeps {
  /** Credentials-freier Sync-Client (niemals signierend). */
  client: BinanceSyncClient;
  /** Injizierbare Uhr (Determinismus in Tests; Default: Realzeit). */
  now?: () => Date;
}

/** Binance-`status` → Registry-`status` (nicht handelbar ⇒ ÜBERNOMMEN, nicht verworfen). */
export function mapBinanceStatus(status: unknown): InstrumentStatus {
  if (status === "TRADING") return "active";
  if (status === "HALT" || status === "BREAK" || status === "AUCTION_MATCH") return "halted";
  return "delisted";
}

/**
 * DTO→Domain-Mapping EINER `exchangeInfo`-Zeile:
 *
 * | DTO-Feld | Domain-Feld | Nullable-Semantik |
 * | --- | --- | --- |
 * | `symbol` | `symbol` + `id = BINANCE:<symbol>` | Pflicht; Allowlist-Verletzung ⇒ Zeile verworfen |
 * | `baseAsset`/`quoteAsset` | `base`/`quote` | Pflicht; fehlend ⇒ Zeile verworfen |
 * | `LOT_SIZE.minQty` | `minQuantity` | ungültig ⇒ `1e-8` (venue-sicherstes Minimum) |
 * | `LOT_SIZE.stepSize` | `quantityStep` | ungültig ⇒ `1e-8` |
 * | `PRICE_FILTER.tickSize` | `priceStep` | ungültig ⇒ `0.01` |
 * | `status` | `status` | siehe {@link mapBinanceStatus} |
 * | — | `makerFee`/`takerFee` | dokumentierter Spot-Default `0.001`/`0.001` (Preset-wertegleich) |
 * | — | `shortAvailable`/`leverageAvailable` | `false` (Spot — kein Margin modelliert, Preset-wertegleich) |
 *
 * Gibt `null` zurück, wenn kein Instrument bildbar ist (Blocklist statt Wurf:
 * EINE kaputte Zeile darf den Katalog nicht verwerfen).
 */
export function mapExchangeSymbolToInstrument(
  raw: BinanceExchangeSymbol,
  now: Date,
): MarketInstrument | null {
  const symbol = typeof raw?.symbol === "string" ? normalizeSyncSymbol(raw.symbol) : null;
  const base = typeof raw?.baseAsset === "string" && raw.baseAsset ? raw.baseAsset : null;
  const quote = typeof raw?.quoteAsset === "string" && raw.quoteAsset ? raw.quoteAsset : null;
  if (!symbol || !base || !quote) return null;
  const filters = Array.isArray(raw.filters) ? raw.filters : [];
  const lot = filters.find((f) => f?.filterType === "LOT_SIZE");
  const price = filters.find((f) => f?.filterType === "PRICE_FILTER");
  return {
    id: `${BINANCE_MARKET_DATA_VENUE}:${symbol}`,
    venue: BINANCE_MARKET_DATA_VENUE,
    symbol,
    base,
    quote,
    assetClass: "crypto",
    marketType: "spot",
    status: mapBinanceStatus(raw.status),
    minQuantity: positiveOr(lot?.minQty, 1e-8),
    priceStep: positiveOr(price?.tickSize, 0.01),
    quantityStep: positiveOr(lot?.stepSize, 1e-8),
    makerFee: 0.001,
    takerFee: 0.001,
    leverageAvailable: false,
    shortAvailable: false,
    paperAvailable: true,
    liveTradable: true,
    liveAvailable: false,
    volume24h: null,
    spread: null,
    volatility: null,
    lastSeen: now.toISOString(),
  };
}

/**
 * `ticker/24hr`-Zeile → `MarketTicker`. `quoteVol` ist explizit
 * Quote-Volumen (`quoteVolume`) — Verwechslung mit Base-Volumen verfälscht
 * jeden min-volume-Filter um Größenordnungen. Gibt `null` bei unbrauchbarer
 * Zeile (Aufrufer: Lücke statt Wurf).
 */
export function mapBinanceTicker(raw: BinanceTicker24h): MarketTicker | null {
  const symbol = typeof raw?.symbol === "string" ? normalizeSyncSymbol(raw.symbol) : null;
  const price = numOrNull(raw?.lastPrice);
  if (!symbol || price === null || price <= 0) return null;
  return {
    symbol,
    price,
    source: "binance",
    ts: typeof raw?.closeTime === "number" && Number.isFinite(raw.closeTime) ? raw.closeTime : Date.now(),
    last: price,
    quoteVol: positiveOrNull(raw?.quoteVolume),
    baseVol: positiveOrNull(raw?.volume),
    high: numOrNull(raw?.highPrice) ?? undefined,
    low: numOrNull(raw?.lowPrice) ?? undefined,
  };
}

/** `klines`-Zeile → `MarketCandle` (`volume` = Base-Volumen, Index 5). */
export function mapBinanceKline(row: BinanceKlineRow): MarketCandle | null {
  if (!Array.isArray(row) || row.length < 6) return null;
  const [time, o, h, l, c, v] = row;
  if (typeof time !== "number" || !Number.isInteger(time) || time <= 0) return null;
  const open = numOrNull(o);
  const high = numOrNull(h);
  const low = numOrNull(l);
  const close = numOrNull(c);
  const volume = numOrNull(v);
  if (open === null || high === null || low === null || close === null || volume === null) return null;
  if (open <= 0 || high <= 0 || low <= 0 || close <= 0 || volume < 0) return null;
  return { time, open, high, low, close, volume };
}

/** Erzeugt den `MarketDataAdapter` über dem Sync-Client. */
export function createBinanceMarketDataAdapter(deps: BinanceMarketAdapterDeps): MarketDataAdapter {
  const client = deps.client;
  const now = deps.now ?? (() => new Date());

  return {
    venue: BINANCE_MARKET_DATA_VENUE,

    async discoverInstruments(): Promise<MarketInstrument[]> {
      const rows = await client.exchangeInfo();
      const at = now();
      const out: MarketInstrument[] = [];
      const seen = new Set<string>();
      for (const row of rows) {
        const instrument = mapExchangeSymbolToInstrument(row, at);
        // Blocklist statt Wurf: unbrauchbare/doppelte Zeilen überspringen.
        if (!instrument || seen.has(instrument.id)) continue;
        seen.add(instrument.id);
        out.push(instrument);
      }
      return out;
    },

    async getTicker(symbol: string): Promise<MarketTicker> {
      const upper = symbol.toUpperCase();
      const mapped = mapBinanceTicker(await client.ticker24h(upper));
      if (!mapped) {
        throw new Error(`Binance-Ticker für ${upper} unbrauchbar (leere/ungültige Zeile).`);
      }
      return mapped;
    },

    /**
     * 1 × `ticker/24hr` (Bulk, ALLE Symbole) — Filterung client-seitig.
     * Fehlende Symbole sind Lücken (Enrichment-Fallback), kein Wurf.
     */
    async getTickers(symbols?: string[]): Promise<MarketTicker[]> {
      const wanted = symbols ? new Set(symbols.map((s) => s.toUpperCase())) : null;
      const out: MarketTicker[] = [];
      for (const row of await client.tickers24h()) {
        const mapped = mapBinanceTicker(row);
        if (!mapped) continue;
        if (wanted && !wanted.has(mapped.symbol)) continue;
        out.push(mapped);
      }
      return out;
    },

    async getOrderBook(symbol: string): Promise<MarketOrderBook> {
      const upper = symbol.toUpperCase();
      const raw = await client.depth(upper, 5);
      return {
        symbol: upper,
        bids: mapDepthLevels(raw?.bids),
        asks: mapDepthLevels(raw?.asks),
        ts: now().getTime(),
      };
    },

    async getCandles(symbol: string, timeframe: SupportedTimeframe, limit: number): Promise<MarketCandle[]> {
      const interval = toBinanceInterval(timeframe);
      // Binance liefert maximal 1000 Bars je Call — das Sync-Limit (150)
      // liegt weit darunter, kein Paging nötig.
      const rows = await client.klines(symbol.toUpperCase(), interval, limit);
      const out: MarketCandle[] = [];
      for (const row of rows) {
        const mapped = mapBinanceKline(row);
        if (mapped) out.push(mapped);
      }
      return out;
    },
  };
}

/** Depth-Seite (`[[Preis, Menge], …]`, Strings) → geprüfte Levels. */
function mapDepthLevels(levels: unknown): MarketOrderBook["bids"] {
  if (!Array.isArray(levels)) return [];
  const out: MarketOrderBook["bids"] = [];
  for (const row of levels.slice(0, 50)) {
    if (!Array.isArray(row) || row.length < 2) continue;
    const price = numOrNull(row[0]);
    const qty = numOrNull(row[1]);
    if (price === null || qty === null || price <= 0 || qty < 0) continue;
    out.push({ price, qty });
  }
  return out;
}

function numOrNull(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value !== "" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function positiveOrNull(value: unknown): number | null {
  const n = numOrNull(value);
  return n !== null && n > 0 ? n : null;
}

function positiveOr(value: unknown, fallback: number): number {
  const n = numOrNull(value);
  return n !== null && n > 0 ? n : fallback;
}

/** Compile-Time-Beweis, dass die Map wirklich JEDES Store-Timeframe abdeckt. */
const _EXHAUSTIVE_TIMEFRAME_CHECK: Record<SupportedTimeframe, string | null> = BINANCE_TIMEFRAME_MAP;
void _EXHAUSTIVE_TIMEFRAME_CHECK;
