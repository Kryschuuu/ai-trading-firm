/**
 * Public REST-Client (keine Signatur, keine Credentials).
 *
 * Endpunkte: trading_pairs, tickers, kline, depth und — seit RMA-P2-02 —
 * funding_rate sowie get_funding_rate_history (historische Perpetual-Daten,
 * ebenfalls public und credential-frei).
 */
import type { MarketCandle, MarketOrderBook, MarketTicker } from "../../contracts/broker";
import {
  BITUNIX_FUNDING_HISTORY_MAX_LIMIT,
  BITUNIX_PATHS,
  BITUNIX_TICKER_SYMBOLS_PER_REQUEST,
  type BitunixRuntimeConfig,
} from "./config";
import { BitunixApiError, classifyBitunixFailure, safeSnippet } from "./errors";
import { BitunixHttp, type BitunixHttpOptions } from "./http";
import { mapTradingPairs } from "./mapping";
import type {
  BitunixDepthRaw,
  BitunixEnvelope,
  BitunixFundingRateHistoryRaw,
  BitunixFundingRateRaw,
  BitunixKlineRaw,
  BitunixTickerRaw,
  BitunixTradingPair,
} from "./types";
import type { MarketInstrument } from "../../universe/types";

function envelopeData<T>(json: unknown): T {
  if (!json || typeof json !== "object") {
    throw new BitunixApiError("unknown", "Bitunix: leere Antwort.");
  }
  const env = json as BitunixEnvelope<T>;
  if (typeof env.code === "number" && env.code !== 0) {
    const c = classifyBitunixFailure({ venueCode: env.code, venueMsg: env.msg });
    throw new BitunixApiError(c.kind, c.message, { venueCode: env.code });
  }
  return env.data;
}

function num(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

export class BitunixPublicClient {
  private readonly http: BitunixHttp;

  constructor(opts: BitunixHttpOptions) {
    this.http = new BitunixHttp(opts);
  }

  async fetchTradingPairs(symbols?: string): Promise<MarketInstrument[]> {
    return mapTradingPairs(await this.fetchTradingPairsRaw(symbols));
  }

  /**
   * RAW-Zeilen von `GET /market/trading_pairs` (BitunixTradingPair-DTO).
   *
   * Das DTO→Domain-Mapping liegt bewusst beim Aufrufer: die Broker-Domäne
   * mappt über `mapTradingPairs()` (src/brokers/bitunix/mapping.ts), die
   * Marketdata-Domäne über den Wrapper
   * `src/marketdata/adapters/bitunix.ts` (inkl. `normalizeVenueSymbol` und
   * `symbolStatus`/`isApiSupported`-Status-Übernahme). Beide Pfade teilen
   * sich denselben Transport (Token-Bucket, Retry, Payload-Kappe).
   */
  async fetchTradingPairsRaw(symbols?: string): Promise<BitunixTradingPair[]> {
    const res = await this.http.request({
      method: "GET",
      path: BITUNIX_PATHS.tradingPairs,
      query: symbols ? { symbols } : undefined,
    });
    const data = envelopeData<unknown>(res.json);
    return Array.isArray(data) ? (data as BitunixTradingPair[]) : [];
  }

  /**
   * `GET /market/tickers` — Bulk-Ticker für alle angefragten Symbole.
   *
   * @param symbols Optionaler Filter. Akzeptiert werden ein Array
   *                (`["BTCUSDT","ETHUSDT"]` → `symbols=BTCUSDT,ETHUSDT`,
   *                leeres Array = kein Filter = alle Symbole) sowie der
   *                vorformatierte Query-String (Abwärtskompatibilität).
   *
   * Große Symbol-Listen werden in Chunks von `BITUNIX_TICKER_SYMBOLS_PER_REQUEST`
   * angefragt: Der volle Bitunix-Katalog (≈ 750 Symbole) ergibt sonst eine
   * URL von > 6 KB, die der Venue-Gateway ablehnt — und ein einziger
   * abgelehnter Request riss bisher die komplette Ticker-Stage (alle
   * Instrumente „SCHEMA_MISMATCH“) mit. Schlägt ein Chunk fehl, werden die
   * übrigen trotzdem geliefert (fehlende Symbole füllt der Aufrufer per
   * Einzel-Ticker nach); nur wenn KEIN Chunk gelingt, wird der erste Fehler
   * geworfen.
   */
  async fetchTickers(symbols?: string[] | string): Promise<BitunixTickerRaw[]> {
    if (Array.isArray(symbols) && symbols.length > BITUNIX_TICKER_SYMBOLS_PER_REQUEST) {
      const chunks: string[][] = [];
      for (let i = 0; i < symbols.length; i += BITUNIX_TICKER_SYMBOLS_PER_REQUEST) {
        chunks.push(symbols.slice(i, i + BITUNIX_TICKER_SYMBOLS_PER_REQUEST));
      }
      const out: BitunixTickerRaw[] = [];
      let firstError: unknown;
      let succeeded = 0;
      for (const chunk of chunks) {
        try {
          out.push(...(await this.fetchTickersOnce(chunk.join(","))));
          succeeded += 1;
        } catch (e) {
          if (firstError === undefined) firstError = e;
        }
      }
      if (succeeded === 0 && firstError !== undefined) throw firstError;
      return out;
    }
    const query = Array.isArray(symbols)
      ? symbols.length > 0
        ? symbols.join(",")
        : undefined
      : symbols;
    return this.fetchTickersOnce(query);
  }

  private async fetchTickersOnce(query: string | undefined): Promise<BitunixTickerRaw[]> {
    const res = await this.http.request({
      method: "GET",
      path: BITUNIX_PATHS.tickers,
      query: query ? { symbols: query } : undefined,
    });
    const data = envelopeData<unknown>(res.json);
    return Array.isArray(data) ? (data as BitunixTickerRaw[]) : [];
  }

  async fetchTicker(symbol: string): Promise<MarketTicker> {
    const rows = await this.fetchTickers(symbol);
    const row = rows.find((r) => String(r.symbol).toUpperCase() === symbol.toUpperCase()) ?? rows[0];
    if (!row) {
      throw new BitunixApiError("unknown", `Kein Ticker für ${symbol.slice(0, 20)}.`);
    }
    return mapTicker(row);
  }

  async fetchKlines(symbol: string, interval: string, limit = 100): Promise<MarketCandle[]> {
    const res = await this.http.request({
      method: "GET",
      path: BITUNIX_PATHS.kline,
      query: { symbol, interval: mapInterval(interval), limit: Math.min(Math.max(limit, 1), 200) },
    });
    const data = envelopeData<unknown>(res.json);
    const rows = Array.isArray(data) ? (data as BitunixKlineRaw[]) : [];
    return rows
      .map(mapKline)
      .filter((c): c is MarketCandle => c !== null)
      .sort((a, b) => a.time - b.time);
  }

  /**
   * `GET /market/depth` — RAW-DTO (`BitunixDepthRaw`: bids/asks als
   * `[price, qty]`-Paare in String/Number-Form, genau wie die Venue liefert).
   *
   * Das DTO→Domain-Mapping (Filterung nicht-endlicher Levels, `price`/`qty`)
   * liegt beim Aufrufer — Broker-Domäne: `fetchOrderBook()`, Marketdata-Domäne:
   * Wrapper `src/marketdata/adapters/bitunix.ts` (`getOrderBook`).
   *
   * @param limit Buchtiefe (`1` | `5` | `15` | `50`; Venue-Doku). Default 5 —
   *              für den Spread reicht das Top-of-Book, und der Sync fragt
   *              depth N-mal (ein Call je Instrument).
   */
  async fetchDepth(symbol: string, limit: number | string = 5): Promise<BitunixDepthRaw> {
    const res = await this.http.request({
      method: "GET",
      path: BITUNIX_PATHS.depth,
      query: { symbol, limit },
    });
    return envelopeData<BitunixDepthRaw>(res.json) ?? {};
  }

  /**
   * `GET /market/funding_rate` — **aktuelle** Funding-Rate (public, RMA-P2-02).
   *
   * Die Venue antwortet mit einem Array (ein Eintrag je angefragtem Symbol).
   * Credentials sind nicht beteiligt; es wird ausschließlich über den
   * credential-freien Public-Transport angefragt.
   *
   * @param symbol Optionales venue-natives Symbol (`BTCUSDT`). Wird es
   *               abgelehnt (Format), wirft der Client **vor** dem Request —
   *               ein Fremd-Symbol erreicht das Netz nie.
   */
  async fetchFundingRates(symbol?: string): Promise<BitunixFundingRateRaw[]> {
    const query = symbol === undefined ? undefined : { symbol: assertPerpSymbol(symbol) };
    const res = await this.http.request({
      method: "GET",
      path: BITUNIX_PATHS.fundingRate,
      query,
    });
    const data = envelopeData<unknown>(res.json);
    return Array.isArray(data) ? (data as BitunixFundingRateRaw[]) : [];
  }

  /**
   * `GET /market/get_funding_rate_history` — Historie der Funding-Sätze
   * (public, RMA-P2-02).
   *
   * Grenzen der Venue-Doku: `limit` Default 100, Maximum 200. Der Client
   * klemmt `limit` hart auf {@link BITUNIX_FUNDING_HISTORY_MAX_LIMIT} und
   * verwirft nicht-endliche Zeitstempel (Validierung **vor** dem Request).
   *
   * Zeitparameter: die Futures-Doku nennt das Startfeld an einer Stelle
   * `starTime` (Tippfehler), `/market/kline` nutzt `startTime`. Gesendet wird
   * `startTime`/`endTime`; der Perp-Adapter filtert zusätzlich client-seitig
   * und meldet ein zu enges Fenster, statt blind zu blättern.
   */
  async fetchFundingRateHistory(request: {
    symbol: string;
    startTime?: number;
    endTime?: number;
    limit?: number;
  }): Promise<BitunixFundingRateHistoryRaw[]> {
    const symbol = assertPerpSymbol(request.symbol);
    const limit = Math.min(
      BITUNIX_FUNDING_HISTORY_MAX_LIMIT,
      Math.max(1, Math.trunc(request.limit ?? BITUNIX_FUNDING_HISTORY_MAX_LIMIT))
    );
    const query: Record<string, string | number> = { symbol, limit };
    if (Number.isFinite(request.startTime ?? NaN) && (request.startTime as number) > 0) {
      query.startTime = Math.trunc(request.startTime as number);
    }
    if (Number.isFinite(request.endTime ?? NaN) && (request.endTime as number) > 0) {
      query.endTime = Math.trunc(request.endTime as number);
    }
    const res = await this.http.request({ method: "GET", path: BITUNIX_PATHS.fundingRateHistory, query });
    const data = envelopeData<unknown>(res.json);
    return Array.isArray(data) ? (data as BitunixFundingRateHistoryRaw[]) : [];
  }

  async fetchOrderBook(symbol: string, limit: "1" | "5" | "15" | "50" | "max" = "15"): Promise<MarketOrderBook> {
    const data = await this.fetchDepth(symbol, limit);
    const mapLevels = (rows: Array<[number | string, number | string]> | undefined) =>
      (rows ?? [])
        .map(([p, q]) => ({ price: Number(p), qty: Number(q) }))
        .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.qty) && l.price > 0 && l.qty >= 0);
    return {
      symbol,
      bids: mapLevels(data.bids),
      asks: mapLevels(data.asks),
      ts: Date.now(),
    };
  }
}

/**
 * Erlaubtes Format eines venue-nativen Symbols (Log-/URL-Injection-Grenze).
 *
 * Bewusst eng: `BTCUSDT`, `BTC_USDT_250926`, `ETHUSDT.P`. Alles andere wird
 * **vor** dem Request abgelehnt — ein fremdbestimmter String darf weder Query
 * noch Log erreichen.
 */
const PERP_SYMBOL_RE = /^[A-Z0-9][A-Z0-9._-]{0,31}$/;

export function assertPerpSymbol(symbol: string): string {
  const value = String(symbol ?? "").trim().toUpperCase();
  if (!PERP_SYMBOL_RE.test(value)) {
    throw new BitunixApiError("unknown", `Symbol „${safeSnippet(value, 32)}“ ist für Perp-Abfragen nicht zulässig.`);
  }
  return value;
}

export function mapTicker(row: BitunixTickerRaw): MarketTicker {
  const last = num(row.lastPrice) ?? num(row.last) ?? 0;
  return {
    symbol: String(row.symbol ?? "").toUpperCase(),
    price: last,
    source: "bitunix",
    ts: Date.now(),
    markPrice: num(row.markPrice),
    quoteVol: num(row.quoteVol),
    baseVol: num(row.baseVol),
    high: num(row.high),
    low: num(row.low),
  };
}

function mapKline(row: BitunixKlineRaw): MarketCandle | null {
  const time = num(row.time);
  const open = num(row.open);
  const high = num(row.high);
  const low = num(row.low);
  const close = num(row.close);
  const volume = num(row.baseVol) ?? num(row.quoteVol) ?? 0;
  if (time === undefined || open === undefined || high === undefined || low === undefined || close === undefined) {
    return null;
  }
  return { time, open, high, low, close, volume };
}

/** Venue-Intervalle: 1m 5m 15m 30m 1h 2h 4h 6h 8h 12h 1d 3d 1w 1M */
export function mapInterval(tf: string): string {
  const t = tf.trim();
  const aliases: Record<string, string> = {
    "1min": "1m",
    "5min": "5m",
    "15min": "15m",
    "30min": "30m",
    "60min": "1h",
    "1hour": "1h",
  };
  return aliases[t] ?? t;
}

export type { BitunixRuntimeConfig };
