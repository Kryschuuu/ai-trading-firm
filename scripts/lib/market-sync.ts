/**
 * Gemeinsamer Market-Data-Sync-Aufruf für die CLIs
 * (`scripts/market-sync.ts`, `scripts/run-market-sync.ts`, `scripts/run-scan.ts --sync`).
 *
 * Einzige Instanzierungsstelle der Adapter ist `registerAdapters()`
 * (`src/marketdata/registerAdapters.ts`): public-only — es wird ausschließlich
 * der credential-freie `BitunixPublicClient` (adaptiert über den Wrapper
 * `src/marketdata/adapters/bitunix.ts`) erzeugt, gated durch die Feature-Flags
 * `MARKET_SYNC_ENABLED`, `MARKET_SYNC_VENUES` und `<VENUE>_ENABLED` sowie die
 * Capability-Matrix (`capabilities.<VENUE>.marketData === true`).
 *
 * Fehler werden im `SyncResult.failures` gesammelt und vom Aufrufer ins
 * Datenfehler-Manifest persistiert (`src/marketdata/dataErrors.ts`, MDERR-006).
 * Dieses Modul schreibt kein Manifest — das ist Aufgabe des Entry-Points,
 * damit `--dry-run` und „nur lesen“ möglich bleiben.
 */
import { HistoricalStore, type SupportedTimeframe } from "../../src/lib/marketdata/historicalStore";
import { getRegistry } from "../../src/universe";
import type { EnvLike } from "../../src/brokers/bitunix/config";
import type { InstrumentRegistry } from "../../src/universe/registry";
import {
  AGGREGATION_TARGETS,
  aggregateCandles,
  defaultSyncLogger,
  KNOWN_SYNC_VENUES,
  MARKET_SYNC_ENABLED_FLAG,
  MARKET_SYNC_VENUES_FLAG,
  MarketDataSyncService,
  resolveSyncOptions,
  type SkippedAdapter,
  type SyncLogger,
  type SyncResult,
} from "../../src/marketdata";
import { createAdapterRegistry } from "../../src/marketdata/adapterRegistry";
import {
  FileSpreadCache,
  MARKET_SPREAD_CACHE_FILE,
  spreadCacheTtlMs,
  type SpreadCache,
} from "../../src/marketdata/spreadCache";

export interface MarketSyncRunOptions {
  /** Zu synchronisierende Venue (Großbuchstaben, z. B. `BITUNIX`). */
  venue: string;
  /**
   * Zu backfillende Timeframes. Default liegt im Service (`SYNC_TIMEFRAMES`,
   * seit v1.37.0 nur `1h` — der einzige von Scanner/Analytics ausgewertete
   * Zeitrahmen). Kürzere Zeitrahmen explizit: `--timeframes=5m,15m,30m,1h`.
   */
  timeframes?: readonly SupportedTimeframe[];
  /** Kerzen je Timeframe; Default `max(150, requiredWarmupCandles)`. */
  candleLimit?: number;
  /** Sicherheits-Cap der Instrumente je Venue; Default 250. */
  maxInstruments?: number;
  /** Nur diese Symbole synchronisieren (venue-nativ). */
  symbols?: readonly string[];
  /** Parallelität (hart ≤ 8); Default 4. */
  concurrency?: number;
  /** `true` ⇒ Abbruch beim ersten Fehler (kein degradierter Lauf). */
  strict?: boolean;
  /** `true` ⇒ vollen Kerzen-Abruf erzwingen (kein inkrementelles Überspringen). */
  fullRefresh?: boolean;
  /**
   * Spread-Cache für die Depth-Stage. Default: dateigestützter Cache
   * (`data/spread-cache.json`, TTL aus `MARKET_SPREAD_CACHE_TTL_MS`,
   * Default 6 h; `0` schaltet ab). Explizit `false` deaktiviert den Cache
   * (Dry-Runs: es darf nichts in `data/` landen).
   */
  spreadCache?: SpreadCache | false;
  /** Env für Adapter-Aufbau und Feature-Gates (Default `process.env`). */
  env?: EnvLike;
  /** Injizierbare Registry (Tests). */
  registry?: InstrumentRegistry;
  /** Injizierbarer Store (Tests). */
  history?: HistoricalStore;
  /** Log-Senke der `[market-sync]`-Zeilen. */
  logger?: SyncLogger;
  /** `true` ⇒ gar nicht loggen (JSON-Ausgabe des CLIs, Tests). */
  quiet?: boolean;
  /**
   * Multi-TF-Aggregation (GAP-07, Default **off**): nach dem Backfill werden
   * die persistierten 1h-Reihen deterministisch zu 4h/1d-Kerzen aggregiert
   * (UTC-Anker, unvollständige Buckets werden ausgeschlossen) und als neue
   * Timeframe-Reihen in den Store appendet. Wirkt nur, wenn `1h`
   * synchronisiert wurde. Env-Default: `MARKET_SYNC_AGGREGATE`.
   */
  aggregate?: boolean;
}

export interface MarketSyncRun {
  result: SyncResult;
  /** Venues, die vom Gate zurückgewiesen wurden (symbolische Gründe). */
  skipped: readonly SkippedAdapter[];
}

/**
 * Führt Discovery → Enrichment → Candle-Backfill für eine Venue aus.
 *
 * Logging übernimmt der `MarketDataSyncService` selbst (über `logger`); diese
 * Funktion loggt zusätzlich nichts — doppelte Zählerzeilen wären mehrdeutig.
 *
 * @throws {Error} wenn die Venue durch kein Feature-Flag freigeschaltet ist,
 *   mit Behebungshinweis statt still gemeldetem „0 Instrumente“.
 */
export async function runMarketSyncDetailed(options: MarketSyncRunOptions): Promise<MarketSyncRun> {
  const venue = options.venue.trim().toUpperCase();
  const registry = options.registry ?? getRegistry();
  const history = options.history ?? new HistoricalStore();
  const adapters = createAdapterRegistry({ registry, env: options.env, venues: [venue] });
  const syncOptions = {
    ...(options.timeframes ? { timeframes: options.timeframes } : {}),
    ...(options.candleLimit !== undefined ? { candleLimit: options.candleLimit } : {}),
    ...(options.maxInstruments !== undefined ? { maxInstruments: options.maxInstruments } : {}),
    ...(options.symbols ? { symbolAllowlist: options.symbols } : {}),
    ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
    ...(options.strict !== undefined ? { strict: options.strict } : {}),
    ...(options.fullRefresh !== undefined ? { fullRefresh: options.fullRefresh } : {}),
  };
  // Validation vor dem ersten Request: ein Fehler in `timeframes` oder
  // `candleLimit` darf keinen halbvollgeschriebenen Store hinterlassen.
  resolveSyncOptions(syncOptions);

  if (!adapters.has(venue)) throw new Error(gateMessage(venue, adapters.skipped));

  const silentLogger: SyncLogger = () => {};
  // Spread-Cache: explizit false (Dry-Run) ⇒ aus; explizite Instanz ⇒ diese;
  // sonst dateigestützter Cache mit der TTL aus der Umgebung.
  let spreadCache: SpreadCache | null = null;
  if (options.spreadCache === false) {
    spreadCache = null;
  } else if (options.spreadCache) {
    spreadCache = options.spreadCache;
  } else {
    const ttlMs = spreadCacheTtlMs(options.env ?? process.env);
    if (ttlMs > 0) spreadCache = new FileSpreadCache(MARKET_SPREAD_CACHE_FILE, ttlMs);
  }
  const service = new MarketDataSyncService(registry, history, adapters.entries, {
    ...syncOptions,
    ...(spreadCache ? { spreadCache } : {}),
    logger: options.quiet ? silentLogger : (options.logger ?? defaultSyncLogger),
  });
  const result = await service.syncVenue(venue);
  return { result, skipped: adapters.skipped };
}

export interface AggregationSummary {
  /** Reihen mit ≥ 1 geschriebener aggregierter Bar. */
  instruments: number;
  /** Neu geschriebene Bars je Ziel-Timeframe. */
  bars: Record<"4h" | "1d", number>;
  /** Ausgeschlossene unvollständige Buckets (Total über alle Ziele). */
  partialBuckets: number;
}

/**
 * Multi-TF-Aggregation (GAP-07): 1h → 4h/1d aus der PERSISTIERTEN Historie,
 * deterministisch (UTC-Anker; unvollständige Buckets — auch die aktuelle
 * Periode — werden nie aggregiert, `nowMs`-Zeitmaske gewahrt). Die
 * aggregierten Reihen sind NEUE Timeframe-Reihen (`feed: "agg:1h"`) — die
 * 1h-Quelle bleibt unangetastet (Append-only + Dedup im Store).
 *
 * Reine CLI-Logik (kein Request): liest den Store, appendet Aggregat.
 * `undefined` bei `1h` ohne Bestand oder ohne synchronisierte 1h-Reihe.
 */
export function runAggregation(
  deps: {
    history: HistoricalStore;
    registry: InstrumentRegistry;
    venue: string;
    nowMs: number;
  },
): AggregationSummary | undefined {
  const { history, registry, venue, nowMs } = deps;
  const instruments: string[] = [];
  let cursor = 1;
  for (;;) {
    const chunk = registry.query({ venue, pageSize: 1000, page: cursor });
    for (const inst of chunk.items) instruments.push(inst.id);
    if (!chunk.hasMore) break;
    cursor += 1;
    if (cursor > 100) break; // harte Obergrenze (DoS-Schutz, Registry ≤ 50k)
  }
  if (instruments.length === 0) return undefined;

  const summary: AggregationSummary = {
    instruments: 0,
    bars: { "4h": 0, "1d": 0 },
    partialBuckets: 0,
  };
  const now = new Date(nowMs);
  for (const instrumentId of instruments) {
    // Store-Einträge (ts-basiert) → QualityCandle (`ts` ist erlaubt); die
    // AGGREGIERTEN Kerzen tragen `time` (Store-Contract des Appends).
    const source = history.query({ instrumentId, timeframe: "1h" });
    if (source.length === 0) continue;
    const qualitySource = source.map((e) => ({
      ts: e.ts,
      open: e.open,
      high: e.high,
      low: e.low,
      close: e.close,
      volume: e.volume,
    }));
    const groups: {
      candles: { time: number; open: number; high: number; low: number; close: number; volume: number }[];
      instrumentId: string;
      provenance: { venue: string; feed: string };
      timeframe: "4h" | "1d";
    }[] = [];
    let writtenThisInstrument = 0;
    for (const target of AGGREGATION_TARGETS) {
      const res = aggregateCandles(qualitySource, "1h", target, { nowMs });
      summary.partialBuckets += res.partial.length;
      if (res.candles.length === 0) continue;
      groups.push({
        candles: res.candles.map((c) => ({
          time: c.time ?? c.ts ?? 0,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
        })),
        instrumentId,
        provenance: { venue, feed: "agg:1h" },
        timeframe: target as "4h" | "1d",
      });
    }
    if (groups.length === 0) continue;
    const batch = history.appendSeries(groups, now);
    for (const [i, group] of groups.entries()) {
      const written = batch.perGroup[i]?.written ?? 0;
      summary.bars[group.timeframe] += written;
      if (written > 0) writtenThisInstrument += 1;
    }
    if (writtenThisInstrument > 0) summary.instruments += 1;
  }
  return summary;
}

/**
 * Behebungshinweis pro Gate-Grund — symbolische Codes, keine Pfade/URLs.
 *
 * MDSYNC-002 (v1.36.38): bewusst OHNE `[market-sync]`-Präfix — der Einstiegspunkt
 * (`runMarketSyncCli`) stellt es voran. Zuvor stand es doppelt in der Ausgabe
 * („[market-sync] [market-sync] BITUNIX wurde nicht freigeschaltet …“).
 */
export function gateMessage(venue: string, skipped: readonly SkippedAdapter[]): string {
  const reason = skipped.find((s) => s.venue === venue)?.reason ?? "UNKNOWN_VENUE";
  const hints: Record<SkippedAdapter["reason"], string> = {
    KILL_SWITCH: `${MARKET_SYNC_ENABLED_FLAG} steht auf "false" — auf "true" setzen oder entfernen.`,
    NOT_IN_ALLOWLIST: `In ${MARKET_SYNC_VENUES_FLAG} fehlt "${venue}" — Liste ergänzen oder Flag leer lassen.`,
    VENUE_DISABLED: `${venue}_ENABLED=true setzen (nur der exakte Wert "true" schaltet an). Public Market Data benoetigt KEINE API-Credentials; Live-Trading bleibt weiterhin durch das Live-Gate gesperrt.`,
    CAPABILITY_DISABLED: `capabilities.${venue}.marketData=false in der Capability-SSoT (src/brokers/capabilities.ts) — die Venue meldet keinen Public-Market-Data-Pfad.`,
    UNKNOWN_VENUE: `Für "${venue}" existiert kein MarketDataAdapter. Bekannte Venues: ${KNOWN_SYNC_VENUES.join(", ")}.`,
    INVALID_VENUE_KEY: "Venue-Key verletzt das erlaubte Format [A-Z0-9][A-Z0-9_-]{0,31}.",
  };
  return `${venue} wurde nicht freigeschaltet (Grund: ${reason}). Behebung: ${hints[reason]}`;
}

/** Rückwärtskompatibler Aufruf: nur das `SyncResult`. */
export async function runMarketSync(
  venue: string,
  options: Omit<MarketSyncRunOptions, "venue"> = {}
): Promise<SyncResult> {
  const { result } = await runMarketSyncDetailed({ ...options, venue });
  return result;
}
