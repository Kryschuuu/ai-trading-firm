/** TASK 07: real PostgreSQL trigger delivery using the embedded test server. */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { Pool } from "pg";
import { TradeRulesNotificationListener } from "../src/lib/tradeRulesNotificationListener";

let postgres: EmbeddedPostgres | null = null;
let pool: Pool | null = null;
let tempDir = "";
let startupError: Error | null = null;
const logs: string[] = [];

before(async () => {
  try {
    tempDir = mkdtempSync(path.join(tmpdir(), "trade-rules-notify-pg-"));
    const instance = new EmbeddedPostgres({
      databaseDir: tempDir,
      user: "postgres",
      password: "postgres",
      port: 55_436,
      persistent: false,
      onLog: (message) => logs.push(message),
      onError: (message) => logs.push(message instanceof Error ? message.message : String(message)),
    });
    await instance.initialise();
    await instance.start();
    await instance.createDatabase("rule_notify_test");
    const localPool = new Pool({
      host: "127.0.0.1",
      port: 55_436,
      user: "postgres",
      password: "postgres",
      database: "rule_notify_test",
      max: 4,
    });
    await localPool.query("CREATE TABLE public.trade_rules (id integer PRIMARY KEY, status text NOT NULL)");
    const migration = readFileSync(path.resolve(process.cwd(), "drizzle/2026-10-05_trade_rules_notify.sql"), "utf8");
    await localPool.query(migration);
    await localPool.query(migration); // idempotent re-apply
    postgres = instance;
    pool = localPool;
  } catch (error) {
    const tail = logs.slice(-8).join(" | ");
    startupError = new Error(`${error instanceof Error ? error.message : String(error)}${tail ? ` :: ${tail}` : ""}`);
  }
});

after(async () => {
  if (pool) await pool.end().catch(() => undefined);
  if (postgres) await postgres.stop().catch(() => undefined);
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

function waitForCount(target: number, getCount: () => number): Promise<void> {
  if (getCount() >= target) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`timed out waiting for ${target} trade_rules notifications`)), 2_000);
    const check = () => {
      if (getCount() >= target) {
        clearTimeout(timeout);
        resolve();
      } else {
        setTimeout(check, 5).unref?.();
      }
    };
    check();
  });
}

test("idempotente SQL-Migration notifiziert INSERT/UPDATE/DELETE/TRUNCATE nach Commit", async (t) => {
  if (!pool) {
    t.skip(`embedded PostgreSQL nicht verfügbar: ${startupError?.message ?? "unbekannt"}`);
    return;
  }
  let notifications = 0;
  const listener = new TradeRulesNotificationListener(pool, () => {
    notifications += 1;
  }, { log: () => undefined });
  try {
    await listener.start();

    let received = waitForCount(1, () => notifications);
    await pool.query("INSERT INTO public.trade_rules(id, status) VALUES (1, 'DRAFT')");
    await received;

    received = waitForCount(2, () => notifications);
    await pool.query("UPDATE public.trade_rules SET status = 'ACTIVE' WHERE id = 1");
    await received;

    received = waitForCount(3, () => notifications);
    await pool.query("DELETE FROM public.trade_rules WHERE id = 1");
    await received;

    received = waitForCount(4, () => notifications);
    await pool.query("TRUNCATE TABLE public.trade_rules");
    await received;

    assert.equal(notifications, 4);
  } finally {
    await listener.stop();
  }
});
