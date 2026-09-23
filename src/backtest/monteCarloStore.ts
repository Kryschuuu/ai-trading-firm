/**
 * Persistenz der Monte-Carlo-/Trade-Resampling-Analyse (RMA-P6-02, v1.72.0)
 * — SERVER-seitig (`@/db`-Import; niemals aus Client-Import-Graphen ziehen).
 *
 * Schichten:
 *   - `loadMonteCarloSample`  Ledger-Quelle: lädt einen verifizierten
 *                             Walk-Forward-Run + seine `backtest_trades`
 *                             (segment-gefiltert, kanonisch sortiert) mit
 *                             allen Eligibility-Gates (fail-closed).
 *   - `runMonteCarloAnalysis` End-to-End-Pfad: Quelle laden → pure
 *                             Simulation (`./montecarlo.ts`) → idempotente
 *                             Persistenz EINER Zeile in
 *                             `backtest_monte_carlo_runs`.
 *   - `listMonteCarloRuns`/`getMonteCarloRun` bounded Read-API.
 *
 * Vertrag:
 *   - **Idempotenz:** `idempotency_key = mcs1:<sha256>` (abgeleitet aus
 *     Quell-Run, Config, Seed, Algorithmusversion und Eingabe-Hash — NICHT
 *     überschreibbar, damit die Reproduzierbarkeitsgarantie hält) +
 *     UNIQUE-Index ⇒ Retry/Restart liefert den bestehenden Lauf zurück
 *     (`created: false`), nie eine zweite Zeile.
 *   - **Fail-closed Quelle:** Run ohne RECONCILED-Ledger (Alt-Runs vor
 *     v1.52.0), inkonsistente `seq`-Ordnung, abweichende Zeilenzahl, leeres
 *     Segment oder gemischte Symbole ⇒ Abweisung vor jedem Write.
 *   - **Bounded:** persistiert wird NUR die Zusammenfassung (Quantile,
 *     Exceedance-Wahrscheinlichkeiten, Statistik-Hinweise, Caveats) — KEINE
 *     Rohpfade (bis zu runs × n Equity-Punkten) in DB oder API.
 *   - **Zeitsemantik:** Die Quell-Trades tragen Ereigniszeiten
 *     (`entry_ts`/`exit_ts`); `created_at` der Analyse-Zeile ist die
 *     Berechnungszeit. Die Simulation liest ausschließlich den unveränderlichen
 *     append-only Ledger — kein Look-ahead möglich.
 *
 * Beobachtung: bounded Metrik `monte_carlo_runs_total` (Labels: Ergebnis-Code
 * + Methode aus geschlossener Menge) + strukturierte Audit-Events
 * `MONTE_CARLO_RUN_PERSISTED` / `MONTE_CARLO_RUN_PERSIST_FAILED`. KEINE Run-/
 * Instrument-/Trade-IDs als Metrik-Labels (Kardinalitätsregel).
 */

import { and, asc, desc, eq } from "drizzle-orm";

import { db } from "../db";
import { backtestMonteCarloRuns, backtestRuns, backtestTrades } from "../db/schema";
import { APP_VERSION } from "../lib/version";
import { auditWrite, type AuditLevel } from "../lib/auditSink";
import { metricLabel, telemetry } from "../lib/telemetry";
import { parseDecimal } from "./tradeLedger";
import {
  MC_ALGORITHM_VERSION,
  MC_MIN_SAMPLE_TRADES,
  MonteCarloError,
  runMonteCarloSimulation,
  type MonteCarloConfig,
  type MonteCarloResult,
  type MonteCarloSegmentFilter,
  type MonteCarloTradeInput,
} from "./montecarlo";

/** Listengröße der Read-API (Deckel wie `BACKTEST_RUNS_LIST_*`). */
export const MONTE_CARLO_LIST_MAX = 100;
export const MONTE_CARLO_LIST_DEFAULT = 20;

// ─────────────────────────────────────────────────────────────────────────────
// Fehler
// ─────────────────────────────────────────────────────────────────────────────

/** Fehlercodes des Store-Pfads (zusätzlich zu `MonteCarloErrorCode`). */
export type MonteCarloStoreErrorCode =
  | MonteCarloError["code"]
  | "mc:run-not-found"
  | "mc:ledger-unavailable"
  | "mc:ledger-inconsistent"
  | "mc:idempotency-conflict"
  | "mc:persist-failed";

export class MonteCarloStoreError extends Error {
  constructor(
    public readonly code: MonteCarloStoreErrorCode,
    message: string,
    public readonly detail: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "MonteCarloStoreError";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Quelle: verifiziertes Trade-Ledger
// ─────────────────────────────────────────────────────────────────────────────

/** Minimaler DB-Vertrag (injizierbar für Tests). */
export type MonteCarloDb = Pick<typeof db, "select" | "insert">;

/** Geladene Analyse-Quelle: Run-Zeile + segment-gefilterte Trades (kanonisch). */
export interface MonteCarloSample {
  run: typeof backtestRuns.$inferSelect;
  trades: MonteCarloTradeInput[];
}

/**
 * Lädt die Analyse-Stichprobe aus dem persistenten Trade-Ledger.
 *
 * Gates (alle fail-closed VOR jedem Write):
 *   - Run existiert (`mc:run-not-found`).
 *   - Run hat ein RECONCILED-Ledger — Alt-Runs vor v1.52.0 (Status/Count NULL)
 *     werden abgelehnt: NULL heißt „kein Ledger“, nicht „0 Trades“
 *     (`mc:ledger-unavailable`).
 *   - `segment: "ALL"`: Zeilenzahl == `run.tradeCount` und `seq` kontiguierlich
 *     1..N (`mc:ledger-inconsistent`); Segment-Filter: streng aufsteigende
 *     `seq` und nicht leer.
 *   - Zahlen parsen (Dezimal-Strings) und Endlichkeit.
 *
 * Gemischte Symbole / Mindeststichprobe / Zeitspanne prüft die pure Engine
 * (`validateMonteCarloSample` / `deriveTradesPerYear`) — dort sind sie ohne
 * DB testbar.
 */
export async function loadMonteCarloSample(
  runId: string,
  segment: MonteCarloSegmentFilter,
  database: MonteCarloDb = db
): Promise<MonteCarloSample> {
  const runRows = await database.select().from(backtestRuns).where(eq(backtestRuns.id, runId)).limit(1);
  const run = runRows[0];
  if (!run) {
    throw new MonteCarloStoreError("mc:run-not-found", `Quell-Run ${runId} existiert nicht.`, { runId });
  }
  if (run.reconciliationStatus !== "RECONCILED" || run.tradeCount === null) {
    throw new MonteCarloStoreError(
      "mc:ledger-unavailable",
      `Quell-Run ${runId} hat kein RECONCILED-Trade-Ledger (Status ${String(run.reconciliationStatus)}, tradeCount ${String(
        run.tradeCount
      )}) — Alt-Runs vor v1.52.0 sind als Monte-Carlo-Quelle unzulässig (NULL ≠ 0).`,
      { runId, reconciliationStatus: run.reconciliationStatus, tradeCount: run.tradeCount }
    );
  }

  const conditions = [eq(backtestTrades.runId, runId)];
  if (segment !== "ALL") conditions.push(eq(backtestTrades.segment, segment));
  const rows = await database
    .select({
      seq: backtestTrades.seq,
      segment: backtestTrades.segment,
      symbol: backtestTrades.symbol,
      strategyId: backtestTrades.strategyId,
      entryTs: backtestTrades.entryTs,
      exitTs: backtestTrades.exitTs,
      pnlNet: backtestTrades.pnlNet,
      fees: backtestTrades.fees,
      slippage: backtestTrades.slippage,
      notional: backtestTrades.notional,
    })
    .from(backtestTrades)
    .where(and(...conditions))
    .orderBy(asc(backtestTrades.seq));

  if (rows.length === 0) {
    throw new MonteCarloStoreError(
      "mc:empty-sample",
      `Segment ${segment} des Runs ${runId} enthält keine Trades — Analyse abgelehnt.`,
      { runId, segment }
    );
  }
  if (segment === "ALL") {
    if (rows.length !== run.tradeCount) {
      throw new MonteCarloStoreError(
        "mc:ledger-inconsistent",
        `Ledger des Runs ${runId}: ${rows.length} Zeilen, Run behauptet ${run.tradeCount}.`,
        { runId, expected: run.tradeCount, actual: rows.length }
      );
    }
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].seq !== i + 1) {
        throw new MonteCarloStoreError(
          "mc:ledger-inconsistent",
          `Ledger des Runs ${runId}: seq nicht kontiguierlich (Position ${i}: seq ${rows[i].seq}).`,
          { runId, position: i, seq: rows[i].seq }
        );
      }
    }
  }

  const trades: MonteCarloTradeInput[] = rows.map((row, i) => ({
    seq: row.seq,
    symbol: row.symbol,
    strategyId: row.strategyId,
    entryTs: row.entryTs instanceof Date ? row.entryTs.getTime() : Number(row.entryTs),
    exitTs: row.exitTs instanceof Date ? row.exitTs.getTime() : Number(row.exitTs),
    pnlNet: parseDecimal(row.pnlNet, `pnlNet[seq=${row.seq}]`),
    fees: parseDecimal(row.fees, `fees[seq=${row.seq}]`),
    slippage: parseDecimal(row.slippage, `slippage[seq=${row.seq}]`),
    notional: parseDecimal(row.notional, `notional[seq=${row.seq}]`),
  }));
  // Defensive: Zeitstempel müssen endliche ms sein (fail-closed, nie 0-Neutralität).
  for (let i = 0; i < trades.length; i++) {
    const t = trades[i];
    if (!Number.isFinite(t.entryTs) || !Number.isFinite(t.exitTs)) {
      throw new MonteCarloStoreError(
        "mc:ledger-inconsistent",
        `Trade seq ${t.seq}: Zeitstempel nicht als endliche ms lesbar.`,
        { runId, seq: t.seq }
      );
    }
  }
  return { run, trades };
}

// ─────────────────────────────────────────────────────────────────────────────
// Analyse-Lauf: Quelle → Simulation → idempotente Persistenz
// ─────────────────────────────────────────────────────────────────────────────

/** Audit-Senke (injizierbar; Default `auditWrite`, Klasse `telemetry`). */
export type MonteCarloAuditSink = (
  event: string,
  level: AuditLevel,
  detail: Record<string, unknown>,
  opts?: Parameters<typeof auditWrite>[3]
) => Promise<unknown>;

export interface RunMonteCarloAnalysisInput {
  runId: string;
  config: MonteCarloConfig;
  /** UUID der neuen Zeile (Aufrufer/CLI vergibt sie; bei Replay gewinnt die bestehende). */
  analysisId: string;
}

export interface RunMonteCarloAnalysisDeps {
  db?: MonteCarloDb;
  audit?: MonteCarloAuditSink;
}

export interface RunMonteCarloAnalysisResult {
  id: string;
  /** false = idempotentes Replay: Analyse mit diesem Key existierte bereits. */
  created: boolean;
  idempotencyKey: string;
  result: MonteCarloResult;
}

function mcLabel(outcome: "created" | "replayed" | "failed", reason: string, method: string): void {
  telemetry.monteCarlo.runs.inc({ result: outcome, reason: metricLabel(reason, "OTHER"), method });
}

/**
 * End-to-End-Analyselauf: lädt die verifizierte Quelle, simuliert rein und
 * persistiert EINE Summary-Zeile idempotent. Rohpfade bleiben im Speicher.
 */
export async function runMonteCarloAnalysis(
  input: RunMonteCarloAnalysisInput,
  deps: RunMonteCarloAnalysisDeps = {}
): Promise<RunMonteCarloAnalysisResult> {
  const database = deps.db ?? db;
  const audit: MonteCarloAuditSink =
    deps.audit ??
    (async (event, level, detail, opts) => auditWrite(event, level, detail, opts));

  const config = input.config;
  let result: MonteCarloResult;
  try {
    const sample = await loadMonteCarloSample(input.runId, config.segment ?? "OOS", database);
    result = runMonteCarloSimulation({ sourceRunId: input.runId, trades: sample.trades, config });
  } catch (e) {
    const code = e instanceof MonteCarloError || e instanceof MonteCarloStoreError ? e.code : "mc:persist-failed";
    mcLabel("failed", code, String(config.method));
    await audit(
      "MONTE_CARLO_RUN_PERSIST_FAILED",
      "WARN",
      {
        runId: input.runId,
        method: String(config.method),
        segment: String(config.segment ?? "OOS"),
        code,
        message: e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300),
      },
      { auditClass: "telemetry" }
    );
    throw e;
  }

  const replay = async (): Promise<RunMonteCarloAnalysisResult> => {
    const existing = await database
      .select({ id: backtestMonteCarloRuns.id, inputTradesHash: backtestMonteCarloRuns.inputTradesHash })
      .from(backtestMonteCarloRuns)
      .where(eq(backtestMonteCarloRuns.idempotencyKey, result.idempotencyKey))
      .limit(1);
    return { id: existing[0]?.id ?? "", created: false, idempotencyKey: result.idempotencyKey, result };
  };

  try {
    const existing = await database
      .select({
        id: backtestMonteCarloRuns.id,
        inputTradesHash: backtestMonteCarloRuns.inputTradesHash,
        summaryJson: backtestMonteCarloRuns.summaryJson,
      })
      .from(backtestMonteCarloRuns)
      .where(eq(backtestMonteCarloRuns.idempotencyKey, result.idempotencyKey))
      .limit(1);
    if (existing[0]) {
      if (existing[0].inputTradesHash !== result.inputTradesHash) {
        // Unmöglicher Branch (der Key enthält den Hash) — Guard gegen korrupte
        // Teilläufe: fail-closed statt stiller Dubletten-Pflege.
        throw new MonteCarloStoreError(
          "mc:idempotency-conflict",
          `Idempotency-Key bereits mit anderem Eingabe-Hash belegt (Zeile ${existing[0].id}).`,
          { runId: input.runId, expected: result.inputTradesHash, actual: existing[0].inputTradesHash }
        );
      }
      mcLabel("replayed", "ok", result.config.method);
      await audit(
        "MONTE_CARLO_RUN_PERSISTED",
        "INFO",
        {
          analysisId: existing[0].id,
          created: false,
          runId: input.runId,
          method: result.config.method,
          segment: result.config.segment,
          seed: result.config.seed,
          runs: result.config.runs,
          sampleTrades: result.summary.stats.sampleTrades,
          scenario: result.summary.stats.scenario,
          idempotencyKey: result.idempotencyKey,
          codeVersion: APP_VERSION,
        },
        { auditClass: "telemetry" }
      );
      return { id: existing[0].id, created: false, idempotencyKey: result.idempotencyKey, result };
    }

    await database
      .insert(backtestMonteCarloRuns)
      .values({
        id: input.analysisId,
        sourceRunId: input.runId,
        idempotencyKey: result.idempotencyKey,
        method: result.config.method,
        segment: result.config.segment,
        scenario: result.summary.stats.scenario,
        seed: result.config.seed,
        seedAlgorithm: result.config.prngAlgorithm,
        runs: result.config.runs,
        blockLength: result.config.blockLength,
        sampleTrades: result.summary.stats.sampleTrades,
        inputTradesHash: result.inputTradesHash,
        configJson: result.config as unknown as Record<string, unknown>,
        summaryJson: result.summary as unknown as Record<string, unknown>,
        codeVersion: APP_VERSION,
      });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // Race: paralleler Retry hat den Key zuerst geschrieben ⇒ Replay.
    if (/backtest_monte_carlo_runs_idempotency_key_unique|duplicate key/i.test(message)) {
      const replayed = await replay();
      if (!replayed.id) {
        throw new MonteCarloStoreError(
          "mc:persist-failed",
          `Idempotenz-Kollision ohne auffindbare Zeile: ${message.slice(0, 200)}`,
          { runId: input.runId }
        );
      }
      mcLabel("replayed", "ok", result.config.method);
      await audit(
        "MONTE_CARLO_RUN_PERSISTED",
        "INFO",
        {
          analysisId: replayed.id,
          created: false,
          runId: input.runId,
          method: result.config.method,
          segment: result.config.segment,
          seed: result.config.seed,
          runs: result.config.runs,
          sampleTrades: result.summary.stats.sampleTrades,
          scenario: result.summary.stats.scenario,
          idempotencyKey: result.idempotencyKey,
          codeVersion: APP_VERSION,
        },
        { auditClass: "telemetry" }
      );
      return replayed;
    }
    if (e instanceof MonteCarloStoreError) throw e;
    mcLabel("failed", "mc:persist-failed", result.config.method);
    await audit(
      "MONTE_CARLO_RUN_PERSIST_FAILED",
      "WARN",
      { runId: input.runId, method: result.config.method, code: "mc:persist-failed", message: message.slice(0, 300) },
      { auditClass: "telemetry" }
    );
    throw new MonteCarloStoreError("mc:persist-failed", `Persistenz fehlgeschlagen: ${message.slice(0, 300)}`, {
      runId: input.runId,
    });
  }

  mcLabel("created", "ok", result.config.method);
  await audit(
    "MONTE_CARLO_RUN_PERSISTED",
    "INFO",
    {
      analysisId: input.analysisId,
      created: true,
      runId: input.runId,
      method: result.config.method,
      segment: result.config.segment,
      seed: result.config.seed,
      runs: result.config.runs,
      blockLength: result.config.blockLength,
      scenario: result.summary.stats.scenario,
      stress: result.config.stress,
      sampleTrades: result.summary.stats.sampleTrades,
      inputTradesHash: result.inputTradesHash,
      idempotencyKey: result.idempotencyKey,
      codeVersion: APP_VERSION,
      algorithmVersion: MC_ALGORITHM_VERSION,
    },
    { auditClass: "telemetry" }
  );
  return { id: input.analysisId, created: true, idempotencyKey: result.idempotencyKey, result };
}

// ─────────────────────────────────────────────────────────────────────────────
// Read-API (bounded, additiv)
// ─────────────────────────────────────────────────────────────────────────────

/** Limit-Validator der Liste (Deckel 100, Default 20). */
export function validateMonteCarloLimit(raw: unknown): { ok: true; limit: number } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === "") return { ok: true, limit: MONTE_CARLO_LIST_DEFAULT };
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > MONTE_CARLO_LIST_MAX) {
    return {
      ok: false,
      error: `INVALID_LIMIT: erwartet 1..${MONTE_CARLO_LIST_MAX}, erhalten ${String(raw).slice(0, 20)}`,
    };
  }
  return { ok: true, limit: n };
}

/** Ansicht einer Analyse-Zeile für die API (bounded; keine Rohpfade). */
export interface MonteCarloRunView {
  id: string;
  sourceRunId: string;
  method: string;
  segment: string;
  scenario: string;
  seed: number;
  seedAlgorithm: string;
  runs: number;
  blockLength: number | null;
  sampleTrades: number;
  inputTradesHash: string;
  idempotencyKey: string;
  codeVersion: string;
  createdAt: string;
  /** Vollständige, reproduzierbare Konfiguration (Export für Replay). */
  config: Record<string, unknown>;
  /** Bounded Summary (Quantile, Exceedance, Statistik, Caveats). */
  summary: Record<string, unknown>;
}

function runToView(row: typeof backtestMonteCarloRuns.$inferSelect): MonteCarloRunView {
  return {
    id: row.id,
    sourceRunId: row.sourceRunId,
    method: row.method,
    segment: row.segment,
    scenario: row.scenario,
    seed: Number(row.seed),
    seedAlgorithm: row.seedAlgorithm,
    runs: row.runs,
    blockLength: row.blockLength,
    sampleTrades: row.sampleTrades,
    inputTradesHash: row.inputTradesHash,
    idempotencyKey: row.idempotencyKey,
    codeVersion: row.codeVersion,
    createdAt: row.createdAt.toISOString(),
    config: row.configJson as Record<string, unknown>,
    summary: row.summaryJson as Record<string, unknown>,
  };
}

/**
 * Listet Analysen, jüngste zuerst; optional gefiltert nach Quell-Run.
 * Reine Metadaten + Summary — keine Rohpfade, kein Paging über Pfade nötig
 * (eine Zeile = eine bounded Summary).
 */
export async function listMonteCarloRuns(
  options: { sourceRunId?: string; limit?: number } = {},
  database: MonteCarloDb = db
): Promise<MonteCarloRunView[]> {
  const checked = options.limit === undefined ? { ok: true as const, limit: MONTE_CARLO_LIST_DEFAULT } : validateMonteCarloLimit(options.limit);
  const limit = checked.ok ? checked.limit : MONTE_CARLO_LIST_DEFAULT;
  const rows = options.sourceRunId
    ? await database
        .select()
        .from(backtestMonteCarloRuns)
        .where(eq(backtestMonteCarloRuns.sourceRunId, options.sourceRunId))
        .orderBy(desc(backtestMonteCarloRuns.createdAt))
        .limit(limit)
    : await database
        .select()
        .from(backtestMonteCarloRuns)
        .orderBy(desc(backtestMonteCarloRuns.createdAt))
        .limit(limit);
  return rows.map(runToView);
}

/** Lädt EINE Analyse per UUID. */
export async function getMonteCarloRun(
  id: string,
  database: MonteCarloDb = db
): Promise<MonteCarloRunView | null> {
  const rows = await database
    .select()
    .from(backtestMonteCarloRuns)
    .where(eq(backtestMonteCarloRuns.id, id))
    .limit(1);
  return rows[0] ? runToView(rows[0]) : null;
}
