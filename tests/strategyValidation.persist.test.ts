/**
 * STX-06-04 — Evidence-Writer (`persist.ts`) gegen echtes Postgres.
 *
 * Abnahme der Schreib-Zusage des Prompts:
 *   1. **Ein Pfad:** `writeValidationEvidence()` schreibt ausschließlich über
 *      `recordEvidence()` der Strategy-Lifecycle — die Zeile trägt deren
 *      Schema (Hash, Idempotency, Zeit-Semantik, Provenienz).
 *   2. **Idempotenz:** Derselbe Report zweimal ⇒ **eine** Zeile
 *      (`created: true` → `created: false`, UNIQUE `idempotency_key` greift);
 *      auch zwei parallele Aufrufe erzeugen keine Dublette.
 *   3. **Keine Promotion:** In `strategy_lifecycle_transitions` entsteht keine
 *      Zeile — der Validator liefert Evidenz, er entscheidet keine Übergänge.
 *   4. **Fail-closed:** Ein nachträglich veränderter Report (falscher
 *      `evidenceHash`) wird abgewiesen, bevor irgendetwas geschrieben wird.
 *
 * Muster wie `tests/strategyLifecycle.db.test.ts`: eingebettete Postgres,
 * echtes Migrations-SQL, Audit-Transport gestubbt.
 */
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import EmbeddedPostgres from "embedded-postgres";
import type { Pool as PoolType } from "pg";
import { Pool } from "pg";

import { setAuditTransportForTests } from "../src/lib/auditSink";
import { resetTelemetryForTests } from "../src/lib/telemetry";
import { __resetAllSingletonsForTests } from "../src/lib/stateRegistry";
import {
  buildValidationReport,
  type BuildValidationReportInput,
  type StrategyValidationReport,
  type ValidationMetrics,
} from "../src/strategies/validator/report";
import {
  DEFAULT_TRAIN_OOS_GAP_THRESHOLDS,
  multipleTestingWarning,
  plateauMetrics,
  type IntegrityCheck,
  type TrainOosGap,
} from "../src/strategies/validator/overfit";
import type { AssumptionAudit, AssumptionCheck } from "../src/strategies/validator/assumptions";
import type { StressSummary } from "../src/strategies/validator/stress";
import type { CandidateScoreRow } from "../src/backtest/walkforward";

const PG_PORT = 55_460;
const DB_NAME = "strategy_validation_persist_test";
const DAY = 24 * 60 * 60 * 1000;

type PersistModule = typeof import("../src/strategies/validator/persist");

// ─────────────────────────────────────────────────────────────────────────────
// Report-Fixture (identisch zur Vertragsform des Report-Tests, kompakt)
// ─────────────────────────────────────────────────────────────────────────────

const NOW = Date.UTC(2026, 9, 2, 12, 0, 0);

function checkFixture(status: AssumptionCheck["status"]): AssumptionCheck {
  return {
    assumptionId: "WARMUP_MET",
    status,
    evidence: "WARMUP_MET: 5000 Kerzen ≥ 4000 benötigt — Fixture.",
    severity: "BLOCKING",
    templateAssumptions: [],
  };
}

const AUDIT_PASS: AssumptionAudit = {
  checks: [checkFixture("HOLDS")],
  violated: [],
  unknown: [],
  verdict: "PASS",
  blocking: [],
  criticalFindings: [],
  uncoveredCritical: [],
  summary: "Fixture-Audit: 1 HOLDS, 0 VIOLATED, 0 UNKNOWN ⇒ PASS.",
  auditVersion: "asm1",
};

const INTEGRITY_CLEAN: IntegrityCheck = {
  status: "CLEAN",
  verdict: "CLEAR",
  checks: [],
  reason: "Fixture: Holdout nach OOS, Kandidat eingefroren, Hash unverändert.",
};

const GAP_OK: TrainOosGap = {
  isSharpe: 1.4,
  oosSharpe: 1.1,
  gap: 0.3,
  verdict: "OK",
  thresholds: DEFAULT_TRAIN_OOS_GAP_THRESHOLDS,
  evidence: "Fixture-Lücke 0.3 ≤ 0.5 ⇒ OK.",
};

const STRESS_ROBUST: StressSummary = {
  scenarios: [
    { id: "base", sharpe: 1.1, netPnl: 900, maxDrawdownPct: 8, trades: 150 },
    { id: "double", sharpe: 0.9, netPnl: 500, maxDrawdownPct: 10, trades: 150 },
    { id: "triple", sharpe: 0.75, netPnl: 200, maxDrawdownPct: 12, trades: 150 },
  ],
  degradationRatio: 0.68,
  breakevenMultiplier: null,
  verdict: "COST_ROBUST",
};

function scoreRow(candidateId: string, passedGates: boolean, score: number): CandidateScoreRow {
  return {
    candidateId,
    config: { candidateId },
    score,
    passedGates,
    rejectionReason: passedGates ? null : "minTrades: 3 < 10",
    metrics: {
      trades: 12,
      winRate: 50,
      netPnl: score * 100,
      pnl: score / 10,
      sharpeRatio: score,
      sortinoRatio: score,
      profitFactor: 1.2,
      maxDrawdownPct: 10,
    },
  };
}

const METRICS: ValidationMetrics = {
  sharpe: 1.2,
  sortino: 1.6,
  maxDrawdownPct: 12,
  winRate: 0.55,
  profitFactor: 1.4,
  expectancy: 4.2,
  tradeCount: 150,
  netPnl: 4200,
};

function buildReport(overrides: Partial<BuildValidationReportInput> = {}): StrategyValidationReport {
  const windowEnd = NOW - 2 * DAY;
  const availableAt = windowEnd + 60 * 60 * 1000;
  return buildValidationReport({
    strategyKey: "rsi-mean-reversion@v3",
    strategyVersion: 3,
    strategyVersionId: "11111111-1111-4111-8111-111111111111",
    templateId: "rsi-mean-reversion",
    templateVersion: 1,
    strategyClass: "mean-reversion",
    symbol: "BITUNIX:BTCUSDT",
    timeframe: "1h",
    metrics: METRICS,
    oosWindows: 3,
    windowStart: NOW - 40 * DAY,
    windowEnd,
    dataQualityScore: 0.95,
    assumptions: AUDIT_PASS,
    integrity: INTEGRITY_CLEAN,
    gap: GAP_OK,
    plateau: plateauMetrics([
      [scoreRow("cand-0", true, 3), scoreRow("cand-1", true, 2)],
      [scoreRow("cand-0", true, 2), scoreRow("cand-1", true, 1)],
      [scoreRow("cand-0", true, 1), scoreRow("cand-1", true, 0.5)],
    ]),
    multipleTesting: multipleTestingWarning(2),
    stress: STRESS_ROBUST,
    trades: [],
    regimeSnapshots: [],
    eventTime: windowEnd,
    availableAt,
    computedAt: availableAt + 60 * 60 * 1000,
    notes: ["Fixture: vollständiger PASS-Report für den Schreibpfad."],
    ...overrides,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe("strategy_validation persist (Postgres): eine Zeile, idempotent, ohne Promotion", () => {
  let pg: EmbeddedPostgres | null = null;
  let pool: PoolType | null = null;
  let persist: PersistModule;

  before(async () => {
    setAuditTransportForTests(async () => {});

    const dataDir = path.join(process.cwd(), `.tmp-strategy-validation-${Date.now()}`);
    pg = new EmbeddedPostgres({
      databaseDir: dataDir,
      user: "postgres",
      password: "password",
      port: PG_PORT,
      persistent: false,
    });
    await pg.initialise();
    await pg.start();
    await pg.createDatabase(DB_NAME);

    process.env.DATABASE_URL = `postgresql://postgres:password@127.0.0.1:${PG_PORT}/${DB_NAME}`;

    const g = globalThis as typeof globalThis & {
      __arenaNextJsPostgresqlPool?: PoolType;
      __arenaNextJsPostgresqlDb?: unknown;
    };
    delete g.__arenaNextJsPostgresqlPool;
    delete g.__arenaNextJsPostgresqlDb;

    pool = new Pool({
      host: "127.0.0.1",
      port: PG_PORT,
      user: "postgres",
      password: "password",
      database: DB_NAME,
    });

    await pool.query(`
      CREATE TABLE IF NOT EXISTS backtest_runs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        instrument_id text NOT NULL,
        timeframe text NOT NULL,
        from_ts timestamptz NOT NULL,
        to_ts timestamptz NOT NULL,
        params_json jsonb NOT NULL,
        metrics_json jsonb NOT NULL,
        windows_json jsonb NOT NULL,
        code_version text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);

    const migration = readFileSync(
      path.join(process.cwd(), "drizzle/2026-09-23_strategy_lifecycle.sql"),
      "utf8",
    );
    await pool.query(migration);

    // Persistenz-Modul nach gesetztem DATABASE_URL importieren (lazy db).
    persist = await import("../src/strategies/validator/persist");
  });

  after(async () => {
    setAuditTransportForTests(null);
    await pool?.end();
    if (pg) await pg.stop();
  });

  beforeEach(async () => {
    resetTelemetryForTests();
    __resetAllSingletonsForTests();
    await pool!.query("DELETE FROM strategy_lifecycle_evidence");
    await pool!.query("DELETE FROM strategy_lifecycle_transitions");
    await pool!.query("DELETE FROM strategy_lifecycle_states");
  });

  it("schreibt genau eine Evidence-Zeile mit Hash, Idempotency und Zeit-Semantik", async () => {
    const report = buildReport();
    const row = await persist.writeValidationEvidence(report);
    assert.ok(pool);

    assert.equal(row.strategyKey, report.strategyKey);
    assert.equal(row.strategyVersion, report.strategyVersion);
    assert.equal(row.kind, "BACKTEST_RUN");
    assert.equal(row.result, "PASS");
    assert.equal(row.contentHash, report.evidenceHash);
    assert.equal(row.idempotencyKey, report.idempotencyKey);
    assert.match(row.contentHash, /^sle1:[0-9a-f]{64}$/);
    assert.match(row.idempotencyKey, /^slei1:[0-9a-f]{64}$/);
    assert.equal(row.sampleSize, report.metrics.tradeCount);
    assert.equal(row.windowStart?.getTime(), report.windowStart);
    assert.equal(row.windowEnd?.getTime(), report.windowEnd);
    assert.ok(row.availableAt.getTime() >= row.eventTime.getTime());
    assert.ok(row.computedAt.getTime() >= row.availableAt.getTime());
    assert.equal((row.metrics as Record<string, unknown>).dataQualityScore, 0.95);
    assert.equal((row.detail as Record<string, unknown>).overfittingHoldoutIntegrity, "CLEAN");
    assert.equal((row.detail as Record<string, unknown>).schemaVersion, "svr1");

    const count = await pool.query("SELECT count(*)::int AS n FROM strategy_lifecycle_evidence");
    assert.equal(count.rows[0].n, 1);
  });

  it("doppelter Lauf ⇒ eine Zeile (created true → false), UNIQUE greift", async () => {
    const report = buildReport();
    const first = await persist.writeValidationEvidenceDetailed(report);
    const second = await persist.writeValidationEvidenceDetailed(report);
    assert.ok(pool);

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(first.evidence.id, second.evidence.id);
    const count = await pool.query("SELECT count(*)::int AS n FROM strategy_lifecycle_evidence");
    assert.equal(count.rows[0].n, 1);
  });

  it("parallele identische Writes erzeugen keine Dublette", async () => {
    const report = buildReport();
    const results = await Promise.all([
      persist.writeValidationEvidenceDetailed(report),
      persist.writeValidationEvidenceDetailed(report),
    ]);
    assert.ok(pool);
    assert.equal(results[0].evidence.id, results[1].evidence.id);
    const count = await pool.query("SELECT count(*)::int AS n FROM strategy_lifecycle_evidence");
    assert.equal(count.rows[0].n, 1);
  });

  it("kein requestTransition: transitions-Tabelle bleibt leer", async () => {
    const report = buildReport();
    await persist.writeValidationEvidence(report);
    assert.ok(pool);
    const transitions = await pool.query("SELECT count(*)::int AS n FROM strategy_lifecycle_transitions");
    const states = await pool.query("SELECT count(*)::int AS n FROM strategy_lifecycle_states");
    assert.equal(transitions.rows[0].n, 0);
    assert.equal(states.rows[0].n, 0);
  });

  it("manipulierter Report wird fail-closed abgewiesen — keine Zeile", async () => {
    const report = buildReport();
    const tampered = { ...report, result: "FAIL" as const };
    await assert.rejects(
      () => persist.writeValidationEvidence(tampered),
      /hash-mismatch|validation:/,
    );
    assert.ok(pool);
    const count = await pool.query("SELECT count(*)::int AS n FROM strategy_lifecycle_evidence");
    assert.equal(count.rows[0].n, 0);
  });

  it("INCONCLUSIVE/FAIL-Reports werden ebenfalls geschrieben (kein stilles Verwerfen)", async () => {
    const inconclusive = buildReport({
      assumptions: { ...AUDIT_PASS, verdict: "INCONCLUSIVE", unknown: [checkFixture("UNKNOWN")], summary: "Fixture: 1 UNKNOWN ⇒ INCONCLUSIVE." },
    });
    const fail = buildReport({ integrity: { ...INTEGRITY_CLEAN, status: "CONTAMINATED", verdict: "INCONCLUSIVE" } });
    const first = await persist.writeValidationEvidence(inconclusive);
    const second = await persist.writeValidationEvidence(fail);
    assert.equal(first.result, "INCONCLUSIVE");
    assert.equal(second.result, "INCONCLUSIVE");
    assert.notEqual(first.id, second.id);
  });
});
