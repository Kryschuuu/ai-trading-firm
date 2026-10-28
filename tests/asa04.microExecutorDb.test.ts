import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import EmbeddedPostgres from "embedded-postgres";
import { Pool } from "pg";
import { loadRuleCacheSnapshot } from "../src/lib/microExecutor";

// Real PostgreSQL checks the filtered count and timestamp decoding, not just a fake loader.
test("ASA-04 snapshot reads Berlin-day counts and latest trigger from PostgreSQL", async () => {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => probe.close((err) => err ? reject(err) : resolve()));
  const dir = mkdtempSync(path.join(tmpdir(), "asa04-pg-"));
  const postgres = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "postgres", port, persistent: false, onLog: () => {}, onError: () => {} });
  const oldUrl = process.env.DATABASE_URL;
  const globals = globalThis as typeof globalThis & { __arenaNextJsPostgresqlPool?: Pool; __arenaNextJsPostgresqlDb?: unknown };
  let pool: Pool | undefined;
  try {
    await postgres.initialise(); await postgres.start();
    process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(`
      CREATE TABLE trade_rules (id uuid primary key, rule_key uuid not null, version integer not null, status text not null,
        name text not null, symbol text not null, mission_id uuid, condition jsonb not null, action jsonb not null,
        "window" jsonb not null, signature text not null, rationale text, source_role text not null, source_agent_id uuid,
        source_mode text not null, previous_version_id uuid, superseded_by_id uuid, activated_at timestamptz,
        deactivated_at timestamptz, risk_score numeric not null, created_at timestamptz not null, updated_at timestamptz not null);
      CREATE TABLE missions (id uuid, status text, template_id text);
      CREATE TABLE rule_executions (rule_id uuid, status text, created_at timestamptz);
      INSERT INTO trade_rules VALUES ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 7,
        'ACTIVE', 'test', 'BTC', null, '{}', '{}', '{}', 'sig', '', 'MANUAL', null, 'SIGMA', null, null, null, null, 0.5, now(), now());
      INSERT INTO rule_executions VALUES ('00000000-0000-0000-0000-000000000001', 'TRIGGERED', now() - interval '2 days'),
        ('00000000-0000-0000-0000-000000000001', 'TRIGGERED', now()),
        ('00000000-0000-0000-0000-000000000001', 'BLOCKED', now());
    `);
    const snapshot = await loadRuleCacheSnapshot();
    assert.equal(snapshot.rows[0].version, 7);
    assert.equal(snapshot.countRows[0].c, 1);
    assert.ok(snapshot.countRows[0].lastFiredAt instanceof Date);
    assert.ok(Math.abs(Date.now() - snapshot.countRows[0].lastFiredAt!.getTime()) < 30_000);
  } finally {
    await globals.__arenaNextJsPostgresqlPool?.end();
    delete globals.__arenaNextJsPostgresqlPool; delete globals.__arenaNextJsPostgresqlDb;
    await pool?.end(); await postgres.stop().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
    if (oldUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = oldUrl;
  }
});
