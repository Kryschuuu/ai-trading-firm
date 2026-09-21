/**
 * Yahoo-Finance-Wrapper: ALPACA/IBKR-Discovery → `MarketDataAdapter`.
 *
 * Warum Yahoo: ALPACA und IBKR bieten keinen öffentlichen (key-freien)
 * Market-Data-REST-Pfad — ihre Broker-APIs verlangen Auth/Scope und gehören
 * nicht in den Sync. Yahoo Finance liefert kuratiert Aktien/ETFs, FX,
 * Continuous-Futures und Indizes über zwei stabile Public-Endpunkte und ist
 * damit die dokumentierte Sync-Quelle beider Broker-Venues (der PAPER-Spiegel
 * nutzt sie für alle Nicht-Krypto-Symbole mit).
 *
 * Endpunkte (öffentlich, kein Key — aber Browser-`User-Agent` ist Pflicht,
 * sonst drosselt Yahoo sofort):
 *   Ticker  `GET /v7/finance/quote?symbols=A,B&fields=…` — Bulk (100/Call).
 *   Chart   `GET /v8/finance/chart/{symbol}?interval=1h&range=3mo` — OHLCV.
 * Orderbook: kein Depth-Endpunkt — Top-of-Book aus `bid`/`ask` der Quote
 *   (aus dem Bulk-Cache, kein Extra-Request; fehlend ⇒ leeres Buch ⇒
 *   Spread `null`, ehrliche Data-Quality statt erfundener Werte).
 *
 * Discovery: Yahoo kennt kein Symbol-Listing — sie liest das kuratierte
 * Universum aus `./seeded.ts` (Preset ∪ Seed je Venue). Die Speicherform
 * bleibt IMMER Yahoo-fremd (`SPX`, `CL`, `EUR.USD` — nie `^GSPC`/`CL=F`);
 * die Abbildung steht in {@link toYahooSymbol} (+ {@link YAHOO_INDEX_MAP}).
 */

import type { SupportedTimeframe } from "../../lib/marketdata/historicalStore";
import type { AssetClass } from "../../universe/types";
import type { InstrumentInput } from "../../universe/types";
import { normalizeSyncSymbol, UnsupportedTimeframeError } from "../errors";
import type { MarketDataAdapter } from "../sync";
import type { MarketCandle, MarketInstrument, MarketOrderBook, MarketTicker } from "../types";
import { SyncHttpClient, taggedSyncError } from "./http";
import { seededToMarketInstrument } from "./seeded";

/** Öffentliche Yahoo-Finance-Basis (kein Key, kein Crumb für quote/chart nötig). */
export const YAHOO_SYNC_BASE_URL = "https://query1.finance.yahoo.com" as const;

/**
 * Konservative Sync-Rate (Yahoo dokumentiert kein Limit, drosselt aber
 * aggressiv — 2/s + Browser-UA bleiben in der Praxis stabil).
 */
export const YAHOO_SYNC_RATE_PER_SEC = 2;

/** Symbole je `quote`-Bulk-Call (URL-Länge bleibt < ~2 KB). */
export const YAHOO_QUOTE_CHUNK_SIZE = 100;

/** Browser-UA (Yahoo-Quirk): Ohne ihn antwortet Yahoo mit 429/Fehlern. */
export const YAHOO_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/**
 * Timeframe → Yahoo-`interval`. Yahoo kennt `2h`/`4h` nicht (nur `90m` —
 * kein Ersatz, Periodizität würde Reihen mischen) und `3m` nicht:
 * dokumentierte Lücken (`null`). `5d` wird bedient.
 */
export const YAHOO_TIMEFRAME_MAP: Readonly<Record<SupportedTimeframe, string | null>> = {
  "1m": "1m",
  "3m": null,
  "5m": "5m",
  "15m": "15m",
  "30m": "30m",
  "1h": "1h",
  "2h": null,
  "4h": null,
  "1d": "1d",
  "5d": "5d",
};

/**
 * Liefert das Yahoo-Intervall für einen Store-Timeframe.
 *
 * @throws {UnsupportedTimeframeError} bei Lücke (`null`) oder Unbekannt.
 */
export function toYahooInterval(timeframe: string): string {
  const mapped = (YAHOO_TIMEFRAME_MAP as Record<string, string | null>)[timeframe];
  if (mapped === undefined || mapped === null) {
    throw new UnsupportedTimeframeError(timeframe, "YAHOO");
  }
  return mapped;
}

/**
 * Großzügige Chart-`range` je (Intervall, Limit) — Stufenleiter mit Reserve
 * für Wochenenden/Feiertage (Aktien: ~390 min/Handelstag). Deckel je
 * Intervall: Intraday ≤ `1mo`, `1h` ≤ `6mo`, `1d`/`5d` ≤ `5y`. Reicht die
 * Maximal-Range für ein großes Limit nicht, liefert Yahoo ehrlich weniger
 * Bars zurück (sichtbar via Readiness, kein stilles Auffüllen).
 */
export function yahooRangeFor(interval: string, limit: number): string {
  const n = Math.max(1, Math.floor(limit));
  switch (interval) {
    case "1m":
      if (n <= 350) return "1d";
      if (n <= 1800) return "5d";
      return "1mo";
    case "5m":
      return n <= 350 ? "5d" : "1mo";
    case "15m":
      return n <= 130 ? "5d" : "1mo";
    case "30m":
      return n <= 60 ? "5d" : "1mo";
    case "1h":
      if (n <= 140) return "1mo";
      if (n <= 400) return "3mo";
      return "6mo";
    case "1d":
      return n <= 500 ? "2y" : "5y";
    case "5d":
      return "5y";
    default:
      throw new UnsupportedTimeframeError(interval, "YAHOO");
  }
}

// ── Symbol-Abbildung Speicher → Yahoo ────────────────────────────────────────

/**
 * Kuratierte Index-Abbildung Preset → Yahoo (50/50, Stand 2026-09).
 *
 * Yahoo kürzt anders als die Presets (`NKY` → `^N225`, `UKX` → `^FTSE`,
 * `XJO` → `^AXJO`, `SENSEX` → `^BSESN`, `NIFTY` → `^NSEI`, `TOPIX` → `^TOPX`,
 * `HSCEI` → `^HSCE`, `KOSPI` → `^KS11`, `TSX` → `^GSPTSE`, `FTMIB` →
 * `FTSE.MI`). Einträge in {@link LOW_CONFIDENCE_YAHOO_INDICES} sind
 * Best-Guess (`^`-Präfix auf Preset-Symbol) — antwortet Yahoo nicht, scheitert
 * das Symbol ISOLIERT als `NOT_FOUND` (Runbook), nie der Lauf.
 */
export const YAHOO_INDEX_MAP: Readonly<Record<string, string>> = {
  // USA (20)
  SPX: "^GSPC",
  NDX: "^NDX",
  DJI: "^DJI",
  IXIC: "^IXIC",
  RUT: "^RUT",
  RUI: "^RUI",
  RUA: "^RUA",
  OEX: "^OEX",
  MID: "^MID",
  SML: "^SML",
  DJT: "^DJT",
  DJU: "^DJU",
  NYA: "^NYA",
  SOX: "^SOX",
  NBI: "^NBI",
  XAU: "^XAU",
  OSX: "^OSX",
  BKX: "^BKX",
  VIX: "^VIX",
  VXN: "^VXN",
  // Europa (13)
  GDAXI: "^GDAXI",
  MDAXI: "^MDAXI",
  TECDAXI: "^TECDAXI",
  FCHI: "^FCHI",
  AEX: "^AEX",
  BEL20: "^BFX",
  SSMI: "^SSMI",
  FTMIB: "FTSE.MI",
  IBEX: "^IBEX",
  OMXS30: "^OMXS30",
  OMXC25: "^OMXC25",
  WIG20: "^WIG20",
  ATX: "^ATX",
  // UK (2)
  UKX: "^FTSE",
  MCX: "^FTMC",
  // Asien (9)
  NKY: "^N225",
  TOPIX: "^TOPX",
  HSI: "^HSI",
  HSCEI: "^HSCE",
  KOSPI: "^KS11",
  TWII: "^TWII",
  STI: "^STI",
  SENSEX: "^BSESN",
  NIFTY: "^NSEI",
  // Amerika ohne USA (4)
  TSX: "^GSPTSE",
  TX60: "^TX60",
  MXX: "^MXX",
  BVSP: "^BVSP",
  // ANZ (2)
  XJO: "^AXJO",
  NZ50: "^NZ50G",
};

/** Best-Guess-Einträge aus {@link YAHOO_INDEX_MAP} (Runbook: dürfen isoliert fehlen). */
export const LOW_CONFIDENCE_YAHOO_INDICES: ReadonlySet<string> = new Set([
  "RUA",
  "SML",
  "OMXC25",
  "TX60",
  "NZ50",
]);

/**
 * Speicher-Symbol → Yahoo-Ticker.
 *
 * Regeln:
 *   - Enthält `=` (z. B. `PAPER:EURUSD=X`) ⇒ bereits Yahoo-nativ, as-is.
 *   - `fx` ⇒ Separatoren raus + `=X` (`EUR.USD` → `EURUSD=X`).
 *   - `commodity` ⇒ `=F`-Suffix (Continuous Future: `CL` → `CL=F`).
 *   - `index` ⇒ {@link YAHOO_INDEX_MAP}.
 *   - `equity`/`etf` ⇒ as-is, `.` → `-` (Aktienklassen: `BRK.B` → `BRK-B`).
 *   - alles andere (`crypto`, `other`, unbekannt) ⇒ `null`.
 *
 * `null` = nicht abbildbar (Adapter wirft `INVALID_SYMBOL`, isoliert).
 */
export function toYahooSymbol(storageSymbol: string, assetClass: AssetClass | string): string | null {
  if (typeof storageSymbol !== "string" || !storageSymbol) return null;
  const symbol = storageSymbol.toUpperCase();
  if (symbol.includes("=")) return symbol;
  switch (assetClass) {
    case "fx": {
      const compact = symbol.replace(/[^A-Z0-9]/g, "");
      if (!/^[A-Z0-9]{4,14}$/.test(compact)) return null;
      return `${compact}=X`;
    }
    case "commodity": {
      if (!/^[A-Z]{1,5}$/.test(symbol)) return null;
      return `${symbol}=F`;
    }
    case "index":
      return YAHOO_INDEX_MAP[symbol] ?? null;
    case "equity":
    case "etf": {
      const mapped = symbol.replace(/\./g, "-");
      if (!/^[A-Z0-9][A-Z0-9-]{0,11}$/.test(mapped)) return null;
      return mapped;
    }
    default:
      return null;
  }
}

// ── Roh-Typen (Yahoo Finance, öffentlich dokumentiert) ───────────────────────

/** Eine `quote`-Zeile (nur genutzte Felder; Yahoo liefert viel mehr). */
export interface YahooQuoteRow {
  symbol?: string;
  regularMarketPrice?: number;
  regularMarketVolume?: number;
  bid?: number;
  ask?: number;
  bidSize?: number;
  askSize?: number;
  regularMarketDayHigh?: number;
  regularMarketDayLow?: number;
  regularMarketTime?: number;
}

/** `chart`-Ergebnis (nur genutzte Felder; Lücken = `null`-Einträge). */
export interface YahooChartResult {
  timestamp?: number[];
  indicators?: {
    quote?: Array<{
      open?: Array<number | null>;
      high?: Array<number | null>;
      low?: Array<number | null>;
      close?: Array<number | null>;
      volume?: Array<number | null>;
    }>;
  };
}

/** Credentials-freier Yahoo-Client (nur quote/chart, GET). */
export class YahooSyncClient {
  private readonly http: SyncHttpClient;

  constructor(http: SyncHttpClient) {
    this.http = http;
  }

  /** Bulk-Quotes (genau EIN Request für die übergebenen Symbole). */
  async quote(symbols: readonly string[]): Promise<YahooQuoteRow[]> {
    if (symbols.length === 0) return [];
    const raw = await this.http.getJson<{ quoteResponse?: { result?: unknown; error?: unknown } }>(
      "/v7/finance/quote",
      {
        symbols: symbols.join(","),
        fields:
          "symbol,regularMarketPrice,regularMarketVolume,bid,ask,bidSize,askSize," +
          "regularMarketDayHigh,regularMarketDayLow,regularMarketTime",
      },
    );
    const result = raw?.quoteResponse?.result;
    return Array.isArray(result) ? (result as YahooQuoteRow[]) : [];
  }

  /** OHLCV-Chart (eine Range, client-seitig auf `limit` geschnitten). */
  async chart(yahooSymbol: string, interval: string, range: string): Promise<YahooChartResult | null> {
    const raw = await this.http.getJson<{ chart?: { result?: unknown; error?: unknown } }>(
      `/v8/finance/chart/${encodeURIComponent(yahooSymbol)}`,
      { interval, range, includePrePost: "false" },
    );
    const results = raw?.chart?.result;
    if (!Array.isArray(results) || results.length === 0) return null;
    return results[0] as YahooChartResult;
  }
}

/** Dependencies des Wrappers (alles injizierbar → deterministische Tests). */
export interface YahooMarketAdapterDeps {
  /** Venue-Key (`ALPACA` oder `IBKR` — steht auf den Discovery-Instrumenten). */
  venue: string;
  /** Credentials-freier Sync-Client (niemals signierend). */
  client: YahooSyncClient;
  /**
   * Kuratiertes Universum der Venue (`seededInstrumentsForVenue`) — zugleich
   * Routing-Tabelle (Speicher-Symbol → Yahoo-Ticker via Asset-Klasse).
   */
  instruments: readonly InstrumentInput[];
  /** Injizierbare Uhr (Determinismus in Tests; Default: Realzeit). */
  now?: () => Date;
}

/**
 * `quote`-Zeile → `MarketTicker` (unter dem SPEICHER-Symbol — nie Yahoo-Form).
 * `quoteVol` = Shares × Preis (Näherung in Quote-Währung), `null` wenn
 * unbrauchbar (niemals 0). `null` = Zeile unbrauchbar (Lücke statt Wurf).
 */
export function mapYahooQuote(storageSymbol: string, raw: YahooQuoteRow): MarketTicker | null {
  const price = numOrNull(raw?.regularMarketPrice);
  if (price === null || price <= 0) return null;
  const shares = numOrNull(raw?.regularMarketVolume);
  const quoteVol = shares !== null && shares > 0 ? shares * price : null;
  const marketTime = numOrNull(raw?.regularMarketTime);
  return {
    symbol: storageSymbol,
    price,
    source: "yahoo",
    ts: marketTime !== null && marketTime > 0 ? Math.round(marketTime * 1000) : Date.now(),
    last: price,
    quoteVol,
    baseVol: shares !== null && shares > 0 ? shares : null,
    high: numOrNull(raw?.regularMarketDayHigh) ?? undefined,
    low: numOrNull(raw?.regularMarketDayLow) ?? undefined,
  };
}

/** `chart`-Ergebnis → Kerzen (`volume` = Shares, `null` ⇒ 0 bei valider OHLC-Zeile). */
export function mapYahooChart(result: YahooChartResult): MarketCandle[] {
  const timestamps = Array.isArray(result?.timestamp) ? result.timestamp : [];
  const quote = result?.indicators?.quote?.[0];
  const opens = quote?.open ?? [];
  const highs = quote?.high ?? [];
  const lows = quote?.low ?? [];
  const closes = quote?.close ?? [];
  const volumes = quote?.volume ?? [];
  const out: MarketCandle[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const ts = timestamps[i];
    if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) continue;
    const open = numOrNull(opens[i]);
    const high = numOrNull(highs[i]);
    const low = numOrNull(lows[i]);
    const close = numOrNull(closes[i]);
    if (open === null || high === null || low === null || close === null) continue;
    if (open <= 0 || high <= 0 || low <= 0 || close <= 0) continue;
    const volumeRaw = numOrNull(volumes[i]);
    out.push({
      time: Math.round(ts * 1000),
      open,
      high,
      low,
      close,
      volume: volumeRaw !== null && volumeRaw >= 0 ? volumeRaw : 0,
    });
  }
  out.sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
  return out;
}

/** Erzeugt den `MarketDataAdapter` über dem Sync-Client. */
export function createYahooMarketDataAdapter(deps: YahooMarketAdapterDeps): MarketDataAdapter {
  const venue = deps.venue.toUpperCase();
  const client = deps.client;
  const now = deps.now ?? (() => new Date());

  // Routing-Tabelle (Bauzeit, kein Call-Order-Risiko): Speicher → Yahoo.
  // `null` = strukturell nicht abbildbar (Adapter wirft INVALID_SYMBOL).
  const yahooByStorage = new Map<string, string | null>();
  for (const input of deps.instruments) {
    const symbol = input.symbol.toUpperCase();
    if (!yahooByStorage.has(symbol)) {
      yahooByStorage.set(symbol, toYahooSymbol(symbol, input.assetClass ?? "other"));
    }
  }

  // Bulk-Quote-Cache des Laufs: `getTickers` befüllt, `getTicker`/
  // `getOrderBook` lesen (Read-Through bei Lücke — kein Extra-Request, wenn
  // der Bulk die Zeile bereits lieferte).
  const quoteCache = new Map<string, YahooQuoteRow>();

  const resolveYahoo = (storage: string): string => {
    const upper = storage.toUpperCase();
    if (!yahooByStorage.has(upper)) {
      throw taggedSyncError(
        "INVALID_SYMBOL",
        `${venue}: ${upper} gehört nicht zum kuratierten Sync-Universum (Preset ∪ Seed).`,
      );
    }
    const yahoo = yahooByStorage.get(upper);
    if (!yahoo) {
      throw taggedSyncError("INVALID_SYMBOL", `${venue}: ${upper} ist nicht auf Yahoo abbildbar.`);
    }
    return yahoo;
  };

  const quoteOf = async (storage: string): Promise<YahooQuoteRow | null> => {
    const upper = storage.toUpperCase();
    const cached = quoteCache.get(upper);
    if (cached) return cached;
    const yahoo = resolveYahoo(upper);
    const rows = await client.quote([yahoo]);
    const row = rows.find((r) => typeof r?.symbol === "string" && r.symbol.toUpperCase() === yahoo.toUpperCase());
    if (row) quoteCache.set(upper, row);
    return row ?? null;
  };

  return {
    venue,

    async discoverInstruments(): Promise<MarketInstrument[]> {
      const at = now();
      const out: MarketInstrument[] = [];
      const seen = new Set<string>();
      for (const input of deps.instruments) {
        const symbol = normalizeSyncSymbol(input.symbol);
        if (!symbol) continue;
        // Discovery verspricht NUR kuratierte Kandidaten — ob Yahoo sie
        // kennt, entscheidet das Enrichment (Lücke ⇒ isoliertes NOT_FOUND,
        // kein stilles Verschweigen, kein Venue-weites Werfen).
        const instrument = seededToMarketInstrument({ ...input, venue, symbol }, at);
        if (seen.has(instrument.id)) continue;
        seen.add(instrument.id);
        out.push(instrument);
      }
      return out;
    },

    async getTicker(symbol: string): Promise<MarketTicker> {
      const upper = symbol.toUpperCase();
      const row = await quoteOf(upper);
      const mapped = row ? mapYahooQuote(upper, row) : null;
      if (!mapped) {
        throw new Error(`Yahoo-Ticker für ${upper} unbrauchbar (leere/ungültige Zeile).`);
      }
      return mapped;
    },

    /**
     * Bulk über die Yahoo-Ticker (100/Call). Nicht abbildbare Symbole werden
     * ÜBERSPRUNGEN (Lücke ⇒ Einzel-Fallback ⇒ isoliertes INVALID_SYMBOL).
     */
    async getTickers(symbols?: string[]): Promise<MarketTicker[]> {
      const wanted = symbols ? symbols.map((s) => s.toUpperCase()) : [...yahooByStorage.keys()];
      const yahooList: string[] = [];
      const storageByYahoo = new Map<string, string>();
      for (const storage of wanted) {
        const yahoo = yahooByStorage.get(storage);
        if (!yahoo || storageByYahoo.has(yahoo.toUpperCase())) continue;
        storageByYahoo.set(yahoo.toUpperCase(), storage);
        yahooList.push(yahoo);
      }
      const out: MarketTicker[] = [];
      for (let i = 0; i < yahooList.length; i += YAHOO_QUOTE_CHUNK_SIZE) {
        const chunk = yahooList.slice(i, i + YAHOO_QUOTE_CHUNK_SIZE);
        const rows = await client.quote(chunk);
        for (const row of rows) {
          const echo = typeof row?.symbol === "string" ? row.symbol.toUpperCase() : "";
          const storage = storageByYahoo.get(echo);
          if (!storage) continue;
          quoteCache.set(storage, row);
          const mapped = mapYahooQuote(storage, row);
          if (mapped) out.push(mapped);
        }
      }
      return out;
    },

    /**
     * Top-of-Book aus der Quote (Cache, kein Extra-Request). Yahoo liefert
     * keine Tiefe — `qty` ist die Lotgröße (`bidSize`/`askSize`, sonst 0);
     * für den Spread zählen nur die Preise. Fehlendes Bid/Ask ⇒ leeres Buch
     * (Spread `null`, Data-Quality).
     */
    async getOrderBook(symbol: string): Promise<MarketOrderBook> {
      const upper = symbol.toUpperCase();
      const row = await quoteOf(upper);
      const bid = numOrNull(row?.bid);
      const ask = numOrNull(row?.ask);
      const bidSize = numOrNull(row?.bidSize);
      const askSize = numOrNull(row?.askSize);
      return {
        symbol: upper,
        bids: bid !== null && bid > 0 ? [{ price: bid, qty: bidSize !== null && bidSize >= 0 ? bidSize : 0 }] : [],
        asks: ask !== null && ask > 0 ? [{ price: ask, qty: askSize !== null && askSize >= 0 ? askSize : 0 }] : [],
        ts: now().getTime(),
      };
    },

    async getCandles(symbol: string, timeframe: SupportedTimeframe, limit: number): Promise<MarketCandle[]> {
      const interval = toYahooInterval(timeframe);
      const upper = symbol.toUpperCase();
      const yahoo = resolveYahoo(upper);
      const result = await client.chart(yahoo, interval, yahooRangeFor(interval, limit));
      if (!result) return [];
      return mapYahooChart(result).slice(-Math.max(limit, 0));
    },
  };
}

function numOrNull(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value !== "" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** Compile-Time-Beweis, dass die Map wirklich JEDES Store-Timeframe abdeckt. */
const _EXHAUSTIVE_TIMEFRAME_CHECK: Record<SupportedTimeframe, string | null> = YAHOO_TIMEFRAME_MAP;
void _EXHAUSTIVE_TIMEFRAME_CHECK;
