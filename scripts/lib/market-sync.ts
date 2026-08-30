/**
 * Gemeinsamer Market-Data-Sync-Aufruf für die CLIs
 * (`scripts/market-sync.ts`, `scripts/run-market-sync.ts`, `scripts/run-scan.ts --sync`).
 *
 * Einzige Instanzierungsstelle der Adapter ist `registerAdapters()`
 * (`src/marketdata/registerAdapters.ts`): public-only, Modus „paper“, ohne
 * Credentials, gated durch die Feature-Flags `MARKET_SYNC_ENABLED`,
 * `MARKET_SYNC_VENUES` und `<VENUE>_ENABLED`.
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

export interface MarketSyncRunOptions {
  /** Zu synchronisierende Venue (Großbuchstaben, z. B. `BITUNIX`). */
  venue: string;
  /** Zu backfillende Timeframes; Default `5m,15m,30m,1h`. */
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
  };
  // Validation vor dem ersten Request: ein Fehler in `timeframes` oder
  // `candleLimit` darf keinen halbvollgeschriebenen Store hinterlassen.
  resolveSyncOptions(syncOptions);

  if (!adapters.has(venue)) throw new Error(gateMessage(venue, adapters.skipped));

  const silentLogger: SyncLogger = () => {};
  const service = new MarketDataSyncService(registry, history, adapters.entries, {
    ...syncOptions,
    logger: options.quiet ? silentLogger : (options.logger ?? defaultSyncLogger),
  });
  const result = await service.syncVenue(venue);
  return { result, skipped: adapters.skipped };
}

/** Behebungshinweis pro Gate-Grund — symbolische Codes, keine Pfade/URLs. */
export function gateMessage(venue: string, skipped: readonly SkippedAdapter[]): string {
  const reason = skipped.find((s) => s.venue === venue)?.reason ?? "UNKNOWN_VENUE";
  const hints: Record<SkippedAdapter["reason"], string> = {
    KILL_SWITCH: `${MARKET_SYNC_ENABLED_FLAG} steht auf "false" — auf "true" setzen oder entfernen.`,
    NOT_IN_ALLOWLIST: `In ${MARKET_SYNC_VENUES_FLAG} fehlt "${venue}" — Liste ergänzen oder Flag leer lassen.`,
    VENUE_DISABLED: `${venue}_ENABLED=true setzen (nur der exakte Wert "true" schaltet an).`,
    UNKNOWN_VENUE: `Für "${venue}" existiert kein MarketDataAdapter. Bekannte Venues: ${KNOWN_SYNC_VENUES.join(", ")}.`,
    INVALID_VENUE_KEY: "Venue-Key verletzt das erlaubte Format [A-Z0-9][A-Z0-9_-]{0,31}.",
  };
  return `[market-sync] ${venue} wurde nicht freigeschaltet (Grund: ${reason}). Behebung: ${hints[reason]}`;
}

/** Rückwärtskompatibler Aufruf: nur das `SyncResult`. */
export async function runMarketSync(
  venue: string,
  options: Omit<MarketSyncRunOptions, "venue"> = {}
): Promise<SyncResult> {
  const { result } = await runMarketSyncDetailed({ ...options, venue });
  return result;
}
