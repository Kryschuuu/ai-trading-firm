/**
 * PerpDataService (RMA-P2-02) — der einzige Einstiegspunkt nach außen.
 *
 * Bündelt Konfiguration, Adapter-Freischaltung, Sync, as-of-Abfrage, Status
 * und Consumer-Snapshots. CLI, API-Routen und Zyklus-Schritte reden **nur**
 * diesen Service an — sie bauen keine eigenen Adapter, keine eigenen Queries
 * und schon gar keine eigenen Env-Lesungen.
 *
 * Gates (Reihenfolge ist absichtlich, jede Stufe meldet ihren Grund):
 *
 *   1. `PERP_DATA_ENABLED`              — Konsumenten lesen kanonische Quelle.
 *   2. `PERP_DATA_SYNC_ENABLED`         — Netz-Ingestion überhaupt.
 *   3. `<VENUE>_ENABLED` + Capability-SSoT — Venue darf öffentliche Marktdaten.
 *   4. `PERP_DATA_VENUES`               — Allowlist des Betriebs.
 *   5. Registry-Filter `marketType === "perpetual"` — Spot bekommt keinen
 *      Perp-Datenpfad (Out-of-Scope des Auftrags, kein Overreach).
 *
 * Geteilter Kill-Switch (`KILL_SWITCH_ACTIVE=true`) schaltet die Ingestion ab;
 * das **Lesen** des Bestands bleibt möglich (Abschaltung bedeutet „nichts
 * Neues holen“, nicht „bekannte Historie verschleiern“). Risiko-, Order- und
 * Live-Pfade werden von diesem Modul nie berührt.
 */
import { getRegistry, type InstrumentRegistry } from "../universe";
import type { MarketInstrument } from "../universe/types";
import { loadPerpConfig, perpDataEnabled, type PerpConfig, type PerpEnvLike } from "./config";
import { PerpQueryError, PerpStoreUnavailableError } from "./errors";
import { perpCapabilitiesFor } from "./capabilities";
import { KNOWN_PERP_VENUES, perpGateMessage, registerPerpAdapters, type SkippedPerpAdapter } from "./registry";
import { aggregatePerpSyncResults, syncPerpVenue, type PerpSleep, type PerpSyncOptions } from "./sync";
import { buildPerpDerivativeSnapshots, type PerpDerivativeSnapshot } from "./consumers";
import {
  buildPerpDerivativeCache,
  loadPerpDerivativeCache,
  savePerpDerivativeCache,
  PERP_DERIVATIVE_CACHE_FILE,
} from "./derivativeCache";
import { replayPositionFunding, type PerpReplayPosition, type PerpReplayResult } from "./replay";
import { queryPerpSeries, type PerpAsOfRequest, type PerpAsOfResponse } from "./query";
import { getPerpStore } from "./store";
import { loadPerpQualityReport, PERP_QUALITY_REPORT_FILE } from "./quality";
import {
  PERP_INSTRUMENT_ID_PATTERN,
  PERP_LIMITS,
  type PerpSeriesKind,
  type PerpSyncMode,
  type PerpSyncResult,
  type PerpVenueCapabilities,
} from "./types";
import type { PerpCoverage, PerpCursor, PerpRunRecord, PerpStorePort } from "./ports";
import type { PerpDataAdapter } from "./port";
import type { PerpSyncLogger } from "./port";

export interface PerpSyncServiceRequest {
  /** Zielvenues (Default: Allowlist bzw. alle bekannten Perp-Venues). */
  venues?: readonly string[];
  mode?: PerpSyncMode;
  /** Fenster (ISO-String oder Epoch-ms); `from` fehlt ⇒ `backfillDays`. */
  from?: string | number | null;
  to?: string | number | null;
  days?: number | null;
  kinds?: readonly PerpSeriesKind[];
  dryRun?: boolean;
  maxInstruments?: number;
  concurrency?: number;
  /** Ignore Gates (nur Validierung/Tests): `--fixture`-Pfad des CLI. */
  ignoreEnvGates?: boolean;
}

export interface PerpVenueSyncReport {
  venue: string;
  results: PerpSyncResult[];
  /** `null`, wenn die Venue gar nicht gelaufen ist (Gate/Skip). */
  aggregate: ReturnType<typeof aggregatePerpSyncResults> | null;
  /** Grund, warum die Venue nicht gelaufen ist (`null` = gelaufen). */
  skipped: SkippedPerpAdapter | null;
  message: string;
}

export interface PerpStatusReport {
  enabled: boolean;
  syncEnabled: boolean;
  availabilityPolicy: PerpConfig["availabilityPolicy"];
  qualityMode: PerpConfig["qualityMode"];
  venues: {
    venue: string;
    adapterReady: boolean;
    skippedReason: SkippedPerpAdapter["reason"] | null;
    capabilities: PerpVenueCapabilities;
  }[];
  limits: {
    backfillDays: number;
    fundingIntervalHours: number;
    oiIntervalMinutes: number;
    maxStaleMs: { funding: number; openInterest: number; liquidations: number };
    maxAbsFundingRate: number;
    maxOiChange: number;
    concurrency: number;
    safetyLagMs: number;
    crosscheckVenue: string | null;
  };
  store: { status: "ready" | "unavailable"; message?: string; dbConfigured: boolean };
  coverage: PerpCoverage[];
  cursors: PerpCursor[];
  cursorsTruncated: boolean;
  runs: PerpRunRecord[];
  quality: {
    mode: PerpConfig["qualityMode"];
    file: string;
    writtenAt: string | null;
    totals: { series: number; rows: number; byClass: Record<string, number> } | null;
  };
  /** Derivative-Artefakt der Konsumenten (Scanner/Analyst) — Alter + Grund. */
  derivativeCache: {
    file: string;
    writtenAt: string | null;
    asOf: string | null;
    entries: number;
    ageMs: number | null;
    reason: string | null;
  };
  generatedAt: string;
}

function toMs(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? Math.floor(value) : null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export class PerpDataService {
  readonly config: PerpConfig;
  private readonly env: PerpEnvLike;
  private readonly registry: InstrumentRegistry;
  private readonly storeOverride: PerpStorePort | null;
  private readonly adaptersOverride: Map<string, PerpDataAdapter> | null;
  private readonly now: () => Date;
  private readonly logger: PerpSyncLogger;
  private readonly sleep: PerpSleep | undefined;
  private readonly rateLimiter: PerpSyncOptions["rateLimiter"];

  constructor(deps: {
    env?: PerpEnvLike;
    config?: PerpConfig;
    registry?: InstrumentRegistry;
    store?: PerpStorePort;
    adapters?: Map<string, PerpDataAdapter>;
    now?: () => Date;
    logger?: PerpSyncLogger;
    sleep?: PerpSleep;
    rateLimiter?: PerpSyncOptions["rateLimiter"];
  } = {}) {
    this.env = deps.env ?? process.env;
    this.config = deps.config ?? loadPerpConfig(this.env);
    this.registry = deps.registry ?? getRegistry();
    this.storeOverride = deps.store ?? null;
    this.adaptersOverride = deps.adapters ?? null;
    this.now = deps.now ?? (() => new Date());
    this.logger = deps.logger ?? ((level, line) => console[level === "info" ? "log" : level](`[perpdata:${level}] ${line}`));
    this.sleep = deps.sleep;
    this.rateLimiter = deps.rateLimiter;
  }

  get store(): PerpStorePort {
    return this.storeOverride ?? getPerpStore();
  }

  /** Master-Gate der Konsumenten (`PERP_DATA_ENABLED`). */
  get enabled(): boolean {
    return perpDataEnabled(this.env);
  }

  /** Adapter-Map (Gates angewandt); `skipped` erklärt jede Lücke. */
  adapters(options: { venues?: readonly string[]; ignoreEnvGates?: boolean } = {}): {
    adapters: Map<string, PerpDataAdapter>;
    skipped: SkippedPerpAdapter[];
  } {
    if (this.adaptersOverride) {
      const wanted = options.venues?.map((venue) => venue.trim().toUpperCase());
      const entries = [...this.adaptersOverride.entries()].filter(
        ([venue]) => !wanted || wanted.length === 0 || wanted.includes(venue)
      );
      return { adapters: new Map(entries), skipped: [] };
    }
    const result = registerPerpAdapters({
      env: this.env,
      ...(options.venues ? { venues: options.venues } : {}),
      ...(options.ignoreEnvGates ? { ignoreEnvGates: true } : {}),
      // Der Service fragt nur für Sync-Läufe nach Adaptern; `allowSync` ist
      // deshalb **nicht** gesetzt — die Sync-Gates bleiben autoritativ und
      // `--status` meldet denselben Zustand, den ein Sync-Lauf vorfindet.
    });
    return { adapters: result.adapters, skipped: result.skipped };
  }

  /** Instrumente einer Venue, nur Perpetuals (Out-of-Scope: Spot). */
  perpetualInstruments(venue: string): MarketInstrument[] {
    const result = this.registry.query({ venue, marketType: "perpetual", pageSize: 500 });
    return [...result.items].sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * Löst Instrument-Angaben auf kanonische IDs auf.
   *
   * `BITUNIX:BTCUSDT` wird übernommen (die Speicherform ist selbstbeschrieben),
   * `BTCUSDT`/`btcusdt` nur zusammen mit `venue` über die Registry. Eine ID, die
   * weder noch etwas auflösbares ist, wirft — „unbekanntes Instrument“ ist eine
   * AnfrageABLEhnung, nie ein leeres Ergebnis.
   */
  resolveInstruments(
    identifiers: readonly string[],
    venue?: string | null
  ): { instruments: MarketInstrument[]; canonicalIds: string[]; unknown: string[] } {
    const instruments: MarketInstrument[] = [];
    const canonicalIds: string[] = [];
    const unknown: string[] = [];
    for (const raw of identifiers) {
      const value = String(raw).trim().toUpperCase();
      if (!value) continue;
      const found = this.registry.get(value) ?? (venue ? this.registry.find(venue.toUpperCase(), value) : null);
      if (found !== null) {
        instruments.push(found);
        canonicalIds.push(found.id);
        continue;
      }
      if (PERP_INSTRUMENT_ID_PATTERN.test(value)) {
        // Kanonische Form ohne Registry-Eintrag (z. B. nach Universe-Pruning):
        // lesen ist erlaubt, denn der Bestand ist die Wahrheit über sich selbst.
        canonicalIds.push(value);
        continue;
      }
      unknown.push(value);
    }
    if (unknown.length > 0) {
      throw new PerpQueryError(
        "query:unknown_instrument",
        `Instrument(e) nicht auflösbar: ${unknown.slice(0, 5).join(", ")}${unknown.length > 5 ? ` … (${unknown.length})` : ""}. ` +
          `Erwartet VENUE:SYMBOL oder ein Registry-Symbol mit passingem venue-Parameter.`,
        { unknown: unknown.slice(0, 10) }
      );
    }
    return { instruments, canonicalIds, unknown };
  }

  /**
   * as-of-Abfrage (API/CLI) — validiert, limitiert, klassifiziert.
   *
   * `identifiers` löst Symbole über die Registry auf kanonische IDs auf;
   * die Validierung der Grenzen passiert in `queryPerpSeries` (eine
   * unzulässige Anfrage wird abgelehnt, bevor die Ablage belastet wird).
   */
  async query(request: PerpAsOfRequest & { identifiers?: readonly string[] }): Promise<PerpAsOfResponse> {
    const instruments =
      request.identifiers && request.identifiers.length > 0
        ? this.resolveInstruments(request.identifiers, request.venue).canonicalIds
        : [...request.instruments];
    return queryPerpSeries(
      this.store,
      { ...request, instruments },
      {
        config: this.config,
        nowMs: this.now().getTime(),
        capabilitiesFor: (venue) => perpCapabilitiesFor(venue),
      }
    );
  }

  /** Consumer-Snapshots (Scanner-Kontext, Analyst). */
  async snapshots(input: {
    instruments: readonly MarketInstrument[];
    asOfMs?: number;
    lookbackMs?: number;
  }): Promise<Map<string, PerpDerivativeSnapshot>> {
    return buildPerpDerivativeSnapshots({
      source: this.store,
      config: this.config,
      instruments: input.instruments,
      asOfMs: input.asOfMs ?? this.now().getTime(),
      ...(input.lookbackMs !== undefined ? { lookbackMs: input.lookbackMs } : {}),
      capabilitiesFor: (venue) => perpCapabilitiesFor(venue),
    });
  }

  /**
   * Aktualisiert das Derivative-Artefakt für die synchronen Konsumenten
   * (Scanner-Faktoren, Analystenzeilen). As-of-gelesen, limitiert, atomar
   * geschrieben — und nur, wenn `PERP_DATA_ENABLED` den Konsumentenpfad freigibt.
   */
  async refreshDerivativeCache(input: {
    instruments?: readonly MarketInstrument[];
    asOfMs?: number;
    file?: string;
  } = {}): Promise<{
    written: boolean;
    entries: number;
    /** davon mit mindestens einem verfügbaren Wert (Scanner-Anreicherung). */
    available: number;
    /** davon ohne Wert (Gründe stehen im Artefakt je Reihe). */
    unavailable: number;
    /** `true` ⇒ die Ablage war nicht erreichbar — Artefakt sagt das nur. */
    storeUnavailable: boolean;
    file: string;
    reason: "OK" | "DISABLED" | "NO_INSTRUMENTS";
  }> {
    const file = input.file ?? PERP_DERIVATIVE_CACHE_FILE;
    if (!this.config.enabled) {
      return {
        written: false,
        entries: 0,
        available: 0,
        unavailable: 0,
        storeUnavailable: false,
        file,
        reason: "DISABLED",
      };
    }
    const instruments = (input.instruments ?? this.perpetualInstrumentsForVenues()).slice(0, PERP_LIMITS.queryInstruments);
    if (instruments.length === 0) {
      return {
        written: false,
        entries: 0,
        available: 0,
        unavailable: 0,
        storeUnavailable: false,
        file,
        reason: "NO_INSTRUMENTS",
      };
    }
    const asOfMs = input.asOfMs ?? this.now().getTime();
    const snapshots = await this.snapshots({ instruments, asOfMs });
    const cache = buildPerpDerivativeCache(snapshots.values(), {
      writtenAt: this.now(),
      availabilityPolicy: this.config.availabilityPolicy,
      qualityMode: this.config.qualityMode,
    });
    savePerpDerivativeCache(cache, file);
    const values = Object.values(cache.entries);
    const unavailable = values.filter((entry) => entry.availability !== "AVAILABLE").length;
    const storeUnavailable = values.some((entry) =>
      Object.values(entry.reasons).some((reason) => String(reason).startsWith("STORE_UNAVAILABLE"))
    );
    return {
      written: true,
      entries: values.length,
      available: values.length - unavailable,
      unavailable,
      storeUnavailable,
      file,
      reason: "OK",
    };
  }

  /** Perpetuals über alle freigegebenen Venues (Cache-Aufbau ohne Adapter). */
  perpetualInstrumentsForVenues(): MarketInstrument[] {
    const venues = this.config.venues ?? [...KNOWN_PERP_VENUES];
    const out: MarketInstrument[] = [];
    const seen = new Set<string>();
    for (const venue of venues) {
      for (const instrument of this.perpetualInstruments(venue)) {
        if (seen.has(instrument.id)) continue;
        seen.add(instrument.id);
        out.push(instrument);
      }
    }
    return out;
  }

  /** Funding-Replay einer Position über die kanonische Historie. */
  async fundingReplay(input: {
    instrumentId: string;
    position: PerpReplayPosition;
    asOfMs?: number;
    qualityMode?: "log" | "strict";
  }): Promise<PerpReplayResult & { truncated: boolean }> {
    const asOfMs = input.asOfMs ?? this.now().getTime();
    const venue = input.instrumentId.includes(":") ? input.instrumentId.slice(0, input.instrumentId.indexOf(":")) : "";
    return replayPositionFunding(this.store, {
      venue: venue || "UNKNOWN",
      instrumentId: input.instrumentId,
      position: input.position,
      asOfMs,
      config: this.config,
      ...(input.qualityMode ? { qualityMode: input.qualityMode } : {}),
    });
  }

  /**
   * Sync über Venues. Fehlt eine Freischaltung, wird die Venue **nicht**
   * still übersprungen, sondern mit Grund gemeldet (`skipped` + Behebung).
   */
  async sync(request: PerpSyncServiceRequest = {}): Promise<{
    venues: PerpVenueSyncReport[];
    totals: {
      runs: number;
      fetched: number;
      written: number;
      duplicates: number;
      requests: number;
      failures: number;
      qualityFindings: Record<string, number>;
    };
    enabled: boolean;
    syncEnabled: boolean;
  }> {
    const mode: PerpSyncMode = request.mode ?? "INCREMENTAL";
    const { adapters, skipped } = this.adapters({
      ...(request.venues ? { venues: request.venues } : {}),
      ...(request.ignoreEnvGates ? { ignoreEnvGates: true } : {}),
    });
    const totals = {
      runs: 0,
      fetched: 0,
      written: 0,
      duplicates: 0,
      requests: 0,
      failures: 0,
      qualityFindings: {} as Record<string, number>,
    };
    const venues: PerpVenueSyncReport[] = [];
    const requestedVenues = request.venues?.length ? request.venues.map((venue) => venue.trim().toUpperCase()) : [...adapters.keys()];
    const uniqueVenues = [...new Set(requestedVenues.length > 0 ? requestedVenues : KNOWN_PERP_VENUES)];

    for (const venue of uniqueVenues) {
      const adapter = adapters.get(venue) ?? null;
      if (adapter === null) {
        const skip = skipped.find((entry) => entry.venue === venue) ?? { venue, reason: "UNKNOWN_VENUE" as const };
        venues.push({ venue, results: [], aggregate: null, skipped: skip, message: perpGateMessage(venue, skipped) });
        continue;
      }
      const instruments = this.perpetualInstruments(venue);
      if (instruments.length === 0) {
        venues.push({
          venue,
          results: [],
          aggregate: null,
          skipped: null,
          message: `${venue}: kein Perpetual-Instrument in der Universe-Registry — Perp-Datenpfad läuft ins Leere (Out-of-Scope: Spot).`,
        });
        continue;
      }
      const toMs = toMsOf(request.to, this.now, this.config.safetyLagMs) ?? this.now().getTime() - this.config.safetyLagMs;
      const fromMs =
        toMsOf(request.from, this.now, 0) ??
        (mode === "BACKFILL"
          ? toMs - Math.round(Math.max(1, request.days ?? this.config.backfillDays) * 86_400_000)
          : null);
      const results = await syncPerpVenue({
        venue,
        adapter,
        store: this.store,
        config: this.config,
        instruments,
        mode,
        fromMs,
        toMs,
        ...(request.kinds ? { kinds: request.kinds } : {}),
        logger: this.logger,
        now: this.now,
        ...(this.sleep ? { sleep: this.sleep } : {}),
        ...(this.rateLimiter ? { rateLimiter: this.rateLimiter } : {}),
        ...(request.dryRun ? { dryRun: true } : {}),
        ...(request.maxInstruments !== undefined ? { maxInstruments: request.maxInstruments } : {}),
        ...(request.concurrency !== undefined ? { concurrency: request.concurrency } : {}),
      });
      const aggregate = aggregatePerpSyncResults(results);
      for (const result of results) {
        totals.runs += 1;
        totals.requests += result.requests;
        totals.failures += result.failures.length;
        for (const kind of ["funding", "openInterest", "liquidations"] as const) {
          totals.written += result.stats[kind].written;
          totals.duplicates += result.stats[kind].duplicates;
          totals.fetched += result.stats[kind].fetched;
        }
        for (const [cls, count] of Object.entries(result.qualityFindings)) {
          totals.qualityFindings[cls] = (totals.qualityFindings[cls] ?? 0) + count;
        }
      }
      venues.push({ venue, results, aggregate, skipped: null, message: aggregateMessage(venue, aggregate) });
    }
    return { venues, totals, enabled: this.config.enabled, syncEnabled: this.config.syncEnabled };
  }

  /**
   * Statusbericht (CLI `--status`, `GET /api/marketdata/perpetual/status`).
   *
   * Diagnose-Oberfläche: ein Erreichbarkeitsfehler der Ablage wird hier
   * **gemeldet** (`store.status = "unavailable"`), weil der Zweck des Aufrufs
   * genau das ist — Ablagefehler herauszufinden. Das ist kein Fallback:
   * `coverage`/`cursors`/`runs` bleiben leer und `store.message` erklärt es.
   */
  async status(venue?: string | null): Promise<PerpStatusReport> {
    const asOfMs = this.now().getTime();
    const { adapters, skipped } = this.adapters({ ...(venue ? { venues: [venue] } : {}) });
    const venues: PerpStatusReport["venues"] = [];
    const known = venue ? [venue.trim().toUpperCase()] : [...new Set([...KNOWN_PERP_VENUES, ...adapters.keys()])];
    for (const entry of known) {
      venues.push({
        venue: entry,
        adapterReady: adapters.has(entry),
        skippedReason: skipped.find((candidate) => candidate.venue === entry)?.reason ?? null,
        capabilities: perpCapabilitiesFor(entry),
      });
    }
    let storeStatus: PerpStatusReport["store"] = {
      status: "ready",
      dbConfigured: Boolean(this.env.DATABASE_URL || process.env.DATABASE_URL),
    };
    let coverage: PerpCoverage[] = [];
    let cursors: PerpCursor[] = [];
    let runs: PerpRunRecord[] = [];
    try {
      coverage = [...(await this.store.coverage(asOfMs, venue ?? null))];
      cursors = (await this.store.readCursors(venue ? { venue } : {})).slice(0, 100);
      runs = (await this.store.recentRuns(10)).slice(0, 10);
    } catch (error) {
      const unavailable = error instanceof PerpStoreUnavailableError;
      storeStatus = {
        status: "unavailable",
        message: String((error as Error).message ?? error).slice(0, 240),
        dbConfigured: Boolean(this.env.DATABASE_URL || process.env.DATABASE_URL),
        ...(unavailable ? {} : {}),
      };
    }
    const report = loadPerpQualityReport(PERP_QUALITY_REPORT_FILE);
    const cache = loadPerpDerivativeCache({
      env: this.env,
      nowMs: asOfMs,
      maxAgeMs: this.config.maxStaleMs.funding,
    });
    return {
      enabled: this.config.enabled,
      syncEnabled: this.config.syncEnabled,
      availabilityPolicy: this.config.availabilityPolicy,
      qualityMode: this.config.qualityMode,
      venues,
      limits: {
        backfillDays: this.config.backfillDays,
        fundingIntervalHours: this.config.fundingIntervalHours,
        oiIntervalMinutes: this.config.oiIntervalMinutes,
        maxStaleMs: {
          funding: this.config.maxStaleMs.funding,
          openInterest: this.config.maxStaleMs.openInterest,
          liquidations: Number.isFinite(this.config.maxStaleMs.liquidations)
            ? this.config.maxStaleMs.liquidations
            : -1,
        },
        maxAbsFundingRate: this.config.maxAbsFundingRate,
        maxOiChange: this.config.maxOiChange,
        concurrency: this.config.concurrency,
        safetyLagMs: this.config.safetyLagMs,
        crosscheckVenue: this.config.crosscheckVenue,
      },
      store: storeStatus,
      coverage,
      cursors,
      cursorsTruncated: cursors.length === 100,
      runs,
      quality: {
        mode: report?.mode ?? this.config.qualityMode,
        file: PERP_QUALITY_REPORT_FILE,
        writtenAt: report?.writtenAt ?? null,
        totals: report?.totals ?? null,
      },
      derivativeCache: {
        file: PERP_DERIVATIVE_CACHE_FILE,
        writtenAt: cache.cache?.writtenAt ?? null,
        asOf: cache.cache?.asOf ?? null,
        entries: cache.entries,
        ageMs: cache.ageMs,
        reason: cache.reason,
      },
      generatedAt: new Date(asOfMs).toISOString(),
    };
  }
}

function toMsOf(value: string | number | null | undefined, now: () => Date, lagMs: number): number | null {
  const parsed = toMs(value);
  if (parsed !== null) return parsed;
  if (lagMs > 0) return now().getTime() - lagMs;
  return null;
}

function aggregateMessage(venue: string, aggregate: ReturnType<typeof aggregatePerpSyncResults>): string {
  const perSeries = ["funding", "openInterest", "liquidations"]
    .map((kind) => `${kind} ${aggregate.stats[kind as PerpSeriesKind].fetched} gelesen/${aggregate.stats[kind as PerpSeriesKind].written} geschrieben`)
    .join(", ");
  return (
    `${venue}: ${aggregate.status} — ${aggregate.runs} Lauf-Manifest(e), ${perSeries}, ` +
    `${aggregate.duplicates} Duplikat(e) ignoriert, ${aggregate.requests} Request(s), ` +
    `${aggregate.failures} Fehlbefund(e)` +
    (Object.keys(aggregate.qualityFindings).length > 0 ? `, Qualität ${JSON.stringify(aggregate.qualityFindings)}` : "")
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Instanz (global; lazy — Import ohne DATABASE_URL/Env bleibt harmlos)
// ─────────────────────────────────────────────────────────────────────────────

const globalForPerp = globalThis as typeof globalThis & { __perpDataService?: PerpDataService };

/** Geteilte Instanz (nur ohne Injektion; Tests bauen einen eigenen Service). */
export function getPerpDataService(): PerpDataService {
  globalForPerp.__perpDataService ??= new PerpDataService();
  return globalForPerp.__perpDataService;
}

/** Nur für Tests: geteilte Instanz verwerfen. */
export function resetPerpDataServiceForTests(): void {
  delete globalForPerp.__perpDataService;
}

/** Fehler der Service-Schicht (bewusst identisch zur Ablage-Klasse). */
export { PerpStoreUnavailableError };
