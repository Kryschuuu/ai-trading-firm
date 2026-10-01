/**
 * STX-05-03 — Screening-Persistenz: Run-Metadaten + immutable Matrix-Zellen.
 *
 * Kein DELETE-Pfad und kein UPDATE auf strategy_market_results. Retries
 * behalten insbesondere die zuerst geschriebene priority/Provenienz.
 * Datenbank injizierbar, damit DB-Tests keine globalen Pools umbiegen müssen.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { strategyMarketResults, strategyScreeningRuns } from "@/db/schema";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "@/lib/paging";
import {
  normalizeScreeningUuid,
  screeningAsOf,
  screeningCellKey,
  screeningRunHash,
  type ScreeningRunKeyInput,
} from "./keys";
import {
  SCREENING_RUN_KINDS,
  SCREENING_RUN_STATUSES,
  type CandidateStatus,
  type ScreeningRunKind,
  type ScreeningRunStatus,
  type StrategyMarketCandidate,
} from "./types";

export type RunRow = typeof strategyScreeningRuns.$inferSelect;
export type CellRow = typeof strategyMarketResults.$inferSelect;
export type ScreeningStoreDb = Pick<typeof db, "transaction" | "select">;

/** 250 Zeilen halten jedes INSERT deutlich unter PostgreSQLs Parameterlimit. */
export const SCREENING_CELLS_INSERT_CHUNK = 250;

export interface CreateScreeningRunInput extends ScreeningRunKeyInput {
  runKind: ScreeningRunKind;
  dataVersion?: string | null;
}

/** Discovery darf ohne Version existieren; eine persistierte Zelle niemals. */
export interface ScreeningCellInput extends Pick<
  StrategyMarketCandidate,
  "instrumentId" | "venue" | "timeframe" | "templateId" | "status"
> {
  strategyVersionId: string;
  priority?: number | null;
  reasons?: readonly string[];
  backtestRunId?: string | null;
  metrics?: Readonly<Record<string, unknown>>;
}

export interface ScreeningRunCounts {
  cellsTotal?: number;
  cellsDone?: number;
}

function checkCount(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 2_147_483_647) {
    throw new Error(`screening: ${field} muss eine nichtnegative PostgreSQL-Ganzzahl sein`);
  }
}

/**
 * INSERT ... ON CONFLICT DO NOTHING + SELECT in EINER READ-COMMITTED-
 * Transaktion. Auch bei parallelen Retries sieht der nachfolgende SELECT
 * den Gewinner des UNIQUE-Konflikts. Die erste Config/Provenienz bleibt.
 */
export async function createOrGetRun(
  input: CreateScreeningRunInput,
  database: ScreeningStoreDb = db,
): Promise<RunRow> {
  if (!SCREENING_RUN_KINDS.includes(input.runKind)) throw new Error("screening: ungültiger runKind");
  const candidateSetHash = screeningRunHash(input);
  const asOf = screeningAsOf(input.asOf);
  checkCount(input.cells.length, "cellsTotal");

  return database.transaction(async (tx) => {
    await tx.insert(strategyScreeningRuns).values({
      runKind: input.runKind,
      asOf,
      candidateSetHash,
      codeVersion: input.codeVersion,
      dataVersion: input.dataVersion ?? null,
      configJson: input.config,
      status: "PENDING",
      cellsTotal: input.cells.length,
    }).onConflictDoNothing({
      target: [strategyScreeningRuns.candidateSetHash, strategyScreeningRuns.codeVersion],
    });
    const [run] = await tx.select().from(strategyScreeningRuns).where(and(
      eq(strategyScreeningRuns.candidateSetHash, candidateSetHash),
      eq(strategyScreeningRuns.codeVersion, input.codeVersion),
    )).limit(1);
    if (!run) throw new Error("screening: Run nach INSERT nicht auffindbar");
    return run;
  }, { isolationLevel: "read committed" });
}

/**
 * Batchweise, atomar und insert-only. Rückgabe = tatsächlich neue Zeilen;
 * Wiederholung = 0. Keys werden aus den FK-/Marktidentitäten hergeleitet,
 * nicht vom Caller übernommen. Ein Fehler in Chunk N rollt alle Chunks zurück.
 */
export async function upsertCells(
  runId: string,
  cells: readonly ScreeningCellInput[],
  database: ScreeningStoreDb = db,
): Promise<number> {
  const id = normalizeScreeningUuid(runId);
  if (cells.length === 0) return 0;

  // Alle Eingaben vor dem ersten DB-Zugriff validieren/abbilden.
  const rows = cells.map((cell) => {
    if (cell.priority != null && (typeof cell.priority !== "number" || !Number.isFinite(cell.priority))) {
      throw new Error("screening: priority muss endlich oder null sein");
    }
    return {
      runId: id,
      strategyVersionId: normalizeScreeningUuid(cell.strategyVersionId),
      instrumentId: cell.instrumentId,
      venue: cell.venue,
      timeframe: cell.timeframe,
      templateId: cell.templateId,
      priority: cell.priority == null ? null : String(cell.priority),
      status: cell.status,
      reasons: cell.reasons ?? [],
      backtestRunId: cell.backtestRunId == null ? null : normalizeScreeningUuid(cell.backtestRunId),
      metrics: cell.metrics ?? {},
      idempotencyKey: screeningCellKey({ ...cell, runId: id }),
    };
  });

  return database.transaction(async (tx) => {
    let inserted = 0;
    for (let offset = 0; offset < rows.length; offset += SCREENING_CELLS_INSERT_CHUNK) {
      const written = await tx.insert(strategyMarketResults)
        .values(rows.slice(offset, offset + SCREENING_CELLS_INSERT_CHUNK))
        .onConflictDoNothing({ target: strategyMarketResults.idempotencyKey })
        .returning({ id: strategyMarketResults.id });
      inserted += written.length;
    }
    return inserted;
  });
}

/**
 * Serialisiert Fortschritt per Zeilensperre: Total/Done sinken niemals,
 * auch nicht bei verspäteten/parallelen Worker-Meldungen. DONE/FAILED sind
 * terminal; RUNNING fällt nicht auf PENDING zurück. ABORTED → RUNNING ist
 * für explizites Fortsetzen erlaubt, ohne den Fortschritt zurückzusetzen.
 */
export async function setRunStatus(
  runId: string,
  status: ScreeningRunStatus,
  counts: ScreeningRunCounts = {},
  database: ScreeningStoreDb = db,
): Promise<RunRow> {
  const id = normalizeScreeningUuid(runId);
  if (!SCREENING_RUN_STATUSES.includes(status)) throw new Error("screening: ungültiger Run-Status");
  if (counts.cellsTotal !== undefined) checkCount(counts.cellsTotal, "cellsTotal");
  if (counts.cellsDone !== undefined) checkCount(counts.cellsDone, "cellsDone");

  return database.transaction(async (tx) => {
    const [current] = await tx.select().from(strategyScreeningRuns)
      .where(eq(strategyScreeningRuns.id, id)).limit(1).for("update");
    if (!current) throw new Error("screening: Run nicht gefunden");
    if (current.status === "DONE" || current.status === "FAILED") return current;

    const cellsTotal = Math.max(current.cellsTotal, counts.cellsTotal ?? 0);
    const cellsDone = Math.max(current.cellsDone, counts.cellsDone ?? 0);
    if (cellsDone > cellsTotal) throw new Error("screening: cellsDone übersteigt cellsTotal");
    if (status === "DONE" && cellsDone !== cellsTotal) throw new Error("screening: DONE benötigt alle Zellen");
    const nextStatus = status === "PENDING" && current.status !== "PENDING" ? current.status : status;
    const [updated] = await tx.update(strategyScreeningRuns).set({
      status: nextStatus,
      cellsTotal,
      cellsDone,
      updatedAt: sql`GREATEST(${strategyScreeningRuns.updatedAt}, now())`,
    }).where(eq(strategyScreeningRuns.id, id)).returning();
    return updated;
  });
}

/** Beliebige positive Ganzzahl, hart gedeckelt durch die gemeinsame Paging-SSoT. */
export function screeningResultsLimit(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? Math.min(value, MAX_PAGE_SIZE)
    : DEFAULT_PAGE_SIZE;
}

/** Bounded Read: hohe Prioritäten zuerst, unbekannte Priorität zuletzt, stabile Ties. */
export async function listResults(
  runId: string,
  query: { status?: CandidateStatus; limit?: number } = {},
  database: ScreeningStoreDb = db,
): Promise<CellRow[]> {
  const id = normalizeScreeningUuid(runId);
  return database.select().from(strategyMarketResults).where(and(
    eq(strategyMarketResults.runId, id),
    query.status === undefined ? undefined : eq(strategyMarketResults.status, query.status),
  )).orderBy(
    sql`${strategyMarketResults.priority} DESC NULLS LAST`,
    asc(strategyMarketResults.templateId),
    asc(strategyMarketResults.instrumentId),
    asc(strategyMarketResults.timeframe),
    asc(strategyMarketResults.venue),
    asc(strategyMarketResults.strategyVersionId),
    asc(strategyMarketResults.id),
  ).limit(screeningResultsLimit(query.limit));
}
