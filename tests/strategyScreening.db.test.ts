/**
 * STX-05-03 — echte PostgreSQL-Zusicherungen: SQL/Drizzle-Parität,
 * parallele Idempotenz, mandatory Strategie-FK, nullable Backtest-Link,
 * immutable Zellen, atomare Chunks, monotone Fortschritte, bounded Reads.
 * Nur ein nicht startbarer embedded-postgres wird übersprungen; Fehler in
 * Migration/Schema/Store sind Testfehler, niemals ein Startup-Skip.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import EmbeddedPostgres from "embedded-postgres";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import {
  backtestRuns,
  strategyDefinitions,
  strategyVersions,
  strategyMarketResults,
  strategyScreeningRuns,
} from "../src/db/schema";
import {
  createOrGetRun,
  listResults,
  setRunStatus,
  upsertCells,
  SCREENING_CELLS_INSERT_CHUNK,
  type CreateScreeningRunInput,
  type ScreeningCellInput,
} from "../src/screening/store";
import { screeningCellKey, screeningRunHash } from "../src/screening/keys";
import { DEFAULT_SCREENING_PRIORITY_CONFIG } from "../src/screening/config";
import { DEFAULT_MATRIX_LIMITS } from "../src/screening/matrix";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "../src/lib/paging";

const PG_PORT = 55_454;
const MIGRATION_FILE = "2026-10-01_strategy_screening.sql";
const AS_OF = "2026-10-01T12:00:00.000Z";
const PARENT_TABLES = ["backtest_runs", "strategy_definitions", "strategy_versions", "strategy_lifecycle_states", "strategy_lifecycle_evidence", "strategy_lifecycle_transitions"];
const SCREENING_TABLES = ["strategy_screening_runs", "strategy_market_results"];
const migration = (file: string) => readFileSync(path.join(process.cwd(), "drizzle", file), "utf8");

async function describeSchema(pool: Pool, tables: string[]) {
  const columns = await pool.query(`
    SELECT c.relname AS table_name, a.attname AS column_name,
           format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null,
           pg_get_expr(d.adbin, d.adrelid) AS default_value
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
    WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])
      AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY c.relname, a.attnum`, [tables]);
  const constraints = await pool.query(`
    SELECT c.relname AS table_name, x.conname AS name, x.contype AS type,
           pg_get_constraintdef(x.oid, true) AS definition
    FROM pg_constraint x JOIN pg_class c ON c.oid = x.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])
    ORDER BY c.relname, x.conname`, [tables]);
  const indexes = await pool.query(`
    SELECT tablename AS table_name, indexname AS name, indexdef AS definition
    FROM pg_indexes WHERE schemaname = 'public' AND tablename = ANY($1::text[])
    ORDER BY tablename, indexname`, [tables]);
  return { columns: columns.rows, constraints: constraints.rows, indexes: indexes.rows };
}

function pgCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const e = error as { code?: string; cause?: unknown };
  return e.code ?? pgCode(e.cause);
}

describe("STX-05-03: strategy screening (Postgres)", () => {
  let pg: EmbeddedPostgres | null = null;
  let pool: Pool | null = null;
  let parityPool: Pool | null = null;
  let database: NodePgDatabase<Record<string, never>>;
  let startupError: Error | null = null;
  let versionId: string;
  let backtestId: string;
  let parentSchema: Awaited<ReturnType<typeof describeSchema>>;
  const logs: string[] = [];

  before(async () => {
    // Nur Infrastruktur-Startup darf skippen. Migrationen außerhalb dieses try.
    try {
      pg = new EmbeddedPostgres({
        databaseDir: mkdtempSync(path.join(tmpdir(), "strategy-screening-pg-")),
        user: "postgres", password: "postgres", port: PG_PORT, persistent: false,
        onLog: (message) => logs.push(String(message)),
        onError: (message) => logs.push(String(message)),
      });
      await pg.initialise();
      await pg.start();
      await pg.createDatabase("strategy_screening_test");
      await pg.createDatabase("strategy_screening_push_test");
      const connect = (name: string) => new Pool({
        host: "127.0.0.1", port: PG_PORT, user: "postgres", password: "postgres", database: name, max: 8,
      });
      pool = connect("strategy_screening_test");
      parityPool = connect("strategy_screening_push_test");
      await pool.query("SELECT 1");
      await parityPool.query("SELECT 1");
    } catch (error) {
      startupError = new Error(`${String(error)} :: ${logs.slice(-8).join(" | ")}`);
      return;
    }

    for (const target of [pool!, parityPool!]) {
      for (const file of [
        "2026-09-19_backtest_runs.sql", "2026-09-20_backtest_trades.sql",
        "2026-10-01_strategy_catalog.sql", "2026-09-23_strategy_lifecycle.sql",
      ]) await target.query(migration(file));
    }
    database = drizzle(pool!);
    const [definition] = await database.insert(strategyDefinitions).values({
      templateId: "ema-adx-trend", strategyClass: "trend", name: "Screening fixture", description: "STX-05-03",
    }).returning();
    const [version] = await database.insert(strategyVersions).values({
      definitionId: definition.id, version: 1, paramsJson: { fastPeriod: 12 }, ruleSpecJson: {},
      timeframe: "1h", fingerprint: "screening-fixture", contentHash: `stv1:${"a".repeat(64)}`,
      codeVersion: "0.8.0", templateVersion: 1, createdBy: "test",
    }).returning();
    versionId = version.id;
    const [backtest] = await database.insert(backtestRuns).values({
      instrumentId: "PAPER:BTCUSD", timeframe: "1h", fromTs: new Date("2026-09-01T00:00:00Z"), toTs: new Date(AS_OF),
      paramsJson: {}, metricsJson: {}, windowsJson: {}, codeVersion: "0.8.0",
    }).returning();
    backtestId = backtest.id;
    await pool!.query(`INSERT INTO strategy_lifecycle_states (strategy_key, strategy_version, state, policy_version)
      VALUES ('legacy-screening-test', 1, 'DRAFT', 'test')`);
    parentSchema = await describeSchema(pool!, PARENT_TABLES);
    await pool!.query(migration(MIGRATION_FILE));
  });

  after(async () => {
    await pool?.end();
    await parityPool?.end();
    await pg?.stop().catch(() => undefined);
  });

  function live(t: { skip: (reason: string) => void }): Pool | null {
    if (startupError) {
      t.skip(`eingebettete Postgres nicht verfügbar: ${startupError.message}`);
      return null;
    }
    assert.ok(pool, "Postgres-Pool initialisiert");
    return pool;
  }

  function cell(overrides: Partial<ScreeningCellInput> = {}): ScreeningCellInput {
    return { strategyVersionId: versionId, instrumentId: "PAPER:BTCUSD", venue: "PAPER", timeframe: "1h", templateId: "ema-adx-trend", status: "READY", ...overrides };
  }

  function input(cells: readonly unknown[] = [cell()], overrides: Partial<CreateScreeningRunInput> = {}): CreateScreeningRunInput {
    return {
      runKind: "MATRIX", cells, asOf: AS_OF, codeVersion: "0.8.0", dataVersion: "candles@test",
      config: { priority: DEFAULT_SCREENING_PRIORITY_CONFIG, limits: DEFAULT_MATRIX_LIMITS, fixture: randomUUID() },
      ...overrides,
    };
  }

  async function rawRun(db: Pool, overrides: Record<string, unknown> = {}) {
    const values = {
      runKind: "MATRIX", hash: `ssr1:${createHash("sha256").update(randomUUID()).digest("hex")}`,
      codeVersion: "0.8.0", config: "{}", status: "PENDING", total: 0, done: 0, ...overrides,
    };
    return db.query(`INSERT INTO strategy_screening_runs
      (run_kind, as_of, candidate_set_hash, code_version, config_json, status, cells_total, cells_done)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8) RETURNING *`,
    [values.runKind, AS_OF, values.hash, values.codeVersion, values.config, values.status, values.total, values.done]);
  }

  async function rawCell(db: Pool, runId: string, overrides: Record<string, unknown> = {}) {
    const values = {
      runId, versionId, backtestId: null, key: `ssm1:${createHash("sha256").update(randomUUID()).digest("hex")}`,
      reasons: "[]", metrics: "{}", ...overrides,
    };
    return db.query(`INSERT INTO strategy_market_results
      (run_id, strategy_version_id, instrument_id, venue, timeframe, template_id, status, backtest_run_id, idempotency_key, reasons, metrics)
      VALUES ($1, $2, 'PAPER:BTCUSD', 'PAPER', '1h', 'ema-adx-trend', 'READY', $3, $4, $5::jsonb, $6::jsonb) RETURNING *`,
    [values.runId, values.versionId, values.backtestId, values.key, values.reasons, values.metrics]);
  }

  it("SQL-Migration ist mehrfach idempotent und lässt gesperrte Tabellen/Indizes/Zeilen unverändert", async (t) => {
    const db = live(t); if (!db) return;
    const before = await describeSchema(db, SCREENING_TABLES);
    await db.query(migration(MIGRATION_FILE));
    await db.query(migration(MIGRATION_FILE));
    assert.deepEqual(await describeSchema(db, SCREENING_TABLES), before);
    assert.deepEqual(await describeSchema(db, PARENT_TABLES), parentSchema);
    assert.equal((await db.query("SELECT instrument_id FROM backtest_runs WHERE id = $1", [backtestId])).rows[0].instrument_id, "PAPER:BTCUSD");
    assert.equal((await db.query("SELECT state FROM strategy_lifecycle_states WHERE strategy_key = 'legacy-screening-test'")).rows[0].state, "DRAFT");
    assert.equal((await db.query("SELECT params_json FROM strategy_versions WHERE id = $1", [versionId])).rows[0].params_json.fastPeriod, 12);
  });

  it("drizzle-kit push ≡ SQL: gleiche Spalten, Defaults, CHECKs, FKs und Indizes; zweiter Push ist leer", async (t) => {
    const db = live(t); if (!db) return;
    const { pushSchema } = await import("drizzle-kit/api");
    const schema = { strategyScreeningRuns, strategyMarketResults };
    const pushDb = drizzle(parityPool!);
    const plan = await pushSchema(schema, pushDb, ["public"], SCREENING_TABLES);
    assert.equal(plan.hasDataLoss, false);
    assert.ok(plan.statementsToExecute.length > 0, "neue Tabellen werden tatsächlich gepusht");
    await plan.apply();
    assert.deepEqual(await describeSchema(parityPool!, SCREENING_TABLES), await describeSchema(db, SCREENING_TABLES));
    const repeat = await pushSchema(schema, pushDb, ["public"], SCREENING_TABLES);
    assert.deepEqual(repeat.statementsToExecute, [], "kein Schema-Drift beim zweiten Push");
    const onSql = await pushSchema(schema, database, ["public"], SCREENING_TABLES);
    assert.deepEqual(onSql.statementsToExecute, [], "SQL-Schema benötigt keine Drizzle-Nachbesserung");
    await parityPool!.query(migration(MIGRATION_FILE));
    assert.deepEqual(await describeSchema(parityPool!, SCREENING_TABLES), await describeSchema(db, SCREENING_TABLES));
  });

  it("createOrGetRun: acht parallele Retries + neuer Pool ⇒ genau eine Zeile, vollständige Config/PIT-Provenienz", async (t) => {
    const db = live(t); if (!db) return;
    const request = input();
    const runs = await Promise.all(Array.from({ length: 8 }, () => createOrGetRun(request, database)));
    assert.equal(new Set(runs.map((r) => r.id)).size, 1);
    const run = runs[0];
    assert.equal(run.candidateSetHash, screeningRunHash(request));
    assert.equal(run.asOf.toISOString(), AS_OF);
    assert.equal(run.dataVersion, "candles@test");
    assert.deepEqual(run.configJson, request.config);
    assert.equal(run.runKind, "MATRIX");
    assert.equal(run.status, "PENDING");
    assert.equal(run.cellsTotal, request.cells.length);
    assert.equal(run.cellsDone, 0);
    assert.ok(run.createdAt instanceof Date && run.updatedAt instanceof Date);
    const fresh = new Pool({ host: "127.0.0.1", port: PG_PORT, user: "postgres", password: "postgres", database: "strategy_screening_test" });
    try {
      assert.deepEqual(await createOrGetRun({ ...request, asOf: "2026-10-01T14:00:00+02:00", dataVersion: "retry-does-not-overwrite" }, drizzle(fresh)), run);
    } finally { await fresh.end(); }
    assert.equal((await db.query("SELECT count(*)::int AS n FROM strategy_screening_runs WHERE candidate_set_hash = $1 AND code_version = $2", [run.candidateSetHash, run.codeVersion])).rows[0].n, 1);
  });

  it("neuer Code, Cutoff oder Config ⇒ neuer Run; Composite-UNIQUE gilt unabhängig von der Hash-Herleitung", async (t) => {
    const db = live(t); if (!db) return;
    const request = input();
    const first = await createOrGetRun(request, database);
    for (const changed of [
      { ...request, codeVersion: "0.8.1" },
      { ...request, asOf: "2026-10-01T12:00:01Z" },
      { ...request, config: { ...request.config, limits: { ...DEFAULT_MATRIX_LIMITS, maxCells: 100 } } },
    ]) assert.notEqual((await createOrGetRun(changed, database)).id, first.id);
    await assert.rejects(rawRun(db, { hash: first.candidateSetHash, codeVersion: first.codeVersion }), (e) => pgCode(e) === "23505");
    await rawRun(db, { hash: first.candidateSetHash, codeVersion: "different-code-for-same-hash" });
  });

  it("Zellen roundtrippen: Pflicht-FK, optionaler Backtest, NULL-Priorität und JSON-/Zeit-Defaults", async (t) => {
    const db = live(t); if (!db) return;
    const cells = [
      cell({ instrumentId: "PAPER:ZZZ", priority: null, status: "BLOCKED", reasons: ["warmup"], metrics: { sharpe: null } }),
      cell({ instrumentId: "PAPER:BBB", priority: 0.9, backtestRunId: backtestId, metrics: { trades: 12 } }),
      cell({ instrumentId: "PAPER:AAA", priority: 0.9 }),
      cell({ instrumentId: "PAPER:ZERO", priority: 0 }),
    ];
    const run = await createOrGetRun(input(cells), database);
    assert.equal(await upsertCells(run.id, cells, database), 4);
    const loaded = await listResults(run.id, { limit: 4 }, database);
    assert.deepEqual(loaded.map((r) => r.instrumentId), ["PAPER:AAA", "PAPER:BBB", "PAPER:ZERO", "PAPER:ZZZ"]);
    assert.equal(loaded[0].strategyVersionId, versionId);
    assert.equal(loaded[0].backtestRunId, null);
    assert.deepEqual(loaded[0].reasons, []);
    assert.deepEqual(loaded[0].metrics, {});
    assert.equal(loaded[0].priority, "0.9");
    assert.equal(loaded[1].backtestRunId, backtestId);
    assert.deepEqual(loaded[1].metrics, { trades: 12 });
    assert.equal(loaded[2].priority, "0");
    assert.equal(loaded[3].priority, null);
    assert.deepEqual(loaded[3].reasons, ["warmup"]);
    assert.deepEqual(loaded[3].metrics, { sharpe: null });
    for (const row of loaded) {
      assert.equal(row.idempotencyKey, screeningCellKey(row));
      assert.ok(row.createdAt instanceof Date && row.updatedAt instanceof Date);
    }
    const defaults = await db.query(`INSERT INTO strategy_market_results
      (run_id, strategy_version_id, instrument_id, venue, timeframe, template_id, status, idempotency_key)
      VALUES ($1, $2, 'PAPER:DEFAULTS', 'PAPER', '1h', 'ema-adx-trend', 'READY', $3) RETURNING *`,
    [run.id, versionId, screeningCellKey({ ...cell({ instrumentId: "PAPER:DEFAULTS" }), runId: run.id })]);
    assert.deepEqual(defaults.rows[0].reasons, []);
    assert.deepEqual(defaults.rows[0].metrics, {});
    assert.equal(defaults.rows[0].backtest_run_id, null);
  });

  it("batchweise parallele upsertCells-Retries bleiben immutable, auch bei geänderter priority/status/metrics", async (t) => {
    const db = live(t); if (!db) return;
    const cells = Array.from({ length: SCREENING_CELLS_INSERT_CHUNK + 7 }, (_, i) => cell({ instrumentId: `PAPER:BATCH${String(i).padStart(4, "0")}`, priority: 0.4 }));
    const run = await createOrGetRun(input(cells), database);
    const inserted = await Promise.all([upsertCells(run.id, cells, database), upsertCells(run.id, cells, database)]);
    assert.equal(inserted.reduce((a, b) => a + b), cells.length);
    assert.equal(await upsertCells(run.id, cells, database), 0);
    const before = await database.select().from(strategyMarketResults).where(eq(strategyMarketResults.runId, run.id));
    const changed = cells.map((c) => ({ ...c, strategyVersionId: c.strategyVersionId.toUpperCase(), priority: 0.99, status: "BLOCKED" as const, reasons: ["retry"], metrics: { trades: 999 }, backtestRunId: backtestId }));
    assert.equal(await upsertCells(run.id.toUpperCase(), changed, database), 0);
    assert.deepEqual(await database.select().from(strategyMarketResults).where(eq(strategyMarketResults.runId, run.id)), before, "auch updated_at bleibt beim Replay unverändert");
    assert.equal(await upsertCells(run.id, [], database), 0);
    const second = await createOrGetRun(input(cells), database);
    assert.equal(await upsertCells(second.id, changed, database), cells.length, "neuer Run ⇒ neue Zellen");
    await assert.rejects(rawCell(db, run.id, { key: before[0].idempotencyKey }), (e) => pgCode(e) === "23505");
  });

  it("Strategieversion ist NOT NULL + FK; Run-/Backtest-FKs verhindern Waisen", async (t) => {
    const db = live(t); if (!db) return;
    const run = await createOrGetRun(input(), database);
    await assert.rejects(rawCell(db, run.id, { versionId: null }), (e) => pgCode(e) === "23502");
    await assert.rejects(db.query(`INSERT INTO strategy_market_results
      (run_id, instrument_id, venue, timeframe, template_id, status, idempotency_key)
      VALUES ($1, 'PAPER:BTCUSD', 'PAPER', '1h', 'ema-adx-trend', 'READY', $2)`,
    [run.id, `ssm1:${"b".repeat(64)}`]), (e) => pgCode(e) === "23502");
    await assert.rejects(rawCell(db, run.id, { versionId: randomUUID() }), (e) => pgCode(e) === "23503");
    await assert.rejects(rawCell(db, randomUUID()), (e) => pgCode(e) === "23503");
    await assert.rejects(rawCell(db, run.id, { backtestId: randomUUID() }), (e) => pgCode(e) === "23503");
    await assert.rejects(upsertCells(run.id, [cell({ strategyVersionId: "" })], database), /UUID/);
  });

  it("Chunk-Fehler rollt den ganzen Batch zurück (kein Teilstand aus Chunk 1)", async (t) => {
    const db = live(t); if (!db) return;
    const cells = Array.from({ length: SCREENING_CELLS_INSERT_CHUNK + 1 }, (_, i) => cell({ instrumentId: `PAPER:ROLLBACK${i}` }));
    cells[cells.length - 1] = cell({ instrumentId: "PAPER:INVALID", strategyVersionId: randomUUID() });
    const run = await createOrGetRun(input(cells), database);
    await assert.rejects(upsertCells(run.id, cells, database), (e) => pgCode(e) === "23503");
    assert.equal((await db.query("SELECT count(*)::int AS n FROM strategy_market_results WHERE run_id = $1", [run.id])).rows[0].n, 0);
  });

  it("CHECKs/NOT NULL verwerfen ungültige Run-Arten, Status, Hashes, Config und Zähler", async (t) => {
    const db = live(t); if (!db) return;
    for (const overrides of [
      { runKind: "UNKNOWN" }, { status: "UNKNOWN" }, { hash: `ssr1:${"A".repeat(64)}` }, { hash: `wf1:${"0".repeat(64)}` },
      { total: -1 }, { done: -1 }, { total: 1, done: 2 }, { config: "null" }, { config: "[]" },
    ]) await assert.rejects(rawRun(db, overrides), (e) => pgCode(e) === "23514");
    await assert.rejects(rawRun(db, { config: null }), (e) => pgCode(e) === "23502");
    const run = await createOrGetRun(input(), database);
    for (const overrides of [{ key: `ssm1:${"A".repeat(64)}` }, { key: `ssr1:${"0".repeat(64)}` }, { reasons: "{}" }, { metrics: "[]" }]) {
      await assert.rejects(rawCell(db, run.id, overrides), (e) => pgCode(e) === "23514");
    }
    const defaults = await db.query(`INSERT INTO strategy_screening_runs
      (run_kind, as_of, candidate_set_hash, code_version, config_json, status)
      VALUES ('DISCOVERY', $1, $2, 'defaults', '{}', 'PENDING') RETURNING *`, [AS_OF, run.candidateSetHash]);
    assert.equal(defaults.rows[0].cells_total, 0);
    assert.equal(defaults.rows[0].cells_done, 0);
  });

  it("Fortschritt bleibt bei alten/parallelen Meldungen monoton; ABORTED ist fortsetzbar, DONE/FAILED terminal", async (t) => {
    if (!live(t)) return;
    const run = await createOrGetRun(input(Array.from({ length: 5 }, () => cell())), database);
    await setRunStatus(run.id, "RUNNING", { cellsDone: 3 }, database);
    const stale = await setRunStatus(run.id, "PENDING", { cellsTotal: 1, cellsDone: 1 }, database);
    assert.equal(stale.status, "RUNNING");
    assert.equal(stale.cellsTotal, 5);
    assert.equal(stale.cellsDone, 3);
    const aborted = await setRunStatus(run.id, "ABORTED", { cellsDone: 4 }, database);
    const resumed = await setRunStatus(run.id, "RUNNING", {}, database);
    assert.equal(resumed.status, "RUNNING");
    assert.equal(resumed.cellsDone, aborted.cellsDone);
    await Promise.all([2, 5, 4].map((cellsDone) => setRunStatus(run.id, "RUNNING", { cellsTotal: 2, cellsDone }, database)));
    const done = await setRunStatus(run.id, "DONE", {}, database);
    assert.equal(done.cellsDone, 5);
    assert.equal(done.cellsTotal, 5);
    assert.ok(done.updatedAt.getTime() >= run.updatedAt.getTime());
    assert.deepEqual(await setRunStatus(run.id, "RUNNING", { cellsDone: 0, cellsTotal: 0 }, database), done);
    const failedRun = await createOrGetRun(input(), database);
    const failed = await setRunStatus(failedRun.id, "FAILED", {}, database);
    assert.deepEqual(await setRunStatus(failedRun.id, "PENDING", {}, database), failed);
    const emptyRun = await createOrGetRun(input([]), database);
    const emptyDone = await setRunStatus(emptyRun.id, "DONE", {}, database);
    assert.deepEqual([emptyDone.status, emptyDone.cellsTotal, emptyDone.cellsDone], ["DONE", 0, 0]);
  });

  it("inkonsistente/ungültige Fortschrittsmeldungen scheitern ohne Mutation", async (t) => {
    if (!live(t)) return;
    const run = await createOrGetRun(input(), database);
    await assert.rejects(setRunStatus(run.id, "DONE", {}, database), /alle Zellen/);
    for (const cellsDone of [-1, 1.5, NaN, Infinity, 2_147_483_648]) {
      await assert.rejects(setRunStatus(run.id, "RUNNING", { cellsDone }, database), /Ganzzahl/);
    }
    await assert.rejects(setRunStatus(run.id, "RUNNING", { cellsDone: 2 }, database), /übersteigt/);
    await assert.rejects(setRunStatus(randomUUID(), "RUNNING", {}, database), /nicht gefunden/);
    assert.deepEqual((await database.select().from(strategyScreeningRuns).where(eq(strategyScreeningRuns.id, run.id)))[0], run);
    const grown = await setRunStatus(run.id, "RUNNING", { cellsTotal: 3, cellsDone: 2 }, database);
    assert.equal(grown.cellsTotal, 3);
    assert.equal(grown.cellsDone, 2);
  });

  it("listResults: Run-/Status-Filter, stabile Prioritätssortierung, Default und hartes Limit", async (t) => {
    if (!live(t)) return;
    const cells = Array.from({ length: MAX_PAGE_SIZE + 7 }, (_, i) => cell({ instrumentId: `PAPER:PAGE${String(i).padStart(4, "0")}`, priority: i, status: i % 2 ? "READY" : "BLOCKED" }));
    const run = await createOrGetRun(input(cells), database);
    await upsertCells(run.id, cells, database);
    assert.equal((await listResults(run.id, {}, database)).length, DEFAULT_PAGE_SIZE);
    const top = await listResults(run.id, { limit: 2 }, database);
    assert.deepEqual(top.map((r) => Number(r.priority)), [cells.length - 1, cells.length - 2]);
    assert.equal((await listResults(run.id, { limit: 1_000_000 }, database)).length, MAX_PAGE_SIZE);
    for (const limit of [-1, 0, NaN, Infinity]) assert.equal((await listResults(run.id, { limit }, database)).length, DEFAULT_PAGE_SIZE);
    const blocked = await listResults(run.id, { status: "BLOCKED", limit: MAX_PAGE_SIZE }, database);
    assert.equal(blocked.length, Math.ceil(cells.length / 2));
    assert.ok(blocked.every((r) => r.runId === run.id && r.status === "BLOCKED"));
    assert.deepEqual(await listResults(randomUUID(), { limit: 1 }, database), []);
  });
});
