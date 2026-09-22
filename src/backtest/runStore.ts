/**
 * Persistenz vergleichbarer Backtest-Runs (GAP-01, v1.51.0) und ihres
 * Trade-Ledgers (RMA-P1-04, v1.52.0).
 *
 * Tabellen (append-only, Stil wie `rule_backtests`):
 *   - `backtest_runs`: ein Walk-Forward-Lauf = EINE Zeile mit `paramsJson`
 *     (Regel-Ref, Fenster, Kostenprofil), `metricsJson` (Aggregate OOS/IS),
 *     `windowsJson` (Kennzahlen + Trade-Hash je Fenster) sowie seit v1.52.0
 *     `idempotencyKey`, `tradeCount`, `reconciliationStatus`,
 *     `reconciliationJson`.
 *   - `backtest_trades`: eine Zeile je Trade des Laufs (Trade-Level-
 *     Wahrheitsquelle; Mapping/Abgleich in `./tradeLedger.ts`).
 *
 * Produktionspfad ist `persistBacktestRun`: Run + alle Trades in EINER
 * Transaktion, Read-back + Hash-Abgleich vor COMMIT, stabiler Idempotency-
 * Key (Retry ⇒ derselbe Run, exakt eine Zeile, keine doppelte Sequenz).
 * Ein inkonsistentes Ledger wird abgelehnt — es entsteht weder Run noch
 * Trade-Zeile (fail-closed, nie ein „erfolgreicher“ Run ohne Ledger).
 * Runs entstehen NUR via CLI (`scripts/run-backtest.ts`) — es gibt bewusst
 * keinen POST-Endpunkt.
 *
 * Schichten-Trennung für Tests: Abbildungen/Validatoren sind rein (ohne DB
 * testbar), die `*Db`-Funktionen sind dünne Drizzle-Hüllen (DB-gegatede
 * Tests, Repo-Konvention: ping → skip). `persistBacktestRun` nimmt seine
 * Abhängigkeiten (DB, Audit) injizierbar entgegen.
 */

import { insertQualityBatch } from "../executionQuality/transaction";
import { and, asc, desc, eq, gt } from "drizzle-orm";
import { db } from "../db";
import { backtestRuns, backtestTrades } from "../db/schema";
import { APP_VERSION } from "../lib/version";
import { auditWrite, type AuditLevel } from "../lib/auditSink";
import { metricLabel, telemetry } from "../lib/telemetry";
import type { WalkForwardReport, WalkForwardSegment } from "./walkforward";
import type { RuleSpec } from "../lib/ruleEngine";
import {
  backtestRunIdempotencyKey,
  mapReportTrades,
  parseTradePageQuery,
  reconcileTradeLedger,
  tradeRowToView,
  TradeLedgerError,
  validateIdempotencyKey,
  encodeTradeCursor,
  type BacktestTradeRow,
  type BacktestTradeView,
  type TradeLedgerReconciliation,
  type TradePageQuery,
} from "./tradeLedger";

/** Maximale Listengröße der Read-API (DoS-Deckel, kein Paging nötig). */
export const BACKTEST_RUNS_LIST_MAX = 100;
export const BACKTEST_RUNS_LIST_DEFAULT = 20;

/** Zeilen je INSERT-Statement (Parameter-Deckel von PostgreSQL: 65 535). */
export const BACKTEST_TRADES_INSERT_CHUNK = 250;

/** Insert-Zeile für `backtest_runs` (reine Abbildung, kein IO). */
export interface BacktestRunInsert {
  id: string;
  instrumentId: string;
  timeframe: string;
  fromTs: Date;
  toTs: Date;
  paramsJson: Record<string, unknown>;
  metricsJson: Record<string, unknown>;
  windowsJson: Record<string, unknown>;
  codeVersion: string;
}

/**
 * Reine Abbildung Report → Insert-Zeile (deterministisch bis auf `id`:
 * der Aufrufer — die CLI — vergibt die UUID, Tests injizieren sie).
 * Die Trade-Liste des Reports wird bewusst NICHT in die JSON-Spalten
 * kopiert — sie lebt relational in `backtest_trades`.
 */
export function toBacktestRunInsert(
  report: WalkForwardReport,
  spec: RuleSpec,
  id: string
): BacktestRunInsert {
  return {
    id,
    instrumentId: report.instrumentId,
    timeframe: report.timeframe,
    fromTs: new Date(report.from),
    toTs: new Date(report.to),
    paramsJson: {
      kind: report.kind,
      ruleRef: report.ruleRef,
      ruleSpec: spec,
      walkforward: report.walkforward,
      costProfile: report.costProfile,
      createdAt: report.createdAt,
      ...(report.selection ? { selection: report.selection } : {}),
      ...(report.freezeArtifacts ? { freezeArtifacts: report.freezeArtifacts } : {}),
      ...(report.holdout ? { holdout: report.holdout } : {}),
      ...(report.replayEvidence ? { replayEvidence: report.replayEvidence } : {}),
    },
    metricsJson: {
      aggregateOos: report.aggregateOos,
      aggregateIs: report.aggregateIs,
    },
    windowsJson: {
      windows: report.windows,
    },
    codeVersion: report.codeVersion || APP_VERSION,
  };
}

/** Handgeschriebener Limit-Validator (Repo-Stil, kein Zod — R3). */
export function validateRunsLimit(raw: unknown): { ok: true; limit: number } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: true, limit: BACKTEST_RUNS_LIST_DEFAULT };
  }
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > BACKTEST_RUNS_LIST_MAX) {
    return {
      ok: false,
      error: `INVALID_LIMIT: erwartet 1..${BACKTEST_RUNS_LIST_MAX}, erhalten ${String(raw).slice(0, 20)}`,
    };
  }
  return { ok: true, limit: n };
}

/** Handgeschriebener UUID-Validator für Run-IDs (Repo-Stil, kein Zod — R3). */
export function validateRunId(raw: unknown): { ok: true; id: string } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: false, error: "INVALID_RUN_ID: keine Zeichenkette" };
  const id = raw.trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
    return { ok: false, error: `INVALID_RUN_ID: kein UUID-Format (${raw.slice(0, 40)})` };
  }
  return { ok: true, id };
}

/**
 * Schreibt EINE Run-Zeile OHNE Trade-Ledger (insert-only).
 *
 * Nur noch Low-Level-/Fixture-Pfad (Alt-Run-Semantik: `tradeCount`,
 * `reconciliationStatus` bleiben NULL = „kein Ledger persistiert“). Der
 * Produktionspfad (CLI) ist `persistBacktestRun`.
 */
export async function insertBacktestRun(row: BacktestRunInsert): Promise<{ id: string }> {
  const inserted = await db
    .insert(backtestRuns)
    .values({
      id: row.id,
      instrumentId: row.instrumentId,
      timeframe: row.timeframe,
      fromTs: row.fromTs,
      toTs: row.toTs,
      paramsJson: row.paramsJson,
      metricsJson: row.metricsJson,
      windowsJson: row.windowsJson,
      codeVersion: row.codeVersion,
    })
    .returning({ id: backtestRuns.id });
  return { id: inserted[0]?.id ?? row.id };
}

/** Listet Runs, jüngste zuerst (Read-API `GET /api/firm/backtests`) — ohne Trades. */
export async function listBacktestRuns(limit: number): Promise<typeof backtestRuns.$inferSelect[]> {
  const checked = validateRunsLimit(limit);
  const take = checked.ok ? checked.limit : BACKTEST_RUNS_LIST_DEFAULT;
  return db.select().from(backtestRuns).orderBy(desc(backtestRuns.createdAt)).limit(take);
}

/** Lädt EINEN Run per UUID (Read-API `GET /api/firm/backtests/[id]`). */
export async function getBacktestRun(id: string): Promise<typeof backtestRuns.$inferSelect | null> {
  const rows = await db.select().from(backtestRuns).where(eq(backtestRuns.id, id)).limit(1);
  return rows[0] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Atomare Persistenz Run + Trades (RMA-P1-04)
// ─────────────────────────────────────────────────────────────────────────────

/** Minimaler DB-Vertrag von `persistBacktestRun` (Transaktion + Selects). */
export type BacktestRunDb = Pick<typeof db, "transaction" | "select">;

export interface PersistBacktestRunInput {
  report: WalkForwardReport;
  spec: RuleSpec;
  /** Run-UUID (Aufrufer vergibt sie; bei idempotentem Replay gewinnt die bestehende). */
  runId: string;
  /** Default: `backtestRunIdempotencyKey(report)` (Inhalts-Fingerprint). */
  idempotencyKey?: string;
}

/** Audit-Senke (injizierbar; Default `auditWrite`, Klasse `telemetry`). */
export type BacktestAuditSink = (
  event: string,
  level: AuditLevel,
  detail: Record<string, unknown>,
  opts?: Parameters<typeof auditWrite>[3]
) => Promise<unknown>;

export interface PersistBacktestRunDeps {
  db?: BacktestRunDb;
  audit?: BacktestAuditSink;
  chunkSize?: number;
}

export interface PersistBacktestRunResult {
  id: string;
  /** false = idempotentes Replay: Run mit diesem Key existierte bereits. */
  created: boolean;
  idempotencyKey: string;
  tradeCount: number;
  reconciliation: TradeLedgerReconciliation;
}

/** Fehlercodes des Persistenzpfads (zusätzlich zu `TradeLedgerErrorCode`). */
export type BacktestPersistenceErrorCode = "persist:db-error" | "persist:run-id-conflict";

export class BacktestPersistenceError extends Error {
  constructor(
    public readonly code: BacktestPersistenceErrorCode,
    message: string,
    public readonly detail: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "BacktestPersistenceError";
  }
}

interface PgErrorShape {
  code?: unknown;
  constraint?: unknown;
  message?: unknown;
  cause?: unknown;
}

/** Entpackt Drizzle-/pg-Fehler auf (SQLSTATE, Constraint, kompakte Meldung) — ohne Query-Parameter. */
export function describeDbError(e: unknown): { code: string | null; constraint: string | null; message: string } {
  const seen = new Set<unknown>();
  let current: unknown = e;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const shape = current as PgErrorShape;
    if (typeof shape.code === "string" && /^[0-9A-Z]{5}$/.test(shape.code)) {
      return {
        code: shape.code,
        constraint: typeof shape.constraint === "string" ? shape.constraint : null,
        message: typeof shape.message === "string" ? shape.message.slice(0, 300) : "DB-Fehler",
      };
    }
    current = shape.cause;
  }
  const message = e instanceof Error ? e.message : String(e);
  // Drizzle hängt Query + Parameter an die Meldung — nur die erste Zeile behalten.
  return { code: null, constraint: null, message: message.split("\n")[0].slice(0, 300) };
}

type ExistingRun = {
  id: string;
  idempotencyKey: string | null;
  tradeCount: number | null;
  reconciliationJson: unknown;
};

function asReconciliation(value: unknown, runId: string): TradeLedgerReconciliation {
  if (value && typeof value === "object" && (value as { status?: unknown }).status === "RECONCILED") {
    return value as TradeLedgerReconciliation;
  }
  throw new TradeLedgerError(
    "ledger:idempotency-conflict",
    `Run ${runId} trägt denselben Idempotency-Key, aber keine RECONCILED-Evidenz — kein sicheres Replay.`,
    { runId }
  );
}

function tradeInsertValues(row: BacktestTradeRow): typeof backtestTrades.$inferInsert {
  return {
    runId: row.runId,
    seq: row.seq,
    windowIndex: row.windowIndex,
    segment: row.segment,
    tradeRef: row.tradeRef,
    strategyId: row.strategyId,
    symbol: row.symbol,
    side: row.side,
    qty: row.qty,
    notional: row.notional,
    entryTs: row.entryTs,
    exitTs: row.exitTs,
    entryPrice: row.entryPrice,
    exitPrice: row.exitPrice,
    pnlGross: row.pnlGross,
    pnlNet: row.pnlNet,
    pnlPct: row.pnlPct,
    fees: row.fees,
    funding: row.funding,
    slippage: row.slippage,
    exitReason: row.exitReason,
    durationBars: row.durationBars,
    provenanceJson: row.provenanceJson,
  };
}

/** DB-Zeile (Drizzle-Select) → Ledger-Zeile (validiert die geschlossenen Mengen). */
export function selectRowToTradeRow(row: typeof backtestTrades.$inferSelect): BacktestTradeRow {
  if (row.segment !== "IS" && row.segment !== "OOS") {
    throw new TradeLedgerError("ledger:readback-mismatch", `Zeile seq ${row.seq}: unbekanntes Segment ${row.segment}`);
  }
  if (row.side !== "LONG" && row.side !== "SHORT") {
    throw new TradeLedgerError("ledger:readback-mismatch", `Zeile seq ${row.seq}: unbekannte Seite ${row.side}`);
  }
  return {
    runId: row.runId,
    seq: row.seq,
    windowIndex: row.windowIndex,
    segment: row.segment,
    tradeRef: row.tradeRef,
    strategyId: row.strategyId,
    symbol: row.symbol,
    side: row.side,
    qty: row.qty,
    notional: row.notional,
    entryTs: row.entryTs,
    exitTs: row.exitTs,
    entryPrice: row.entryPrice,
    exitPrice: row.exitPrice,
    pnlGross: row.pnlGross,
    pnlNet: row.pnlNet,
    pnlPct: row.pnlPct,
    fees: row.fees,
    funding: row.funding,
    slippage: row.slippage,
    exitReason: row.exitReason as BacktestTradeRow["exitReason"],
    durationBars: row.durationBars,
    provenanceJson: row.provenanceJson as BacktestTradeRow["provenanceJson"],
  };
}

/** Bounded Metrik: `result` und `reason` sind Code-Konstanten (nie IDs/Symbole). */
function persistLabel(result: "created" | "replayed" | "failed", reason: string): void {
  telemetry.backtest.runPersist.inc({ result, reason: metricLabel(reason, "OTHER") });
}

/**
 * Persistiert Run + Trades atomar (EINE Transaktion) und idempotent.
 *
 * Ablauf:
 *   1. Rein (vor jedem IO): Zeilen abbilden + validieren, Ledger gegen die
 *      Report-Aggregate abgleichen — Abweichung ⇒ Fehler, kein DB-Zugriff.
 *   2. Transaktion: Key-Lookup (Replay ⇒ bestehender Run, nichts schreiben)
 *      → Run-Zeile (inkl. `tradeCount`, `RECONCILED`, Evidenz) → Trades in
 *      Chunks → Read-back aller Zeilen → erneuter Abgleich der GELESENEN
 *      Zeilen (Hash je Fenster, Summen) — Abweichung ⇒ Rollback.
 *   3. Race zweier gleichzeitiger Retries: die zweite Transaktion läuft auf
 *      den partiellen UNIQUE-Index (SQLSTATE 23505) und wird als Replay
 *      aufgelöst (erneuter Lookup) — nie zwei Runs für einen Key.
 *   4. Audit-Event `BACKTEST_RUN_PERSISTED` (Klasse telemetry) bzw.
 *      `BACKTEST_RUN_PERSIST_FAILED` + bounded Metrik
 *      `backtest_run_persist_total{result,reason}`.
 */
export async function persistBacktestRun(
  input: PersistBacktestRunInput,
  deps: PersistBacktestRunDeps = {}
): Promise<PersistBacktestRunResult> {
  const database = deps.db ?? db;
  const audit: BacktestAuditSink = deps.audit ?? auditWrite;
  const chunkSize = deps.chunkSize ?? BACKTEST_TRADES_INSERT_CHUNK;
  const runIdChecked = validateRunId(input.runId);
  if (!runIdChecked.ok) {
    throw new BacktestPersistenceError("persist:run-id-conflict", runIdChecked.error, { runId: String(input.runId).slice(0, 40) });
  }
  const runId = runIdChecked.id;

  let key: string;
  let rows: BacktestTradeRow[];
  let reconciliation: TradeLedgerReconciliation;
  try {
    key = validateIdempotencyKey(input.idempotencyKey ?? backtestRunIdempotencyKey(input.report));
    rows = mapReportTrades(input.report, runId);
    reconciliation = reconcileTradeLedger(input.report, rows);
  } catch (e) {
    const code = e instanceof TradeLedgerError ? e.code : "persist:db-error";
    persistLabel("failed", code);
    await audit(
      "BACKTEST_RUN_PERSIST_FAILED",
      "WARN",
      { runId, instrumentId: input.report.instrumentId, timeframe: input.report.timeframe, code, message: e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300) },
      { auditClass: "telemetry" }
    );
    throw e;
  }

  const runRow = toBacktestRunInsert(input.report, input.spec, runId);
  const expectedEvidence = JSON.stringify(reconciliation);

  const findExisting = async (executor: BacktestRunDb): Promise<ExistingRun | null> => {
    const byKey = await executor
      .select({
        id: backtestRuns.id,
        idempotencyKey: backtestRuns.idempotencyKey,
        tradeCount: backtestRuns.tradeCount,
        reconciliationJson: backtestRuns.reconciliationJson,
      })
      .from(backtestRuns)
      .where(eq(backtestRuns.idempotencyKey, key))
      .limit(1);
    return byKey[0] ?? null;
  };

  const replay = (existing: ExistingRun): PersistBacktestRunResult => {
    const evidence = asReconciliation(existing.reconciliationJson, existing.id);
    if (existing.tradeCount !== rows.length || evidence.tradeCount !== rows.length) {
      throw new TradeLedgerError(
        "ledger:idempotency-conflict",
        `Idempotency-Key bereits mit ${String(existing.tradeCount)} Trades belegt (Run ${existing.id}), dieser Lauf hat ${rows.length}.`,
        { runId: existing.id, expected: rows.length, actual: existing.tradeCount }
      );
    }
    const sameHashes =
      evidence.windows.length === reconciliation.windows.length &&
      evidence.windows.every((w, i) => {
        const mine = reconciliation.windows[i];
        return w.index === mine.index && w.segment === mine.segment && w.tradeHash === mine.tradeHash;
      });
    if (!sameHashes) {
      throw new TradeLedgerError(
        "ledger:idempotency-conflict",
        `Idempotency-Key bereits mit anderen Trade-Hashes belegt (Run ${existing.id}) — kein Replay möglich.`,
        { runId: existing.id }
      );
    }
    return { id: existing.id, created: false, idempotencyKey: key, tradeCount: rows.length, reconciliation: evidence };
  };

  const write = async (): Promise<PersistBacktestRunResult> =>
    database.transaction(async (tx) => {
      const existing = await findExisting(tx);
      if (existing) return replay(existing);

      const clash = await tx
        .select({ id: backtestRuns.id, idempotencyKey: backtestRuns.idempotencyKey })
        .from(backtestRuns)
        .where(eq(backtestRuns.id, runId))
        .limit(1);
      if (clash[0]) {
        throw new BacktestPersistenceError(
          "persist:run-id-conflict",
          `Run-ID ${runId} existiert bereits mit anderem Idempotency-Key (${String(clash[0].idempotencyKey ?? "NULL").slice(0, 16)}…).`,
          { runId }
        );
      }

      await tx.insert(backtestRuns).values({
        id: runRow.id,
        instrumentId: runRow.instrumentId,
        timeframe: runRow.timeframe,
        fromTs: runRow.fromTs,
        toTs: runRow.toTs,
        paramsJson: runRow.paramsJson,
        metricsJson: runRow.metricsJson,
        windowsJson: runRow.windowsJson,
        codeVersion: runRow.codeVersion,
        idempotencyKey: key,
        tradeCount: rows.length,
        reconciliationStatus: "RECONCILED",
        reconciliationJson: reconciliation,
      });

      for (let i = 0; i < rows.length; i += chunkSize) {
        const chunk = rows.slice(i, i + chunkSize).map(tradeInsertValues);
        await tx.insert(backtestTrades).values(chunk);
      }

      for (const batch of input.report.executionQuality ?? []) await insertQualityBatch(tx, batch);

      // Read-back: die DATENBANK ist die Wahrheit — erst wenn die gelesenen
      // Zeilen dieselben Fenster-Hashes und Summen liefern, wird committet.
      const stored = await tx
        .select()
        .from(backtestTrades)
        .where(eq(backtestTrades.runId, runId))
        .orderBy(asc(backtestTrades.seq));
      if (stored.length !== rows.length) {
        throw new TradeLedgerError(
          "ledger:readback-mismatch",
          `Read-back liefert ${stored.length} statt ${rows.length} Trade-Zeilen — Transaktion wird zurückgerollt.`,
          { runId, expected: rows.length, actual: stored.length }
        );
      }
      const verified = reconcileTradeLedger(input.report, stored.map(selectRowToTradeRow));
      if (JSON.stringify(verified) !== expectedEvidence) {
        throw new TradeLedgerError(
          "ledger:readback-mismatch",
          "Read-back-Abgleich weicht vom Vorab-Abgleich ab (Rundung/Typverlust in der DB) — Transaktion wird zurückgerollt.",
          { runId }
        );
      }

      return { id: runId, created: true, idempotencyKey: key, tradeCount: rows.length, reconciliation };
    });

  let result: PersistBacktestRunResult;
  try {
    try {
      result = await write();
    } catch (e) {
      const described = describeDbError(e);
      // Race: paralleler Retry hat den Key zuerst geschrieben ⇒ Replay.
      if (described.code === "23505" && described.constraint === "backtest_runs_idempotency_key_unique") {
        const existing = await findExisting(database);
        if (existing) {
          result = replay(existing);
        } else {
          throw new BacktestPersistenceError("persist:db-error", `Idempotency-Kollision ohne auffindbaren Run (${described.message})`, { runId });
        }
      } else if (e instanceof TradeLedgerError || e instanceof BacktestPersistenceError) {
        throw e;
      } else {
        throw new BacktestPersistenceError(
          "persist:db-error",
          `backtest_runs/backtest_trades-Write fehlgeschlagen${described.code ? ` (SQLSTATE ${described.code}${described.constraint ? `, ${described.constraint}` : ""})` : ""}: ${described.message}`,
          { runId, sqlState: described.code, constraint: described.constraint }
        );
      }
    }
  } catch (e) {
    const code = e instanceof TradeLedgerError || e instanceof BacktestPersistenceError ? e.code : "persist:db-error";
    persistLabel("failed", code);
    await audit(
      "BACKTEST_RUN_PERSIST_FAILED",
      "WARN",
      { runId, instrumentId: input.report.instrumentId, timeframe: input.report.timeframe, code, message: e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300) },
      { auditClass: "telemetry" }
    );
    throw e;
  }

  persistLabel(result.created ? "created" : "replayed", "ok");
  await audit(
    "BACKTEST_RUN_PERSISTED",
    "INFO",
    {
      runId: result.id,
      created: result.created,
      instrumentId: input.report.instrumentId,
      timeframe: input.report.timeframe,
      windows: input.report.walkforward.windowCount,
      tradeCount: result.tradeCount,
      oosTrades: result.reconciliation.segments.OOS.trades,
      oosNetPnl: result.reconciliation.segments.OOS.netPnl,
      idempotencyKey: result.idempotencyKey,
      codeVersion: input.report.codeVersion,
      // RMA-P1-01 (additiv): Ausführungspfad + Friktionsmodell des Laufs.
      executionModel: input.report.costProfile.executionModel,
      frictionModelVersion: input.report.costProfile.frictionModelVersion ?? null,
    },
    { auditClass: "telemetry" }
  );
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Read-API: Trade-Ledger eines Runs (paginiert, bounded)
// ─────────────────────────────────────────────────────────────────────────────

/** Ledger-Status eines Runs in der API (Alt-Runs: `UNAVAILABLE`, nie 0). */
export interface BacktestRunLedgerView {
  status: "RECONCILED" | "UNAVAILABLE";
  /** `null` = kein Ledger persistiert (Alt-Run vor v1.52.0). */
  tradeCount: number | null;
  idempotencyKey: string | null;
  reconciliation: TradeLedgerReconciliation | null;
}

export function runLedgerView(run: typeof backtestRuns.$inferSelect): BacktestRunLedgerView {
  const reconciled = run.reconciliationStatus === "RECONCILED" && run.tradeCount !== null;
  return {
    status: reconciled ? "RECONCILED" : "UNAVAILABLE",
    tradeCount: reconciled ? run.tradeCount : null,
    idempotencyKey: run.idempotencyKey ?? null,
    reconciliation: reconciled ? (run.reconciliationJson as TradeLedgerReconciliation) : null,
  };
}

export interface BacktestTradePage {
  items: BacktestTradeView[];
  /** Cursor der nächsten Seite oder `null` (letzte Seite). */
  nextCursor: string | null;
  limit: number;
  filter: {
    segment: WalkForwardSegment | null;
    window: number | null;
    symbol: string | null;
    side: "LONG" | "SHORT" | null;
    exitReason: string | null;
  };
}

function pageFilter(query: TradePageQuery): BacktestTradePage["filter"] {
  return {
    segment: query.segment ?? null,
    window: query.windowIndex ?? null,
    symbol: query.symbol ?? null,
    side: query.side ?? null,
    exitReason: query.exitReason ?? null,
  };
}

/** Leere Seite (Alt-Run ohne Ledger) — dieselbe Form wie eine echte Seite. */
export function emptyTradePage(query: TradePageQuery): BacktestTradePage {
  return { items: [], nextCursor: null, limit: query.limit, filter: pageFilter(query) };
}

/**
 * Keyset-Seite des Trade-Ledgers: `run_id = ? AND seq > ?` (+ Filter),
 * `ORDER BY seq LIMIT n+1` — Index-Range über
 * `backtest_trades_run_seq_unique`, kein OFFSET, hartes Limit 500.
 */
export async function listBacktestTrades(
  runId: string,
  query: TradePageQuery,
  database: Pick<typeof db, "select"> = db
): Promise<BacktestTradePage> {
  const conditions = [eq(backtestTrades.runId, runId), gt(backtestTrades.seq, query.afterSeq)];
  if (query.segment) conditions.push(eq(backtestTrades.segment, query.segment));
  if (query.windowIndex !== undefined) conditions.push(eq(backtestTrades.windowIndex, query.windowIndex));
  if (query.symbol) conditions.push(eq(backtestTrades.symbol, query.symbol));
  if (query.side) conditions.push(eq(backtestTrades.side, query.side));
  if (query.exitReason) conditions.push(eq(backtestTrades.exitReason, query.exitReason));

  const rows = await database
    .select()
    .from(backtestTrades)
    .where(and(...conditions))
    .orderBy(asc(backtestTrades.seq))
    .limit(query.limit + 1);

  const page = rows.slice(0, query.limit).map((r) => tradeRowToView(selectRowToTradeRow(r)));
  const nextCursor = rows.length > query.limit && page.length > 0 ? encodeTradeCursor(page[page.length - 1].seq) : null;
  return { items: page, nextCursor, limit: query.limit, filter: pageFilter(query) };
}

/** Parst die Trade-Query einer Request-URL (gemeinsam für Detail- und Trades-Route). */
export function tradePageQueryFromUrl(url: URL): ReturnType<typeof parseTradePageQuery> {
  return parseTradePageQuery(url.searchParams);
}
