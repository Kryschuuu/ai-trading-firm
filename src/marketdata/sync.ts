/**
 * MarketDataSyncService — single orchestration point for
 * Discovery → Ticker-Enrichment → Orderbook-Enrichment → Candle-Backfill
 * → Registry / HistoricalStore persistence.
 *
 * Network I/O lives HERE, not in the scanner. `scanUniverse()` remains a
 * pure function over already-persisted local data.
 *
 * Request-Budget pro Venue-Lauf (Bitunix: 10 req/s/IP, HTTP-Layer drosselt auf
 * 8 req/s — das Budget ist darauf ausgelegt, nie über einen einzelnen Lauf
 * hinaus zu wachsen):
 *
 *   1 × trading_pairs      Discovery
 *   1 × tickers   (bulk)   24h-Volumen für ALLE Instrumente in einem Request
 *   N × depth              Bid/Ask je Instrument (Ticker-API hat keinen Spread)
 *   N × M × kline          M = Anzahl Timeframes
 *
 * Ein `getTicker(symbol)` pro Instrument wäre N+1 Requests und wird deshalb
 * nur als Lücken-Fallback genutzt (Venues ohne Bulk-Endpoint, Batch-Antworten
 * ohne Treffer).
 */

import {
  isSupportedTimeframe,
  type CandleSeriesGroup,
  type HistoricalStore,
  type SupportedTimeframe,
} from "../lib/marketdata/historicalStore";
import type { MarketCandle as StoreCandle } from "../lib/marketdata/types";
import { classifyMarketDataError } from "../lib/marketDataErrors";
import { loadScannerConfig } from "../scanner/config";
import { requiredWarmupCandles } from "../scanner/warmup";
import { toInstrumentId } from "../universe/normalization";
import type { InstrumentRegistry } from "../universe/registry";
import {
  InsufficientCandleLimitError,
  normalizeSyncSymbol,
  sanitizeSyncErrorMessage,
  sanitizeVenue,
  SyncPartialFailureError,
  UnsupportedVenueError,
} from "./errors";
import { calculateRelativeSpread } from "./spread";
import {
  candleTimeMs,
  SYNC_CANDLE_LIMIT,
  SYNC_LIMITS,
  SYNC_TIMEFRAMES,
  type MarketCandle,
  type MarketInstrument,
  type MarketOrderBook,
  type MarketOrderBookLevel,
  type MarketTicker,
  type RateLimiter,
  type SyncError,
  type SyncFailure,
  type SyncResult,
  type SyncTimeframe,
  type TimeframeSyncStats,
} from "./types";

/**
 * Venue-agnostic public market-data port.
 *
 * Jede Venue (Bitunix, Binance, Bitfinex, …) implementiert dieses Interface,
 * um Austauschbarkeit zu gewährleisten. Implementierungen dürfen ausschließlich
 * **öffentliche** Market-Data-Endpunkte verwenden — niemals PrivateClient,
 * API-Keys oder Live-Order-Pfade.
 *
 * `getTickers` (bulk) ist das bevorzugte Enrichment: ein Request für das
 * 24h-Volumen aller Instrumente. Es ist optional, damit eine Venue ohne
 * Batch-Endpoint den Port trotzdem erfüllen kann — der Service fällt dann auf
 * per-Symbol `getTicker` zurück (und dokumentiert das im Sync-Ergebnis).
 */
export interface MarketDataAdapter {
  /** Venue-Key des Adapters (optional; der Service nutzt den Registry-Key). */
  readonly venue?: string;
  discoverInstruments(): Promise<MarketInstrument[]>;
  getTicker(symbol: string): Promise<MarketTicker>;
  /** BULK, nicht pro Symbol: ein Request für alle angefragten Symbole. */
  getTickers?(symbols?: string[]): Promise<MarketTicker[]>;
  getOrderBook(symbol: string): Promise<MarketOrderBook>;
  getCandles(symbol: string, timeframe: SupportedTimeframe, limit: number): Promise<MarketCandle[]>;
}

/** Minimales Logger-Contract des Syncs: eine fertig formatierte, leak-freie Zeile. */
export type SyncLogger = (level: "info" | "warn" | "error", line: string) => void;

/** Default-Senke: `console` (CLI/Betrieb). Strukturierte Events laufen separat über `structuredLog`. */
export const defaultSyncLogger: SyncLogger = (level, line) => {
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
};

/** Harte, nicht konfigurierbare Deckel (Security: kein Massen-Fetching). */
export const MAX_INSTRUMENTS_CEILING = 1_000;
export const MAX_CANDLE_LIMIT = 2_000;
export const MIN_CONCURRENCY = 1;
/** Ticket-Vorgabe: Concurrency hart auf ≤ 8 begrenzt (Token-Bucket bleibt autoritativ). */
export const MAX_CONCURRENCY = 8;
/** Max. Zeilen, die aus einem Discovery-/Ticker-Response übernommen werden. */
const MAX_RESPONSE_ROWS = 10_000;

/**
 * Optionen eines Sync-Laufs. Alle Felder sind auch pro `syncVenue()`-Aufruf
 * überschreibbar; die Defaults stammen aus dem Ticket (MDSYNC-001 §3.3).
 */
export interface SyncOptions {
  /** Zu backfillende Periodizitäten. Default: `["5m","15m","30m","1h"]`. */
  timeframes: readonly SupportedTimeframe[];
  /**
   * Anzahl je Timeframe zu ladender Kerzen. Default:
   * `max(150, requiredWarmupCandles(config))`. Muss ≥ dem abgeleiteten
   * Warmup-Bedarf sein, sonst bleibt der Scanner im Zustand `WARMING`.
   */
  candleLimit: number;
  /** Sicherheits-Cap der synchronisierten Instrumente je Venue. Default 250. */
  maxInstruments: number;
  /** Wenn gesetzt: nur diese Symbole synchronisieren (venue-nativ, Großbuchstaben). */
  symbolAllowlist?: readonly string[];
  /** Parallelität der Instrumenten-Bearbeitung. Default 4, hart begrenzt auf ≤ 8. */
  concurrency: number;
  /** `true` (Default): Einzelfehler degradieren, der Lauf läuft weiter. */
  continueOnError: boolean;
  /** Injizierbare Uhr (Determinismus in Tests). */
  clock?: () => Date;
  /** Alias von `clock` (bestehende Aufrufer). */
  now?: () => Date;
  /** Globaler Token-Bucket; der Bitunix-HTTP-Layer hat einen eigenen (8 req/s). */
  rateLimiter?: RateLimiter;
  /** Injizierbarer Warmup-Bedarf; Default: `requiredWarmupCandles(loadScannerConfig())`. */
  requiredWarmupCandles?: number;
  /** Senke für die strukturierten `[market-sync]`-Zeilen. */
  logger?: SyncLogger;
  /** `true` ⇒ Abbruch beim ersten Fehler (Alias von `continueOnError: false`). */
  strict?: boolean;
}

/** Vollständige, validierte Optionen nach Auflösung der Defaults. */
export interface ResolvedSyncOptions {
  readonly timeframes: readonly SupportedTimeframe[];
  readonly candleLimit: number;
  readonly maxInstruments: number;
  readonly symbolAllowlist: readonly string[] | null;
  readonly concurrency: number;
  readonly continueOnError: boolean;
  /** Abgeleiteter Warmup-Bedarf, gegen den `candleLimit` validiert wird. */
  readonly requiredWarmup: number;
}

/** Kompatibilitätsname älterer Aufrufer (identische Struktur). */
export type MarketDataSyncOptions = Partial<SyncOptions>;

/** Ein Instrumenten-Ergebnis — pro Instrument gesammelt, deterministisch aggregiert. */
interface InstrumentOutcome {
  failures: SyncFailure[];
  /** Kanonische ID (`VENUE:SYMBOL`) — identisch zum Registry-Schlüssel. */
  instrumentId: string;
  tickerEnriched: boolean;
  orderbookEnriched: boolean;
  spreadUnknown: boolean;
  /** Vom Universe-Policy-Ausschluss betroffene Sätze (fachlich, kein Datenfehler). */
  policyExcluded: number;
  /**
   * Geprüfte, aber noch NICHT geschriebene Bars je Timeframe. Der Sync puffert
   * sie und ruft {@link HistoricalStore.appendSeries} einmal pro Lauf auf —
   * ein Append je Instrument × Timeframe würde die NDJSON-Datei N×M mal
   * komplett atomar umschreiben (O(n²) I/O).
   */
  candlesByTimeframe: Map<SupportedTimeframe, StoreCandle[]>;
}

/**
 * Liefert den abgeleiteten Warmup-Bedarf. Bewusst **nicht** hartcodiert:
 * eine erhöhte Faktor-Periode erhöht automatisch die verlangte Kerzenzahl.
 */
export function defaultRequiredWarmupCandles(): number {
  return requiredWarmupCandles(loadScannerConfig());
}

/**
 * Validiert und normalisiert Sync-Optionen. Wirft bei Konfigurationsfehlern —
 * ein falscher Timeframe oder ein zu kleines Limit ist ein Bedienfehler, kein
 * Laufzeitzustand, den man verschlucken dürfte.
 */
export function resolveSyncOptions(
  input: Partial<SyncOptions> = {},
  requiredWarmup: number = defaultRequiredWarmupCandles()
): ResolvedSyncOptions {
  const timeframes = (input.timeframes ?? SYNC_TIMEFRAMES) as readonly string[];
  if (timeframes.length === 0) {
    throw new Error("SyncOptions.timeframes darf nicht leer sein — ein leerer Backfill wäre still ein Erfolg ohne Daten.");
  }
  const seen = new Set<string>();
  for (const tf of timeframes) {
    if (!isSupportedTimeframe(tf)) {
      throw new Error(
        `SyncOptions.timeframes: "${String(tf)}" ist nicht in der Allowlist ` +
          `(1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 1d, 5d). Ein ungültiger Timeframe würde Reihen mischen.`,
      );
    }
    if (seen.has(tf)) {
      throw new Error(
        `SyncOptions.timeframes: "${tf}" ist doppelt enthalten — das würde Bars und Instrumente doppelt zählen.`
      );
    }
    seen.add(tf);
  }

  const candleLimit = input.candleLimit ?? Math.max(SYNC_CANDLE_LIMIT, requiredWarmup);
  if (!Number.isInteger(candleLimit) || candleLimit <= 0) {
    throw new Error(`SyncOptions.candleLimit muss eine positive Ganzzahl sein (war ${String(input.candleLimit)}).`);
  }
  if (candleLimit > MAX_CANDLE_LIMIT) {
    throw new Error(
      `SyncOptions.candleLimit=${candleLimit} übersteigt die harte Obergrenze ${MAX_CANDLE_LIMIT} ` +
        `(Payload-/Speicher-Schutz). Reduziere das Limit.`
    );
  }
  if (candleLimit < requiredWarmup) {
    throw new InsufficientCandleLimitError(candleLimit, requiredWarmup, {
      momentumLookback: momentumLookbackFor(requiredWarmup),
    });
  }

  const requestedMax = input.maxInstruments ?? SYNC_LIMITS.maxInstruments;
  if (!Number.isInteger(requestedMax) || requestedMax <= 0) {
    throw new Error(`SyncOptions.maxInstruments muss eine positive Ganzzahl sein (war ${String(input.maxInstruments)}).`);
  }
  const maxInstruments = Math.min(requestedMax, MAX_INSTRUMENTS_CEILING);

  let allowlist: readonly string[] | null = null;
  if (input.symbolAllowlist !== undefined) {
    if (input.symbolAllowlist.length > SYNC_LIMITS.maxAllowlist) {
      throw new Error(
        `SyncOptions.symbolAllowlist: ${input.symbolAllowlist.length} Einträge über der Obergrenze ${SYNC_LIMITS.maxAllowlist}.`
      );
    }
    const normalized: string[] = [];
    for (const raw of input.symbolAllowlist) {
      const value = normalizeSyncSymbol(raw);
      if (!value) {
        throw new Error(
          `SyncOptions.symbolAllowlist: "${String(raw).slice(0, 40)}" verletzt die Symbol-Allowlist ` +
            `(erlaubt sind Großbuchstaben, Ziffern und /. - = _ in begrenzter Anzahl).`
        );
      }
      if (!normalized.includes(value)) normalized.push(value);
    }
    allowlist = normalized;
  }

  const concurrency = Math.min(
    MAX_CONCURRENCY,
    Math.max(MIN_CONCURRENCY, Math.floor(input.concurrency ?? 4) || MIN_CONCURRENCY)
  );

  const continueOnError = input.strict === true ? false : (input.continueOnError ?? true);

  return {
    timeframes: timeframes as readonly SupportedTimeframe[],
    candleLimit,
    maxInstruments,
    symbolAllowlist: allowlist,
    concurrency,
    continueOnError,
    requiredWarmup,
  };
}

/** Rekonstruiert den dominanten Lookback aus dem Warmup-Bedarf (nur für die Meldung). */
function momentumLookbackFor(requiredWarmup: number): number | undefined {
  const value = requiredWarmup - 1;
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * Deterministische Auswahl-Reihenfolge vor der Kappung:
 * 24h-Volumen absteigend (die liquidesten Märkte bleiben), bei Gleichstand oder
 * fehlenden Tickern alphabetisch nach Symbol. Nie Ankunftsreihenfolge des
 * Venues — die ist nicht stabil und würde bei zwei Läufen verschiedene
 * Teilmengen behalten.
 */
export function rankInstruments(
  instruments: readonly MarketInstrument[],
  tickerBySymbol: ReadonlyMap<string, MarketTicker>
): MarketInstrument[] {
  const volumeOf = (instrument: MarketInstrument): number | null => {
    const key = normalizeSyncSymbol(instrument.symbol);
    const quoteVol = key ? tickerBySymbol.get(key)?.quoteVol : undefined;
    return typeof quoteVol === "number" && Number.isFinite(quoteVol) ? quoteVol : null;
  };
  return [...instruments].sort((a, b) => {
    const va = volumeOf(a);
    const vb = volumeOf(b);
    if (va !== null && vb !== null && va !== vb) return vb - va;
    if (va === null && vb !== null) return 1;
    if (va !== null && vb === null) return -1;
    const sa = normalizeSyncSymbol(a.symbol) ?? a.symbol;
    const sb = normalizeSyncSymbol(b.symbol) ?? b.symbol;
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  });
}

/**
 * Kleiner, allocationsarmer Concurrency-Pool (p-limit-artig) mit
 * Ergebnis-Reihenfolge nach Eingabeindex. Kein Array-`Promise.all` über alle
 * Instrumente: das würde N×M Requests gleichzeitig in den Token-Bucket legen.
 */
async function runPool<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  aborted: () => boolean
): Promise<(R | undefined)[]> {
  const results = new Array<R | undefined>(items.length);
  let cursor = 0;
  const lanes = Math.max(1, Math.min(limit, items.length));
  const runners = Array.from({ length: lanes }, async () => {
    for (;;) {
      if (aborted()) return;
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

export class MarketDataSyncService {
  private readonly clock: () => Date;
  private readonly rateLimiter?: RateLimiter;
  private readonly logger: SyncLogger;
  private readonly options: ResolvedSyncOptions;

  constructor(
    private readonly registry: InstrumentRegistry,
    private readonly history: HistoricalStore,
    private readonly adapters: Map<string, MarketDataAdapter>,
    options: Partial<SyncOptions> = {},
  ) {
    this.clock = options.clock ?? options.now ?? (() => new Date());
    this.rateLimiter = options.rateLimiter;
    this.logger = options.logger ?? defaultSyncLogger;
    this.options = resolveSyncOptions(options, options.requiredWarmupCandles ?? defaultRequiredWarmupCandles());
    if (
      options.maxInstruments !== undefined &&
      Number.isInteger(options.maxInstruments) &&
      options.maxInstruments > MAX_INSTRUMENTS_CEILING
    ) {
      this.logger(
        "warn",
        `[market-sync] maxInstruments=${options.maxInstruments} begrenzt auf ${MAX_INSTRUMENTS_CEILING} (harte Obergrenze).`
      );
    }
  }

  /** Aufgelöste, validierte Optionen der Instanz (Diagnose, CLI-Output, Tests). */
  get resolvedOptions(): ResolvedSyncOptions {
    return this.options;
  }

  /**
   * Discovery → Enrichment → Backfill → Persistenz für eine Venue.
   *
   * Warum Tickers **bulk** und Depth **pro Symbol**: die Bitunix-Ticker-API
   * liefert das 24h-Volumen für alle Symbole in einem Request, aber **kein**
   * Bid/Ask — der Spread muss aus `/depth` berechnet werden und ist dort pro
   * Symbol gefragt. Ein per-Symbol-Ticker wäre dagegen N Requests für Daten,
   * die ein einziger Request liefert, und würde das 8-req/s-Budget
   * unnötig verbrauchen. Deshalb: 1 × tickers, N × depth, N × M × kline.
   *
   * @param venue Venue-Key (case-insensitive), z. B. `"BITUNIX"`.
   * @param options Pro-Lauf-Überschreibungen der Instanz-Optionen.
   * @throws {UnsupportedVenueError} wenn kein Adapter registriert ist.
   * @throws {SyncPartialFailureError} bei `continueOnError: false` und Fehlern.
   */
  async syncVenue(venue: string, options: Partial<SyncOptions> = {}): Promise<SyncResult> {
    const startedAtMs = performance.now();
    const opts = Object.keys(options).length
      ? resolveSyncOptions(
          { ...this.instanceDefaults(), ...options },
          options.requiredWarmupCandles ?? this.options.requiredWarmup
        )
      : this.options;
    const key = sanitizeVenue(venue).toUpperCase();
    const adapter = this.adapters.get(key) ?? this.adapters.get(venue);
    if (!adapter) throw new UnsupportedVenueError(venue);

    const startedAt = this.clock().toISOString();
    const failures: SyncFailure[] = [];
    const runState = { aborted: false };
    const abort = () => runState.aborted;

    // ── 1. Discovery (1 Request) ────────────────────────────────────────────
    await this.limit();
    let discovered: MarketInstrument[] = [];
    try {
      const raw = await adapter.discoverInstruments();
      discovered = Array.isArray(raw) ? raw : [];
    } catch (e) {
      failures.push(this.toFailure("discovery", e));
      // Ohne Instrumente gibt es nichts anzureichern: der Lauf endet hier
      // kontrolliert (degraded), statt einen leeren Trichter vorzutäuschen.
      const zeroBars = new Map<SupportedTimeframe, number>();
      const zeroInstruments = new Map<SupportedTimeframe, number>();
      for (const tf of opts.timeframes) {
        zeroBars.set(tf, 0);
        zeroInstruments.set(tf, 0);
      }
      return this.finalize(key, startedAt, startedAtMs, opts, {
        discovered: 0,
        synced: 0,
        skipped: 0,
        tickersEnriched: 0,
        orderbooksEnriched: 0,
        spreadsUnknown: 0,
        policyExcluded: 0,
        barsByTimeframe: zeroBars,
        instrumentsWithBars: zeroInstruments,
        failures,
      });
    }

    // ── 2. Validierung, Dedup, Allowlist ───────────────────────────────────
    const usable: MarketInstrument[] = [];
    const seenIds = new Set<string>();
    /** Unbrauchbare/duplizierte Discovery-Zeilen (nicht: Allowlist-Filters). */
    let unusableRows = 0;
    const allowlist = opts.symbolAllowlist ? new Set(opts.symbolAllowlist) : null;
    const discoveryRows = Math.min(discovered.length, MAX_RESPONSE_ROWS);
    if (discovered.length > MAX_RESPONSE_ROWS) {
      failures.push({
        stage: "discovery",
        message: `Discovery-Response gekappt: ${discovered.length} > ${MAX_RESPONSE_ROWS} Zeilen (Payload-Schutz).`,
        reason: "SCHEMA_MISMATCH",
        retryable: false,
      });
    }
    for (let i = 0; i < discoveryRows; i++) {
      const instrument = discovered[i];
      const symbol = normalizeSyncSymbol(instrument?.symbol);
      if (!instrument || !symbol) {
        unusableRows += 1;
        failures.push({
          stage: "discovery",
          message: `Discovery-Zeile ${i} ohne gültiges Symbol verworfen (Symbol-Allowlist).`,
          reason: "INVALID_SYMBOL",
          retryable: false,
        });
        continue;
      }
      let id: string;
      try {
        // Der Key wird exakt so gebildet wie in der Registry
        // (`normalizeInstrument` ignoriert ein mitgeliefertes `id` und leitet
        //  `VENUE:SYMBOL` ab). Nur wenn HistoricalStore und Registry denselben
        //  Schlüssel verwenden, findet der Scanner die Kerzen wieder — eine
        //  abweichende ID wäre genau der Fehler, den dieser Task behebt.
        id = toInstrumentId(key, symbol);
      } catch {
        unusableRows += 1;
        failures.push({
          stage: "discovery",
          symbol,
          message: `Discovery-Zeile ${i} abgelehnt: Instrument-ID für "${key}:${symbol}" ist nicht bildbar.`,
          reason: "INVALID_SYMBOL",
          retryable: false,
        });
        continue;
      }
      if (seenIds.has(id)) {
        unusableRows += 1; // Duplikate der Venue: erste Zeile gewinnt.
        continue;
      }
      seenIds.add(id);
      if (allowlist && !allowlist.has(symbol)) continue;
      usable.push({ ...instrument, symbol, id, venue: key });
    }

    // ── 3. Tickers: EIN bulk-Request für alle Symbole ───────────────────────
    const tickerBySymbol = await this.loadTickers(adapter, usable, opts, failures);

    // ── 4. Deterministische Kappung (nach Tickern: die liquidesten bleiben) ─
    const ranked = rankInstruments(usable, tickerBySymbol);
    const selected = ranked.slice(0, opts.maxInstruments);
    // `skipped` sind ALLE Discovery-Zeilen, die nicht synchronisiert wurden —
    // ungültige, duplizierte, allowlist- und kappungsbedingte. So gilt immer
    // `discovered = synced + skipped`, und ein Betreiber sieht verlorene Zeilen.
    const skipped = Math.max(0, discovered.length - selected.length);

    // Frühe, ZÄHLERNEUTRALE Warnung nur, wenn Zeilen verloren gingen — die
    // `discovery:`-Zeile selbst gehört in den Abschluss-Block (formatSyncLog),
    // sonst stünde sie doppelt im Log und die Zähler wären nicht deckbar.
    if (unusableRows > 0) {
      this.logger(
        "warn",
        `[market-sync] ${key}: ${unusableRows} Discovery-Zeile(n) unbrauchbar oder dupliziert — nicht synchronisiert.`
      );
    }

    // ── 5.–6. Enrichment + Backfill je Instrument (concurrency-begrenzt) ────
    const barsByTimeframe = new Map<SupportedTimeframe, number>();
    const instrumentsWithBars = new Map<SupportedTimeframe, number>();
    for (const tf of opts.timeframes) {
      barsByTimeframe.set(tf, 0);
      instrumentsWithBars.set(tf, 0);
    }

    let tickersEnriched = 0;
    let orderbooksEnriched = 0;
    let spreadsUnknown = 0;
    let policyExcluded = 0;
    const groups: CandleSeriesGroup[] = [];
    const owners: { instrumentId: string; timeframe: SupportedTimeframe }[] = [];

    const outcomes = await runPool<MarketInstrument, InstrumentOutcome>(
      selected,
      opts.concurrency,
      async (instrument) => {
        const outcome = await this.syncInstrument(key, adapter, instrument, tickerBySymbol, opts, abort);
        // Strict-Modus: der erste Fehler stoppt die verbleibenden Instrumente;
        // laufende Tasks werden abgewartet, damit kein halbfertiger Zustand
        // als „fertig“ interpretiert wird.
        if (!opts.continueOnError && outcome.failures.length > 0) runState.aborted = true;
        return outcome;
      },
      abort
    );

    // Aggregation in Auswahl-Reihenfolge ⇒ deterministische failure-Reihenfolge,
    // unabhängig davon, welche Lane zuerst fertig wurde.
    for (const outcome of outcomes) {
      if (!outcome) continue; // Lane wegen Abbruch nie gestartet.
      for (const failure of outcome.failures) failures.push(failure);
      if (outcome.tickerEnriched) tickersEnriched += 1;
      if (outcome.orderbookEnriched) orderbooksEnriched += 1;
      if (outcome.spreadUnknown) spreadsUnknown += 1;
      policyExcluded += outcome.policyExcluded;
      for (const [timeframe, candles] of outcome.candlesByTimeframe) {
        groups.push({
          candles,
          instrumentId: outcome.instrumentId,
          provenance: { venue: key, feed: `${key}:rest` },
          timeframe,
        });
        owners.push({ instrumentId: outcome.instrumentId, timeframe });
      }
    }

    this.persistBars(groups, owners, failures, barsByTimeframe, instrumentsWithBars);

    if (!opts.continueOnError && failures.length > 0) runState.aborted = true;

    return this.finalize(
      key,
      startedAt,
      startedAtMs,
      opts,
      {
        discovered: discovered.length,
        synced: selected.length,
        skipped,
        tickersEnriched,
        orderbooksEnriched,
        spreadsUnknown,
        policyExcluded,
        barsByTimeframe,
        instrumentsWithBars,
        failures,
      }
    );
  }

  /**
   * Ergebnis bauen, loggen und bei `continueOnError: false` abbrechen.
   *
   * Bewusst EIN Abschlusspfad für beide Ausgänge von `syncVenue()`
   * (Discovery-Ausfall wie Regel-Lauf): ein Lauf, der Fehler aufgezeichnet
   * hat, muss in beiden Modi gleich behandelt werden — sonst exitiert ein
   * Strict-Lauf bei Discovery-Problemen mit 0, obwohl nichts synchronisiert
   * wurde.
   */
  private finalize(
    key: string,
    startedAt: string,
    startedAtMs: number,
    opts: ResolvedSyncOptions,
    stats: Parameters<MarketDataSyncService["finish"]>[3]
  ): SyncResult {
    const result = this.finish(key, startedAt, startedAtMs, stats);
    for (const line of formatSyncLog(result, opts)) this.logger("info", line);
    const degradedLine = formatDegradedLog(result);
    if (degradedLine) this.logger("warn", degradedLine);
    if (!opts.continueOnError && result.failures.length > 0) {
      throw new SyncPartialFailureError(key, result.failures);
    }
    return result;
  }

  /**
   * Sync für alle registrierten Venues. Venues laufen sequentiell: der
   * Rate-Limit-Budget ist pro IP gemeinsam, parallele Venue-Läufe würden
   * denselben Bucket verdoppeln.
   */
  async syncAll(options: Partial<SyncOptions> = {}): Promise<SyncResult[]> {
    const venues = [...this.adapters.keys()].sort();
    const out: SyncResult[] = [];
    for (const venue of venues) out.push(await this.syncVenue(venue, options));
    return out;
  }

  /**
   * Enrichment + Backfill EINES Instruments. Fehler werden gesammelt und
   * isoliert — ein Ausfall eines Symbols darf den Lauf nicht beenden, außer
   * `continueOnError: false`.
   *
   * Reihenfolge (fix, getestet): `depth → upsert → kline`. Der Upsert liegt
   * vor dem Candle-Backfill, damit die Registry pro Instrument genau EINEN
   * Satz aus Discovery + Ticker + Orderbook erhält — nie einen Zwischenstand
   * mit `spread: null` aus der Discovery.
   */
  private async syncInstrument(
    venueKey: string,
    adapter: MarketDataAdapter,
    instrument: MarketInstrument,
    tickerBySymbol: Map<string, MarketTicker>,
    opts: ResolvedSyncOptions,
    aborted: () => boolean
  ): Promise<InstrumentOutcome> {
    const failures: SyncFailure[] = [];
    const symbol = instrument.symbol;
    const instrumentId = instrument.id;
    const outcome: InstrumentOutcome = {
      failures,
      instrumentId,
      tickerEnriched: false,
      orderbookEnriched: false,
      spreadUnknown: true,
      policyExcluded: 0,
      candlesByTimeframe: new Map(),
    };
    if (aborted()) return outcome;

    // 1) Ticker: Bulk-Treffer, sonst Lücken-Fallback pro Symbol.
    let ticker: MarketTicker | undefined = tickerBySymbol.get(symbol);
    if (!ticker) {
      try {
        await this.limit();
        const fetched = await adapter.getTicker(symbol);
        const fetchedSymbol = normalizeSyncSymbol(fetched?.symbol);
        if (fetchedSymbol) tickerBySymbol.set(fetchedSymbol, fetched);
        // Symbol-Guard: Ein Venue-Client kann auf eine fremde Zeile
        // zurückfallen, wenn das angefragte Symbol fehlt (Batch-Antwort ohne
        // Treffer). Dessen `quoteVol` einem anderen Instrument zuzuschreiben
        // wäre schlimmer als „unbekannt“ — deshalb nur bei exakter Überein-
        // stimmung übernehmen.
        if (fetchedSymbol === symbol) {
          ticker = fetched;
        } else {
          failures.push({
            stage: "ticker",
            instrumentId,
            symbol,
            // Zwei Fälle, eine Konsequenz: kein verwertbarer Ticker.
            // „kein Ticker“ = Venue listet das Symbol nicht (z. B. illiquide);
            // „fremdes Symbol“ = die Antwort gehört zu einem anderen Instrument.
            message:
              fetchedSymbol === undefined
                ? "Kein Ticker für das Symbol verfügbar — volume24h bleibt unbekannt"
                : "Ticker-Antwort enthält ein anderes Symbol — volume24h bleibt unbekannt",
          });
        }
      } catch (e) {
        failures.push(this.toFailure("ticker", e, { instrumentId, symbol }));
      }
    }
    if (ticker) outcome.tickerEnriched = true;

    // 2) Orderbook → Spread.
    let spread: number | null = null;
    try {
      await this.limit();
      const book = await adapter.getOrderBook(symbol);
      // Ticker-API liefert KEINEN Spread — er entsteht hier aus dem
      // Orderbook-Snapshot (`/depth`). `null` = „nicht geladen/ungültig“
      // (Data-Quality) und wird bewusst NICHT auf 0 gemappt: 0 bp wäre
      // fachlich verdächtig und würde den `max-spread`-Filter täuschen.
      spread = calculateRelativeSpread(bestPrice(book?.bids), bestPrice(book?.asks));
      outcome.orderbookEnriched = true;
      outcome.spreadUnknown = spread === null;
    } catch (e) {
      failures.push(this.toFailure("orderbook", e, { instrumentId, symbol }));
    }

    // 3) Upsert in die Registry (quelle: `sync:<VENUE>`).
    try {
      const upserted = this.registry.upsert(
        {
          ...instrument,
          venue: venueKey,
          symbol,
          volume24h: finiteOrNull(ticker?.quoteVol ?? ticker?.last ?? null),
          spread,
          lastSeen: this.clock().toISOString(),
        },
        `sync:${venueKey}`,
      );
      // Die Registry lehnt Zeilen einzeln ab (Policy/Validierung), ohne zu
      // werfen. Eine Policy-Ablehnung ist ein fachlicher Ausschluss (z. B.
      // delistete Märkte) und darf den Lauf nicht degradieren; ein
      // Validierungsfehler ist dagegen ein Datenfehler des Adapters.
      for (const rejected of upserted.rejected ?? []) {
        if (rejected.code === "POLICY_EXCLUDED") {
          outcome.policyExcluded += 1;
          continue;
        }
        failures.push({
          stage: "upsert",
          instrumentId,
          symbol,
          message: `Registry-Ablehnung (${String(rejected.code).slice(0, 32)}): ${sanitizeSyncErrorMessage(rejected.message)}`,
          reason: "SCHEMA_MISMATCH",
          retryable: false,
        });
      }
    } catch (e) {
      failures.push(this.toFailure("upsert", e, { instrumentId, symbol }));
    }

    // 4) Candle-Backfill je Timeframe: laden, prüfen, puffern. Geschrieben
    //    wird anschließend EINMAL pro Lauf (siehe persistBars()).
    for (const timeframe of opts.timeframes) {
      if (aborted()) break;
      try {
        await this.limit();
        const candles = await adapter.getCandles(symbol, timeframe, opts.candleLimit);
        const rows = normalizeCandles(candles, timeframe, failures, { instrumentId, symbol });
        if (rows.length === 0) continue;
        outcome.candlesByTimeframe.set(timeframe, rows);
      } catch (e) {
        failures.push(this.toFailure("candles", e, { instrumentId, symbol, timeframe }));
      }
    }

    return outcome;
  }

  /**
   * 1 × tickers (batch), wenn der Adapter sie unterstützt. Ein Fehler im
   * Bulk-Call ist kein Abbruch: der per-Symbol-Fallback im Instrumentenlauf
   * holt die Lücken nach (und degradiert den Lauf sichtbar).
   */
  private async loadTickers(
    adapter: MarketDataAdapter,
    instruments: readonly MarketInstrument[],
    opts: ResolvedSyncOptions,
    failures: SyncFailure[]
  ): Promise<Map<string, MarketTicker>> {
    const out = new Map<string, MarketTicker>();
    if (!adapter.getTickers || instruments.length === 0) return out;
    try {
      await this.limit();
      const symbols = instruments.map((i) => i.symbol).slice(0, SYNC_LIMITS.maxTickerBatch);
      const batch = await adapter.getTickers(symbols);
      const rows = Array.isArray(batch) ? batch : [];
      if (rows.length > MAX_RESPONSE_ROWS) {
        failures.push({
          stage: "ticker",
          message: `Ticker-Response gekappt: ${rows.length} > ${MAX_RESPONSE_ROWS} Zeilen (Payload-Schutz).`,
          reason: "SCHEMA_MISMATCH",
          retryable: false,
        });
      }
      for (let i = 0; i < Math.min(rows.length, MAX_RESPONSE_ROWS); i++) {
        const t = rows[i];
        const symbol = normalizeSyncSymbol(t?.symbol);
        if (!symbol) continue;
        if (!out.has(symbol)) out.set(symbol, t);
      }
    } catch (e) {
      failures.push(this.toFailure("ticker", e));
    }
    return out;
  }

  /**
   * EIN atomarer Schreibvorgang für alle gepufferten Reihen.
   *
   * Scheitert der Store (z. B. Platte voll), wird das pro Reihe als
   * Candle-Fehler verbucht — die Registry-Enrichment-Ergebnisse bleiben
   * bestehen, weil Upsert und Backfill getrennte Stages sind.
   */
  private persistBars(
    groups: CandleSeriesGroup[],
    owners: { instrumentId: string; timeframe: SupportedTimeframe }[],
    failures: SyncFailure[],
    barsByTimeframe: Map<SupportedTimeframe, number>,
    instrumentsWithBars: Map<SupportedTimeframe, number>
  ): void {
    if (groups.length === 0) return;
    let batch;
    try {
      batch = this.history.appendSeries(groups, this.clock());
    } catch (e) {
      for (const owner of owners) {
        failures.push(this.toFailure("candles", e, { instrumentId: owner.instrumentId, timeframe: owner.timeframe }));
      }
      return;
    }
    for (let i = 0; i < batch.perGroup.length; i++) {
      const stats = batch.perGroup[i];
      const owner = owners[i];
      if (!owner) continue;
      barsByTimeframe.set(owner.timeframe, (barsByTimeframe.get(owner.timeframe) ?? 0) + stats.written);
      if (stats.written > 0) {
        instrumentsWithBars.set(owner.timeframe, (instrumentsWithBars.get(owner.timeframe) ?? 0) + 1);
      }
      if (stats.invalid > 0) {
        failures.push({
          stage: "candles",
          instrumentId: owner.instrumentId,
          timeframe: owner.timeframe,
          message: `${stats.invalid} Kerze(n) vom Store abgelehnt (OHLC/Zeitstempel ungültig).`,
          reason: "SCHEMA_MISMATCH",
          retryable: false,
        });
      }
    }
  }

  /** Instanz-Defaults als Partial (für saubere Pro-Lauf-Merges). */
  private instanceDefaults(): Partial<SyncOptions> {
    return {
      timeframes: this.options.timeframes,
      candleLimit: this.options.candleLimit,
      maxInstruments: this.options.maxInstruments,
      ...(this.options.symbolAllowlist ? { symbolAllowlist: this.options.symbolAllowlist } : {}),
      concurrency: this.options.concurrency,
      continueOnError: this.options.continueOnError,
    };
  }

  private finish(
    venue: string,
    startedAt: string,
    startedAtMs: number,
    stats: {
      discovered: number;
      synced: number;
      skipped: number;
      tickersEnriched: number;
      orderbooksEnriched: number;
      spreadsUnknown: number;
      policyExcluded: number;
      barsByTimeframe: Map<SupportedTimeframe, number>;
      instrumentsWithBars: Map<SupportedTimeframe, number>;
      failures: SyncFailure[];
    }
  ): SyncResult {
    const candlesByTimeframe: Partial<Record<SupportedTimeframe, TimeframeSyncStats>> = {};
    for (const [tf, bars] of stats.barsByTimeframe) {
      candlesByTimeframe[tf] = { instruments: stats.instrumentsWithBars.get(tf) ?? 0, bars };
    }
    return {
      venue,
      startedAt,
      finishedAt: this.clock().toISOString(),
      discovered: stats.discovered,
      synced: stats.synced,
      skipped: stats.skipped,
      tickersEnriched: stats.tickersEnriched,
      orderbooksEnriched: stats.orderbooksEnriched,
      spreadsUnknown: stats.spreadsUnknown,
      policyExcluded: stats.policyExcluded,
      candlesByTimeframe,
      failures: stats.failures,
      degraded: stats.failures.length > 0,
      durationMs: Math.max(0, performance.now() - startedAtMs),
    };
  }

  /**
   * Isolierter Sync-Fehler mit klassifizierter Ursache (MDERR-006). Der Grund
   * wird schon beim Abfangen bestimmt — nicht erst später aus einer
   * redigierten Meldung rekonstruiert. Damit bleibt ein HTTP-429/5xx von
   * `BitunixApiError.httpStatus` auch nach der Serialisierung als
   * `RATE_LIMITED`/`UPSTREAM_5XX` erhalten.
   */
  private toFailure(
    stage: SyncError["stage"],
    cause: unknown,
    ctx: { instrumentId?: string; symbol?: string; timeframe?: string } = {}
  ): SyncFailure {
    const { reason, retryable, httpStatus } = classifyMarketDataError(cause);
    return {
      stage,
      ...(ctx.instrumentId ? { instrumentId: ctx.instrumentId } : {}),
      ...(ctx.symbol ? { symbol: ctx.symbol } : {}),
      ...(ctx.timeframe ? { timeframe: ctx.timeframe } : {}),
      message: sanitizeSyncErrorMessage(cause),
      reason,
      retryable,
      ...(httpStatus !== undefined ? { httpStatus } : {}),
    };
  }

  /** Globaler Limiter: eine Anfrage, ein Token. Kein Request umgeht den Bucket. */
  private async limit(): Promise<void> {
    if (this.rateLimiter) await this.rateLimiter.take();
  }
}

/** Bestes Level (`bids[0]`/`asks[0]`) eines Orders — gekappt gegen Payload-Bombing. */
function bestPrice(levels: MarketOrderBookLevel[] | undefined): number | undefined {
  if (!Array.isArray(levels) || levels.length === 0) return undefined;
  const top = levels.slice(0, SYNC_LIMITS.maxBookLevels).find((l) => typeof l?.price === "number");
  return top?.price;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Adapter-Kerzen → Store-Kerzen ({@link MarketCandle} mit `time`).
 *
 * Kappung auf `SYNC_LIMITS.maxCandlesPerResponse`, Verwerfen unbrauchbarer
 * Zeilen (kein Zeitstempel, nicht-endliche Preise, Volumen < 0) und Sortierung
 * nach Zeit — sonst schreibt `append` eine Reihe in Response-Reihenfolge.
 */
function normalizeCandles(
  candles: MarketCandle[] | undefined,
  timeframe: SupportedTimeframe,
  failures: SyncFailure[],
  ctx: { instrumentId: string; symbol: string }
): StoreCandle[] {
  const rows = Array.isArray(candles) ? candles : [];
  if (rows.length > SYNC_LIMITS.maxCandlesPerResponse) {
    failures.push({
      stage: "candles",
      ...ctx,
      timeframe,
      message: `Kerzen-Response gekappt: ${rows.length} > ${SYNC_LIMITS.maxCandlesPerResponse} (Payload-Schutz).`,
      reason: "SCHEMA_MISMATCH",
      retryable: false,
    });
  }
  const out: StoreCandle[] = [];
  let dropped = 0;
  for (const c of rows.slice(0, SYNC_LIMITS.maxCandlesPerResponse)) {
    const time = candleTimeMs(c);
    const ok =
      time !== null &&
      [c.open, c.high, c.low, c.close].every((v) => typeof v === "number" && Number.isFinite(v) && v > 0) &&
      typeof c.volume === "number" &&
      Number.isFinite(c.volume) &&
      c.volume >= 0;
    if (!ok) {
      dropped += 1;
      continue;
    }
    out.push({ time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });
  }
  if (dropped > 0) {
    failures.push({
      stage: "candles",
      ...ctx,
      timeframe,
      message: `${dropped} unbrauchbare Kerze(n) verworfen (Zeitstempel/OHLC ungültig).`,
      reason: "SCHEMA_MISMATCH",
      retryable: false,
    });
  }
  return out.sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
}

/**
 * Structured CLI lines — counters only, never symbols or secrets.
 * Format laut MDSYNC-001 §3.3; die Bar-Anzahl steht als Klammerzusatz hinter
 * der Instrumenten-Abdeckung, damit `180/180` als Kernformat lesbar bleibt.
 */
export function formatSyncLog(
  result: SyncResult,
  options?: { candleLimit?: number; timeframes?: readonly string[] }
): string[] {
  const candleLimit = options?.candleLimit ?? SYNC_CANDLE_LIMIT;
  const timeframes = (options?.timeframes ?? Object.keys(result.candlesByTimeframe)) as readonly string[];
  const lines = [
    `[market-sync] ${result.venue} discovery: ${result.synced} instruments`,
    `[market-sync] tickers enriched: ${result.tickersEnriched}`,
    `[market-sync] orderbooks enriched: ${result.orderbooksEnriched}`,
  ];
  const tfs = timeframes.length ? timeframes : [...SYNC_TIMEFRAMES];
  for (const tf of tfs) {
    const stats = result.candlesByTimeframe[tf as SupportedTimeframe];
    const bars = stats?.bars ?? 0;
    const instruments = stats?.instruments ?? 0;
    const total = Math.max(result.synced, instruments);
    lines.push(
      `[market-sync] ${tf} candles: ${instruments}/${total}` +
        ` (${bars}/${total * candleLimit} bars)`
    );
  }
  if (result.skipped > 0) {
    lines.push(`[market-sync] übersprungen (Allowlist/Kappung): ${result.skipped}`);
  }
  if (result.policyExcluded > 0) {
    lines.push(
      `[market-sync] von der Universe-Policy abgelehnt: ${result.policyExcluded} (fachlicher Ausschluss, kein Datenfehler)`
    );
  }
  if (result.failures.length) {
    lines.push(`[market-sync] failures: ${result.failures.length}`);
  }
  lines.push(`[market-sync] duration: ${result.durationMs.toFixed(0)} ms`);
  return lines;
}

/**
 * Warnzeile bei degradiertem Lauf. Sie benennt Wirkung und Behebung, damit
 * „Sync erfolgreich, Trichter leer“ nicht als Fachergebnis missdeutet wird.
 */
export function formatDegradedLog(result: SyncResult): string | null {
  if (!result.degraded && result.spreadsUnknown === 0) return null;
  const total = result.synced;
  const lines: string[] = [];
  if (result.spreadsUnknown > 0) {
    lines.push(
      `[market-sync] DEGRADED: ${result.spreadsUnknown}/${total} Instrumente ohne Orderbook — Spread bleibt null, ` +
        `diese Instrumente werden vom Scanner mit rule="max-spread" (Datenqualität) abgelehnt.`
    );
  }
  if (result.failures.length > 0) {
    lines.push(
      `[market-sync] DEGRADED: ${result.failures.length} isolierte(r) Fehler — ` +
        `Ursachen im Manifest (data/market-data-errors.json), Behebung: erneut ausführen.`
    );
  }
  return lines.join(" ");
}

export type { SyncTimeframe };
