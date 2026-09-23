/**
 * Tests: Monte-Carlo-/Trade-Resampling — Persistenz & API (RMA-P6-02, v1.72.0).
 *
 * Deckung (gegen eine eingebettete Postgres-Instanz, Port 55447):
 *   - Migration `drizzle/2026-09-23_monte_carlo.sql` zweifach idempotent
 *     (append-only; Basis-Migrationen backtest_runs/backtest_trades vorher).
 *   - Roundtrip über den ECHTEN Pfad (`runMonteCarloAnalysis` mit injiziertem
 *     Drizzle-Client): Zeile referenziert Quell-Run, Seed, Methode, Config,
 *     Code-Version; Summary ist bounded (keine Rohpfade).
 *   - Idempotenz: Retry (auch mit NEUER analysisId, Restart-Semantik) ⇒
 *     `created: false`, exakt EINE Zeile; andere Config ⇒ neue Zeile.
 *   - Fail-closed Quelle: Alt-Run ohne Ledger, leeres Segment, inkonsistente
 *     seq/Anzahl ⇒ Abweisung, KEINE Zeile.
 *   - CHECK-Constraints (Methode, Blocklänge, Seed-Bereich), FK ohne Cascade.
 *   - Read-API: Liste + Detail (bounded), Filter nach Quell-Run.
 *   - HTTP-Vertrag: 401 ohne Credential (Token-Modus), 400 ungültige
 *     UUID/Limits, 404 unbekannt, 200 Happy Path gegen dieselbe Instanz.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Pool as PoolType } from "pg";

import EmbeddedPostgres from "embedded-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import {
  listMonteCarloRuns,
  getMonteCarloRun,
  MonteCarloStoreError,
  runMonteCarloAnalysis,
  validateMonteCarloLimit,
  type MonteCarloAuditSink,
  type MonteCarloDb,
} from "../src/backtest/monteCarloStore";
import { MonteCarloError, runMonteCarloSimulation } from "../src/backtest/montecarlo";
import { resetTelemetryForTests, telemetry } from "../src/lib/telemetry";

const PG_PORT = 55_447; // 55443–55446 sind belegt (crossSectional, Sentiment, VTP, DDS)
const DB_NAME = "mc_test";
const DAY = 24 * 60 * 60 * 1000;

const AUTH_KEYS = ["FIRM_ADMIN_TOKEN", "FIRM_API_TOKEN", "FIRM_VIEWER_TOKEN", "FIRM_SESSION_SECRET", "AUTH_MODE"] as const;

describe("backtest_monte_carlo_runs (Postgres): Migration, Roundtrip, Idempotenz, API", () => {
  let pg: EmbeddedPostgres | null = null;
  let pool: PoolType | null = null;
  let db: MonteCarloDb | null = null;
  let startupError: Error | null = null;
  const savedEnv = new Map<string, string | undefined>();
  const auditEvents: Array<{ event: string; detail: Record<string, unknown> }> = [];

  const noopAudit: MonteCarloAuditSink = async (event, _level, detail) => {
    auditEvents.push({ event, detail });
  };

  function migration(name: string): string {
    return readFileSync(path.join(process.cwd(), "drizzle", name), "utf8");
  }

  /** Seedet EINEN Walk-Forward-Run mit `oos`/`is` Trades (deterministisch). */
  async function seedRun(oos: number, is: number, opts: { legacy?: boolean } = {}): Promise<string> {
    assert.ok(pool);
    const runId = randomUUID();
    await pool.query(
      `INSERT INTO backtest_runs (id, instrument_id, timeframe, from_ts, to_ts, params_json, metrics_json,
         windows_json, code_version, idempotency_key, trade_count, reconciliation_status, reconciliation_json)
       VALUES ($1, 'BITUNIX:BTCUSDT', '1h', $2, $3, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'v1.72.0-test',
         ${opts.legacy ? "NULL" : "$4"}, ${opts.legacy ? "NULL" : "$5"}, ${opts.legacy ? "NULL" : "'RECONCILED'"}, ${opts.legacy ? "NULL" : "'{}'::jsonb"})`,
      opts.legacy
        ? [runId, new Date(Date.now() - 400 * DAY), new Date()]
        : [runId, new Date(Date.now() - 400 * DAY), new Date(), `wf1:test:${runId}`, oos + is]
    );
    let seq = 0;
    const insertTrade = async (segment: "OOS" | "IS", i: number) => {
      seq++;
      const pnl = [120, -60, 200, -90, 40, -150, 80, 30, -45, 160][i % 10];
      await pool!.query(
        `INSERT INTO backtest_trades (run_id, seq, window_index, segment, trade_ref, strategy_id, symbol, side,
           qty, notional, entry_ts, exit_ts, entry_price, exit_price, pnl_gross, pnl_net, pnl_pct, fees, funding,
           slippage, exit_reason, duration_bars, provenance_json)
         VALUES ($1, $2, 0, $3, $4, 'RULE-BITUNIX:BTCUSDT', 'BITUNIX:BTCUSDT', 'LONG',
           0.5, 2000, $5, $6, 100, 101, $7, $7, 5.5, 12, -0.25, 6, 'TAKE_PROFIT', 4, '{}'::jsonb)`,
        [
          runId,
          seq,
          segment,
          `POS-${seq}`,
          new Date(Date.now() - (400 - seq * 2) * DAY),
          new Date(Date.now() - (399 - seq * 2) * DAY),
          pnl,
        ]
      );
    };
    for (let i = 0; i < oos; i++) await insertTrade("OOS", i);
    for (let i = 0; i < is; i++) await insertTrade("IS", i);
    return runId;
  }

  before(async () => {
    try {
      for (const key of AUTH_KEYS) {
        if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
        delete process.env[key];
      }
      process.env.AUDIT_SPOOL_DIR = mkdtempSync(path.join(tmpdir(), "mc-db-audit-"));
      process.env.AUDIT_RETRY_MAX = "1";
      process.env.AUDIT_RETRY_BASE_MS = "5";
      process.env.AUDIT_DB_COOLDOWN_MS = "0";

      const dir = mkdtempSync(path.join(tmpdir(), "mc-pg-"));
      const instance = new EmbeddedPostgres({
        databaseDir: dir,
        user: "postgres",
        password: "postgres",
        port: PG_PORT,
        persistent: false,
        onLog: () => {},
        onError: () => {},
      });
      await instance.initialise();
      await instance.start();
      pg = instance;

      const adminPool = new Pool({ user: "postgres", password: "postgres", host: "127.0.0.1", port: PG_PORT, database: "postgres" });
      await adminPool.query(`CREATE DATABASE ${DB_NAME}`);
      await adminPool.end();

      pool = new Pool({ user: "postgres", password: "postgres", host: "127.0.0.1", port: PG_PORT, database: DB_NAME });
      db = drizzle(pool) as unknown as MonteCarloDb;

      await pool.query(migration("2026-09-19_backtest_runs.sql"));
      await pool.query(migration("2026-09-20_backtest_trades.sql"));
      await pool.query(migration("2026-09-23_monte_carlo.sql"));

      // Der HTTP-Pfad nutzt den Lazy-Singleton `@/db` — auf die Instanz zeigen lassen.
      process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/${DB_NAME}`;
    } catch (e) {
      startupError = e instanceof Error ? e : new Error(String(e));
    }
  });

  after(async () => {
    const g = globalThis as typeof globalThis & { __arenaNextJsPostgresqlPool?: PoolType };
    if (g.__arenaNextJsPostgresqlPool) await g.__arenaNextJsPostgresqlPool.end().catch(() => {});
    if (pool) await pool.end().catch(() => {});
    if (pg) await pg.stop().catch(() => {});
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    savedEnv.clear();
  });

  it("Migration ist strikt idempotent (zweites Ausführen wirft keinen Fehler)", async (t) => {
    if (!pool) return t.skip(startupError?.message ?? "Postgres nicht gestartet");
    await assert.doesNotReject(async () => {
      await pool!.query(migration("2026-09-23_monte_carlo.sql"));
    });
  });

  it("Roundtrip: runMonteCarloAnalysis persistiert eine bounded Zeile mit voller Referenz", async (t) => {
    if (!pool || !db) return t.skip(startupError?.message ?? "Postgres nicht gestartet");
    resetTelemetryForTests();
    auditEvents.length = 0;
    await pool.query(`DELETE FROM backtest_monte_carlo_runs`);
    const runId = await seedRun(40, 5);

    const analysis = await runMonteCarloAnalysis(
      { runId, config: { method: "iid", seed: 42, runs: 200, segment: "OOS" }, analysisId: randomUUID() },
      { db, audit: noopAudit }
    );
    assert.equal(analysis.created, true);
    assert.match(analysis.idempotencyKey, /^mcs1:[0-9a-f]{64}$/);

    const res = await pool.query(`SELECT * FROM backtest_monte_carlo_runs WHERE id = $1`, [analysis.id]);
    assert.equal(res.rows.length, 1);
    const row = res.rows[0];
    assert.equal(row.source_run_id, runId);
    assert.equal(row.method, "iid");
    assert.equal(row.segment, "OOS");
    assert.equal(row.scenario, "baseline");
    assert.equal(Number(row.seed), 42);
    assert.equal(row.seed_algorithm, "mulberry32-v1");
    assert.equal(row.runs, 200);
    assert.equal(row.block_length, null);
    assert.equal(row.sample_trades, 40, "nur OOS-Trades");
    assert.match(row.input_trades_hash, /^[0-9a-f]{64}$/);
    assert.equal(typeof row.code_version, "string");
    assert.ok(row.code_version.length > 0);
    // Config ist vollständig persistiert (Replay-Grundlage).
    const config = row.config_json as Record<string, unknown>;
    assert.equal(config.method, "iid");
    assert.equal(config.seed, 42);
    assert.equal(config.prngAlgorithm, "mulberry32-v1");
    assert.equal(config.algorithmVersion, "mc1");
    // Summary: bounded, ohne Rohpfade, mit getrennten Ebenen.
    const summary = row.summary_json as Record<string, unknown>;
    assert.deepEqual(Object.keys(summary).sort(), ["caveats", "observed", "observedStressed", "resampled", "stats"]);
    assert.ok(JSON.stringify(summary).length < 8_000, "Summary bleibt bounded");
    assert.ok(!JSON.stringify(summary).includes('"path'), "keine Rohpfade persistiert");
    // Audit + Telemetrie (bounded Labels; Key-Reihung sortiert: method,reason,result).
    assert.ok(auditEvents.some((e) => e.event === "MONTE_CARLO_RUN_PERSISTED" && e.detail.created === true));
    assert.equal(telemetry.monteCarlo.runs.byLabel()["method=iid,reason=ok,result=created"], 1);
  });

  it("Idempotenz: Retry (auch mit neuer UUID) ⇒ created=false, exakt EINE Zeile", async (t) => {
    if (!pool || !db) return t.skip(startupError?.message ?? "Postgres nicht gestartet");
    await pool.query(`DELETE FROM backtest_monte_carlo_runs`);
    const runId = await seedRun(40, 0);
    const config = { method: "iid", seed: 7, runs: 150, segment: "OOS" } as const;

    const first = await runMonteCarloAnalysis(
      { runId, config: { ...config }, analysisId: randomUUID() },
      { db, audit: noopAudit }
    );
    assert.equal(first.created, true);
    // Restart-Semantik: neuer Prozess vergibt eine neue UUID, Key bleibt gleich.
    const second = await runMonteCarloAnalysis(
      { runId, config: { ...config }, analysisId: randomUUID() },
      { db, audit: noopAudit }
    );
    assert.equal(second.created, false);
    assert.equal(second.id, first.id, "Replay liefert die BESTEHENDE Zeile");

    const count = await pool!.query(`SELECT count(*)::int AS n FROM backtest_monte_carlo_runs`);
    assert.equal(count.rows[0].n, 1, "keine Dublette trotz Retry");

    // Andere Config (Seed) ⇒ neue fachliche Analyse ⇒ zweite Zeile.
    const other = await runMonteCarloAnalysis(
      { runId, config: { ...config, seed: 8 }, analysisId: randomUUID() },
      { db, audit: noopAudit }
    );
    assert.equal(other.created, true);
    assert.notEqual(other.id, first.id);
    const count2 = await pool!.query(`SELECT count(*)::int AS n FROM backtest_monte_carlo_runs`);
    assert.equal(count2.rows[0].n, 2);
  });

  it("Fail-closed Quelle: Alt-Run ohne Ledger, leeres Segment, inkonsistentes Ledger", async (t) => {
    if (!pool || !db) return t.skip(startupError?.message ?? "Postgres nicht gestartet");
    const before = await pool!.query(`SELECT count(*)::int AS n FROM backtest_monte_carlo_runs`);

    // Alt-Run vor v1.52.0: reconciliation_status/trade_count NULL (NULL ≠ 0).
    const legacyRunId = await seedRun(40, 0, { legacy: true });
    await assert.rejects(
      runMonteCarloAnalysis(
        { runId: legacyRunId, config: { method: "iid", segment: "ALL" }, analysisId: randomUUID() },
        { db, audit: noopAudit }
      ),
      (e: unknown) => e instanceof MonteCarloStoreError && e.code === "mc:ledger-unavailable"
    );

    // Leeres Segment: Run hat nur OOS, Analyse will IS.
    const runId = await seedRun(40, 0);
    await assert.rejects(
      runMonteCarloAnalysis(
        { runId, config: { method: "iid", segment: "IS" }, analysisId: randomUUID() },
        { db, audit: noopAudit }
      ),
      (e: unknown) => e instanceof MonteCarloStoreError && e.code === "mc:empty-sample"
    );

    // Inkonsistentes Ledger: trade_count im Run lügt (40 Zeilen, Run behauptet 39).
    await pool!.query(`UPDATE backtest_runs SET trade_count = 39 WHERE id = $1`, [runId]);
    await assert.rejects(
      runMonteCarloAnalysis(
        { runId, config: { method: "iid", segment: "ALL" }, analysisId: randomUUID() },
        { db, audit: noopAudit }
      ),
      (e: unknown) => e instanceof MonteCarloStoreError && e.code === "mc:ledger-inconsistent"
    );

    // Unbekannter Run.
    await assert.rejects(
      runMonteCarloAnalysis(
        { runId: randomUUID(), config: { method: "iid", segment: "OOS" }, analysisId: randomUUID() },
        { db, audit: noopAudit }
      ),
      (e: unknown) => e instanceof MonteCarloStoreError && e.code === "mc:run-not-found"
    );

    // Zu kleine Stichprobe (Segment OOS eines Runs mit 20 OOS-Trades).
    const smallRun = await seedRun(20, 0);
    await assert.rejects(
      runMonteCarloAnalysis(
        { runId: smallRun, config: { method: "iid", segment: "OOS" }, analysisId: randomUUID() },
        { db, audit: noopAudit }
      ),
      (e: unknown) => e instanceof MonteCarloError && e.code === "mc:insufficient-sample"
    );

    const after = await pool!.query(`SELECT count(*)::int AS n FROM backtest_monte_carlo_runs`);
    assert.equal(after.rows[0].n, before.rows[0].n, "fail-closed Pfade schreiben KEINE Zeile");
  });

  it("CHECK-Constraints und FK: DB erzwingt die harten Invarianten", async (t) => {
    if (!pool) return t.skip(startupError?.message ?? "Postgres nicht gestartet");
    const runId = await seedRun(40, 0);
    const uniqueKey = () => `mcs1:${randomUUID().replace(/-/g, "").repeat(2)}`;
    const base = (over: Record<string, unknown>) => ({
      id: randomUUID(),
      source_run_id: runId,
      idempotency_key: uniqueKey(),
      method: "iid",
      segment: "OOS",
      scenario: "baseline",
      seed: 1,
      seed_algorithm: "mulberry32-v1",
      runs: 100,
      block_length: null,
      sample_trades: 40,
      input_trades_hash: "b".repeat(64),
      config_json: "{}",
      summary_json: "{}",
      code_version: "test",
      ...over,
    });
    const insert = (row: Record<string, unknown>) =>
      pool!.query(
        `INSERT INTO backtest_monte_carlo_runs (id, source_run_id, idempotency_key, method, segment, scenario,
           seed, seed_algorithm, runs, block_length, sample_trades, input_trades_hash, config_json, summary_json, code_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15)`,
        [
          row.id, row.source_run_id, row.idempotency_key, row.method, row.segment, row.scenario,
          row.seed, row.seed_algorithm, row.runs, row.block_length, row.sample_trades,
          row.input_trades_hash, row.config_json, row.summary_json, row.code_version,
        ]
      );
    await assert.doesNotReject(insert(base({})));
    await assert.rejects(insert(base({ method: "magic" })), /backtest_monte_carlo_runs_method_check/);
    await assert.rejects(insert(base({ segment: "EVAL" })), /backtest_monte_carlo_runs_segment_check/);
    await assert.rejects(insert(base({ scenario: "dream" })), /backtest_monte_carlo_runs_scenario_check/);
    await assert.rejects(insert(base({ seed: 4_294_967_296 })), /backtest_monte_carlo_runs_seed_check/);
    await assert.rejects(insert(base({ runs: 99 })), /backtest_monte_carlo_runs_runs_check/);
    await assert.rejects(insert(base({ block_length: 1 })), /backtest_monte_carlo_runs_block_length_check/);
    await assert.rejects(insert(base({ input_trades_hash: "nothex" })), /backtest_monte_carlo_runs_hash_check/);
    await assert.rejects(insert(base({ idempotency_key: "wf1:plain" })), /backtest_monte_carlo_runs_idempotency_key_check/);
    await assert.rejects(
      insert(base({ source_run_id: randomUUID() })),
      /foreign key/i,
      "FK auf backtest_runs ohne Cascade"
    );
    // Doppelte Idempotency-Keys sind strukturell unmöglich.
    const key = `mcs1:${"c".repeat(64)}`;
    await assert.doesNotReject(insert(base({ idempotency_key: key })));
    await assert.rejects(insert(base({ idempotency_key: key })), /backtest_monte_carlo_runs_idempotency_key_unique/);
    // FK ohne Cascade: Quell-Run mit Analyse ist nicht still löschbar.
    await assert.rejects(pool!.query(`DELETE FROM backtest_runs WHERE id = $1`, [runId]), /foreign key/i);
  });

  it("Read-API: Liste, Detail und Quell-Filter (bounded)", async (t) => {
    if (!pool || !db) return t.skip(startupError?.message ?? "Postgres nicht gestartet");
    await pool.query(`DELETE FROM backtest_monte_carlo_runs`);
    const runIdA = await seedRun(40, 0);
    const runIdB = await seedRun(40, 0);
    const a = await runMonteCarloAnalysis(
      { runId: runIdA, config: { method: "moving_block", seed: 1, runs: 120, blockLength: 6, segment: "OOS" }, analysisId: randomUUID() },
      { db, audit: noopAudit }
    );
    await runMonteCarloAnalysis(
      { runId: runIdB, config: { method: "iid", seed: 1, runs: 120, segment: "OOS" }, analysisId: randomUUID() },
      { db, audit: noopAudit }
    );

    const all = await listMonteCarloRuns({}, db);
    assert.equal(all.length, 2);
    const ofA = await listMonteCarloRuns({ sourceRunId: runIdA }, db);
    assert.equal(ofA.length, 1);
    assert.equal(ofA[0].sourceRunId, runIdA);
    assert.equal(ofA[0].method, "moving_block");
    assert.equal(ofA[0].blockLength, 6);
    assert.equal(ofA[0].id, a.id);

    const detail = await getMonteCarloRun(a.id, db);
    assert.ok(detail);
    assert.equal(detail!.id, a.id);
    assert.equal(detail!.config.blockLength, 6);
    assert.ok(detail!.summary.observed);
    assert.equal(await getMonteCarloRun(randomUUID(), db), null);

    // Limit-Validator.
    assert.deepEqual(validateMonteCarloLimit(undefined), { ok: true, limit: 20 });
    assert.deepEqual(validateMonteCarloLimit("50"), { ok: true, limit: 50 });
    assert.equal(validateMonteCarloLimit("0").ok, false);
    assert.equal(validateMonteCarloLimit("101").ok, false);
    assert.equal(validateMonteCarloLimit("abc").ok, false);
  });

  it("Replay-Vertrag: persistierte Config + Ledger ⇒ byte-identische Summary", async (t) => {
    if (!pool || !db) return t.skip(startupError?.message ?? "Postgres nicht gestartet");
    const runId = await seedRun(40, 0);
    const analysis = await runMonteCarloAnalysis(
      { runId, config: { method: "stationary_block", seed: 99, runs: 150, blockLength: 8, segment: "OOS", stress: { feeMultiplier: 2, slippageMultiplier: 1 } }, analysisId: randomUUID() },
      { db, audit: noopAudit }
    );
    const detail = await getMonteCarloRun(analysis.id, db);
    assert.ok(detail);
    // Config aus der DB + frisch geladene Trades ⇒ identisches Result.
    const { loadMonteCarloSample } = await import("../src/backtest/monteCarloStore");
    const sample = await loadMonteCarloSample(runId, "OOS", db);
    const replayed = runMonteCarloSimulation({
      sourceRunId: runId,
      trades: sample.trades,
      config: detail!.config as never,
    });
    assert.equal(JSON.stringify(replayed.summary), JSON.stringify(analysis.result.summary));
    assert.equal(replayed.idempotencyKey, analysis.idempotencyKey);
  });

  // ── HTTP-Vertrag (Lazy-Singleton @/db zeigt auf die eingebettete Instanz) ──

  it("API: 401 ohne Credential im Token-Betrieb — vor jedem DB-Zugriff", async (t) => {
    if (!pool) return t.skip(startupError?.message ?? "Postgres nicht gestartet");
    process.env.FIRM_API_TOKEN = "mc-api-token-0123456789abcdef";
    try {
      const { GET: listGet } = await import("../src/app/api/firm/montecarlo/route");
      const res = await listGet(new Request("https://trading.example.test/api/firm/montecarlo"));
      assert.equal(res.status, 401);
    } finally {
      delete process.env.FIRM_API_TOKEN;
    }
  });

  it("API: 400 bei ungültiger UUID/Limit, 404 unbekannt, 200 Happy Path", async (t) => {
    if (!pool || !db) return t.skip(startupError?.message ?? "Postgres nicht gestartet");
    const { GET: listGet } = await import("../src/app/api/firm/montecarlo/route");
    const { GET: detailGet } = await import("../src/app/api/firm/montecarlo/[id]/route");
    const BASE = "https://trading.example.test/api/firm/montecarlo";
    const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

    assert.equal((await listGet(new Request(`${BASE}?limit=abc`))).status, 400);
    assert.equal((await listGet(new Request(`${BASE}?run=keine-uuid`))).status, 400);
    assert.equal((await detailGet(new Request(`${BASE}/keine-uuid`), ctx("keine-uuid"))).status, 400);
    assert.equal((await detailGet(new Request(`${BASE}/${randomUUID()}`), ctx(randomUUID()))).status, 404);

    const runId = await seedRun(40, 0);
    const analysis = await runMonteCarloAnalysis(
      { runId, config: { method: "iid", seed: 5, runs: 120, segment: "OOS" }, analysisId: randomUUID() },
      { db, audit: noopAudit }
    );
    const listRes = await listGet(new Request(`${BASE}?run=${runId}&limit=10`));
    assert.equal(listRes.status, 200);
    const listBody = (await listRes.json()) as { ok: boolean; analyses: Array<{ id: string }> };
    assert.equal(listBody.ok, true);
    assert.equal(listBody.analyses.length, 1);
    assert.equal(listBody.analyses[0].id, analysis.id);

    const detailRes = await detailGet(new Request(`${BASE}/${analysis.id}`), ctx(analysis.id));
    assert.equal(detailRes.status, 200);
    const detailBody = (await detailRes.json()) as {
      ok: boolean;
      analysis: { id: string; config: Record<string, unknown>; summary: Record<string, unknown> };
    };
    assert.equal(detailBody.ok, true);
    assert.equal(detailBody.analysis.id, analysis.id);
    assert.equal(detailBody.analysis.config.seed, 5);
    assert.ok(detailBody.analysis.summary.resampled);
    assert.ok(JSON.stringify(detailBody).length < 16_000, "API-Antwort bleibt bounded");
  });
});
