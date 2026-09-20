/**
 * Ablage für historische Perpetual-Daten (RMA-P2-02, v1.54.0) — Drizzle/Postgres.
 *
 * Vier Eigenschaften, die dieses Modul gegenüber einem einfachen INSERT
 * verantwortet:
 *
 *  1. **Append-only.** Identische Sätze werden ignoriert
 *     (`ON CONFLICT DO NOTHING`); abweichende Sätze zum selben natürlichen
 *     Schlüssel werden **nicht überschrieben**, sondern als `revisions` gezählt
 *     und im Audit protokolliert (`PERP_DATA_REVISION_DETECTED`). Der
 *     gespeicherte Satz bleibt die Wahrheit, die er zum Schreibzeitpunkt war.
 *  2. **Atomar je Lauf.** Manifest + Zeilen + Wasserstände stehen in EINER
 *     Transaktion: entweder ist der Lauf vollständig (inklusive Cursor)
 *     sichtbar oder gar nicht. Ein Absturz hinterlässt keinen halben
 *     Wasserstand; ein Neustart setzt lückenlos und duplikatfrei fort.
 *  3. **Idempotenter Retry.** `perp_sync_runs.idempotency_key` ist UNIQUE —
 *     ein Lauf mit identischen Eingaben (Venue, Modus, Fenster, Instrumente,
 *     Reihenarten, Verfügbarkeitspolitik, Code-Version) schreibt 0 Zeilen und
 *     meldet `created: false`. Ein zuvor FEHLGESCHLAGENER Lauf mit demselben
 *     Schlüssel darf dasselbe Manifest erneut füllen (Retry nach Netzwerkfehler).
 *  4. **Kein Stille-Fallback.** Erreichbarkeit ist Voraussetzung: ein
 *     Datenbankfehler wird als `perp:store_unavailable` klassifiziert und
 *     geworfen — nie in leere Ergebnismengen übersetzt.
 *
 * Rohe Venue-Nutzdaten werden **nie** persistiert — nur normalisierte Zeilen,
 * ihr inhaltsbezogener Fingerprint und klassifizierte Fehler.
 */
import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";

import { db } from "../db";
import {
  perpFundingRates,
  perpLiquidations,
  perpOpenInterest,
  perpSyncCursors,
  perpSyncRuns,
} from "../db/schema";
import { auditWrite, type AuditLevel } from "../lib/auditSink";
import { metricLabel, telemetry } from "../lib/telemetry";
import { APP_VERSION } from "../lib/version";
import { perpRowKey } from "./normalize";
import { PerpDataError, PerpStoreUnavailableError } from "./errors";
import type {
  PerpCommit,
  PerpCommitResult,
  PerpCoverage,
  PerpCursor,
  PerpRunRecord,
  PerpStorePort,
  PerpWriteBatch,
} from "./ports";
import {
  PERP_LIMITS,
  type PerpFundingRow,
  type PerpLiquidationRow,
  type PerpOpenInterestRow,
  type PerpSeriesKind,
  type PerpSeriesQuery,
} from "./types";

/** Datenbank-Handle (injizierbar für Tests und Transaktionen). */
export type PerpDb = Pick<typeof db, "select" | "insert" | "update" | "delete" | "execute" | "transaction">;

/** Audit-Senke (injizierbar; Default `auditWrite`, Klasse `telemetry`). */
export type PerpAuditSink = (
  event: string,
  level: AuditLevel,
  detail: Record<string, unknown>,
  opts?: Parameters<typeof auditWrite>[3]
) => Promise<unknown>;

export interface PerpStoreDeps {
  db?: PerpDb;
  audit?: PerpAuditSink;
  /** Zeilen je Insert-Chunk (Parameterdeckel). */
  chunkSize?: number;
  now?: () => Date;
}

/** Fehler der Persistenz (maschinelle Codes für API/Betrieb). */
export class PerpPersistenceError extends PerpDataError {}

const DEFAULT_CHUNK = PERP_LIMITS.insertChunkRows;
const SERIES_KINDS: readonly PerpSeriesKind[] = ["funding", "openInterest", "liquidations"];

/** Schlüssel + Inhalt einer Zeile (für Dedup und Revisionsvergleich). */
interface PerpRowKeyed {
  kind: PerpSeriesKind;
  venue: string;
  instrumentId: string;
  eventTime: Date;
  sourceEventId?: string;
  contentHash: string;
}

/** Spaltengriff einer Perp-Datentabelle (für as-of-Filter und Hash-Reads). */
interface PerpTableHandle {
  table: PgTable;
  venue: PgColumn;
  instrumentId: PgColumn;
  eventTime: PgColumn;
  availableAt: PgColumn;
  contentHash: PgColumn;
  missingReason: PgColumn;
  qualityStatus: PgColumn;
  sourceEventId?: PgColumn;
}

function handleFor(kind: PerpSeriesKind): PerpTableHandle {
  if (kind === "funding") {
    return {
      table: perpFundingRates,
      venue: perpFundingRates.venue,
      instrumentId: perpFundingRates.instrumentId,
      eventTime: perpFundingRates.eventTime,
      availableAt: perpFundingRates.availableAt,
      contentHash: perpFundingRates.contentHash,
      missingReason: perpFundingRates.missingReason,
      qualityStatus: perpFundingRates.qualityStatus,
    };
  }
  if (kind === "openInterest") {
    return {
      table: perpOpenInterest,
      venue: perpOpenInterest.venue,
      instrumentId: perpOpenInterest.instrumentId,
      eventTime: perpOpenInterest.eventTime,
      availableAt: perpOpenInterest.availableAt,
      contentHash: perpOpenInterest.contentHash,
      missingReason: perpOpenInterest.missingReason,
      qualityStatus: perpOpenInterest.qualityStatus,
    };
  }
  return {
    table: perpLiquidations,
    venue: perpLiquidations.venue,
    instrumentId: perpLiquidations.instrumentId,
    eventTime: perpLiquidations.eventTime,
    availableAt: perpLiquidations.availableAt,
    contentHash: perpLiquidations.contentHash,
    missingReason: perpLiquidations.missingReason,
    qualityStatus: perpLiquidations.qualityStatus,
    sourceEventId: perpLiquidations.sourceEventId,
  };
}

function emptyKindCounts(): Record<PerpSeriesKind, number> {
  return { funding: 0, openInterest: 0, liquidations: 0 };
}

function chunk<T>(rows: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/** `numeric` kommt als String zurück — die Fachschicht rechnet in `number`. */
function toNum(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toDate(value: Date | string, field: string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new PerpPersistenceError("value:invalid", `Zeitfeld "${field}" ist kein gültiger Zeitpunkt.`, { field });
  }
  return date;
}

// ─────────────────────────────────────────────────────────────────────────────
// Idempotenzschlüssel und Zeilenabbildung (rein, ohne IO testbar)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Idempotenzschlüssel eines Laufs: `prk1:<sha256>` über genau die Eingaben,
 * die das Ergebnis bestimmen. Weicht eine davon ab (anderes Fenster, andere
 * Politik, neue Code-Version), ist es definitionsgemäß ein anderer Lauf.
 */
export function perpRunIdempotencyKey(input: {
  venue: string;
  mode: string;
  fromMs: number;
  toMs: number;
  instrumentIds: readonly string[];
  kinds: readonly PerpSeriesKind[];
  availabilityPolicy: string;
  codeVersion: string;
}): string {
  const canonical = JSON.stringify({
    venue: input.venue,
    mode: input.mode,
    fromMs: Math.floor(input.fromMs),
    toMs: Math.floor(input.toMs),
    instrumentIds: [...input.instrumentIds].sort(),
    kinds: [...input.kinds].sort(),
    availabilityPolicy: input.availabilityPolicy,
    codeVersion: input.codeVersion,
  });
  return `prk1:${createHash("sha256").update(canonical).digest("hex")}`;
}

/** Insert-Zeile `perp_funding_rates` (numeric-Felder als String). */
export function fundingToInsert(row: PerpFundingRow, runId: string | null) {
  return {
    id: randomUUID(),
    runId,
    venue: row.venue,
    instrumentId: row.instrumentId,
    symbol: row.symbol,
    sourceId: row.sourceId,
    schemaVersion: row.schemaVersion,
    eventTime: toDate(row.eventTime, "eventTime"),
    availableAt: toDate(row.availableAt, "availableAt"),
    fetchedAt: toDate(row.fetchedAt, "fetchedAt"),
    fundingRate: row.fundingRate === null ? null : String(row.fundingRate),
    intervalHours: row.intervalHours === null ? null : String(row.intervalHours),
    nextFundingTime: row.nextFundingTime === null ? null : toDate(row.nextFundingTime, "nextFundingTime"),
    markPrice: row.markPrice === null ? null : String(row.markPrice),
    unit: row.unit,
    qualityStatus: row.qualityStatus,
    missingReason: row.missingReason,
    contentHash: row.contentHash,
  };
}

/** Insert-Zeile `perp_open_interest`. */
export function openInterestToInsert(row: PerpOpenInterestRow, runId: string | null) {
  return {
    id: randomUUID(),
    runId,
    venue: row.venue,
    instrumentId: row.instrumentId,
    symbol: row.symbol,
    sourceId: row.sourceId,
    schemaVersion: row.schemaVersion,
    eventTime: toDate(row.eventTime, "eventTime"),
    availableAt: toDate(row.availableAt, "availableAt"),
    fetchedAt: toDate(row.fetchedAt, "fetchedAt"),
    contracts: row.contracts === null ? null : String(row.contracts),
    baseQuantity: row.baseQuantity === null ? null : String(row.baseQuantity),
    quoteValue: row.quoteValue === null ? null : String(row.quoteValue),
    basis: row.basis,
    contractSize: row.contractSize === null ? null : String(row.contractSize),
    quoteCurrency: row.quoteCurrency,
    markPrice: row.markPrice === null ? null : String(row.markPrice),
    converted: row.converted,
    unit: row.unit,
    qualityStatus: row.qualityStatus,
    missingReason: row.missingReason,
    contentHash: row.contentHash,
  };
}

/** Insert-Zeile `perp_liquidations`. */
export function liquidationToInsert(row: PerpLiquidationRow, runId: string | null) {
  return {
    id: randomUUID(),
    runId,
    venue: row.venue,
    instrumentId: row.instrumentId,
    symbol: row.symbol,
    sourceId: row.sourceId,
    schemaVersion: row.schemaVersion,
    eventTime: toDate(row.eventTime, "eventTime"),
    availableAt: toDate(row.availableAt, "availableAt"),
    fetchedAt: toDate(row.fetchedAt, "fetchedAt"),
    side: row.side,
    quantityBase: row.quantityBase === null ? null : String(row.quantityBase),
    price: row.price === null ? null : String(row.price),
    notionalQuote: row.notionalQuote === null ? null : String(row.notionalQuote),
    quoteCurrency: row.quoteCurrency,
    sourceEventId: row.sourceEventId,
    aggregateCount: row.aggregateCount,
    unit: row.unit,
    qualityStatus: row.qualityStatus,
    missingReason: row.missingReason,
    contentHash: row.contentHash,
  };
}

/**
 * Fail-closed-Prüfung vor dem Schreiben. Zwei Fehler, die der DB-CHECK erst
 * nach dem Insert sähe — und dann ohne Kontext:
 *
 *   * weder Messwert noch Grund (oder beides): „unavailable“ wäre eine 0,
 *   * `available_at < event_time`: das wäre Look-ahead in der as-of-Abfrage.
 */
function assertValueOrReason(row: PerpFundingRow | PerpOpenInterestRow | PerpLiquidationRow): void {
  const measured =
    row.kind === "funding"
      ? row.fundingRate !== null
      : row.kind === "openInterest"
        ? row.contracts !== null || row.baseQuantity !== null || row.quoteValue !== null
        : row.quantityBase !== null || row.notionalQuote !== null;
  if (measured === (row.missingReason !== null)) {
    throw new PerpPersistenceError(
      "value:exclusive",
      "Zeile muss GENAU einen Messwert oder einen Missing-Grund tragen (unavailable ist keine 0).",
      { kind: row.kind, instrumentId: row.instrumentId, eventTime: toIso(row.eventTime) }
    );
  }
  if (row.eventTime.getTime() > row.availableAt.getTime()) {
    throw new PerpPersistenceError("value:availability", "available_at liegt vor event_time.", {
      kind: row.kind,
      instrumentId: row.instrumentId,
    });
  }
  if (!Number.isInteger(row.schemaVersion) || row.schemaVersion < 1) {
    throw new PerpPersistenceError("value:schema", "schemaVersion muss eine positive Ganzzahl sein.", {
      kind: row.kind,
    });
  }
}

/** Deduplizierung innerhalb einer Charge (natürlicher Schlüssel, erste gewinnt). */
function dedupeByNaturalKey<T extends PerpRowKeyed>(rows: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    const key = perpRowKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

/** Wasserstand-Merge: fällt nie zurück; `UNSUPPORTED` bleibt bis zum ersten Erfolg. */
export function mergeCursor(prior: PerpCursor | undefined, next: PerpCursor): PerpCursor {
  if (!prior) return next;
  const ok = next.lastStatus === "OK";
  return {
    ...next,
    watermarkEventTime: new Date(Math.max(prior.watermarkEventTime.getTime(), next.watermarkEventTime.getTime())),
    watermarkAvailableAt: new Date(Math.max(prior.watermarkAvailableAt.getTime(), next.watermarkAvailableAt.getTime())),
    consecutiveFailures: ok ? 0 : prior.consecutiveFailures + 1,
    lastStatus: prior.lastStatus === "UNSUPPORTED" && ok ? "UNSUPPORTED" : next.lastStatus,
    unsupportedReason: prior.unsupportedReason ?? next.unsupportedReason,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Drizzle-Ablage
// ─────────────────────────────────────────────────────────────────────────────

export class PerpStore implements PerpStorePort {
  private readonly database: PerpDb;
  private readonly audit: PerpAuditSink;
  private readonly chunkSize: number;
  private readonly now: () => Date;

  constructor(deps: PerpStoreDeps = {}) {
    this.database = deps.db ?? db;
    this.audit = deps.audit ?? (auditWrite as PerpAuditSink);
    this.chunkSize = Math.max(1, Math.min(deps.chunkSize ?? DEFAULT_CHUNK, PERP_LIMITS.insertChunkRows));
    this.now = deps.now ?? (() => new Date());
  }

  private async auditEvent(event: string, level: AuditLevel, detail: Record<string, unknown>): Promise<void> {
    await this.audit(event, level, detail, { auditClass: "telemetry" });
  }

  /** Lese-/Schreibzugriff mit klassifiziertem Ablagefehler (nie `[]` bei Ausfall). */
  private async guard<T>(operation: () => Promise<T>, context: string): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof PerpDataError) throw error;
      const message = String((error as Error)?.message ?? error).slice(0, 240);
      throw new PerpStoreUnavailableError(`Perp-Ablage nicht erreichbar (${context}): ${message}`, { context });
    }
  }

  // ── Schreiben ──────────────────────────────────────────────────────────────

  /**
   * Manifest + Zeilen + Wasserstände, atomar. Vorher wird der
   * Idempotenzschlüssel geprüft: ein abgeschlossener Lauf wird als Replay
   * beantwortet, ohne dass eine Zeile geschrieben wird.
   */
  async commitRun(commit: PerpCommit): Promise<PerpCommitResult> {
    const run = commit.run;
    const totalRows =
      commit.batch.funding.length + commit.batch.openInterest.length + commit.batch.liquidations.length;
    if (totalRows > PERP_LIMITS.batchRows) {
      throw new PerpPersistenceError("run:batch-too-large", `Batch überschreitet ${PERP_LIMITS.batchRows} Zeilen.`, {
        rows: totalRows,
      });
    }

    const existing = await this.guard(() => this.findRunByIdempotencyKey(run.idempotencyKey), "idempotency-lookup");
    if (existing && existing.status !== "FAILED") {
      await this.auditEvent("PERP_SYNC_REPLAY", "INFO", {
        venue: run.venue,
        runId: existing.id,
        mode: run.mode,
      });
      telemetry.perp.syncRuns.inc({ result: "replayed", mode: metricLabel(run.mode) });
      return {
        runId: existing.id,
        created: false,
        inserted: emptyKindCounts(),
        duplicates: emptyKindCounts(),
        revisionConflicts: 0,
        cursorsUpdated: 0,
        rejectedRows: 0,
      };
    }

    const runId = existing?.id ?? run.id;
    let result: PerpCommitResult;
    try {
      result = await this.database.transaction((tx) => this.commitInTransaction(tx as unknown as PerpDb, runId, existing !== null, commit));
    } catch (error) {
      telemetry.perp.syncRuns.inc({ result: "failed", mode: metricLabel(run.mode) });
      if (error instanceof PerpDataError) throw error;
      const message = String((error as Error)?.message ?? error).slice(0, 240);
      await this.auditEvent("PERP_SYNC_WRITE_FAILED", "WARN", { venue: run.venue, runId, message });
      throw new PerpStoreUnavailableError(`Perp-Sync konnte nicht schreiben: ${message}`, { runId });
    }

    for (const kind of SERIES_KINDS) {
      if (result.inserted[kind] > 0) {
        telemetry.perp.syncRows.inc({ kind: metricLabel(kind), result: "written" }, result.inserted[kind]);
      }
      if (result.duplicates[kind] > 0) {
        telemetry.perp.syncRows.inc({ kind: metricLabel(kind), result: "duplicate" }, result.duplicates[kind]);
      }
    }
    if (result.revisionConflicts > 0) {
      telemetry.perp.revisions.inc({ kind: "total" }, result.revisionConflicts);
      await this.auditEvent("PERP_DATA_REVISION_DETECTED", "WARN", {
        venue: run.venue,
        runId,
        revisions: result.revisionConflicts,
        hint: "gleicher Schlüssel, abweichender Inhalt — gespeicherte Zeilen werden nie überschrieben",
      });
    }
    telemetry.perp.syncRuns.inc({
      result: run.status === "PARTIAL" ? "partial" : "written",
      mode: metricLabel(run.mode),
    });
    await this.auditEvent("PERP_SYNC_RUN_COMMITTED", "INFO", {
      venue: run.venue,
      runId,
      mode: run.mode,
      status: run.status,
      rows: result.inserted.funding + result.inserted.openInterest + result.inserted.liquidations,
      revisions: result.revisionConflicts,
      codeVersion: APP_VERSION,
    });
    return result;
  }

  /** Korpus der Transaktion (Manifest → Zeilen → Wasserstände). */
  private async commitInTransaction(
    queries: PerpDb,
    runId: string,
    isRetry: boolean,
    commit: PerpCommit
  ): Promise<PerpCommitResult> {
    const run = commit.run;
    if (isRetry) {
      // Retry nach Fehlschlag: dasselbe Manifest wird gefüllt, nicht dupliziert.
      await queries
        .update(perpSyncRuns)
        .set({
          status: run.status,
          counts: run.counts,
          failures: run.failures,
          capabilities: run.capabilities,
          errorCode: run.errorCode,
          finishedAt: run.finishedAt,
        })
        .where(eq(perpSyncRuns.id, runId));
    } else {
      await queries.insert(perpSyncRuns).values({
        id: runId,
        idempotencyKey: run.idempotencyKey,
        venue: run.venue,
        mode: run.mode,
        status: run.status,
        availabilityPolicy: run.availabilityPolicy,
        fromTs: run.fromTs,
        toTs: run.toTs,
        kinds: run.kinds,
        instrumentIds: run.instrumentIds,
        counts: run.counts,
        capabilities: run.capabilities,
        failures: run.failures,
        codeVersion: run.codeVersion,
        errorCode: run.errorCode,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
      });
    }

    const inserted = emptyKindCounts();
    const duplicates = emptyKindCounts();
    const keyed: PerpRowKeyed[] = [];
    const rejected = new Map<PerpSeriesKind, number>();
    for (const kind of run.kinds) {
      const rows = rowsFor(kind, commit.batch);
      const deduped = dedupeByNaturalKey(rows as readonly PerpRowKeyed[]);
      // Zeilen ohne Messwert UND ohne Grund (bzw. mit beidem) werden abgewiesen,
      // nicht gespeichert: die CHECK-Constraints würden die ganze Charge werfen.
      const valid: typeof deduped = [];
      for (const row of deduped) {
        try {
          assertValueOrReason(row as never);
          valid.push(row);
        } catch (error) {
          if (!(error instanceof PerpPersistenceError)) throw error;
          rejected.set(kind, (rejected.get(kind) ?? 0) + 1);
        }
      }
      keyed.push(...valid);
      const written = await this.insertRows(queries, kind, run.venue, runId, valid);
      inserted[kind] = written.inserted;
      duplicates[kind] = written.duplicates;
    }

    const priorHashes = await this.existingHashes(queries, run.venue, keyed);
    let revisions = 0;
    for (const row of keyed) {
      const prior = priorHashes.get(perpRowKey(row));
      if (prior !== undefined && prior !== row.contentHash) revisions += 1;
    }

    const cursorsUpdated = await this.writeCursors(queries, runId, commit.cursors);

    return {
      runId,
      created: true,
      inserted,
      duplicates,
      revisionConflicts: revisions,
      cursorsUpdated,
      rejectedRows: [...rejected.values()].reduce((a, b) => a + b, 0),
    } satisfies PerpCommitResult;
  }

  /** Insert einer Dedup-Charge (append-only); zählt Duplikate über die Differenz. */
  private async insertRows(
    queries: PerpDb,
    kind: PerpSeriesKind,
    venue: string,
    runId: string,
    rows: readonly PerpRowKeyed[]
  ): Promise<{ inserted: number; duplicates: number }> {
    if (rows.length === 0) return { inserted: 0, duplicates: 0 };
    void venue;
    let inserted = 0;
    for (const part of chunk(rows, this.chunkSize)) {
      if (kind === "funding") {
        const values = part.map((row) => fundingToInsert(row as unknown as PerpFundingRow, runId));
        const stored = await queries
          .insert(perpFundingRates)
          .values(values)
          .onConflictDoNothing({
            target: [perpFundingRates.venue, perpFundingRates.instrumentId, perpFundingRates.eventTime],
          })
          .returning({ id: perpFundingRates.id });
        inserted += stored.length;
      } else if (kind === "openInterest") {
        const values = part.map((row) => openInterestToInsert(row as unknown as PerpOpenInterestRow, runId));
        const stored = await queries
          .insert(perpOpenInterest)
          .values(values)
          .onConflictDoNothing({
            target: [perpOpenInterest.venue, perpOpenInterest.instrumentId, perpOpenInterest.eventTime],
          })
          .returning({ id: perpOpenInterest.id });
        inserted += stored.length;
      } else {
        const values = part.map((row) => liquidationToInsert(row as unknown as PerpLiquidationRow, runId));
        const stored = await queries
          .insert(perpLiquidations)
          .values(values)
          .onConflictDoNothing({
            target: [
              perpLiquidations.venue,
              perpLiquidations.instrumentId,
              perpLiquidations.eventTime,
              perpLiquidations.sourceEventId,
            ],
          })
          .returning({ id: perpLiquidations.id });
        inserted += stored.length;
      }
    }
    return { inserted, duplicates: Math.max(0, rows.length - inserted) };
  }

  /**
   * Inhalt-Hashes bereits gespeicherter Zeilen zu denselben Schlüsseln.
   * Begrenzt auf die Schlüssel der Charge (instrument_ids × event_times) —
   * kein Tabellen-Scan, dafür die exakte Revisionszahl.
   */
  private async existingHashes(queries: PerpDb, venue: string, rows: readonly PerpRowKeyed[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (rows.length === 0) return out;
    for (const kind of SERIES_KINDS) {
      const ofKind = rows.filter((row) => row.kind === kind);
      if (ofKind.length === 0) continue;
      const handle = handleFor(kind);
      const instrumentIds = [...new Set(ofKind.map((row) => row.instrumentId))].slice(0, PERP_LIMITS.queryInstruments);
      const times = [...new Set(ofKind.map((row) => row.eventTime.getTime()))]
        .sort((a, b) => a - b)
        .slice(0, PERP_LIMITS.batchRows)
        .map((ms) => new Date(ms));
      if (instrumentIds.length === 0 || times.length === 0) continue;
      const stored = await queries
        .select({
          instrumentId: handle.instrumentId,
          eventTime: handle.eventTime,
          contentHash: handle.contentHash,
          sourceEventId: handle.sourceEventId ?? (sql`null::text` as never),
        })
        .from(handle.table)
        .where(
          and(
            eq(handle.venue, venue),
            inArray(handle.instrumentId, instrumentIds),
            inArray(handle.eventTime, times)
          )
        )
        .limit(PERP_LIMITS.batchRows);
      for (const row of stored) {
        out.set(
          perpRowKey({
            kind,
            venue,
            instrumentId: row.instrumentId as string,
            eventTime: toDate(row.eventTime as unknown as Date, "eventTime"),
            sourceEventId: (row.sourceEventId as string | null) ?? undefined,
          }),
          row.contentHash as string
        );
      }
    }
    return out;
  }

  /** Wasserstände lesen, in JS mergen (nie zurückfallen), zurückschreiben. */
  private async writeCursors(queries: PerpDb, runId: string, cursors: readonly PerpCursor[]): Promise<number> {
    if (cursors.length === 0) return 0;
    const instrumentIds = [...new Set(cursors.map((cursor) => cursor.instrumentId))].slice(0, PERP_LIMITS.queryInstruments);
    const priorRows = await queries
      .select()
      .from(perpSyncCursors)
      .where(inArray(perpSyncCursors.instrumentId, instrumentIds))
      .limit(2_000);
    const prior = new Map<string, PerpCursor>();
    for (const row of priorRows) {
      prior.set(`${row.venue}|${row.instrumentId}|${row.kind}`, {
        venue: row.venue,
        instrumentId: row.instrumentId,
        kind: row.kind as PerpCursor["kind"],
        watermarkEventTime: row.watermarkEventTime,
        watermarkAvailableAt: row.watermarkAvailableAt,
        lastRunId: row.lastRunId ?? null,
        consecutiveFailures: row.consecutiveFailures,
        lastStatus: row.lastStatus as PerpCursor["lastStatus"],
        unsupportedReason: row.unsupportedReason ?? null,
      });
    }
    let updated = 0;
    for (const cursor of cursors) {
      const merged = mergeCursor(prior.get(`${cursor.venue}|${cursor.instrumentId}|${cursor.kind}`), cursor);
      await queries
        .insert(perpSyncCursors)
        .values({
          venue: merged.venue,
          instrumentId: merged.instrumentId,
          kind: merged.kind,
          watermarkEventTime: merged.watermarkEventTime,
          watermarkAvailableAt: merged.watermarkAvailableAt,
          lastRunId: runId,
          consecutiveFailures: merged.consecutiveFailures,
          lastStatus: merged.lastStatus,
          unsupportedReason: merged.unsupportedReason,
          updatedAt: this.now(),
        })
        .onConflictDoUpdate({
          target: [perpSyncCursors.venue, perpSyncCursors.instrumentId, perpSyncCursors.kind],
          set: {
            watermarkEventTime: merged.watermarkEventTime,
            watermarkAvailableAt: merged.watermarkAvailableAt,
            lastRunId: runId,
            consecutiveFailures: merged.consecutiveFailures,
            lastStatus: merged.lastStatus,
            unsupportedReason: merged.unsupportedReason,
            updatedAt: this.now(),
          },
        });
      prior.set(`${merged.venue}|${merged.instrumentId}|${merged.kind}`, merged);
      updated += 1;
    }
    return updated;
  }

  private async findRunByIdempotencyKey(key: string): Promise<PerpRunRecord | null> {
    const rows = await this.database
      .select()
      .from(perpSyncRuns)
      .where(eq(perpSyncRuns.idempotencyKey, key))
      .limit(1);
    return rows[0] ? toRunRecord(rows[0]) : null;
  }

  // ── as-of-Lesen ────────────────────────────────────────────────────────────

  async readFunding(query: PerpSeriesQuery): Promise<readonly PerpFundingRow[]> {
    const rows = await this.readRaw("funding", query);
    return rows.map((row) => ({
      kind: "funding" as const,
      venue: row.venue as string,
      instrumentId: row.instrumentId as string,
      symbol: row.symbol as string,
      sourceId: row.sourceId as string,
      schemaVersion: row.schemaVersion as number,
      eventTime: toDate(row.eventTime as Date, "eventTime"),
      availableAt: toDate(row.availableAt as Date, "availableAt"),
      fetchedAt: toDate(row.fetchedAt as Date, "fetchedAt"),
      fundingRate: toNum(row.fundingRate as string | null),
      intervalHours: toNum(row.intervalHours as string | null),
      nextFundingTime: row.nextFundingTime ? toDate(row.nextFundingTime as Date, "nextFundingTime") : null,
      markPrice: toNum(row.markPrice as string | null),
      unit: row.unit as PerpFundingRow["unit"],
      qualityStatus: row.qualityStatus as PerpFundingRow["qualityStatus"],
      missingReason: (row.missingReason as PerpFundingRow["missingReason"]) ?? null,
      contentHash: row.contentHash as string,
    }));
  }

  async readOpenInterest(query: PerpSeriesQuery): Promise<readonly PerpOpenInterestRow[]> {
    const rows = await this.readRaw("openInterest", query);
    return rows.map((row) => ({
      kind: "openInterest" as const,
      venue: row.venue as string,
      instrumentId: row.instrumentId as string,
      symbol: row.symbol as string,
      sourceId: row.sourceId as string,
      schemaVersion: row.schemaVersion as number,
      eventTime: toDate(row.eventTime as Date, "eventTime"),
      availableAt: toDate(row.availableAt as Date, "availableAt"),
      fetchedAt: toDate(row.fetchedAt as Date, "fetchedAt"),
      contracts: toNum(row.contracts as string | null),
      baseQuantity: toNum(row.baseQuantity as string | null),
      quoteValue: toNum(row.quoteValue as string | null),
      basis: row.basis as PerpOpenInterestRow["basis"],
      contractSize: toNum(row.contractSize as string | null),
      quoteCurrency: (row.quoteCurrency as string | null) ?? null,
      markPrice: toNum(row.markPrice as string | null),
      converted: row.converted as boolean,
      unit: row.unit as PerpOpenInterestRow["unit"],
      qualityStatus: row.qualityStatus as PerpOpenInterestRow["qualityStatus"],
      missingReason: (row.missingReason as PerpOpenInterestRow["missingReason"]) ?? null,
      contentHash: row.contentHash as string,
    }));
  }

  async readLiquidations(query: PerpSeriesQuery): Promise<readonly PerpLiquidationRow[]> {
    const rows = await this.readRaw("liquidations", query);
    return rows.map((row) => ({
      kind: "liquidations" as const,
      venue: row.venue as string,
      instrumentId: row.instrumentId as string,
      symbol: row.symbol as string,
      sourceId: row.sourceId as string,
      schemaVersion: row.schemaVersion as number,
      eventTime: toDate(row.eventTime as Date, "eventTime"),
      availableAt: toDate(row.availableAt as Date, "availableAt"),
      fetchedAt: toDate(row.fetchedAt as Date, "fetchedAt"),
      side: row.side as PerpLiquidationRow["side"],
      quantityBase: toNum(row.quantityBase as string | null),
      price: toNum(row.price as string | null),
      notionalQuote: toNum(row.notionalQuote as string | null),
      quoteCurrency: (row.quoteCurrency as string | null) ?? null,
      sourceEventId: row.sourceEventId as string,
      aggregateCount: (row.aggregateCount as number | null) ?? null,
      unit: row.unit as PerpLiquidationRow["unit"],
      qualityStatus: row.qualityStatus as PerpLiquidationRow["qualityStatus"],
      missingReason: (row.missingReason as PerpLiquidationRow["missingReason"]) ?? null,
      contentHash: row.contentHash as string,
    }));
  }

  /**
   * as-of-Härte (Point-in-Time-Garantie) — in SQL, nicht im Aufrufer:
   *
   *     event_time <= asOf  AND  available_at <= asOf
   *
   * Eine Zeile, die erst nach `asOf` bekannt werden durfte, existiert für diese
   * Abfrage nicht — unabhängig davon, wie vollständig der Bestand ist.
   */
  private async readRaw(kind: PerpSeriesKind, query: PerpSeriesQuery): Promise<Record<string, unknown>[]> {
    return this.guard(async () => {
      const handle = handleFor(kind);
      const asOf = new Date(query.asOfMs);
      const conditions = [lte(handle.eventTime, asOf), lte(handle.availableAt, asOf)];
      if (query.fromMs !== null && Number.isFinite(query.fromMs)) {
        conditions.push(sql`${handle.eventTime} >= ${new Date(query.fromMs)}`);
      }
      if (query.toMs !== null && Number.isFinite(query.toMs)) {
        conditions.push(lte(handle.eventTime, new Date(query.toMs)));
      }
      if (query.venue) conditions.push(eq(handle.venue, query.venue));
      if (query.instrumentIds.length > 0) conditions.push(inArray(handle.instrumentId, [...query.instrumentIds]));
      const rows = await this.database
        .select()
        .from(handle.table as never)
        .where(and(...conditions))
        .orderBy(asc(handle.instrumentId), asc(handle.eventTime))
        .limit(this.fetchLimit(query));
      return rows as unknown as Record<string, unknown>[];
    }, `read:${kind}`);
  }

  /** Ladebudget je Abfrage: Instrumente × Reihenlimit, hart gedeckelt (+1 = Kürzungserkennung). */
  private fetchLimit(query: PerpSeriesQuery): number {
    const instruments = Math.max(1, query.instrumentIds.length || 1);
    return Math.min(instruments * Math.max(1, query.limit) + 1, PERP_LIMITS.querySourceRows);
  }

  // ── Betrieb ────────────────────────────────────────────────────────────────

  async readCursors(scope: { venue?: string | null; instrumentIds?: readonly string[] }): Promise<readonly PerpCursor[]> {
    return this.guard(async () => {
      const conditions = [];
      if (scope.venue) conditions.push(eq(perpSyncCursors.venue, scope.venue));
      if (scope.instrumentIds && scope.instrumentIds.length > 0) {
        conditions.push(inArray(perpSyncCursors.instrumentId, [...scope.instrumentIds].slice(0, PERP_LIMITS.queryInstruments)));
      }
      const rows = await this.database
        .select()
        .from(perpSyncCursors)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(asc(perpSyncCursors.venue), asc(perpSyncCursors.instrumentId), asc(perpSyncCursors.kind))
        .limit(2_000);
      return rows.map((row) => ({
        venue: row.venue,
        instrumentId: row.instrumentId,
        kind: row.kind as PerpCursor["kind"],
        watermarkEventTime: row.watermarkEventTime,
        watermarkAvailableAt: row.watermarkAvailableAt,
        lastRunId: row.lastRunId ?? null,
        consecutiveFailures: row.consecutiveFailures,
        lastStatus: row.lastStatus as PerpCursor["lastStatus"],
        unsupportedReason: row.unsupportedReason ?? null,
      }));
    }, "readCursors");
  }

  async recentRuns(limit: number): Promise<readonly PerpRunRecord[]> {
    return this.guard(async () => {
      const wanted = Math.max(1, Math.min(50, Math.trunc(limit)));
      const rows = await this.database
        .select()
        .from(perpSyncRuns)
        .orderBy(desc(perpSyncRuns.startedAt))
        .limit(wanted);
      return rows.map(toRunRecord);
    }, "recentRuns");
  }

  /**
   * Abdeckung je (Venue, Reihenart) — ausschließlich Aggregate, keine
   * Instrument-IDs (Kardinalitätsregel wie bei den Metriken).
   */
  async coverage(asOfMs: number, venue?: string | null): Promise<readonly PerpCoverage[]> {
    return this.guard(async () => {
      const out: PerpCoverage[] = [];
      for (const kind of SERIES_KINDS) {
        const handle = handleFor(kind);
        const asOf = new Date(asOfMs);
        const conditions = [lte(handle.eventTime, asOf), lte(handle.availableAt, asOf)];
        if (venue) conditions.push(eq(handle.venue, venue));
        const aggregates = (await this.database
          .select({
            venue: handle.venue,
            rows: sql<number>`count(*)::int`,
            instruments: sql<number>`count(distinct ${handle.instrumentId})::int`,
            nullRows: sql<number>`count(*) filter (where ${handle.missingReason} is not null)::int`,
            invalidRows: sql<number>`count(*) filter (where ${handle.qualityStatus} = 'INVALID')::int`,
            unknownRows: sql<number>`count(*) filter (where ${handle.qualityStatus} not in ('OK','GAP','STALE'))::int`,
            minEventTime: sql<Date | string | null>`min(${handle.eventTime})`,
            maxEventTime: sql<Date | string | null>`max(${handle.eventTime})`,
            maxAvailableAt: sql<Date | string | null>`max(${handle.availableAt})`,
          })
          .from(handle.table as never)
          .where(and(...conditions))
          .groupBy(handle.venue)
          .orderBy(handle.venue)
          .limit(50)) as unknown as readonly {
          venue: string;
          rows: number;
          instruments: number;
          nullRows: number;
          invalidRows: number;
          unknownRows: number;
          minEventTime: Date | string | null;
          maxEventTime: Date | string | null;
          maxAvailableAt: Date | string | null;
        }[];
        for (const row of aggregates) {
          const lastAvailable = row.maxAvailableAt === null ? null : toDate(row.maxAvailableAt, "coverage");
          out.push({
            venue: row.venue,
            kind,
            rows: Number(row.rows),
            instruments: Number(row.instruments),
            nullRows: Number(row.nullRows),
            invalidRows: Number(row.invalidRows),
            unknownQualityRows: Number(row.unknownRows),
            firstEventTime: row.minEventTime === null ? null : toDate(row.minEventTime, "coverage").toISOString(),
            lastEventTime: row.maxEventTime === null ? null : toDate(row.maxEventTime, "coverage").toISOString(),
            ageMs: lastAvailable === null ? null : Math.max(0, asOfMs - lastAvailable.getTime()),
          });
        }
      }
      return out;
    }, "coverage");
  }

  /**
   * Retention der Lauf-Manifeste. Die **Datenzeilen bleiben erhalten** — nur ihr
   * Manifest-Verweis wird auf `NULL` gesetzt (analog zur Log-Rotation: die
   * Wahrheit bleibt, der Index altert).
   */
  async pruneRuns(keepLast: number): Promise<number> {
    const keep = Math.max(1, Math.min(1_000, Math.trunc(keepLast)));
    return this.guard(async () => {
      const victims = await this.database
        .select({ id: perpSyncRuns.id, rn: sql<number>`row_number() over (partition by ${perpSyncRuns.venue} order by ${perpSyncRuns.startedAt} desc)::int` })
        .from(perpSyncRuns)
        .limit(50_000);
      const ids = victims.filter((row) => row.rn > keep).map((row) => row.id);
      if (ids.length === 0) return 0;
      await this.database.transaction(async (tx) => {
        const queries = tx as unknown as PerpDb;
        for (const table of [perpFundingRates, perpOpenInterest, perpLiquidations]) {
          await queries
            .update(table as never)
            .set({ runId: null } as never)
            .where(inArray(table.runId, ids) as never);
        }
        // Die Cursor zeigen per `last_run_id` auf ihr Manifest; ohne diese
        // Referenz aufzuhalten würde der Foreign-Key das Löschen blockieren —
        // und ein Cursor zeigt auf nichts, was es nicht mehr gibt.
        await queries
          .update(perpSyncCursors as never)
          .set({ lastRunId: null } as never)
          .where(inArray(perpSyncCursors.lastRunId, ids) as never);
        await queries.delete(perpSyncRuns).where(inArray(perpSyncRuns.id, ids));
      });
      return ids.length;
    }, "pruneRuns");
  }
}

/** Zeilen einer Reihenart aus dem Schreibbatch. */
function rowsFor(
  kind: PerpSeriesKind,
  batch: PerpWriteBatch
): readonly (PerpFundingRow | PerpOpenInterestRow | PerpLiquidationRow)[] {
  return kind === "funding" ? batch.funding : kind === "openInterest" ? batch.openInterest : batch.liquidations;
}

function toRunRecord(row: typeof perpSyncRuns.$inferSelect): PerpRunRecord {
  return {
    id: row.id,
    idempotencyKey: row.idempotencyKey,
    venue: row.venue,
    mode: row.mode as PerpRunRecord["mode"],
    status: row.status as PerpRunRecord["status"],
    availabilityPolicy: row.availabilityPolicy as PerpRunRecord["availabilityPolicy"],
    fromTs: row.fromTs,
    toTs: row.toTs,
    kinds: Array.isArray(row.kinds) ? (row.kinds as PerpRunRecord["kinds"]) : [],
    instrumentIds: Array.isArray(row.instrumentIds) ? (row.instrumentIds as string[]) : [],
    counts: (row.counts ?? {}) as PerpRunRecord["counts"],
    capabilities: (row.capabilities ?? {}) as PerpRunRecord["capabilities"],
    failures: Array.isArray(row.failures) ? (row.failures as PerpRunRecord["failures"]) : [],
    codeVersion: row.codeVersion,
    errorCode: row.errorCode ?? null,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Instanz (global, lazy — kein Import-Wurf ohne DATABASE_URL)
// ─────────────────────────────────────────────────────────────────────────────

let storeInstance: PerpStore | null = null;

export function getPerpStore(deps: PerpStoreDeps = {}): PerpStore {
  if (deps.db) return new PerpStore(deps);
  if (storeInstance === null) storeInstance = new PerpStore(deps);
  return storeInstance;
}

/** Nur für Tests: die geteilte Instanz verwerfen. */
export function resetPerpStoreForTests(): void {
  storeInstance = null;
}
