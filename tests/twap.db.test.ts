/**
 * TWAP-Persistenz gegen eingebettetes Postgres (Port 55449, exklusiv).
 *
 * Migration zweimal, Roundtrip, Idempotenz, Optimistic Lock, append-only
 * Trigger, NULL bleibt NULL, Restart über eine frische Store-Instanz legt
 * keine zweite Kind-Order an.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Pool as PoolType } from "pg";

import EmbeddedPostgres from "embedded-postgres";
import { Pool } from "pg";

import { ExecutionPolicyController } from "../src/execution/controller";
import { PaperVenuePort } from "../src/execution/ports";
import { InMemoryExecutionStore } from "../src/execution/store";
import { controllerChildExecutor } from "../src/execution/twap/child";
import type { DepthBook } from "../src/execution/twap/depth";
import { TwapError } from "../src/execution/twap/errors";
import { buildEvalKey, buildParentKey } from "../src/execution/twap/keys";
import { parseTwapPolicy } from "../src/execution/twap/policy";
import { TwapScheduler } from "../src/execution/twap/scheduler";
import { PostgresTwapStore, type CreateParentInput } from "../src/execution/twap/store";
import { __resetAllSingletonsForTests } from "../src/lib/stateRegistry";
import { killSwitch } from "../src/lib/riskGuard";

const PG_PORT = 55_449;
const DB_NAME = "twap_test";
const NOW = 1_760_000_000_000;

function parentInput(over: Partial<CreateParentInput> = {}): CreateParentInput {
  const policy = parseTwapPolicy({ sliceIntervalMs: 60_000, maxSliceQty: 3, minSliceQty: 3, childTtlMs: 3_600_000 });
  const base: CreateParentInput = {
    parentKey: buildParentKey({
      venue: "PAPER",
      mode: "paper",
      symbol: "BTC",
      side: "LONG",
      targetQty: "9.00000000",
      startAt: NOW,
      deadlineAt: NOW + 180_000,
      seed: "db-seed",
      policyVersion: policy.policyVersion,
    }),
    venue: "PAPER",
    mode: "paper",
    symbol: "BTC",
    side: "LONG",
    targetQty: 9,
    startAt: NOW,
    deadlineAt: NOW + 180_000,
    sliceIntervalMs: 60_000,
    policyVersion: policy.policyVersion,
    policy,
    jitterSeed: "db-seed",
    limitPrice: 101,
    hasStopLoss: true,
    scope: "twap",
    quoteCurrency: "USD",
    quantityStep: 1,
    priceStep: 0.01,
    minQuantity: 1,
    now: NOW,
  };
  return { ...base, ...over };
}

describe("execution_twap (Postgres)", () => {
  let pg: EmbeddedPostgres | null = null;
  let pool: PoolType | null = null;
  let startupError: Error | null = null;
  const logs: string[] = [];

  function store(): PostgresTwapStore {
    assert.ok(pool);
    return new PostgresTwapStore(pool);
  }

  before(async () => {
    __resetAllSingletonsForTests();
    killSwitch.disarm();
    try {
      const dir = mkdtempSync(path.join(tmpdir(), "twap-pg-"));
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
      const admin = new Pool({ user: "postgres", password: "postgres", host: "127.0.0.1", port: PG_PORT, database: "postgres" });
      await admin.query(`CREATE DATABASE ${DB_NAME}`);
      await admin.end();
      pool = new Pool({ user: "postgres", password: "postgres", host: "127.0.0.1", port: PG_PORT, database: DB_NAME });
      const migration = readFileSync(path.join(process.cwd(), "drizzle/2026-09-23_twap_execution.sql"), "utf8");
      await pool.query(migration);
      await pool.query(migration);
    } catch (e) {
      startupError = e instanceof Error ? e : new Error(String(e));
    }
  });

  after(async () => {
    killSwitch.disarm();
    try {
      await pool?.end();
    } catch {
      // Shutdown best-effort.
    }
    try {
      await pg?.stop();
    } catch {
      // Shutdown best-effort.
    }
  });

  function requirePg(): void {
    assert.ok(!startupError, `embedded Postgres fehlgeschlagen: ${startupError?.message}\n${logs.slice(-8).join("\n")}`);
    assert.ok(pool);
  }

  it("Migration ist idempotent und legt die vier Tabellen an", async () => {
    requirePg();
    const tables = await pool!.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'execution_twap%' ORDER BY tablename",
    );
    assert.deepEqual(
      tables.rows.map((r) => r.tablename),
      ["execution_twap_evaluations", "execution_twap_events", "execution_twap_parents", "execution_twap_slices"],
    );
  });

  it("Roundtrip, Idempotenz, Policy-Mismatch und NULL bleiben NULL", async () => {
    requirePg();
    const s = store();
    const input = parentInput();
    const first = await s.createParent(input);
    assert.equal(first.created, true);
    assert.equal(first.record.status, "PLANNED");
    assert.equal(first.record.unscheduledQty, null);
    assert.equal(first.record.arrivalMid, null);
    assert.equal(first.record.limitPrice, 101);
    const again = await s.createParent(input);
    assert.equal(again.created, false);
    assert.equal(again.record.id, first.record.id);
    await assert.rejects(
      () => s.createParent({ ...input, policyVersion: "etw1:" + "a".repeat(64) }),
      (e: unknown) => e instanceof TwapError && e.code === "POLICY_MISMATCH",
    );
    const fresh = new PostgresTwapStore(pool!);
    const loaded = await fresh.loadParentByKey(input.parentKey);
    assert.equal(loaded?.id, first.record.id);
    assert.equal(loaded?.filledQty, 0);
  });

  it("Lease, Slice-Claim und Optimistic Lock", async () => {
    requirePg();
    const s = store();
    const { record } = await s.createParent(parentInput({ jitterSeed: "lease", parentKey: buildParentKey({
      venue: "PAPER", mode: "paper", symbol: "ETH", side: "LONG", targetQty: "3.00000000",
      startAt: NOW, deadlineAt: NOW + 180_000, seed: "lease", policyVersion: parseTwapPolicy({}).policyVersion,
    }), symbol: "ETH", targetQty: 3 }));
    const leased = await s.acquireLease(record.id, record.version, "worker-a", "tok-a", NOW, NOW + 30_000);
    assert.ok(leased);
    const stolen = await s.acquireLease(leased.id, leased.version, "worker-b", "tok-b", NOW, NOW + 30_000);
    assert.equal(stolen, null);
    const slices = await s.insertSlices(record.id, [
      { sliceIndex: 0, childKey: "etc1:" + "b".repeat(64), planVersion: 1, targetQty: 3, scheduledAt: NOW },
    ]);
    const claimed = await s.claimSlice(slices[0]!.id, slices[0]!.version, "worker-a", NOW, NOW - 30_000);
    assert.ok(claimed);
    await assert.rejects(
      () => s.updateSlice(claimed.id, claimed.version - 1, { status: "SKIPPED" }),
      (e: unknown) => e instanceof TwapError && e.code === "STORE_CONFLICT",
    );
  });

  it("Events und Evaluationen sind append-only; Duplikat-Eval schreibt nichts", async () => {
    requirePg();
    const s = store();
    const { record } = await s.createParent(parentInput({
      symbol: "SOL",
      jitterSeed: "eval",
      parentKey: buildParentKey({
        venue: "PAPER", mode: "paper", symbol: "SOL", side: "LONG", targetQty: "9.00000000",
        startAt: NOW, deadlineAt: NOW + 180_000, seed: "eval", policyVersion: parseTwapPolicy({}).policyVersion,
      }),
    }));
    const event = await s.appendEvent({
      parentId: record.id,
      eventId: "ete1:" + "c".repeat(64),
      kind: "PLAN",
      reason: "PLANNED",
      fromStatus: null,
      toStatus: "PLANNED",
      detail: { note: "db" },
      eventTime: NOW,
      availableAt: NOW,
      computedAt: NOW,
      policyVersion: record.policyVersion,
    });
    assert.equal(event.seq, 1);
    await assert.rejects(() => pool!.query("UPDATE execution_twap_events SET reason = 'NO' WHERE id = $1", [event.id]));
    await assert.rejects(() => pool!.query("DELETE FROM execution_twap_events WHERE id = $1", [event.id]));
    const evalKey = buildEvalKey(record.parentKey, NOW, "0.00000000", "PLANNED");
    const saved = await s.saveEvaluation({
      parentId: record.id,
      evalKey,
      asOf: NOW,
      computedAt: NOW,
      completion: 0,
      durationMs: null,
      coverage: null,
      twapShortfallBps: null,
      immediateShortfallBps: null,
      shortfallVsImmediateBps: null,
      arrivalPrice: null,
      twapVwap: null,
      immediateVwap: null,
      filledQty: 0,
      targetQty: 9,
      reason: "NO_FILLS",
      detail: {},
    });
    assert.equal(saved.inserted, true);
    const retry = await s.saveEvaluation({
      parentId: record.id,
      evalKey,
      asOf: NOW,
      computedAt: NOW,
      completion: 1,
      durationMs: 1,
      coverage: 1,
      twapShortfallBps: 1,
      immediateShortfallBps: 1,
      shortfallVsImmediateBps: 1,
      arrivalPrice: 1,
      twapVwap: 1,
      immediateVwap: 1,
      filledQty: 9,
      targetQty: 9,
      reason: "OK",
      detail: {},
    });
    assert.equal(retry.inserted, false);
    const latest = await s.latestEvaluation(record.id);
    assert.equal(latest?.twapShortfallBps, null);
    assert.equal(latest?.durationMs, null);
    assert.equal(latest?.reason, "NO_FILLS");
  });

  it("ungültiger Parent-Key wird von der Datenbank abgewiesen", async () => {
    requirePg();
    await assert.rejects(() =>
      pool!.query(
        `INSERT INTO execution_twap_parents (parent_key, venue, mode, symbol, side, target_qty, start_at, deadline_at, slice_interval_ms, policy_version, policy_json, quantity_step, price_step, min_quantity)
         VALUES ('not-a-key', 'PAPER', 'paper', 'BTC', 'LONG', 1, to_timestamp($1/1000.0), to_timestamp($2/1000.0), 60000, $3, '{}'::jsonb, 1, 0.01, 1)`,
        [NOW, NOW + 60_000, "etw1:" + "d".repeat(64)],
      ),
    );
  });

  it("Restart über eine frische Store-Instanz sendet das Kind nicht erneut", async () => {
    requirePg();
    __resetAllSingletonsForTests();
    killSwitch.disarm();
    let now = NOW;
    const exec = new InMemoryExecutionStore();
    const port = new PaperVenuePort({ venue: "PAPER", now: () => now });
    let places = 0;
    const raw = port.placeLimitOrder.bind(port);
    port.placeLimitOrder = async (args) => {
      places += 1;
      return raw(args);
    };
    const book = (): DepthBook => ({
      bids: [{ price: 99.99, qty: 500 }],
      asks: [{ price: 100.01, qty: 500 }],
      eventTime: now,
      availableAt: now,
      observedVolume: 500,
      volumeEventTime: now,
      volumeAvailableAt: now,
    });
    port.setQuote("BTC", { bid: 99.99, ask: 100.01, mid: 100, ts: now });
    const quote = () => ({ mid: 100, bid: 99.99, ask: 100.01, spread: 0.0002, eventTime: now, availableAt: now });
    const make = () => {
      const controller = new ExecutionPolicyController({
        store: exec,
        ports: new Map([["PAPER", port]]),
        getQuote: async () => quote(),
        getAccount: async () => ({ equity: 10_000, openPositions: 0 }),
        getInstrument: () => ({ quantityStep: 1, priceStep: 0.01, minQuantity: 1 }),
        now: () => now,
        audit: async () => {},
      });
      return new TwapScheduler({
        store: new PostgresTwapStore(pool!),
        executor: controllerChildExecutor(controller, (id) => exec.listFills(id)),
        getBook: async () => book(),
        now: () => now,
        isKilled: () => false,
        isMarketOpen: () => true,
        isVenueConnected: () => true,
      });
    };
    const parent = await make().start({
      venue: "PAPER",
      mode: "paper",
      symbol: "BTC",
      side: "LONG",
      targetQty: 9,
      startAt: NOW,
      deadlineAt: NOW + 180_000,
      seed: "restart-db",
      policy: { sliceIntervalMs: 60_000, minSliceQty: 3, maxSliceQty: 3, maxParticipation: 1, childTtlMs: 3_600_000, maxBookAgeMs: 5_000 },
      limitPrice: 101,
      hasStopLoss: true,
      quantityStep: 1,
      priceStep: 0.01,
      minQuantity: 1,
    });
    const first = await make().tick(parent.id, "worker-a");
    assert.equal(first.submitted, true, first.reason);
    assert.equal(places, 1);
    const second = await make().tick(parent.id, "worker-b");
    assert.equal(second.submitted, false);
    assert.equal(places, 1);
    const slices = await new PostgresTwapStore(pool!).listSlices(parent.id);
    const live = slices.filter((s) => s.workflowId);
    assert.equal(live.length, 1);
    assert.equal(new Set(live.map((s) => s.childKey)).size, 1);
  });
});
