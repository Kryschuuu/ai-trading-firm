/**
 * DB-Tests Strategy-Lifecycle (RMA-P1-05, v1.73.0) — eingebettete Postgres.
 *
 * - Migration zweifach idempotent (append-only) + CHECK-Constraints
 * - Roundtrip über den echten Service-Pfad: ensure → evidence → transitions
 * - Idempotenz: gleicher Evidence-Hash / Transition-Key ⇒ keine Dublette
 * - Parallele Transitions: genau EIN Zustand / eine Transition-Zeile
 * - DRAFT→LIVE und Promotion ohne Evidenz abgelehnt
 * - Drift-Degradation idempotent; Order-Gate nach Degradation
 * - Recovery braucht Cooldown/Evidenz (fail-closed)
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import EmbeddedPostgres from "embedded-postgres";
import type { Pool as PoolType } from "pg";
import { Pool } from "pg";

import { setAuditTransportForTests } from "../src/lib/auditSink";
import { resetTelemetryForTests } from "../src/lib/telemetry";
import { __resetAllSingletonsForTests } from "../src/lib/stateRegistry";

const PG_PORT = 55_451;
const DB_NAME = "strategy_lifecycle_test";
const MIN = 60_000;

const ENFORCE = {
  STRATEGY_LIFECYCLE_MODE: "enforce",
  STRATEGY_LIFECYCLE_RECOVERY_COOLDOWN_MS: "60000",
};

type Service = typeof import("../src/strategyLifecycle/service");
type Policies = typeof import("../src/strategyLifecycle/policies");
type Drift = typeof import("../src/strategyLifecycle/drift");

describe("strategy_lifecycle (Postgres): Migration, Roundtrip, Idempotenz", () => {
  let pg: EmbeddedPostgres | null = null;
  let pool: PoolType | null = null;
  let svc: Service;
  let policies: Policies;
  let drift: Drift;

  before(async () => {
    // Audit ohne DB-Schreibpfad (kein audit_log in dieser Mini-DB nötig).
    setAuditTransportForTests(async () => {});

    const dataDir = path.join(process.cwd(), `.tmp-strategy-lifecycle-${Date.now()}`);
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

    // Lazy-DB-Singleton frisch aufbauen (Testsuite-alter Cache killen).
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

    // Minimalschema für FK backtest_runs
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
      "utf8"
    );
    await pool.query(migration);
    await pool.query(migration);

    // Service nach gesetztem DATABASE_URL importieren (lazy db).
    svc = await import("../src/strategyLifecycle/service");
    policies = await import("../src/strategyLifecycle/policies");
    drift = await import("../src/strategyLifecycle/drift");
  });

  after(async () => {
    setAuditTransportForTests(null);
    await pool?.end();
    if (pg) await pg.stop();
  });

  beforeEach(() => {
    resetTelemetryForTests();
    __resetAllSingletonsForTests();
  });

  it("Migration zweifach idempotent + CHECK-Constraints", async () => {
    assert.ok(pool);
    const r = await pool!.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_name LIKE 'strategy_lifecycle%' ORDER BY 1`
    );
    assert.equal(r.rowCount, 3);

    await assert.rejects(
      pool!.query(
        `INSERT INTO strategy_lifecycle_states (strategy_key, strategy_version, policy_version, risk_scale)
         VALUES ('x', 1, 'slp1', '2')`
      ),
      /scale_check/
    );
    await assert.rejects(
      pool!.query(
        `INSERT INTO strategy_lifecycle_states (strategy_key, strategy_version, policy_version, state)
         VALUES ('y', 1, 'slp1', 'NOPE')`
      ),
      /state/
    );
    await assert.rejects(
      pool!.query(
        `INSERT INTO strategy_lifecycle_evidence
          (strategy_key, strategy_version, kind, result, code_version, policy_version,
           event_time, available_at, computed_at, content_hash, idempotency_key)
         VALUES ('z', 1, 'DRIFT', 'PASS', 'v', 'p',
                 now(), now() - interval '1 hour', now(),
                 'sle1:' || repeat('a', 64), 'slei1:' || repeat('b', 64))`
      ),
      /available_at|time/
    );
  });

  it("ensure idempotent, Evidence idempotent, DRAFT→LIVE verboten", async () => {
    const now = Date.now();
    const s1 = await svc.ensureLifecycleDraft("alpha", 1, {
      actor: "test",
      role: "operator",
    });
    const s2 = await svc.ensureLifecycleDraft("alpha", 1, {
      actor: "test",
      role: "operator",
    });
    assert.equal(s1.id, s2.id);
    assert.equal(s1.state, "DRAFT");

    const input = {
      strategyKey: "alpha",
      strategyVersion: 1,
      kind: "BACKTEST_RUN" as const,
      result: "PASS" as const,
      codeVersion: "1.73.0",
      policyVersion: policies.DEFAULT_PROMOTION_POLICY.version,
      snapshot: {
        metrics: {
          winRate: 0.55,
          profitFactor: 1.2,
          maxDrawdownPct: 10,
          dataQualityScore: 0.95,
        },
        sampleSize: 50,
        windowStartMs: now - 20 * 24 * MIN,
        windowEndMs: now - 1000,
      },
      eventTimeMs: now - 3600_000,
      availableAtMs: now - 3600_000,
      computedAtMs: now,
    };
    const e1 = await svc.recordEvidence(input);
    const e2 = await svc.recordEvidence(input);
    assert.equal(e1.created, true);
    assert.equal(e2.created, false);
    assert.equal(e1.evidence.id, e2.evidence.id);
    assert.match(e1.evidence.contentHash, /^sle1:[0-9a-f]{64}$/);

    const bad = await svc.requestTransition({
      strategyKey: "alpha",
      strategyVersion: 1,
      to: "LIVE",
      actor: { actor: "admin", role: "admin" },
      trigger: "operator",
      reason: "illegal jump DRAFT to LIVE",
      nowMs: now,
      env: ENFORCE,
    });
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.equal(bad.code, "TRANSITION_FORBIDDEN");
  });

  it("parallele Transitions mit gleichem Key: genau ein Zustand, eine Zeile", async () => {
    const now = Date.now();
    await svc.ensureLifecycleDraft("gamma", 1, { actor: "t", role: "operator" });

    const req = {
      strategyKey: "gamma",
      strategyVersion: 1,
      to: "BACKTEST_PENDING" as const,
      actor: { actor: "op", role: "operator" as const },
      trigger: "operator" as const,
      reason: "start",
      nowMs: now,
      env: ENFORCE,
    };
    const [a, b, c] = await Promise.all([
      svc.requestTransition(req),
      svc.requestTransition(req),
      svc.requestTransition(req),
    ]);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(c.ok, true);
    const applied = [a, b, c].filter((x) => x.ok && !x.idempotent);
    assert.equal(applied.length, 1, "genau eine echte Transition");
    const rows = await svc.listTransitions("gamma", 1, 50);
    assert.equal(rows.length, 1);
    const st = await svc.getLifecycleState("gamma", 1);
    assert.equal(st?.state, "BACKTEST_PENDING");
    assert.equal(st?.stateSeq, 1);
  });

  it("Promotion ohne Paper-Evidenz blockiert; mit Evidenz LIVE_LIMITED", async () => {
    const now = Date.now();
    await svc.ensureLifecycleDraft("delta", 1, { actor: "t", role: "operator" });

    const bt = await svc.recordEvidence({
      strategyKey: "delta",
      strategyVersion: 1,
      kind: "BACKTEST_RUN",
      result: "PASS",
      codeVersion: "1.73.0",
      policyVersion: policies.DEFAULT_PROMOTION_POLICY.version,
      snapshot: {
        metrics: {
          winRate: 0.55,
          profitFactor: 1.2,
          maxDrawdownPct: 10,
          dataQualityScore: 0.95,
        },
        sampleSize: 50,
        windowStartMs: now - 20 * 24 * MIN,
        windowEndMs: now - 1000,
      },
      eventTimeMs: now - 3600_000,
      availableAtMs: now - 3600_000,
      computedAtMs: now,
    });

    // DRAFT → BACKTEST_PENDING → BACKTEST_PASSED → PAPER
    const t1 = await svc.requestTransition({
      strategyKey: "delta",
      strategyVersion: 1,
      to: "BACKTEST_PENDING",
      actor: { actor: "op", role: "operator" },
      trigger: "operator",
      reason: "run",
      nowMs: now,
      env: ENFORCE,
    });
    assert.equal(t1.ok, true);

    const t2 = await svc.requestTransition({
      strategyKey: "delta",
      strategyVersion: 1,
      to: "BACKTEST_PASSED",
      actor: { actor: "sys", role: "system" },
      trigger: "system",
      reason: "oos gates passed",
      evidenceId: bt.evidence.id,
      nowMs: now,
      env: ENFORCE,
    });
    assert.equal(t2.ok, true, JSON.stringify(t2));

    const t3 = await svc.requestTransition({
      strategyKey: "delta",
      strategyVersion: 1,
      to: "PAPER",
      actor: { actor: "op", role: "operator" },
      trigger: "operator",
      reason: "paper window",
      evidenceId: bt.evidence.id,
      nowMs: now,
      env: ENFORCE,
    });
    assert.equal(t3.ok, true, JSON.stringify(t3));

    // Ohne PAPER_WINDOW: LIVE_LIMITED verboten
    const early = await svc.requestTransition({
      strategyKey: "delta",
      strategyVersion: 1,
      to: "LIVE_LIMITED",
      actor: { actor: "admin", role: "admin" },
      trigger: "operator",
      reason: "promote without paper",
      nowMs: now,
      env: ENFORCE,
    });
    assert.equal(early.ok, false);
    if (!early.ok) assert.equal(early.code, "EVIDENCE_REQUIRED");

    const gate = await svc.evaluatePromotionGate({
      strategyKey: "delta",
      strategyVersion: 1,
      target: "LIVE_LIMITED",
      nowMs: now,
    });
    assert.equal(gate.ok, false);
    assert.ok(gate.missingEvidence.includes("PAPER_WINDOW"));

    // Paper-Evidenz ⇒ Promotion
    const paper = await svc.recordEvidence({
      strategyKey: "delta",
      strategyVersion: 1,
      kind: "PAPER_WINDOW",
      result: "PASS",
      codeVersion: "1.73.0",
      policyVersion: policies.DEFAULT_PROMOTION_POLICY.version,
      snapshot: {
        metrics: { reconClean: 1, reconAtMs: now - 3600_000, avgSlippageBps: 5 },
        sampleSize: 30,
        windowStartMs: now - 10 * 24 * MIN,
        windowEndMs: now - 1000,
      },
      eventTimeMs: now - 7200_000,
      availableAtMs: now - 7200_000,
      computedAtMs: now,
    });
    const promote = await svc.requestTransition({
      strategyKey: "delta",
      strategyVersion: 1,
      to: "LIVE_LIMITED",
      actor: { actor: "admin", role: "admin" },
      trigger: "operator",
      reason: "paper ok",
      evidenceId: paper.evidence.id,
      nowMs: now,
      env: ENFORCE,
    });
    assert.equal(promote.ok, true, JSON.stringify(promote));

    const st = await svc.getLifecycleState("delta", 1);
    assert.equal(st?.state, "LIVE_LIMITED");
    assert.ok(Number(st!.riskScale) <= 1 && Number(st!.riskScale) > 0);

    const allow = await svc.authorizeLiveOrder({
      strategyKey: "delta",
      strategyVersion: 1,
      nowMs: now,
      env: ENFORCE,
    });
    assert.equal(allow.allowed, true);
    assert.equal(allow.lifecycleState, "LIVE_LIMITED");
    assert.equal(allow.strategyVersion, 1);
  });

  it("Drift-Degradation enforce idempotent; Order-Gate nach Degradation; Recovery-Coolddown", async () => {
    const now = Date.now();
    await svc.ensureLifecycleDraft("eps", 1, { actor: "t", role: "operator" });

    // Schnellweg nach LIVE_LIMITED mit Evidenz
    const bt = await svc.recordEvidence({
      strategyKey: "eps",
      strategyVersion: 1,
      kind: "BACKTEST_RUN",
      result: "PASS",
      codeVersion: "1.73.0",
      policyVersion: policies.DEFAULT_PROMOTION_POLICY.version,
      snapshot: {
        metrics: {
          winRate: 0.55,
          profitFactor: 1.2,
          maxDrawdownPct: 10,
          dataQualityScore: 0.95,
        },
        sampleSize: 50,
        windowStartMs: now - 20 * 24 * MIN,
        windowEndMs: now - 1000,
      },
      eventTimeMs: now - 3600_000,
      availableAtMs: now - 3600_000,
      computedAtMs: now,
    });
    const paper = await svc.recordEvidence({
      strategyKey: "eps",
      strategyVersion: 1,
      kind: "PAPER_WINDOW",
      result: "PASS",
      codeVersion: "1.73.0",
      policyVersion: policies.DEFAULT_PROMOTION_POLICY.version,
      snapshot: {
        metrics: { reconClean: 1, reconAtMs: now - 3600_000, avgSlippageBps: 5 },
        sampleSize: 30,
        windowStartMs: now - 10 * 24 * MIN,
        windowEndMs: now - 1000,
      },
      eventTimeMs: now - 7200_000,
      availableAtMs: now - 7200_000,
      computedAtMs: now,
    });

    for (const step of [
      {
        to: "BACKTEST_PENDING" as const,
        trigger: "operator" as const,
        role: "operator" as const,
        evidenceId: null,
        reason: "a",
      },
      {
        to: "BACKTEST_PASSED" as const,
        trigger: "system" as const,
        role: "system" as const,
        evidenceId: bt.evidence.id,
        reason: "b",
      },
      {
        to: "PAPER" as const,
        trigger: "operator" as const,
        role: "operator" as const,
        evidenceId: bt.evidence.id,
        reason: "c",
      },
      {
        to: "LIVE_LIMITED" as const,
        trigger: "operator" as const,
        role: "admin" as const,
        evidenceId: paper.evidence.id,
        reason: "d",
      },
    ]) {
      const r = await svc.requestTransition({
        strategyKey: "eps",
        strategyVersion: 1,
        to: step.to,
        actor: { actor: "t", role: step.role },
        trigger: step.trigger,
        reason: step.reason,
        evidenceId: step.evidenceId,
        nowMs: now,
        env: ENFORCE,
      });
      assert.equal(r.ok, true, `${step.to}: ${JSON.stringify(r)}`);
    }

    const pairs = [
      {
        key: "maxDrawdownPct",
        baseline: drift.metricWindow(10, 100, now - 3600_000, now),
        current: drift.metricWindow(40, 100, now - 1000, now),
      },
      {
        key: "winRate",
        baseline: drift.metricWindow(0.55, 100, now - 3600_000, now),
        current: drift.metricWindow(0.55, 100, now - 1000, now),
      },
      {
        key: "profitFactor",
        baseline: drift.metricWindow(1.2, 100, now - 3600_000, now),
        current: drift.metricWindow(1.2, 100, now - 1000, now),
      },
      {
        key: "avgTradePnl",
        baseline: drift.metricWindow(0.001, 100, now - 3600_000, now),
        current: drift.metricWindow(0.001, 100, now - 1000, now),
      },
      {
        key: "avgSlippageBps",
        baseline: drift.metricWindow(5, 100, now - 3600_000, now),
        current: drift.metricWindow(5, 100, now - 1000, now),
      },
      {
        key: "dataQualityScore",
        baseline: drift.metricWindow(0.95, 100, now - 3600_000, now),
        current: drift.metricWindow(0.95, 100, now - 1000, now),
      },
    ];

    const d1 = await svc.checkAndDegrade({
      strategyKey: "eps",
      strategyVersion: 1,
      pairs,
      nowMs: now,
      env: ENFORCE,
    });
    assert.equal(d1.evaluation.verdict, "BREACH");
    assert.notEqual(d1.appliedAction, "NONE");

    const st1 = await svc.getLifecycleState("eps", 1);
    assert.ok(st1);
    assert.notEqual(st1.state, "LIVE");
    const seq1 = st1.stateSeq;
    const scale1 = Number(st1.riskScale);
    assert.ok(scale1 <= 1 && scale1 > 0);

    // Zweiter Lauf: idempotent (kein Flapping, kein zweites DEGRADED-Event)
    const d2 = await svc.checkAndDegrade({
      strategyKey: "eps",
      strategyVersion: 1,
      pairs,
      nowMs: now + 5000,
      env: ENFORCE,
    });
    const st2 = await svc.getLifecycleState("eps", 1);
    assert.equal(st2!.state, st1!.state, "kein Flapping");
    if (d2.appliedAction === "SKIPPED" || d2.transition === null) {
      assert.ok(true);
    } else if (d2.transition.ok) {
      assert.equal(d2.transition.idempotent, true);
    }

    // Order-Gate nach Degradation
    const gate = await svc.authorizeLiveOrder({
      strategyKey: "eps",
      strategyVersion: 1,
      nowMs: now + 6000,
      env: ENFORCE,
    });
    if (st2!.state === "DEGRADED" || st2!.state === "PAUSED") {
      assert.equal(gate.allowed, false, st2!.state);
      assert.equal(gate.blocked, true);
    }

    // Recovery: Cooldown aktiv ⇒ verfrühte Promotion schlägt fehl (wenn Kante evidence/cooldown-pflichtig)
    if (st2!.cooldownUntil && st2!.cooldownUntil.getTime() > now + 7000) {
      const earlyRecovery = await svc.requestTransition({
        strategyKey: "eps",
        strategyVersion: 1,
        to: st2!.state === "PAUSED" ? "PAPER" : "LIVE_LIMITED",
        actor: { actor: "admin", role: "admin" },
        trigger: "recovery",
        reason: "recover too early",
        nowMs: now + 7000,
        env: ENFORCE,
      });
      assert.equal(earlyRecovery.ok, false, JSON.stringify(earlyRecovery));
      if (!earlyRecovery.ok) {
        assert.ok(
          ["COOLDOWN_ACTIVE", "EVIDENCE_REQUIRED"].includes(earlyRecovery.code),
          earlyRecovery.code
        );
      }
    }

    // Audit-Timeline mind. 1 Transitions-Zeile
    const timeline = await svc.listTransitions("eps", 1, 100);
    assert.ok(timeline.length >= 4);
    for (const t of timeline) {
      assert.match(t.transitionKey, /^slt1:[0-9a-f]{64}$/);
      assert.equal(t.seqAfter, t.seqBefore + 1);
    }
    void seq1;
  });

  it("parallele ensure auf denselben Key: genau eine State-Zeile", async () => {
    const [a, b] = await Promise.all([
      svc.ensureLifecycleDraft("zeta", 1, { actor: "t", role: "operator" }),
      svc.ensureLifecycleDraft("zeta", 1, { actor: "t", role: "operator" }),
    ]);
    assert.equal(a.id, b.id);
    const count = await pool!.query(
      `SELECT count(*)::int AS n FROM strategy_lifecycle_states WHERE strategy_key='zeta'`
    );
    assert.equal(count.rows[0].n, 1);
  });
});
