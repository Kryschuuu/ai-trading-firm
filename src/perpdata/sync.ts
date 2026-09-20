/**
 * Sync der Perp-Reihen (RMA-P2-02) — Backfill, inkrementell, Cursor, Limits.
 *
 * ```text
 *   Registry (nur Perpetuals)                 Capability-Matrix
 *          │                                         │
 *          ▼                                           ▼
 *   Fenster je (Instrument, Reihe) ──► Adapter ──► normalize ──► quality ──► store
 *          ▲                                                           │
 *          └───────────── perp_sync_cursors (Wasserstand) ◄────────────┘
 * ```
 *
 * ── Begrenzt, nie unendlich ─────────────────────────────────────────────────
 *   * Instrumente je Lauf ≤ `PERP_LIMITS.syncInstruments` (250),
 *   * Zeilen je Request ≤ `rowsPerRequest` (500), Requests je Reihe ≤
 *     `requestsPerSeries` (20) — ein Venue, der 10 Jahre History auf einmal
 *     will, bekommt 20 Fenster, keinen Dauerlauf,
 *   * Zeilen je Schreibbatch ≤ `batchRows` (2 000): was darüber hinausgeht,
 *     wird in **weitere Läufe** mit eigenem Manifest aufgeteilt statt in einen
 *     unendlichen.
 *
 * ── Wasserstände (Backfill-Cursor) ─────────────────────────────────────────
 *   * `BACKFILL`: Fensterbeginn = `toMs − backfillDays`, oder explizit.
 *   * `INCREMENTAL`: Fensterbeginn = Wasserstand − ein Intervall (Late-Arrivals),
 *     nie vor dem Backfill-Beginn. Ein Instrument, dessen Wasserstand das
 *     Fenstende bereits abdeckt, wird **ohne Request** übersprungen
 *     (`skippedFresh`) — der tägliche Lauf bleibt billig.
 *   * Nach einem Abbruch setzt der nächste Lauf am persistierten Wasserstand
 *     fort; wegen der Append-only-Schlüssel ist das Wiederelesen desselben
 *     Fensters duplikatfrei (Idempotenz statt Buchführung).
 *
 * ── Fehler Isoliert, nie Verschluckt ────────────────────────────────────────
 *   * transient (`UNAVAILABLE`, `retryable`) → ein Retry mit Backoff, danach
 *     `PerpSyncFailure` (stage `fetch`) und der Lauf endet `PARTIAL` — die
 *     übrigen Reihen werden trotzdem geschrieben,
 *   * `UNSUPPORTED` → kein Request, Cursor-Status `UNSUPPORTED`, im Manifest
 *     dokumentiert (Grund + Hinweis der Venue),
 *   * Normalisierungs-/Qualitätsablehnung → Zeile raus, Befund in den
 *     Quality-Report, Zähler `invalid`.
 *
 * Der Sync **schreibt nie in Positions-, Order- oder Risiko-Tabellen** und
 * berührt keine Live-Gates: er füllt ausschließlich die Perp-Reihen und seine
 * eigenen Betriebsmetadata.
 */
import { randomUUID } from "node:crypto";

import { APP_VERSION } from "../lib/version";
import type { MarketInstrument } from "../universe/types";
import { hoursToMs, PERP_BOUNDS, type PerpConfig } from "./config";
import {
  PERP_LIMITS,
  PERP_SERIES_KINDS,
  type PerpKindSyncStats,
  type PerpRow,
  type PerpSeriesKind,
  type PerpSeriesRequest,
  type PerpSyncFailure,
  type PerpSyncMode,
  type PerpSyncResult,
  type PerpSyncStatus,
  type PerpVenueCapabilities,
} from "./types";
import {
  normalizeBatch,
  normalizeFundingRow,
  normalizeLiquidationRow,
  normalizeOpenInterestRow,
  type PerpNormalizeContext,
} from "./normalize";
import {
  buildPerpQualityReport,
  perpExpectedIntervalMs,
  perpQualityBounds,
  recordPerpQualityFindings,
  savePerpQualityReport,
  validatePerpSeries,
  type PerpAnyRow,
  type PerpQualityClass,
  type PerpQualitySeriesReport,
} from "./quality";
import { perpRedactMessage } from "./errors";
import { perpRunIdempotencyKey } from "./store";
import type { PerpCommit, PerpCursor, PerpRunRecord, PerpStorePort, PerpWriteBatch } from "./ports";
import { perpFetchMethod, supportsFundingIntervals, type PerpDataAdapter, type PerpRateLimiter, type PerpSyncLogger } from "./port";

/** Konstante für die Fenster-Planung (1 h Überlappung bei Ereignisströmen). */
const LIQUIDATION_OVERLAP_MS = 3_600_000;

/** Backoff-Funktion (injizierbar; Tests nutzen `() => 0`). */
export type PerpSleep = (ms: number) => Promise<void>;

const defaultSleep: PerpSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export interface PerpSyncOptions {
  venue: string;
  adapter: PerpDataAdapter;
  store: PerpStorePort;
  config: PerpConfig;
  /** Instrumente der Venue (der Sync filtert selbst auf `marketType === "perpetual"`). */
  instruments: readonly MarketInstrument[];
  mode: PerpSyncMode;
  /** Fenstergrenzen (Epoch-ms). `fromMs` fehlt ⇒ Backfill-Fenster bzw. Cursor. */
  fromMs?: number | null;
  toMs?: number | null;
  /** Reihenarten (Default: alle drei). */
  kinds?: readonly PerpSeriesKind[];
  logger?: PerpSyncLogger;
  now?: () => Date;
  /** Zusätzlicher Rate-Limiter pro Anfrage (der Venue-Client hat seinen eigenen). */
  rateLimiter?: PerpRateLimiter;
  sleep?: PerpSleep;
  /** `true` ⇒ alles rechnen, nichts schreiben (CLI `--dry-run`). */
  dryRun?: boolean;
  /** Qualitärsbericht auf Platte schreiben (Default `true` außer Dry-Run). */
  writeQualityArtifact?: boolean;
  /** Harte Kappung der Instrumente je Lauf (Default `PERP_LIMITS.syncInstruments`). */
  maxInstruments?: number;
  /** Parallele Reihen (Default `config.concurrency`, hart ≤ 8). */
  concurrency?: number;
  /** Zweitvenue für den Cross-Check (Default: `config.crosscheckVenue`, nur Funding). */
  crosscheckAdapter?: PerpDataAdapter | null;
}

function emptyStats(): Record<PerpSeriesKind, PerpKindSyncStats> {
  return {
    funding: { fetched: 0, written: 0, duplicates: 0, invalid: 0, skippedFresh: 0, unsupported: 0 },
    openInterest: { fetched: 0, written: 0, duplicates: 0, invalid: 0, skippedFresh: 0, unsupported: 0 },
    liquidations: { fetched: 0, written: 0, duplicates: 0, invalid: 0, skippedFresh: 0, unsupported: 0 },
  };
}

function emptyFindings(): Record<PerpQualityClassKey, number> {
  return { GAP: 0, OUTLIER: 0, INVALID: 0, DUPLICATE: 0, CROSSCHECK: 0, STALE: 0 };
}

/** Metrik-/Report-tauglicher Schlüssel (identisch zu den Report-Klassen). */
type PerpQualityClassKey = PerpQualityClass;

function countOf(counts: Record<PerpQualityClassKey, number>, cls: PerpQualityClassKey, by = 1): void {
  counts[cls] = (counts[cls] ?? 0) + by;
}

/** Nur Perpetuals dieser Venue (Out-of-Scope: Spot-Instrumente). */
export function selectPerpInstruments(
  instruments: readonly MarketInstrument[],
  venue: string
): { perpetual: MarketInstrument[]; notPerpetual: number } {
  const perpetual: MarketInstrument[] = [];
  let notPerpetual = 0;
  for (const instrument of instruments) {
    if (instrument.venue !== venue) continue;
    if (instrument.marketType !== "perpetual") {
      notPerpetual += 1;
      continue;
    }
    perpetual.push(instrument);
  }
  perpetual.sort((a, b) => a.id.localeCompare(b.id));
  return { perpetual, notPerpetual };
}

/** Fenster einer (Instrument, Reihe)-Abfrage inklusive Wasserstand. */
export function planPerpWindow(input: {
  kind: PerpSeriesKind;
  mode: PerpSyncMode;
  config: PerpConfig;
  cursor: PerpCursor | null;
  windowFromMs: number;
  windowToMs: number;
}): { fromMs: number; toMs: number; skippedFresh: boolean } {
  const { kind, mode, config, cursor, windowFromMs, windowToMs } = input;
  const intervalMs = perpExpectedIntervalMs(kind, config) || LIQUIDATION_OVERLAP_MS;
  if (mode === "INCREMENTAL" && cursor !== null) {
    const coveredUntil = cursor.watermarkEventTime.getTime();
    if (coveredUntil + intervalMs >= windowToMs) {
      // Der Bestand deckt das erwartete letzte Settlement bereits ab: kein Request.
      return { fromMs: windowToMs, toMs: windowToMs, skippedFresh: true };
    }
    // Ein Intervall Überlappung: Late-Arrivals (Korrekturen, verspätete
    // Settlements) werden erneut gelesen; die Append-only-Schlüssel machen das
    // doppelfreie Wiederelesen billig.
    const fromMs = Math.max(windowFromMs, coveredUntil - intervalMs);
    return { fromMs, toMs: windowToMs, skippedFresh: false };
  }
  return { fromMs: windowFromMs, toMs: windowToMs, skippedFresh: false };
}

/** Wiederverwendbarer Normalisierungs-Kontext einer Reihe. */
function normalizeContext(input: {
  venue: string;
  instrument: MarketInstrument;
  sourceId: string;
  fetchedAt: Date;
  config: PerpConfig;
  epochUnit?: "ms" | "s";
  defaultIntervalHours?: number | null;
  limit: number;
}): PerpNormalizeContext {
  return {
    venue: input.venue,
    instrumentId: input.instrument.id,
    symbol: input.instrument.symbol,
    sourceId: input.sourceId,
    fetchedAt: input.fetchedAt,
    availabilityPolicy: input.config.availabilityPolicy,
    maxAbsFundingRate: input.config.maxAbsFundingRate,
    epochUnit: input.epochUnit ?? "ms",
    limit: input.limit,
    defaultIntervalHours: input.defaultIntervalHours ?? null,
    quoteCurrency: input.instrument.quote ?? null,
    contractSize: null,
  };
}

/** Normalisiert je Reihenart (die einzigen Stellen, die Fremdformen kennen). */
function normalizeRows(
  kind: PerpSeriesKind,
  rawRows: readonly unknown[],
  ctx: PerpNormalizeContext
): {
    rows: PerpRow[];
    duplicates: number;
    truncated: boolean;
    rejected: number;
    /** davon „gemeldet, aber fachlich unmöglich“ (INVALID, kein Loch). */
    invalidRejected: number;
  } {
  const mapOne =
    kind === "funding"
      ? (raw: unknown, index: number) => normalizeFundingRow(raw as never, index, ctx)
      : kind === "openInterest"
        ? (raw: unknown, index: number) => normalizeOpenInterestRow(raw as never, index, ctx)
        : (raw: unknown, index: number) => normalizeLiquidationRow(raw as never, index, ctx);
  const result = normalizeBatch(rawRows, mapOne as never, { limit: ctx.limit });
  return {
    rows: result.rows as unknown as PerpRow[],
    duplicates: result.duplicates,
    truncated: result.truncated,
    rejected: result.rejected.length,
    invalidRejected: result.rejected.filter((entry) => entry.reason === "INVALID_MEASURE").length,
  };
}

/** Setzt den Qualitätsstatus einer Zeile (Zeilen sind unveränderlich → Kopie). */
function withStatus<T extends PerpRow>(row: T, status: T["qualityStatus"]): T {
  if (row.qualityStatus === status) return row;
  return { ...row, qualityStatus: status };
}

/**
 * Sync einer Venue.
 *
 * Rückgabe: ein Eintrag je Manifest (Schreibbatch). Ein Lauf über 250
 * Instrumente mit langem Backfill sind definitionsgemäß mehr als ein Batch —
 * die Aufteilung ist Sichtbar, nicht versteckt: jedes Manifest trägt sein
 * eigenes Fenster, seinen Idempotenzschlüssel und seine Zähler.
 */
export async function syncPerpVenue(options: PerpSyncOptions): Promise<PerpSyncResult[]> {
  const config = options.config;
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? defaultSleep;
  const log = options.logger ?? (() => undefined);
  const startedAt = now();
  const kinds = options.kinds && options.kinds.length > 0 ? [...options.kinds] : [...PERP_SERIES_KINDS];
  const concurrency = Math.max(1, Math.min(options.concurrency ?? config.concurrency, PERP_BOUNDS.concurrency.max));

  const toMsRaw = options.toMs ?? now().getTime() - config.safetyLagMs;
  // Sicherheits-Nachlauf gilt auch für eine explizite Obergrenze: ein
  // Settlement, das noch nicht abgeschlossen sein kann, wird nicht angefragt.
  const toMs = Math.min(toMsRaw, now().getTime() - config.safetyLagMs);
  const backfillFromMs = toMs - config.backfillDays * 86_400_000;
  const windowFromMs = options.fromMs ?? backfillFromMs;
  if (!Number.isFinite(toMs) || !Number.isFinite(windowFromMs) || windowFromMs >= toMs) {
    throw new RangeError(`perp sync: ungültiges Fenster [${windowFromMs}, ${toMs}).`);
  }

  const selected = selectPerpInstruments(options.instruments, options.venue);
  const cap = Math.max(0, Math.min(options.maxInstruments ?? PERP_LIMITS.syncInstruments, PERP_LIMITS.syncInstruments));
  const instruments = selected.perpetual.slice(0, cap);
  const truncatedScope = selected.perpetual.length - instruments.length;
  if (truncatedScope > 0) {
    log("warn", `${options.venue}: Instrumentenliste auf ${cap} gekappt (${truncatedScope} übersprungen — --max-instruments).`);
  }

  const capabilities: PerpVenueCapabilities = {
    venue: options.venue,
    funding: options.adapter.capabilities.funding,
    openInterest: options.adapter.capabilities.openInterest,
    liquidations: options.adapter.capabilities.liquidations,
  };
  const stats = emptyStats();
  const findings = emptyFindings();
  const failures: PerpSyncFailure[] = [];
  const seriesReports: PerpQualitySeriesReport[] = [];
  const watermarks: PerpSyncResult["watermarks"] = [];
  let requests = 0;

  // Intervall-Metadaten (Bulk, EIN Request je Lauf) — nur bei Unterstützung.
  const intervalInfo = new Map<string, { intervalHours: number | null }>();
  if (kinds.includes("funding") && supportsFundingIntervals(options.adapter)) {
    try {
      const info = await options.adapter.readFundingIntervals(instruments.map((instrument) => instrument.symbol));
      for (const [symbol, entry] of info) intervalInfo.set(symbol.toUpperCase(), { intervalHours: entry.intervalHours });
      requests += 1;
    } catch (error) {
      // Metadaten sind optional: ihr Fehlen wechselt nichts an den Daten, wird
      // aber dokumentiert (kein Rate-Raten ohne Meldung).
      failures.push({
        stage: "capability",
        kind: "funding",
        reason: "SCHEMA_MISMATCH",
        message: `Intervall-Metadaten nicht lesbar (${String((error as Error).message ?? "").slice(0, 120)})`,
        retryable: true,
      });
    }
  }

  const cursorRows = await options.store.readCursors({
    venue: options.venue,
    instrumentIds: instruments.map((instrument) => instrument.id),
  });
  const cursorByKey = new Map<string, PerpCursor>();
  for (const cursor of cursorRows) cursorByKey.set(`${cursor.instrumentId}|${cursor.kind}`, cursor);

  interface SeriesOutcome {
    instrumentId: string;
    kind: PerpSeriesKind;
    rows: PerpRow[];
    cursor: PerpCursor;
    truncated: boolean;
  }
  const outcomes: SeriesOutcome[] = [];

  const jobQueue: { instrument: MarketInstrument; kind: PerpSeriesKind }[] = [];
  for (const instrument of instruments) {
    for (const kind of kinds) jobQueue.push({ instrument, kind });
  }

  let cursorIndex = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const job = jobQueue[cursorIndex++];
      if (job === undefined) return;
      const { instrument, kind } = job;
      const capability = capabilities[kind];
      if (!capability.supported) {
        // Kein Request, kein Daten-Satz: `UNSUPPORTED` ist eine Aussage über die
        // Venue, nicht über den Markt.
        stats[kind].unsupported += 1;
        outcomes.push({
          instrumentId: instrument.id,
          kind,
          rows: [],
          cursor: {
            venue: options.venue,
            instrumentId: instrument.id,
            kind,
            watermarkEventTime: new Date(windowFromMs),
            watermarkAvailableAt: new Date(windowFromMs),
            lastRunId: null,
            consecutiveFailures: 0,
            lastStatus: "UNSUPPORTED",
            unsupportedReason: capability.reason,
          },
          truncated: false,
        });
        continue;
      }

      const plan = planPerpWindow({
        kind,
        mode: options.mode,
        config,
        cursor: cursorByKey.get(`${instrument.id}|${kind}`) ?? null,
        windowFromMs,
        windowToMs: toMs,
      });
      if (plan.skippedFresh) {
        stats[kind].skippedFresh += 1;
        continue;
      }

      const method = perpFetchMethod(options.adapter, kind);
      const collected: unknown[] = [];
      let fromMs = plan.fromMs;
      let truncated = false;
      let unavailable: PerpSyncFailure | null = null;
      let unsupported = false;

      for (let attempt = 0; attempt < PERP_LIMITS.requestsPerSeries; attempt += 1) {
        const request: PerpSeriesRequest = {
          symbol: instrument.symbol,
          fromMs,
          toMs,
          limit: PERP_LIMITS.rowsPerRequest,
        };
        let result: Awaited<ReturnType<typeof method>> | null = null;
        let lastError = "";
        for (let retry = 0; retry <= 1; retry += 1) {
          if (options.rateLimiter) await options.rateLimiter();
          requests += 1;
          try {
            result = await method(request);
          } catch (error) {
            // Der Adapter darf werfen (Transportfehler); hier wird klassifiziert —
            // redigiert, weil der Text im Lauf-Manifest persistiert wird
            // (keine URLs, keine Keys, keine Rohtexte der Venue).
            lastError = perpRedactMessage((error as Error).message ?? "", 140);
            result = null;
          }
          if (
            result !== null &&
            result.availability === "UNAVAILABLE" &&
            result.retryable &&
            retry === 0
          ) {
            // Rate-Limit/Timeout: ein Rückzug mit Backoff, bevor der Fehlbefund
            // steht. Der Wasserstand rückt in beiden Fällen nicht — ein
            // bleibender Ausfall wird im nächsten Lauf nachgeholt, nicht
            // übersprungen (at-least-once mit Überlappung statt Lücke).
            await sleep(500);
            continue;
          }
          if (result !== null) break;
          if (retry === 0) {
            await sleep(250 * (retry + 1));
            log("warn", `${options.venue} ${instrument.symbol} ${kind}: Abruf fehlgeschlagen (${lastError || "Adapterfehler"}) — ein Retry.`);
          }
        }
        if (result === null) {
          unavailable = {
            stage: "fetch",
            kind,
            instrumentId: instrument.id,
            reason: "NETWORK",
            message: lastError || "Adapter ohne Antwort (Transportfehler nach Retry).",
            retryable: true,
          };
          break;
        }
        if (result.availability === "UNSUPPORTED") {
          unsupported = true;
          break;
        }
        if (result.availability === "UNAVAILABLE") {
          unavailable = {
            stage: "fetch",
            kind,
            instrumentId: instrument.id,
            reason: result.reason,
            message: `Venue meldet ${result.reason}${result.httpStatus ? ` (HTTP ${result.httpStatus})` : ""}.`,
            retryable: result.retryable,
            ...(result.httpStatus !== undefined ? { httpStatus: result.httpStatus } : {}),
          };
          break;
        }
        const series = result.series;
        collected.push(...series.rows);
        truncated = series.truncated;
        if (series.rows.length === 0) break;
        const lastEventMs = series.rows.reduce(
          (max, row) => Math.max(max, typeof (row as { eventTime?: unknown }).eventTime === "number" ? (row as { eventTime: number }).eventTime : max),
          fromMs
        );
        if (!series.truncated) break;
        // Fenster schiebt vorwärts; der Requests-Budget begrenzt den Dauerlauf.
        fromMs = Math.min(lastEventMs + 1, toMs);
        if (fromMs >= toMs) break;
      }

      if (unsupported) {
        stats[kind].unsupported += 1;
        outcomes.push({
          instrumentId: instrument.id,
          kind,
          rows: [],
          cursor: {
            venue: options.venue,
            instrumentId: instrument.id,
            kind,
            watermarkEventTime: new Date(windowFromMs),
            watermarkAvailableAt: new Date(windowFromMs),
            lastRunId: null,
            consecutiveFailures: 0,
            lastStatus: "UNSUPPORTED",
            unsupportedReason: "NO_PUBLIC_ENDPOINT",
          },
          truncated: false,
        });
        continue;
      }
      if (unavailable !== null) {
        failures.push(unavailable);
        stats[kind].invalid += 0;
        outcomes.push({
          instrumentId: instrument.id,
          kind,
          rows: [],
          cursor: {
            venue: options.venue,
            instrumentId: instrument.id,
            kind,
            watermarkEventTime: new Date(plan.fromMs),
            watermarkAvailableAt: new Date(plan.fromMs),
            lastRunId: null,
            consecutiveFailures: (cursorByKey.get(`${instrument.id}|${kind}`)?.consecutiveFailures ?? 0) + 1,
            lastStatus: "FAILED",
            unsupportedReason: null,
          },
          truncated: false,
        });
        continue;
      }

      const fetchedAt = now();
      const ctx = normalizeContext({
        venue: options.venue,
        instrument,
        sourceId: `${options.venue.toLowerCase()}:${kind}`,
        fetchedAt,
        config,
        defaultIntervalHours: intervalInfo.get(instrument.symbol.toUpperCase())?.intervalHours ?? null,
        limit: PERP_LIMITS.batchRows,
      });
      const normalized = normalizeRows(kind, collected, ctx);
      let pendingInvalid = 0;
      stats[kind].fetched += collected.length;
      stats[kind].duplicates += normalized.duplicates;
      stats[kind].invalid += normalized.rejected;
      if (normalized.invalidRejected > 0) {
        // Abgewiesene, aber gemeldete Unsinnswerte (negatives OI) sind ein
        // Qualitätsbefund der Reihe: sie zählen in die Klasse `INVALID` und
        // blockieren damit in `strict` — sonst verschwinde n ein Ausreißer
        // sang- und klanglos zwischen Adapter und Ablage.
        countOf(findings, "INVALID", normalized.invalidRejected);
        pendingInvalid += normalized.invalidRejected;
      }
      if (normalized.truncated) {
        truncated = true;
        failures.push({
          stage: "normalize",
          kind,
          instrumentId: instrument.id,
          reason: "LIMIT_EXCEEDED",
          message: `Antwortkappung: ${collected.length} Zeilen über dem Batch-Deckel ${PERP_LIMITS.batchRows}.`,
          retryable: false,
        });
      }

      const validation = validatePerpSeries({
        venue: options.venue,
        instrumentId: instrument.id,
        kind,
        rows: normalized.rows as readonly PerpAnyRow[],
        asOfMs: toMs,
        config,
      });
      if (pendingInvalid > 0) {
        validation.report.counts.INVALID += pendingInvalid;
        validation.report.findings.push({
          cls: "INVALID",
          detail: `${pendingInvalid} Zeile(n) von der Normalisierung als unplausibel abgewiesen (negativer Messwert).`,
        });
        validation.report.rows += pendingInvalid;
      }
      for (const [cls, count] of Object.entries(validation.report.counts)) {
        if (count > 0) countOf(findings, cls as PerpQualityClassKey, count);
      }
      seriesReports.push(validation.report);
      const rejectedByQuality = normalized.rows.length - validation.accepted.length;
      if (rejectedByQuality > 0) {
        stats[kind].invalid += rejectedByQuality;
        failures.push({
          stage: "quality",
          kind,
          instrumentId: instrument.id,
          reason: "QUALITY_INVALID",
          message: `${rejectedByQuality} Zeile(n) von der Qualitätsschicht abgewiesen.`,
          retryable: false,
        });
      }
      const rows = validation.accepted.map((row, index) => {
        const status = validation.statuses.get(index);
        return status === undefined ? (row as PerpRow) : withStatus(row as PerpRow, status);
      });
      const latest = rows.reduce<PerpRow | null>((best, row) => (best === null || row.eventTime > best.eventTime ? row : best), null);
      outcomes.push({
        instrumentId: instrument.id,
        kind,
        rows,
        cursor: {
          venue: options.venue,
          instrumentId: instrument.id,
          kind,
          watermarkEventTime: latest ? latest.eventTime : new Date(plan.fromMs),
          watermarkAvailableAt: latest ? latest.availableAt : new Date(plan.fromMs),
          lastRunId: null,
          consecutiveFailures: 0,
          lastStatus: truncated ? "PARTIAL" : "OK",
          unsupportedReason: null,
        },
        truncated,
      });
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  // ── Batches bilden (vollständige Reihen, Zeilendeckel je Manifest) ───────
  const batches: { instruments: Set<string>; batch: PerpWriteBatch; cursors: PerpCursor[]; fromMs: number; toMs: number }[] = [];
  let current = newBatch();
  function newBatch() {
    return {
      instruments: new Set<string>(),
      batch: { funding: [], openInterest: [], liquidations: [] } as PerpWriteBatch,
      cursors: [] as PerpCursor[],
      fromMs: toMs,
      toMs: windowFromMs,
    };
  }
  function flush() {
    if (current.batch.funding.length + current.batch.openInterest.length + current.batch.liquidations.length === 0 && current.cursors.length === 0) {
      return;
    }
    batches.push(current);
    current = newBatch();
  }
  const push = (outcome: SeriesOutcome): void => {
    const size = current.batch.funding.length + current.batch.openInterest.length + current.batch.liquidations.length;
    if (size > 0 && size + outcome.rows.length > PERP_LIMITS.batchRows) flush();
    const list = current.batch[outcome.kind] as unknown as PerpRow[];
    list.push(...outcome.rows);
    current.batch[outcome.kind] = list as never;
    current.cursors.push(outcome.cursor);
    current.instruments.add(outcome.instrumentId);
    current.fromMs = Math.min(current.fromMs, outcome.cursor.watermarkEventTime.getTime());
    current.toMs = Math.max(current.toMs, toMs);
  };
  outcomes.sort((a, b) => a.instrumentId.localeCompare(b.instrumentId) || a.kind.localeCompare(b.kind));
  for (const outcome of outcomes) push(outcome);
  flush();

  // ── Commits ──────────────────────────────────────────────────────────────
  const strictMode = config.qualityMode === "strict";
  const blocked = new Set<string>();
  if (strictMode) {
    for (const report of seriesReports) {
      const blocking = (report.counts.INVALID ?? 0) + (report.counts.DUPLICATE ?? 0);
      if (blocking > 0) blocked.add(`${report.instrumentId}|${report.kind}`);
    }
  }
  const qualityReport = buildPerpQualityReport(seriesReports, config.qualityMode, perpQualityBounds(config), now());
  if (!options.dryRun && options.writeQualityArtifact !== false) {
    try {
      savePerpQualityReport(qualityReport);
    } catch (error) {
      log("warn", `Qualitätsreport konnte nicht geschrieben werden: ${String((error as Error).message).slice(0, 120)}`);
    }
  }
  recordPerpQualityFindings(qualityReport);

  const results: PerpSyncResult[] = [];
  let batchIndex = 0;
  for (const batch of batches) {
    batchIndex += 1;
    // `strict`: belastete Reihen bleiben ungeschrieben. Entscheidend ist die
    // zweihälfte davon: ihr Wasserstand rückt **nicht** nach — sonst wäre das
    // Fenster dauerhaft übersprungen und der Befund zur Lücke geworden.
    const batchRows: Record<PerpSeriesKind, readonly PerpRow[]> = strictMode
      ? {
          funding: (batch.batch.funding as readonly PerpRow[]).filter((row) => !blocked.has(`${row.instrumentId}|funding`)),
          openInterest: (batch.batch.openInterest as readonly PerpRow[]).filter(
            (row) => !blocked.has(`${row.instrumentId}|openInterest`)
          ),
          liquidations: (batch.batch.liquidations as readonly PerpRow[]).filter(
            (row) => !blocked.has(`${row.instrumentId}|liquidations`)
          ),
        }
      : {
          funding: batch.batch.funding as readonly PerpRow[],
          openInterest: batch.batch.openInterest as readonly PerpRow[],
          liquidations: batch.batch.liquidations as readonly PerpRow[],
        };
    const batchCursors = strictMode
      ? batch.cursors.filter((cursor) => !blocked.has(`${cursor.instrumentId}|${cursor.kind}`))
      : batch.cursors;
    const batchKinds = kinds.filter(
      (kind) =>
        (batchRows[kind] as readonly unknown[]).length > 0 ||
        batchCursors.some((cursor) => cursor.kind === kind)
    );
    const instrumentIds = [...batch.instruments].sort();
    const idempotencyKey = perpRunIdempotencyKey({
      venue: options.venue,
      mode: options.mode,
      fromMs: batch.fromMs,
      toMs: batch.toMs,
      instrumentIds,
      kinds: batchKinds,
      availabilityPolicy: config.availabilityPolicy,
      codeVersion: APP_VERSION,
    });
    const runStats = emptyStats();
    // Laufweite Zähler (unsupported/skippedFresh/invalid) gehören zum Lauf,
    // nicht zu einem Manifest: sie werden auf dem ersten Manifest getragen,
    // damit sie in Aggregat, CLI und API sichtbar bleiben (und nicht
    // doppelt zählen).
    if (batchIndex === 1) {
      for (const kind of PERP_SERIES_KINDS) {
        runStats[kind].unsupported = stats[kind].unsupported;
        runStats[kind].skippedFresh = stats[kind].skippedFresh;
        runStats[kind].invalid = stats[kind].invalid;
      }
    }
    const batchFindings = emptyFindings();
    let writtenRows = 0;
    for (const kind of batchKinds) {
      const rows = batchRows[kind];
      runStats[kind].fetched = rows.length;
      writtenRows += rows.length;
    }
    for (const report of seriesReports) {
      if (!batch.instruments.has(report.instrumentId)) continue;
      for (const [cls, count] of Object.entries(report.counts)) {
        if (count > 0) countOf(batchFindings, cls as PerpQualityClassKey, count);
      }
    }
    let status: PerpSyncStatus = failures.length > 0 || writtenRows === 0 ? "PARTIAL" : "SUCCEEDED";
    const runId = randomUUID();
    const finishedAt = now();
    const run: PerpRunRecord = {
      id: runId,
      idempotencyKey,
      venue: options.venue,
      mode: options.mode,
      status,
      availabilityPolicy: config.availabilityPolicy,
      fromTs: new Date(batch.fromMs),
      toTs: new Date(batch.toMs),
      kinds: batchKinds,
      instrumentIds,
      counts: {
        ...runStats,
        qualityFindings: batchFindings,
        revisionConflicts: 0,
        rejectedRows: 0,
        requests,
      },
      capabilities: {
        funding: capabilities.funding,
        openInterest: capabilities.openInterest,
        liquidations: capabilities.liquidations,
      },
      failures,
      codeVersion: APP_VERSION,
      errorCode: null,
      startedAt,
      finishedAt,
    };

    if (options.dryRun) {
      results.push({
        venue: options.venue,
        mode: options.mode,
        status,
        availabilityPolicy: config.availabilityPolicy,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        instruments: instrumentIds.length,
        notPerpetual: selected.notPerpetual,
        qualityFindings: batchFindings as PerpSyncResult["qualityFindings"],
        stats: runStats,
        capabilities: run.capabilities,
        failures,
        requests,
        idempotencyKey,
        replayed: false,
        runId: null,
        watermarks: batchCursors.map((cursor) => ({
          instrumentId: cursor.instrumentId,
          kind: cursor.kind,
          watermarkEventTime: cursor.watermarkEventTime.toISOString(),
          watermarkAvailableAt: cursor.watermarkAvailableAt.toISOString(),
        })),
      });
      continue;
    }

    const commit: PerpCommit = {
      run,
      batch: { funding: batchRows.funding, openInterest: batchRows.openInterest, liquidations: batchRows.liquidations } as PerpWriteBatch,
      cursors: batchCursors,
    };
    const outcome = await options.store.commitRun(commit);
    if (outcome.revisionConflicts > 0) {
      // Die Manifest-Zähler können die Revision des eigenen Laufs nicht mehr
      // enthalten (sie werden vor dem Commit gebildet) — der durable Nachweis
      // ist das Audit-Event `PERP_DATA_REVISION_DETECTED`; hier wird der Lauf
      // zusätzlich als Teilerfolg markiert, damit `--status` ihn zeigt.
      failures.push({
        stage: "persist",
        kind: "funding",
        reason: "ROW_REJECTED",
        message: `${outcome.revisionConflicts} abweichende(r) Satz/Sätze zum selben Schlüssel (Revision, nicht überschrieben).`,
        retryable: false,
      });
      status = "PARTIAL";
    }
    for (const kind of batchKinds) {
      runStats[kind].written = outcome.inserted[kind];
      runStats[kind].duplicates += outcome.duplicates[kind];
    }
    for (const cursor of batchCursors) {
      watermarks.push({
        instrumentId: cursor.instrumentId,
        kind: cursor.kind,
        watermarkEventTime: cursor.watermarkEventTime.toISOString(),
        watermarkAvailableAt: cursor.watermarkAvailableAt.toISOString(),
      });
    }
    results.push({
      venue: options.venue,
      mode: options.mode,
      status,
      availabilityPolicy: config.availabilityPolicy,
      startedAt: startedAt.toISOString(),
      finishedAt: now().toISOString(),
      instruments: instrumentIds.length,
      notPerpetual: selected.notPerpetual,
      qualityFindings: batchFindings as PerpSyncResult["qualityFindings"],
      stats: runStats,
      capabilities: run.capabilities,
      failures,
      requests,
      idempotencyKey,
      replayed: !outcome.created,
      runId: outcome.runId,
      watermarks: batch.cursors.map((cursor) => ({
        instrumentId: cursor.instrumentId,
        kind: cursor.kind,
        watermarkEventTime: cursor.watermarkEventTime.toISOString(),
        watermarkAvailableAt: cursor.watermarkAvailableAt.toISOString(),
      })),
    });
    log(
      status === "SUCCEEDED" ? "info" : "warn",
      `${options.venue}: ${writtenRows} Zeile(n) über ${instrumentIds.length} Instrument(e) geschrieben (${outcome.inserted.funding} funding, ${outcome.inserted.openInterest} oi, ${outcome.inserted.liquidations} liq)${outcome.created ? "" : " — Replay (Idempotenzschlüssel vorhanden)"}`
    );
  }

  if (results.length === 0) {
    // Kein Schreibbedarf (alles frisch oder keine Instrumente): ein
    // Leer-Lauf wird trotzdem dokumentiert, damit `--status` ihn sieht.
    log("info", `${options.venue}: nichts zu schreiben (Bestand frisch oder kein Perp-Instrument im Scope).`);
    results.push({
      venue: options.venue,
      mode: options.mode,
      status: failures.length > 0 ? "PARTIAL" : "SUCCEEDED",
      availabilityPolicy: config.availabilityPolicy,
      startedAt: startedAt.toISOString(),
      finishedAt: now().toISOString(),
      instruments: instruments.length,
      notPerpetual: selected.notPerpetual,
      qualityFindings: findings as PerpSyncResult["qualityFindings"],
      stats,
      capabilities,
      failures,
      requests,
      idempotencyKey: perpRunIdempotencyKey({
        venue: options.venue,
        mode: options.mode,
        fromMs: windowFromMs,
        toMs,
        instrumentIds: instruments.map((instrument) => instrument.id),
        kinds,
        availabilityPolicy: config.availabilityPolicy,
        codeVersion: APP_VERSION,
      }),
      replayed: false,
      runId: null,
      watermarks,
    });
  }

  if (blocked.size > 0) {
    log("warn", `${options.venue}: strict-Modus — ${blocked.size} Reihe(n) mit Strukturverstößen bleiben ungeschrieben.`);
  }
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Aggregate über die Manifeste eines Laufs (CLI/API-Status)
// ─────────────────────────────────────────────────────────────────────────────

export function aggregatePerpSyncResults(results: readonly PerpSyncResult[]): {
  status: PerpSyncStatus;
  stats: Record<PerpSeriesKind, PerpKindSyncStats>;
  qualityFindings: Record<PerpQualityClassKey, number>;
  duplicates: number;
  fetched: number;
  requests: number;
  runs: number;
  instruments: number;
  failures: number;
} {
  const stats = emptyStats();
  const qualityFindings = emptyFindings();
  let requests = 0;
  let failures = 0;
  let instruments = 0;
  let duplicates = 0;
  let fetched = 0;
  let hasPartial = false;
  for (const result of results) {
    for (const kind of PERP_SERIES_KINDS) {
      const entry = result.stats[kind];
      stats[kind].fetched += entry.fetched;
      stats[kind].written += entry.written;
      stats[kind].duplicates += entry.duplicates;
      stats[kind].invalid += entry.invalid;
      stats[kind].skippedFresh += entry.skippedFresh;
      stats[kind].unsupported += entry.unsupported;
      duplicates += entry.duplicates;
      fetched += entry.fetched;
    }
    for (const [cls, count] of Object.entries(result.qualityFindings)) {
      if (typeof count === "number" && count > 0) countOf(qualityFindings, cls as PerpQualityClassKey, count);
    }
    requests += result.requests;
    instruments += result.instruments;
    failures += result.failures.length;
    if (result.status !== "SUCCEEDED") hasPartial = true;
  }
  return {
    status: results.length === 0 ? "FAILED" : hasPartial ? "PARTIAL" : "SUCCEEDED",
    stats,
    qualityFindings,
    duplicates,
    fetched,
    requests,
    runs: results.length,
    instruments,
    failures,
  };
}

/** Nur für Diagnosezwecke exportiert: Fensterlänge einer Reihe. */
export function perpOverlapMs(kind: PerpSeriesKind, config: PerpConfig): number {
  return perpExpectedIntervalMs(kind, config) || LIQUIDATION_OVERLAP_MS;
}

/** Intervall in Stunden, das der Sync als erwartet annimmt (Replay-Herleitung). */
export function perpExpectedFundingIntervalHours(config: PerpConfig): number {
  return hoursToMs(config.fundingIntervalHours) / 3_600_000;
}
