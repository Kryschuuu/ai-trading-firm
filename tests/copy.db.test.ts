/** PostgreSQL integration tests for the additive Copy-07-02 schema and link store. */
import { after, before, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { Pool } from "pg";

import { CopyStore, CopyStoreError, type CopyAuditWriter } from "../src/copy/store";
import { DEFAULT_COPY_POLICY_CONFIG } from "../src/copy/config";

const PG_PORT = 55_471;
const DATABASE = "copy_policy_test";
let pg: EmbeddedPostgres | null = null;
let pool: Pool | null = null;
let directory = "";
let startupError: Error | null = null;
const pgLogs: string[] = [];

before(async () => {
  try {
    directory = await mkdtemp(join(tmpdir(), "copy-policy-pg-"));
    const instance = new EmbeddedPostgres({
      databaseDir: directory,
      user: "postgres",
      password: "postgres",
      port: PG_PORT,
      persistent: false,
      onLog: (message) => pgLogs.push(String(message)),
      onError: (message) => pgLogs.push(message instanceof Error ? message.message : String(message)),
    });
    await instance.initialise();
    await instance.start();
    pg = instance;
    await instance.createDatabase(DATABASE);
    const connection = new Pool({
      host: "127.0.0.1",
      port: PG_PORT,
      user: "postgres",
      password: "postgres",
      database: DATABASE,
      max: 4,
    });
    pool = connection;
    const executionQualityMigration = await readFile(
      "drizzle/2026-09-20_execution_quality.sql",
      "utf8",
    );
    const copyMigration = await readFile("drizzle/2026-10-03_copy_subscriptions.sql", "utf8");
    await connection.query(executionQualityMigration);
    await connection.query(copyMigration);
    await connection.query(copyMigration); // additive/idempotent
  } catch (error) {
    startupError = error instanceof Error ? error : new Error(String(error));
  }
});

after(async () => {
  await pool?.end().catch(() => undefined);
  await pg?.stop().catch(() => undefined);
  if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
});

function requirePostgres(context: TestContext): Pool | null {
  if (!pool) {
    context.skip(
      `embedded PostgreSQL unavailable: ${startupError?.message ?? "unknown"}; ${pgLogs.slice(-5).join(" | ")}`,
    );
    return null;
  }
  return pool;
}

async function insertQualityIntent(database: Pool, id: string): Promise<void> {
  await database.query(
    `INSERT INTO execution_quality_intents
      (id, venue, mode, scope, client_order_id, submit_at, payload)
    VALUES ($1, 'PAPER', 'paper', 'copy-test', $2, now(), '{}'::jsonb)`,
    [id, `client-${id}`],
  );
}

test("migration is idempotent and creates only the two phase-7 copy tables", async (t) => {
  const database = requirePostgres(t);
  if (!database) return;
  const result = await database.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename LIKE 'copy_%'
      ORDER BY tablename`,
  );
  assert.deepEqual(result.rows.map((row) => row.tablename), ["copy_order_links", "copy_subscriptions"]);

  const subscription = await database.query<{
    mode: string;
    enabled: boolean;
  }>(
    `INSERT INTO copy_subscriptions (
      follower_account, leader_venue, leader_account, leader_symbol,
      sizing_mode, sizing_params, leverage_policy, policy_json, policy_version
    ) VALUES ($1, $2, $3, $4, 'FIXED_AMOUNT', '{}'::jsonb, 'CAP', $5::jsonb, $6)
    RETURNING mode, enabled`,
    [
      "follower-paper",
      "PAPER",
      "leader-account",
      "BTC/USD",
      JSON.stringify(DEFAULT_COPY_POLICY_CONFIG.policy),
      DEFAULT_COPY_POLICY_CONFIG.policyVersion,
    ],
  );
  assert.equal(subscription.rows[0].mode, "SIMULATE_ONLY");
  assert.equal(subscription.rows[0].enabled, false);

  await assert.rejects(
    () => database.query(
      `INSERT INTO copy_subscriptions (
        follower_account, leader_venue, leader_account, leader_symbol,
        sizing_mode, sizing_params, leverage_policy, policy_json, policy_version, mode
      ) VALUES ('follower-live', 'PAPER', 'leader', 'BTC/USD', 'FIXED_AMOUNT',
        '{}'::jsonb, 'CAP', $1::jsonb, $2, 'LIVE')`,
      [JSON.stringify(DEFAULT_COPY_POLICY_CONFIG.policy), DEFAULT_COPY_POLICY_CONFIG.policyVersion],
    ),
    /copy_subscriptions_mode_check|check constraint/i,
  );
});

test("unique links, real execution-quality FK, forward transitions and FILLED retry no-op", async (t) => {
  const database = requirePostgres(t);
  if (!database) return;
  const executionQualityId = "eq-copy-fill-1";
  await insertQualityIntent(database, executionQualityId);

  const auditRecords: Array<{ event: string; level: string; detail: unknown }> = [];
  const audit: CopyAuditWriter = async (record) => {
    auditRecords.push({ event: record.event, level: record.level, detail: record.detail });
    return { durable: true };
  };
  const store = new CopyStore(database, audit);
  const input = {
    leaderEventId: "leader-event-fill",
    followerIntentId: "follower-intent-fill",
    executionQualityIntentId: executionQualityId,
  };

  const [first, retry] = await Promise.all([store.createIntent(input), store.createIntent(input)]);
  assert.equal(first.id, retry.id);
  assert.equal(first.state, "PENDING");
  assert.equal(first.executionQualityIntentId, executionQualityId);
  const count = await database.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM copy_order_links WHERE follower_intent_id = $1",
    [input.followerIntentId],
  );
  assert.equal(count.rows[0].count, 1);

  await assert.rejects(
    () => store.createIntent({ ...input, leaderEventId: "different-leader-event" }),
    (error: unknown) => error instanceof CopyStoreError && error.code === "LINK_IDENTITY_CONFLICT",
  );

  const sent = await store.markSent(input.followerIntentId);
  assert.equal(sent.state, "SENT");
  const partial = await store.markPartial(input.followerIntentId);
  assert.equal(partial.state, "PARTIAL");
  const filled = await store.markFilled(input.followerIntentId, 1_234.5);
  assert.equal(filled.state, "FILLED");
  assert.equal(filled.observedDeviationBps, 1_234.5, "realized deviation is stored, not used as a cancel gate");

  const retryFilled = await store.markFilled(input.followerIntentId, 1);
  assert.equal(retryFilled.state, "FILLED");
  assert.equal(retryFilled.observedDeviationBps, 1_234.5, "FILLED retry must not overwrite first measurement");
  assert.equal(retryFilled.updatedAt.getTime(), filled.updatedAt.getTime(), "FILLED retry is a true no-op");
  await assert.rejects(
    () => store.markSent(input.followerIntentId),
    (error: unknown) => error instanceof CopyStoreError && error.code === "TERMINAL_STATE",
  );

  const persisted = await database.query<{
    state: string;
    policy_code: string | null;
    observed_deviation_bps: string | null;
  }>(
    "SELECT state, policy_code, observed_deviation_bps FROM copy_order_links WHERE follower_intent_id = $1",
    [input.followerIntentId],
  );
  assert.equal(persisted.rows[0].state, "FILLED");
  assert.equal(persisted.rows[0].policy_code, null);
  assert.equal(Number(persisted.rows[0].observed_deviation_bps), 1_234.5);
  assert.ok(auditRecords.some((record) => record.event === "COPY_ORDER_LINK_TRANSITION"));
  assert.ok(auditRecords.every((record) => record.level === "INFO" || record.level === "WARN" || record.level === "CRITICAL"));
});

test("policy failure from PENDING, illegal skips and DIVERGED terminal state", async (t) => {
  const database = requirePostgres(t);
  if (!database) return;
  const store = new CopyStore(database, async () => ({ durable: true }));

  await store.createIntent({ leaderEventId: "leader-event-failed", followerIntentId: "follower-intent-failed" });
  await assert.rejects(
    () => store.markPartial("follower-intent-failed"),
    (error: unknown) => error instanceof CopyStoreError && error.code === "ILLEGAL_TRANSITION",
  );
  const failed = await store.markFailed("follower-intent-failed", "MAX_SLIPPAGE");
  assert.equal(failed.state, "FAILED");
  assert.equal(failed.policyCode, "MAX_SLIPPAGE");
  assert.equal((await store.markFailed("follower-intent-failed", "MAX_SLIPPAGE")).state, "FAILED");
  await assert.rejects(
    () => store.markSent("follower-intent-failed"),
    (error: unknown) => error instanceof CopyStoreError && error.code === "TERMINAL_STATE",
  );

  await store.createIntent({ leaderEventId: "leader-event-diverged", followerIntentId: "follower-intent-diverged" });
  await store.markSent("follower-intent-diverged");
  const diverged = await store.markDiverged("follower-intent-diverged");
  assert.equal(diverged.state, "DIVERGED");
  await assert.rejects(
    () => store.markFilled("follower-intent-diverged", 20),
    (error: unknown) => error instanceof CopyStoreError && error.code === "TERMINAL_STATE",
  );
});

test("DB constraints enforce uniqueness and the execution-quality FK", async (t) => {
  const database = requirePostgres(t);
  if (!database) return;
  const store = new CopyStore(database, async () => ({ durable: true }));
  await store.createIntent({ leaderEventId: "leader-event-unique", followerIntentId: "follower-intent-unique" });

  await assert.rejects(
    () => database.query(
      `INSERT INTO copy_order_links (leader_event_id, follower_intent_id, state)
       VALUES ('leader-event-other', 'follower-intent-unique', 'PENDING')`,
    ),
    /copy_order_links_follower_intent_unique|unique constraint/i,
  );
  await assert.rejects(
    () => database.query(
      `INSERT INTO copy_order_links (leader_event_id, follower_intent_id, execution_quality_intent_id, state)
       VALUES ('leader-event-fk', 'follower-intent-fk', 'missing-quality-intent', 'PENDING')`,
    ),
    /foreign key constraint/i,
  );
});
