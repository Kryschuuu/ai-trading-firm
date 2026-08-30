/**
 * Adapter-facing market-data contracts for `MarketDataSyncService` (MDSYNC-001).
 *
 * These types are the venue-agnostic boundary between public REST adapters
 * (Bitunix, Binance, Bitfinex, …) and persistence (`InstrumentRegistry`,
 * `HistoricalStore`). They are intentionally independent of private trading
 * APIs — no credentials, no order payloads, no account state.
 *
 * `MarketInstrument` is the universe contract (single source of truth) so a
 * discovered row can be upserted without a second mapping layer.
 *
 * Abweichungen vom Ticket-Entwurf (bewusst, dokumentiert):
 *  - `MarketInstrument` ist der **Registry**-Contract (`src/universe/types.ts`),
 *    nicht eine zweite, parallele Instrumenten-Form. Venue-Metadaten aus dem
 *    Ticket (`minTradeVolume`, `basePrecision`, `quotePrecision`, `maxLeverage`)
 *    haben dort bereits kanonische Pendants (`minQuantity`, `priceStep`,
 *    `quantityStep`, `leverageAvailable`); der Status ist das Registry-Enum
 *    (`active | halted | delisted | preview`). Eine Duplikation des Contracts
 *    würde zwei Wahrheiten über dasselbe Instrument erzeugen.
 *  - `MarketCandle` akzeptiert `time` **oder** `ts` als Zeitstempel (siehe
 *    {@link MarketCandle}); der persistierte Store-Key ist `ts`. Venues
 *    liefern beide Schreibweisen, die Normalisierung liegt an der Adapter-
 *    grenze, nicht in jedem Adapter.
 *  - `SupportedTimeframe` ist die Store-Allowlist (Superset der im Ticket
 *    genannten sieben Periodizitäten) — siehe `MARKET_SYNC_TIMEFRAMES` für die
 *    von Bitunix nachweislich bedienten Intervalle.
 */

import type { SupportedTimeframe as StoreSupportedTimeframe } from "../lib/marketdata/historicalStore";

export type { MarketInstrument } from "../universe/types";

/**
 * Alle Timeframes, die der Store überhaupt akzeptiert (Allowlist aus
 * `HistoricalStore`). Superset der Ticket-Liste `1m, 5m, 15m, 30m, 1h, 4h, 1d`.
 */
export type SupportedTimeframe = StoreSupportedTimeframe;

/**
 * Zeitrahmen, die die Public-Kline-Endpunkte der angebundenen Venues nachweislich
 * bedienen (Venue Capability Matrix, `docs/MARKET_DATA_PIPELINE.md` §10).
 * Nur diese Werte sind für einen Backfill über Bitunix vorgesehen.
 */
export const MARKET_SYNC_TIMEFRAMES: readonly SupportedTimeframe[] = [
  "1m",
  "5m",
  "15m",
  "30m",
  "1h",
  "4h",
  "1d",
] as const;

/** Zeitrahmen, die `syncVenue()` standardmäßig backfüllt (Ticket-Default). */
export const SYNC_TIMEFRAMES = ["5m", "15m", "30m", "1h"] as const;
export type SyncTimeframe = (typeof SYNC_TIMEFRAMES)[number];

/** Default candle page size per instrument × timeframe. */
export const SYNC_CANDLE_LIMIT = 150;

/**
 * Harte Obergrenzen gegen Payload-Bombing (Security).
 *
 * Ein Venue-Response ist fremdbestimmt. Der Sync limitiert deshalb die Anzahl
 * der Elemente, die er aus einem Response übernimmt — ein Antwort-Ring mit
 * 10 Mio. Kerzen darf weder den Prozess aufblähen noch den Store füllen.
 */
export const SYNC_LIMITS = {
  /** Max. Instrumente pro Venue-Lauf (Sicherheits-Cap, Default). */
  maxInstruments: 250,
  /** Max. Kerzen je Response (`getCandles`) — darüber hinaus wird verworfen und gemeldet. */
  maxCandlesPerResponse: 2000,
  /** Max. Orderbook-Levels je Seite, die ausgewertet werden. */
  maxBookLevels: 200,
  /** Max. Symbole in einem `getTickers`-Batch-Filter. */
  maxTickerBatch: 500,
  /** Max. Symbole in einer `symbolAllowlist`. */
  maxAllowlist: 5000,
} as const;

/** Current ticker / 24h stats from a public market-data endpoint. */
export interface MarketTicker {
  symbol: string;
  price: number;
  /** Public feed id, e.g. `"bitunix"`. Never a secret. */
  source: string;
  /** Unix-epoch milliseconds. */
  ts: number;
  markPrice?: number;
  /**
   * Letzter Handelspreis. Alias des venue-neutralen `price` — beide Felder
   * sind zulässig, `price` gewinnt, wenn beide gesetzt sind.
   */
  last?: number | null;
  /** 24h quote-volume — maps to `MarketInstrument.volume24h`. */
  quoteVol?: number | null;
  baseVol?: number | null;
  high?: number;
  low?: number;
}

/**
 * One price level of an order book.
 *
 * `qty` ist der repo-weite Name (`src/contracts/broker.ts` → `OrderBookLevel`)
 * und bleibt Pflicht; `size` (Ticket-Namensraum) ist ein optionaler Alias, den
 * Venue-Mapper beim Mapping auf `qty` abbilden. Für den Spread ist ausschließlich
 * `price` relevant — die Sizes werden im Sync bewusst nicht ausgewertet.
 */
export interface MarketOrderBookLevel {
  price: number;
  qty: number;
  /** Alias von `qty` (Venue-Schreibweise). Nie die einzige Größenquelle. */
  size?: number;
}

/** Public order-book snapshot used only to compute relative spread. */
export interface MarketOrderBook {
  symbol?: string;
  instrumentId?: string;
  bids: MarketOrderBookLevel[];
  asks: MarketOrderBookLevel[];
  ts: number;
}

/**
 * One OHLCV candle as delivered by a venue adapter.
 *
 * `time` (repo-Contract) und `ts` (Ticket-Contract) sind gleichwertige
 * Zeitstempel in Unix-Epoch-Millisekunden; mindestens eines muss gesetzt und
 * eine positive Ganzzahl sein. {@link candleTimeMs} ist der einzige Lesepfad —
 * so normalisiert jede Adapter-Grenze an einer Stelle.
 */
export interface MarketCandle {
  /** Epoch-ms. Alias für `ts`; mindestens eines der beiden Felder ist Pflicht. */
  time?: number;
  /** Epoch-ms. Alias für `time`. */
  ts?: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Liest den Zeitstempel einer Adapter-Kerze (`time` ∪ `ts`). `null` = unbrauchbar. */
export function candleTimeMs(candle: MarketCandle | null | undefined): number | null {
  if (!candle || typeof candle !== "object") return null;
  for (const candidate of [candle.time, candle.ts]) {
    if (typeof candidate === "number" && Number.isInteger(candidate) && candidate > 0) {
      return candidate;
    }
  }
  return null;
}

/** Isolierter, nicht-fataler Fehler, der in `SyncResult.failures` landet. */
export interface SyncError {
  /** Stage that failed. */
  stage: "discovery" | "ticker" | "orderbook" | "candles" | "upsert";
  /** Optional instrument id (`VENUE:SYMBOL`) — never a secret. */
  instrumentId?: string;
  /** Optional venue-native symbol — never a secret. */
  symbol?: string;
  /** Set when `stage === "candles"`. */
  timeframe?: string;
  /** Redacted, truncated human-readable reason. */
  message: string;
  /** Klassifizierte Ursachen-Taxonomie (MDERR-006) — bleibt auch bei entfernten Fehlerobjekten maschinenlesbar. */
  reason?: import("../lib/marketDataErrors").MarketDataErrorReason;
  /** Ob ein Retry sinnvoll wäre (429/5xx/Timeout/Netzwerk). */
  retryable?: boolean;
  /** Original-HTTP-Status, falls vorhanden (z. B. 429, 503). */
  httpStatus?: number;
}

/** Ticket-Kontrakt: `failures: Array<{ stage, symbol?, reason }>`. */
export type SyncFailure = SyncError;

/** Backfill-Statistik eines Timeframes (Ticket: `candlesByTimeframe`). */
export interface TimeframeSyncStats {
  /** Instrumente, in deren Reihe Bars geschrieben wurden. */
  instruments: number;
  /** Effektiv geschriebene (deduplizierte) Bars. */
  bars: number;
}

/**
 * Aggregated outcome of `MarketDataSyncService.syncVenue()`.
 *
 * Vollständig JSON-serialisierbar ( roundtrip-getestet) — der CLI schreibt die
 * Struktur als `--json`-Ausgabe, das Operations-Center liest Zähler.
 * Geloggt werden nur Zähler — niemals Symbole oder Payloads.
 */
export interface SyncResult {
  /** Venue-Key, wie aufgelöst (Großbuchstaben, sanitisiert). */
  venue: string;
  /** ISO-8601 UTC zu Beginn des Laufs. */
  startedAt: string;
  /** ISO-8601 UTC am Ende des Laufs. */
  finishedAt: string;
  /** Von `discoverInstruments()` gelieferte Instrumente (vor Filter/Kappung). */
  discovered: number;
  /** Nach Allowlist + `maxInstruments` tatsächlich synchronisierte Instrumente. */
  synced: number;
  /** Durch Allowlist/Kappung verworfene Instrumente. */
  skipped: number;
  /** Instrumente mit verwertetem Ticker (`volume24h` gesetzt). */
  tickersEnriched: number;
  /** Instrumente mit verwertetem Orderbook (Spread berechnet oder bewusst `null`). */
  orderbooksEnriched: number;
  /** Instrumente, deren Spread `null` blieb (Data-Quality, kein Fachablehnung). */
  spreadsUnknown: number;
  /** Vom Universe-Policy-Ausschluss abgelehnte Sätze (fachlich, kein Datenfehler). */
  policyExcluded: number;
  /** Bars/Instrumente je Timeframe. */
  candlesByTimeframe: Partial<Record<SupportedTimeframe, TimeframeSyncStats>>;
  /** Isolierte Fehler; leer bei sauberem Lauf. */
  failures: SyncFailure[];
  /** `true`, wenn `failures.length > 0`, der Lauf aber fortgesetzt wurde. */
  degraded: boolean;
  /** Laufzeit in ms (Betriebs-Diagnose; kein Fachwert). */
  durationMs: number;
}

/** Optional token-bucket (or any serial limiter) used by the orchestrator. */
export interface RateLimiter {
  take(): Promise<void>;
}
