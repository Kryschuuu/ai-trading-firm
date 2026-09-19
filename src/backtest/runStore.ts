/**
 * Persistenz vergleichbarer Backtest-Runs (GAP-01, v1.51.0).
 *
 * Tabelle `backtest_runs` (append-only, Stil wie `rule_backtests`): ein
 * Walk-Forward-Lauf = EINE Zeile mit `paramsJson` (Regel-Ref, Fenster,
 * Kostenprofil), `metricsJson` (Aggregate OOS/IS) und `windowsJson`
 * (Kennzahlen + Trade-Hash je Fenster). Runs entstehen NUR via CLI
 * (`scripts/run-backtest.ts`) — es gibt bewusst keinen POST-Endpunkt.
 *
 * Schichten-Trennung für Tests: `toBacktestRunInsert` ist rein (ohne DB
 * testbar), die `*Db`-Funktionen sind dünne Drizzle-Hüllen (DB-gegatede
 * Tests, Repo-Konvention: ping → skip).
 */

import { desc, eq } from "drizzle-orm";
import { db } from "../db";
import { backtestRuns } from "../db/schema";
import { APP_VERSION } from "../lib/version";
import type { WalkForwardReport } from "./walkforward";
import type { RuleSpec } from "../lib/ruleEngine";

/** Maximale Listengröße der Read-API (DoS-Deckel, kein Paging nötig). */
export const BACKTEST_RUNS_LIST_MAX = 100;
export const BACKTEST_RUNS_LIST_DEFAULT = 20;

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

/** Schreibt EINEN Run (insert-only — kein Update-Pfad, append-only). */
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

/** Listet Runs, jüngste zuerst (Read-API `GET /api/firm/backtests`). */
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
