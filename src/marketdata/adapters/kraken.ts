/**
 * Kraken-Spot-Wrapper: öffentlicher Sync-Client → `MarketDataAdapter`.
 *
 * Domänen-/Sicherheits-Kontrakt wie beim Binance-Wrapper (`./binance.ts`):
 * ausschließlich ÖFFENTLICHE Endpunkte über den gemeinsamen Sync-Client
 * (`./http.ts`), Symbol-Allowlist vor URL, geprüfte Numerik, typisierte
 * Fehler. Kraken braucht keinen Key für Public-GETs.
 *
 * Endpunkte (Kraken Public-API):
 *   Discovery  `GET /0/public/AssetPairs` — alle Paare + Dezimalstellen.
 *   Ticker     `GET /0/public/Ticker?pair=K1,K2,…` — Bulk (50 Paare/Call).
 *   Depth      `GET /0/public/Depth?pair=K&count=5` — Top-of-Book.
 *   OHLC       `GET /0/public/OHLC?pair=K&interval=60` — immer die letzten
 *              720 Kerzen (kein Limit-Parameter; client-seitig geschnitten).
 *
 * Symbol-Modell (zwei Ebenen, niemals geraten):
 *   - SPEICHERFORM = `wsname`-Stil mit `/` und `XBT→BTC`-Alias, z. B.
 *     `BTC/USD` — exakt die Seed-Schreibweise (`src/universe/seed.ts`), damit
 *     Discovery per Upsert auf dieselbe Registry-ID mergt (`KRAKEN:BTC/USD`).
 *   - REST-FORM = der `AssetPairs`-Key (z. B. `XXBTZUSD`), garantiert von der
 *     API akzeptiert. Die Discovery memoisiert `Speicher → Key`; alle
 *     Folge-Calls lösen darüber auf. Fehlschlag nach Reload ⇒
 *     `INVALID_SYMBOL` (isoliert, nicht retryable).
 *   Paare ohne `wsname` fallen auf `altname` + Quote-Suffix-Schnitt zurück
 *   (`XBTUSD` → `BTC/USD`); unlösbare Paare werden übersprungen (Blocklist).
 *
 * Kraken-Umschlag: `{ error: [...], result: {...} }` — ein NICHT-leeres
 * `error`-Array bei HTTP 200 wird übersetzt (`Unknown asset pair` ⇒
 * INVALID_SYMBOL, `Rate limit exceeded` ⇒ RATE_LIMITED, `Service
 * unavailable`/`Internal error` ⇒ UPSTREAM_5XX, Rest ⇒ UNKNOWN).
 */

import type { SupportedTimeframe } from "../../lib/marketdata/historicalStore";
import { FIAT_CODES } from "../../symbols/venueProfiles";
import type { AssetClass } from "../../universe/types";
import { normalizeSyncSymbol, UnsupportedTimeframeError } from "../errors";
import type { MarketDataAdapter } from "../sync";
import type { MarketCandle, MarketInstrument, MarketOrderBook, MarketTicker } from "../types";
import { SyncHttpClient, taggedSyncError } from "./http";

/** Venue-Key, unter dem der Wrapper registriert wird (`registerAdapters.ts`). */
export const KRAKEN_MARKET_DATA_VENUE = "KRAKEN" as const;

/** Öffentliche Kraken-Basis (kein Key nötig). */
export const KRAKEN_SYNC_BASE_URL = "https://api.kraken.com" as const;

/**
 * Konservative Sync-Rate (Kraken drosselt Public-GETs per Zähler; 2/s bleibt
 * weit unter jeder dokumentierten Grenze und schont den geteilten Bucket).
 */
export const KRAKEN_SYNC_RATE_PER_SEC = 2;

/** Paare je `Ticker`-Bulk-Call (~9 Zeichen/Key ⇒ ~450 Zeichen Query). */
export const KRAKEN_TICKER_CHUNK_SIZE = 50;

/**
 * Timeframe → Kraken-`interval` (Minuten). Kraken kennt nur
 * 1/5/15/30/60/240/1440/10080/21600 — `3m`, `2h` und `5d` (21600 min = 15d,
 * nicht 5d) sind dokumentierte Lücken (`null`, kein stiller Ersatz).
 */
export const KRAKEN_TIMEFRAME_MAP: Readonly<Record<SupportedTimeframe, number | null>> = {
  "1m": 1,
  "3m": null,
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "1h": 60,
  "2h": null,
  "4h": 240,
  "1d": 1440,
  "5d": null,
};

/**
 * Liefert das Kraken-Intervall für einen Store-Timeframe.
 *
 * @throws {UnsupportedTimeframeError} bei Lücke (`null`) oder Unbekannt.
 */
export function toKrakenInterval(timeframe: string): number {
  const mapped = (KRAKEN_TIMEFRAME_MAP as Record<string, number | null>)[timeframe];
  if (mapped === undefined || mapped === null) {
    throw new UnsupportedTimeframeError(timeframe, KRAKEN_MARKET_DATA_VENUE);
  }
  return mapped;
}

// ── Roh-Typen (Kraken Public-API, öffentlich dokumentiert) ───────────────────

/** Kraken-Umschlag: Fehler stehen im Body, nicht (nur) im HTTP-Status. */
export interface KrakenEnvelope<T> {
  error: string[];
  result?: T;
}

/** Eine `AssetPairs`-Zeile (nur genutzte Felder). */
export interface KrakenAssetPair {
  altname?: string;
  wsname?: string;
  base?: string;
  quote?: string;
  pair_decimals?: number;
  lot_decimals?: number;
  leverage_buy?: number[];
  leverage_sell?: number[];
}

/** Eine `Ticker`-Zeile: Index `[1]` = 24h-Fenster (nur genutzte Felder). */
export interface KrakenTickerRow {
  a?: [string, string, string];
  b?: [string, string, string];
  c?: [string, string];
  v?: [string, string];
  l?: [string, string];
  h?: [string, string];
  o?: string;
}

/** `OHLC`-Zeile: `[Zeit(s), o, h, l, c, vwap, Volumen(base), Trades]`. */
export type KrakenOhlcRow = [number, string, string, string, string, string, string, number];

/** `Depth`-Seite: `[Preis, Menge, Zeitstempel]` (Strings). */
export type KrakenDepthRow = [string, string, number];

/** Credentials-freier Kraken-Client (nur die vier Sync-Endpunkte). */
export class KrakenSyncClient {
  private readonly http: SyncHttpClient;

  constructor(http: SyncHttpClient) {
    this.http = http;
  }

  async assetPairs(): Promise<Record<string, KrakenAssetPair>> {
    const raw = await this.http.getJson<KrakenEnvelope<Record<string, KrakenAssetPair>>>("/0/public/AssetPairs");
    return unwrapKraken(raw, "AssetPairs");
  }

  async ticker(keys: readonly string[]): Promise<Record<string, KrakenTickerRow>> {
    const raw = await this.http.getJson<KrakenEnvelope<Record<string, KrakenTickerRow>>>("/0/public/Ticker", {
      pair: keys.join(","),
    });
    return unwrapKraken(raw, "Ticker");
  }

  async ohlc(key: string, interval: number): Promise<KrakenOhlcRow[]> {
    const raw = await this.http.getJson<KrakenEnvelope<Record<string, unknown>>>("/0/public/OHLC", {
      pair: key,
      interval: String(interval),
    });
    const result = unwrapKraken(raw, "OHLC");
    // `{ <Key>: [...], last: <n> }` — die Reihen-Key ist der einzige
    // Nicht-`last`-Eintrag (robust gegen Key-Normalisierung der Venue).
    const rowsKey = Object.keys(result).find((k) => k !== "last");
    const rows = rowsKey ? result[rowsKey] : undefined;
    return Array.isArray(rows) ? (rows as KrakenOhlcRow[]) : [];
  }

  async depth(key: string, count = 5): Promise<{ asks: KrakenDepthRow[]; bids: KrakenDepthRow[] }> {
    const raw = await this.http.getJson<KrakenEnvelope<Record<string, unknown>>>("/0/public/Depth", {
      pair: key,
      count: String(count),
    });
    const result = unwrapKraken(raw, "Depth");
    const bookKey = Object.keys(result)[0];
    const book = (bookKey ? result[bookKey] : undefined) as
      | { asks?: KrakenDepthRow[]; bids?: KrakenDepthRow[] }
      | undefined;
    return {
      asks: Array.isArray(book?.asks) ? book.asks : [],
      bids: Array.isArray(book?.bids) ? book.bids : [],
    };
  }
}

/**
 * Prüft den Kraken-Umschlag: nicht-leeres `error` ⇒ typisierter Wurf
 * (Taxonomie-`code`, vom Klassifikator direkt übernommen).
 */
export function unwrapKraken<T>(raw: KrakenEnvelope<T>, endpoint: string): T {
  const errors = Array.isArray(raw?.error) ? raw.error : [];
  if (errors.length > 0) {
    const first = String(errors[0] ?? "Kraken-Fehler").slice(0, 160);
    if (/unknown asset pair/i.test(first)) {
      throw taggedSyncError("INVALID_SYMBOL", `Kraken/${endpoint}: ${first}`);
    }
    if (/rate limit/i.test(first)) {
      throw taggedSyncError("RATE_LIMITED", `Kraken/${endpoint}: ${first}`);
    }
    if (/service unavailable|internal error|temporary|timeout/i.test(first)) {
      throw taggedSyncError("UPSTREAM_5XX", `Kraken/${endpoint}: ${first}`);
    }
    throw taggedSyncError("UNKNOWN", `Kraken/${endpoint}: ${first}`);
  }
  if (raw?.result === undefined) {
    throw taggedSyncError("SCHEMA_MISMATCH", `Kraken/${endpoint}: Antwort ohne result-Feld.`);
  }
  return raw.result;
}

/** Dependencies des Wrappers (alles injizierbar → deterministische Tests). */
export interface KrakenMarketAdapterDeps {
  /** Credentials-freier Sync-Client (niemals signierend). */
  client: KrakenSyncClient;
  /** Injizierbare Uhr (Determinismus in Tests; Default: Realzeit). */
  now?: () => Date;
}

/**
 * Kraken-Asset-ID → Ticker (`XXBT` → `BTC`, `ZUSD` → `USD`, `SOL` → `SOL`).
 * Das X/Z-Präfix tragen nur 4-stellige Legacy-Codes — `XTZ` (Tezos, 3
 * Zeichen) bleibt unangetastet. `XBT` wird zu `BTC` aliasiert (Seed-
 * Schreibweise, `src/universe/seed.ts`).
 */
export function normalizeKrakenAsset(asset: unknown): string | null {
  if (typeof asset !== "string" || !asset) return null;
  let code = asset.toUpperCase();
  if ((code.startsWith("X") || code.startsWith("Z")) && code.length > 3) {
    code = code.slice(1);
  }
  if (code === "XBT") return "BTC";
  return code;
}

/**
 * Kraken-Quote-Whitelist für den `altname`-Suffix-Fallback (längste zuerst
 * geprüft). BEWUSST Kraken-spezifisch statt `KNOWN_QUOTES`: Kraken führt
 * keine TUSD/BUSD/FDUSD-Märkte — deren Suffixe würden echte Paare falsch
 * schneiden (`XBTUSD` ⇒ `XB/TUSD` statt `XBT/USD`).
 */
const KRAKEN_FALLBACK_QUOTES: readonly string[] = [
  "USDT",
  "USDC",
  "USD",
  "EUR",
  "GBP",
  "JPY",
  "CHF",
  "CAD",
  "AUD",
  "BTC",
  "ETH",
];

/**
 * `AssetPairs`-Zeile → Speicher-Symbol (`BTC/USD`).
 *
 * Drei Stufen, erste gewinnt: (1) `wsname` (`XBT/USD` → `BTC/USD`);
 * (2) `base`/`quote`-Asset-IDs (`XXBT`/`ZUSD` → `BTC/USD` — eindeutig);
 * (3) `altname` + Quote-Suffix-Schnitt (`XBTUSD` → `BTC/USD`).
 * `null` = unlösbar (Zeile wird übersprungen — niemals geraten).
 */
export function krakenStorageSymbol(key: string, pair: KrakenAssetPair): string | null {
  const wsname = typeof pair?.wsname === "string" ? pair.wsname : "";
  if (wsname.includes("/")) {
    const [rawBase, rawQuote] = wsname.split("/");
    const base = rawBase === "XBT" ? "BTC" : rawBase;
    const symbol = `${base}/${rawQuote}`;
    return normalizeSyncSymbol(symbol);
  }
  const baseId = normalizeKrakenAsset(pair?.base);
  const quoteId = normalizeKrakenAsset(pair?.quote);
  if (baseId && quoteId) {
    return normalizeSyncSymbol(`${baseId}/${quoteId}`);
  }
  const altname = typeof pair?.altname === "string" ? pair.altname.toUpperCase() : "";
  if (altname) {
    const quotes = [...KRAKEN_FALLBACK_QUOTES].sort((a, b) => b.length - a.length);
    for (const quote of quotes) {
      if (altname.length > quote.length && altname.endsWith(quote)) {
        const rawBase = altname.slice(0, altname.length - quote.length);
        const base = rawBase === "XBT" ? "BTC" : rawBase;
        if (!/^[A-Z0-9]{1,12}$/.test(base)) continue;
        return normalizeSyncSymbol(`${base}/${quote}`);
      }
    }
  }
  void key;
  return null;
}

/**
 * DTO→Domain-Mapping EINER `AssetPairs`-Zeile (Regeln siehe Binance-Wrapper):
 * `base`/`quote` aus den Asset-IDs, Ticks aus den Dezimalstellen
 * (`10^-pair_decimals`), Gebühren = dokumentiertes Starter-Tier
 * `0.0016`/`0.0026` (Seed-wertegleich — `AssetPairs` liefert keine Fees und
 * kein Minimum: `minQuantity = 1e-8`, venue-sicherstes Minimum). Fiat/Fiat ⇒
 * `fx`, sonst `crypto`. `null` = Zeile unbrauchbar (Blocklist statt Wurf).
 */
export function mapAssetPairToInstrument(
  key: string,
  pair: KrakenAssetPair,
  now: Date,
): MarketInstrument | null {
  const symbol = krakenStorageSymbol(key, pair);
  const base = normalizeKrakenAsset(pair?.base);
  const quote = normalizeKrakenAsset(pair?.quote);
  if (!symbol || !base || !quote) return null;
  const pairDecimals = numOrNull(pair?.pair_decimals);
  const lotDecimals = numOrNull(pair?.lot_decimals);
  const leverage =
    (Array.isArray(pair?.leverage_buy) && pair.leverage_buy.length > 0) ||
    (Array.isArray(pair?.leverage_sell) && pair.leverage_sell.length > 0);
  const assetClass: AssetClass = FIAT_CODES.has(base) && FIAT_CODES.has(quote) ? "fx" : "crypto";
  return {
    id: `${KRAKEN_MARKET_DATA_VENUE}:${symbol}`,
    venue: KRAKEN_MARKET_DATA_VENUE,
    symbol,
    base,
    quote,
    assetClass,
    marketType: "spot",
    status: "active",
    minQuantity: 1e-8,
    priceStep: pairDecimals !== null ? Math.pow(10, -Math.min(Math.max(pairDecimals, 0), 12)) : 0.01,
    quantityStep: lotDecimals !== null ? Math.pow(10, -Math.min(Math.max(lotDecimals, 0), 12)) : 1e-8,
    makerFee: 0.0016,
    takerFee: 0.0026,
    leverageAvailable: leverage,
    shortAvailable: false,
    paperAvailable: true,
    liveTradable: true,
    liveAvailable: false,
    volume24h: null,
    spread: null,
    bookDepthUsd: null,
    volatility: null,
    lastSeen: now.toISOString(),
  };
}

/**
 * `Ticker`-Zeile → `MarketTicker`. Kraken meldet 24h-Volumen in BASE (`v[1]`)
 * — `quoteVol` ist die dokumentierte Näherung `v[1] × last` (Quote-Währung),
 * `null` wenn unbrauchbar (niemals 0).
 */
export function mapKrakenTicker(symbol: string, raw: KrakenTickerRow): MarketTicker | null {
  const price = numOrNull(raw?.c?.[0]);
  if (price === null || price <= 0) return null;
  const baseVol24h = numOrNull(raw?.v?.[1]);
  const quoteVol = baseVol24h !== null && baseVol24h > 0 ? baseVol24h * price : null;
  return {
    symbol,
    price,
    source: "kraken",
    ts: Date.now(),
    last: price,
    quoteVol,
    baseVol: baseVol24h !== null && baseVol24h > 0 ? baseVol24h : null,
    high: numOrNull(raw?.h?.[1]) ?? undefined,
    low: numOrNull(raw?.l?.[1]) ?? undefined,
  };
}

/** `OHLC`-Zeile → `MarketCandle` (`volume` = Base-Volumen, Index 6). Zeit in Sekunden ⇒ ms. */
export function mapKrakenOhlc(row: KrakenOhlcRow): MarketCandle | null {
  if (!Array.isArray(row) || row.length < 7) return null;
  const [timeSec, o, h, l, c, , v] = row;
  if (typeof timeSec !== "number" || !Number.isFinite(timeSec) || timeSec <= 0) return null;
  const open = numOrNull(o);
  const high = numOrNull(h);
  const low = numOrNull(l);
  const close = numOrNull(c);
  const volume = numOrNull(v);
  if (open === null || high === null || low === null || close === null || volume === null) return null;
  if (open <= 0 || high <= 0 || low <= 0 || close <= 0 || volume < 0) return null;
  return { time: Math.round(timeSec * 1000), open, high, low, close, volume };
}

/** Erzeugt den `MarketDataAdapter` über dem Sync-Client. */
export function createKrakenMarketDataAdapter(deps: KrakenMarketAdapterDeps): MarketDataAdapter {
  const client = deps.client;
  const now = deps.now ?? (() => new Date());

  // Speicher-Symbol → REST-Key (einmal je Lauf aus `AssetPairs` aufgebaut;
  // `reloadPairs` lädt bei Fehlschlag genau EINMAL nach).
  let pairsBySymbol: Map<string, string> | null = null;
  let pairsPromise: Promise<Map<string, string>> | null = null;

  const loadPairs = (): Promise<Map<string, string>> => {
    if (pairsPromise) return pairsPromise;
    pairsPromise = (async () => {
      const table = await client.assetPairs();
      const map = new Map<string, string>();
      for (const [key, pair] of Object.entries(table)) {
        const symbol = krakenStorageSymbol(key, pair);
        if (symbol && !map.has(symbol)) map.set(symbol, key);
      }
      pairsBySymbol = map;
      return map;
    })();
    return pairsPromise;
  };

  const resolveKey = async (symbol: string): Promise<string> => {
    const upper = symbol.toUpperCase();
    const table = pairsBySymbol ?? (await loadPairs());
    const direct = table.get(upper);
    if (direct) return direct;
    // Nachlader: genau EIN Reload, dann ehrlich INVALID_SYMBOL (kein Raten).
    pairsPromise = null;
    const reloaded = await loadPairs();
    const found = reloaded.get(upper);
    if (found) return found;
    throw taggedSyncError(
      "INVALID_SYMBOL",
      `Kraken kennt kein Paar für ${upper} (weder wsname- noch altname-Auflösung).`,
    );
  };

  return {
    venue: KRAKEN_MARKET_DATA_VENUE,

    async discoverInstruments(): Promise<MarketInstrument[]> {
      const table = await client.assetPairs();
      const at = now();
      const out: MarketInstrument[] = [];
      const seen = new Set<string>();
      const memo = new Map<string, string>();
      for (const [key, pair] of Object.entries(table)) {
        const instrument = mapAssetPairToInstrument(key, pair, at);
        if (!instrument || seen.has(instrument.id)) continue;
        seen.add(instrument.id);
        memo.set(instrument.symbol, key);
        out.push(instrument);
      }
      // Discovery befüllt dasselbe Memo wie `resolveKey` (ein Lauf = ein Stand).
      pairsBySymbol = memo;
      return out;
    },

    async getTicker(symbol: string): Promise<MarketTicker> {
      const upper = symbol.toUpperCase();
      const key = await resolveKey(upper);
      const rows = await client.ticker([key]);
      const mapped = mapKrakenTicker(upper, rows[key] as KrakenTickerRow);
      if (!mapped) {
        throw new Error(`Kraken-Ticker für ${upper} unbrauchbar (leere/ungültige Zeile).`);
      }
      return mapped;
    },

    /**
     * Bulk über die aufgelösten Keys (50 Paare/Call). Unauflösbare Symbole
     * werden ÜBERSPRUNGEN (Lücke ⇒ Einzel-Fallback ⇒ isoliertes
     * INVALID_SYMBOL) statt den Bulk zu verwerfen.
     */
    async getTickers(symbols?: string[]): Promise<MarketTicker[]> {
      const table = pairsBySymbol ?? (await loadPairs());
      const wanted = symbols ? symbols.map((s) => s.toUpperCase()) : [...table.keys()];
      const keys: string[] = [];
      const symbolByKey = new Map<string, string>();
      for (const symbol of wanted) {
        const key = table.get(symbol);
        if (!key || symbolByKey.has(key)) continue;
        symbolByKey.set(key, symbol);
        keys.push(key);
      }
      const out: MarketTicker[] = [];
      for (let i = 0; i < keys.length; i += KRAKEN_TICKER_CHUNK_SIZE) {
        const chunk = keys.slice(i, i + KRAKEN_TICKER_CHUNK_SIZE);
        const rows = await client.ticker(chunk);
        for (const [key, row] of Object.entries(rows)) {
          const symbol = symbolByKey.get(key);
          if (!symbol) continue;
          const mapped = mapKrakenTicker(symbol, row);
          if (mapped) out.push(mapped);
        }
      }
      return out;
    },

    async getOrderBook(symbol: string): Promise<MarketOrderBook> {
      const upper = symbol.toUpperCase();
      const key = await resolveKey(upper);
      const raw = await client.depth(key, 5);
      return {
        symbol: upper,
        bids: mapDepthLevels(raw?.bids),
        asks: mapDepthLevels(raw?.asks),
        ts: now().getTime(),
      };
    },

    async getCandles(symbol: string, timeframe: SupportedTimeframe, limit: number): Promise<MarketCandle[]> {
      const interval = toKrakenInterval(timeframe);
      const upper = symbol.toUpperCase();
      const key = await resolveKey(upper);
      // Kraken liefert immer die letzten 720 Kerzen (inkl. laufender) —
      // Schnitt auf `limit` client-seitig. Die laufende Kerze wird NICHT
      // verworfen (konsistent zu Binance/Bitunix: der inkrementelle Sync
      // erkennt sie am Periodenrand und spart den nächsten Call).
      const rows = await client.ohlc(key, interval);
      const out: MarketCandle[] = [];
      for (const row of rows) {
        const mapped = mapKrakenOhlc(row);
        if (mapped) out.push(mapped);
      }
      out.sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
      return out.slice(-Math.max(limit, 0));
    },
  };
}

/** Depth-Seite (`[Preis, Menge, ts]`, Strings) → geprüfte Levels. */
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

/** Compile-Time-Beweis, dass die Map wirklich JEDES Store-Timeframe abdeckt. */
const _EXHAUSTIVE_TIMEFRAME_CHECK: Record<SupportedTimeframe, number | null> = KRAKEN_TIMEFRAME_MAP;
void _EXHAUSTIVE_TIMEFRAME_CHECK;
