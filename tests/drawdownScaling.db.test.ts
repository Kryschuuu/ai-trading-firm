/**
 * Tests: Drawdown-Risk-Scaling — Postgres DB Tests (RMA-P5-04, v1.68.0).
 *
 * Deckt die Persistenz-Zusicherungen ab:
 *   - Idempotente Migration `drizzle/2026-09-22_drawdown_scaling.sql`
 *     (zweifach ausführbar, append-only)
 *   - Roundtrip über den ECHTEN Persistenzpfad (`updateDrawdownScaling` mit
 *     injiziertem Drizzle-Client): Snapshot erscheint vollständig, inkl.
 *     PnL-/Cashflow-/Hysterese-Zustand für die Neustart-Rekonstruktion
 *   - Idempotenz: gleicher Idempotency-Key ⇒ keine doppelte Zeile (Retry/
 *     Restart-Schutz), andere Minute ⇒ neue Zeile
 *   - Neustart-Rekonstruktion über den ECHTEN Lesepfad
 *     (`readPersistedDrawdownScalingState` gegen die reale DB)
 *   - CHECK-Constraints erzwingen die harten Invarianten auf DB-Ebene
 *     (Faktor ≤ 1, pause ⇔ stage PAUSE, Zeit-Semantik, Hash-Formate)
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Pool as PoolType } from "pg";

import EmbeddedPostgres from "embedded-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import {
  __resetDrawdownScalingForTests,
  readPersistedDrawdownScalingState,
  updateDrawdownScaling,
  type DdsDbLike,
  type DrawdownScalingDeps,
} from "../src/lib/drawdownScaling";
import {
  drawdownStateFromRow,
  resolveDrawdownScalingConfig,
  type DrawdownEquityObservation,
} from "../src/portfolio/drawdownScaling";

const PG_PORT = 55_446; // 55444 (Sentiment) + 55445 (VTP) sind belegt
const DB_NAME = "dds_test";
const MIN = 60_000;

describe("drawdown_scaling_snapshots (Postgres): Migration, Roundtrip, Idempotenz, Constraints", () => {
  let pg: EmbeddedPostgres | null = null;
  let pool: PoolType | null = null;
  let db: ReturnType<typeof drizzle> | null = null;
  let startupError: Error | null = null;
  const logs: string[] = [];

  function testConfig() {
    return resolveDrawdownScalingConfig({
      softThresholdPct: 5,
      hardThresholdPct: 12,
      minFactor: 0.25,
      pauseThresholdPct: 15,
      recoveryCooldownMs: 60 * MIN,
      recoveryConfirmations: 2,
      recoveryStep: 0.05,
      enabled: true,
    });
  }

  function makeNow(): number {
    return Math.floor(Date.now() / MIN) * MIN;
  }

  function observation(
    p: Partial<DrawdownEquityObservation> & { equity: number },
    now: number
  ): DrawdownEquityObservation {
    return {
      availableAt: now,
      baselineEquity: 10_000,
      tradingPnl: { realized: 0, unrealized: 0 },
      reconciliation: { at: now, clean: true },
      source: "db-snapshot:TICK",
      ...p,
    };
  }

  /** Deps mit REALER embedded DB (als DdsDbLike injiziert) + fixem Zeitstempel. */
  function makeDeps(
    now: number,
    obs: DrawdownEquityObservation,
    readState?: () => Promise<ReturnType<typeof drawdownStateFromRow> | null>
  ): DrawdownScalingDeps {
    const deps: DrawdownScalingDeps = {
      now: () => now,
      db: (db as unknown) as DdsDbLike,
      readEquity: async () => obs,
      readReconciliation: async () => ({ at: now, clean: true }),
    };
    if (readState) deps.readState = readState;
    return deps;
  }

  before(async () => {
    try {
      process.env.AUDIT_SPOOL_DIR = mkdtempSync(path.join(tmpdir(), "dds-db-audit-"));
      process.env.AUDIT_RETRY_MAX = "1";
      process.env.AUDIT_RETRY_BASE_MS = "5";
      process.env.AUDIT_DB_COOLDOWN_MS = "0";
      process.env.DRAWDOWN_SCALING_MODE = "active";

      const dir = mkdtempSync(path.join(tmpdir(), "dds-pg-"));
      const instance = new EmbeddedPostgres({
        databaseDir: dir,
        user: "postgres",
        password: "postgres",
        port: PG_PORT,
        persistent: false,
        onLog: (m) => logs.push(String(m)),
        onError: (m) => logs.push(m instanceof Error ? m.message : String(m)),
      });
      await instance.initialise();
      await instance.start();
      pg = instance;

      const adminPool = new Pool({
        user: "postgres",
        password: "postgres",
        host: "127.0.0.1",
        port: PG_PORT,
        database: "postgres",
      });
      await adminPool.query(`CREATE DATABASE ${DB_NAME}`);
      await adminPool.end();

      pool = new Pool({
        user: "postgres",
        password: "postgres",
        host: "127.0.0.1",
        port: PG_PORT,
        database: DB_NAME,
      });
      db = drizzle(pool);

      const migrationSql = readFileSync(
        path.join(process.cwd(), "drizzle", "2026-09-22_drawdown_scaling.sql"),
        "utf8"
      );
      await pool.query(migrationSql);

      // Der ECHTE Lesepfad (`readPersistedDrawdownScalingState`) greift auf den
      // Lazy-Singleton `@/db` zu — der wird sonst per DATABASE_URL erzeugt.
      process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/${DB_NAME}`;
    } catch (e) {
      startupError = e instanceof Error ? e : new Error(String(e));
    }
  });

  after(async () => {
    // Der von `@/db` erzeugte Singleton-Pool würde den Test-Worker offen halten.
    const g = globalThis as typeof globalThis & { __arenaNextJsPostgresqlPool?: PoolType };
    if (g.__arenaNextJsPostgresqlPool) await g.__arenaNextJsPostgresqlPool.end().catch(() => {});
    if (pool) await pool.end().catch(() => {});
    if (pg) await pg.stop().catch(() => {});
    __resetDrawdownScalingForTests();
    delete process.env.DRAWDOWN_SCALING_MODE;
  });

  it("Migration ist strikt idempotent (zweites Ausführen wirft keinen Fehler)", async (t) => {
    if (!pool) return t.skip(startupError?.message ?? "Postgres nicht gestartet");
    const migrationSql = readFileSync(
      path.join(process.cwd(), "drizzle", "2026-09-22_drawdown_scaling.sql"),
      "utf8"
    );
    await assert.doesNotReject(async () => {
      await pool!.query(migrationSql);
    });
  });

  it("Roundtrip: Snapshot über den echten Persistenzpfad erscheint vollständig", async (t) => {
    if (!pool || !db) return t.skip(startupError?.message ?? "Postgres nicht gestartet");
    __resetDrawdownScalingForTests();
    await pool.query(`DELETE FROM drawdown_scaling_snapshots`);

    const now = makeNow();
    const status = await updateDrawdownScaling({
      deps: makeDeps(
        now,
        observation({ equity: 9_000, tradingPnl: { realized: -1_000, unrealized: 0 } }, now)
      ),
      config: testConfig(),
      force: true,
    });
    assert.equal(status.mode, "active");
    assert.equal(status.status, "BOOTSTRAP");

    const res = await pool.query(`SELECT * FROM drawdown_scaling_snapshots WHERE as_of = $1 LIMIT 1`, [
      new Date(now),
    ]);
    assert.equal(res.rows.length, 1, "Snapshot-Row für diesen Zeitpunkt muss existieren");
    const r = res.rows[0];
    assert.match(r.snapshot_id, /^dsc1:[0-9a-f]{64}$/);
    assert.match(r.policy_version, /^ddp1:[0-9a-f]{64}$/);
    assert.match(r.data_hash, /^dd1:[0-9a-f]{64}$/);
    assert.equal(r.mode, "active");
    assert.equal(r.status, "BOOTSTRAP");
    assert.equal(r.stage, "SOFT");
    assert.equal(r.paused, false);
    assert.equal(r.transition, "BOOTSTRAP");
    // Bootstrap hat keine Vorbewertung ⇒ Attribution unverified (kein
    // Cashflow behauptet, konservativ). Ab der zweiten Bewertung: verified.
    assert.equal(r.cashflow_verification, "unverified");
    assert.equal(parseFloat(r.cashflow_detected), 0, "Bootstrap erfindet keinen Cashflow");
    // Zeit-Semantik: computed_at ≥ as_of; equity_available_at ist der Snapshot-Zeitpunkt.
    assert.ok(new Date(r.computed_at).getTime() >= new Date(r.as_of).getTime());
    assert.ok(Math.abs(new Date(r.as_of).getTime() - now) < 1000);
    assert.ok(Math.abs(new Date(r.equity_available_at).getTime() - now) < 1000);
    // HWM + Faktor (NUMERIC kommt als String).
    assert.ok(Math.abs(parseFloat(r.hwm) - 10_000) < 1e-9);
    assert.ok(parseFloat(r.applied_factor) > 0 && parseFloat(r.applied_factor) <= 1);
    assert.ok(parseFloat(r.applied_factor) < 1, "10 % Drawdown ⇒ Faktor unter 1");
    assert.equal(parseFloat(r.drawdown_pct) > 0.09, true);
    // Zustand für die Neustart-Rekonstruktion.
    assert.ok(Math.abs(parseFloat(r.last_equity) - 9_000) < 1e-9);
    assert.ok(Math.abs(parseFloat(r.last_trading_pnl) - -1_000) < 1e-9);
    assert.equal(parseFloat(r.cumulative_net_flow), 0);
    assert.equal(r.recovery_streak, 0);
    assert.equal(new Date(r.last_observation_at).getTime(), now);
  });

  it("Idempotenz: Retry in derselben Minute ⇒ keine doppelte Zeile", async (t) => {
    if (!pool || !db) return t.skip(startupError?.message ?? "Postgres nicht gestartet");
    __resetDrawdownScalingForTests();
    await pool.query(`DELETE FROM drawdown_scaling_snapshots`);

    const now = makeNow() + 30_000;
    const obs = observation({ equity: 9_500, tradingPnl: { realized: -500, unrealized: 0 } }, now);
    await updateDrawdownScaling({ deps: makeDeps(now, obs), config: testConfig(), force: true });
    await updateDrawdownScaling({ deps: makeDeps(now, obs), config: testConfig(), force: true });
    const res = await pool.query(
      `SELECT count(*)::int AS count FROM drawdown_scaling_snapshots WHERE as_of = $1`,
      [new Date(now)]
    );
    assert.equal(res.rows[0].count, 1, "Retry darf keine zweite Zeile erzeugen");
  });

  it("andere Minute ⇒ neue Zeile (Historie wächst, ohne Uminterpretation)", async (t) => {
    if (!pool || !db) return t.skip(startupError?.message ?? "Postgres nicht gestartet");
    __resetDrawdownScalingForTests();
    await pool.query(`DELETE FROM drawdown_scaling_snapshots`);

    const base = makeNow();
    const m1 = base + 41 * MIN;
    const m2 = base + 42 * MIN;
    await updateDrawdownScaling({
      deps: makeDeps(m1, observation({ equity: 9_800, tradingPnl: { realized: -200, unrealized: 0 } }, m1)),
      config: testConfig(),
      force: true,
    });
    await updateDrawdownScaling({
      deps: makeDeps(m2, observation({ equity: 9_600, tradingPnl: { realized: -400, unrealized: 0 } }, m2)),
      config: testConfig(),
      force: true,
    });
    const res = await pool.query(
      `SELECT count(*)::int AS count FROM drawdown_scaling_snapshots WHERE as_of IN ($1, $2)`,
      [new Date(m1), new Date(m2)]
    );
    assert.equal(res.rows[0].count, 2, "zwei Minuten ⇒ zwei Snapshots");
  });

  it("Neustart-Rekonstruktion: echter Lesepfad liefert identischen HWM/Faktor", async (t) => {
    if (!pool || !db) return t.skip(startupError?.message ?? "Postgres nicht gestartet");
    __resetDrawdownScalingForTests();
    await pool.query(`DELETE FROM drawdown_scaling_snapshots`);

    const now = makeNow();
    const obs = observation({ equity: 8_800, tradingPnl: { realized: -1_200, unrealized: 0 } }, now);
    const first = await updateDrawdownScaling({
      deps: makeDeps(now, obs),
      config: testConfig(),
      force: true,
    });
    assert.equal(first.status, "BOOTSTRAP");
    assert.equal(first.stage, "DEEP");

    // Prozessteil neu: Zustand NUR noch aus der DB (echter Lesepfad).
    __resetDrawdownScalingForTests();
    const restored = await readPersistedDrawdownScalingState();
    assert.ok(restored !== null, "Zustand muss aus der DB rekonstruierbar sein");
    assert.ok(Math.abs((restored!.hwm as number) - 10_000) < 1e-9, "HWM überlebt den Neustart");
    assert.ok(Math.abs((restored!.factor as number) - first.appliedFactor) < 1e-9);
    assert.equal(restored!.stage, "DEEP");
    assert.equal(restored!.lastTradingPnl, -1_200, "NUMERIC-Roundtrip als Zahl");

    // Weiterbewertung aus der rekonstruierten Zeile ⇒ identischer Faktor
    // (kein Bootstrap, kein Reset).
    const next = makeNow() + MIN;
    const second = await updateDrawdownScaling({
      deps: makeDeps(
        next,
        observation({ equity: 8_800, availableAt: next, tradingPnl: { realized: -1_200, unrealized: 0 } }, next),
        async () => restored
      ),
      config: testConfig(),
      force: true,
    });
    assert.equal(second.status, "OK", "kein Bootstrap nach Neustart");
    assert.equal(second.hwm, 10_000);
    assert.equal(second.appliedFactor, first.appliedFactor);
  });

  it("CHECK-Constraints weisen ungültige Zustände auf DB-Ebene strikt ab", async (t) => {
    if (!pool) return t.skip(startupError?.message ?? "Postgres nicht gestartet");

    const ts = new Date("2026-09-22T12:00:00Z");

    async function insertRow(opts: {
      snapshotId?: string;
      mode?: string;
      stage?: string;
      paused?: boolean;
      appliedFactor?: string;
      policyVersion?: string;
      computedAtOffsetMs?: number;
    }) {
      await pool!.query(
        `INSERT INTO drawdown_scaling_snapshots
           (snapshot_id, mode, status, reason_code, reason, as_of, computed_at,
            prev_factor, applied_factor, stage, paused, transition, policy_version, data_hash,
            cumulative_net_flow, cashflow_detected, cashflow_verification, recovery_streak)
         VALUES ($1, $2, 'OK', 'OK', 'test', $3, $4,
            '1', $5, $6, $7, 'DEGRADE', $8, $9,
            '0', '0', 'verified', 0)`,
        [
          opts.snapshotId ?? "dsc1:" + "a".repeat(64),
          opts.mode ?? "active",
          ts,
          new Date(ts.getTime() + (opts.computedAtOffsetMs ?? 0)),
          opts.appliedFactor ?? "0.5",
          opts.stage ?? "SOFT",
          opts.paused ?? false,
          opts.policyVersion ?? "ddp1:" + "b".repeat(64),
          "dd1:" + "c".repeat(64),
        ]
      );
    }

    // 1) applied_factor > 1 ⇒ Verstoß (Faktor darf nie risikosteigernd sein).
    await assert.rejects(
      insertRow({ appliedFactor: "1.5" }),
      /drawdown_scaling_snapshots_applied_factor_check/
    );

    // 2) paused = true ohne Stufe PAUSE ⇒ Verstoß.
    await assert.rejects(
      insertRow({ stage: "DEEP", paused: true }),
      /drawdown_scaling_snapshots_pause_stage_check/
    );

    // 3) computed_at < as_of ⇒ Verstoß (Zeit-Semantik / Look-ahead).
    await assert.rejects(
      insertRow({ computedAtOffsetMs: -60_000 }),
      /drawdown_scaling_snapshots_time_check/
    );

    // 4) unbekannte Stufe ⇒ Verstoß.
    await assert.rejects(
      insertRow({ stage: "MOON" }),
      /drawdown_scaling_snapshots_stage_check/
    );

    // 5) ungültiger Snapshot-Hash ⇒ Verstoß.
    await assert.rejects(
      insertRow({ snapshotId: "dsc1:NOT-A-HASH" }),
      /drawdown_scaling_snapshots_snapshot_id_check/
    );

    // 6) gültige Zeile mit paused = true UND Stufe PAUSE wird akzeptiert.
    await assert.doesNotReject(
      insertRow({
        snapshotId: "dsc1:" + "d".repeat(64),
        stage: "PAUSE",
        paused: true,
        appliedFactor: "0.25",
      })
    );

    const count = await pool!.query(
      `SELECT count(*)::int AS count FROM drawdown_scaling_snapshots WHERE stage = 'PAUSE'`
    );
    assert.equal(count.rows[0].count, 1);
  });
});
