import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  captureOrder,
  type CaptureStore,
} from "../src/executionQuality/runtime";
import { insertQualityBatch } from "../src/executionQuality/transaction";
import { newIntent } from "../src/executionQuality/capture";
import { evidenceEvents } from "../src/executionQuality/reconcile";
import { summarize } from "../src/executionQuality/model";
import type { BrokerOrderResult } from "../src/contracts/broker";
import { pool as applicationPool } from "../src/db";
import { ExecutionQualityStore } from "../src/executionQuality/store";
import { fixture } from "./fixtures/executionQuality";
let pg: EmbeddedPostgres;
let pool: Pool;
let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "execution-quality-pg-"));
  pg = new EmbeddedPostgres({
    databaseDir: dir,
    user: "postgres",
    password: "postgres",
    port: 55439,
    persistent: false,
    onLog: () => {},
    onError: () => {},
  });
  await pg.initialise();
  await pg.start();
  pool = new Pool({
    host: "127.0.0.1",
    port: 55439,
    user: "postgres",
    password: "postgres",
    database: "postgres",
  });
  const sql = await readFile(
    "drizzle/2026-09-20_execution_quality.sql",
    "utf8",
  );
  await pool.query(sql);
  await pool.query(sql);
  for (const file of ["capture", "quotes", "integrity", "completion"]) {
    const migration = await readFile(
      `drizzle/2026-09-21_execution_quality_${file}.sql`,
      "utf8",
    );
    await pool.query(migration);
    await pool.query(migration);
  }
  process.env.DATABASE_URL =
    "postgresql://postgres:postgres@127.0.0.1:55439/postgres";
  await pool.query(`CREATE TABLE positions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),symbol text NOT NULL,status text NOT NULL);
    CREATE TABLE order_intents(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),account text NOT NULL DEFAULT 'PAPER',symbol text NOT NULL,side text NOT NULL,qty numeric NOT NULL,status text NOT NULL DEFAULT 'RESERVED',reason text,created_at timestamptz NOT NULL DEFAULT now());
    CREATE UNIQUE INDEX order_intents_reserved_symbol_unique ON order_intents(symbol) WHERE status='RESERVED'`);
});
after(async () => {
  await applicationPool.end();
  if (pool) await pool.end();
  if (pg) await pg.stop();
  if (dir) await rm(dir, { recursive: true, force: true });
});
test("migration, concurrent retry, roundtrip, restart, append-only and atomic conflicts", async () => {
  const first = new ExecutionQualityStore(pool),
    b = fixture();
  const results = await Promise.all([first.append(b), first.append(b)]);
  assert.equal(
    results.reduce((s, r) => s + r.inserted, 0),
    5,
  );
  const restarted = new ExecutionQualityStore(pool);
  assert.equal((await restarted.append(b)).inserted, 0);
  const out = await restarted.report(0, 20000, 20000);
  assert.equal(out.orderCount, 1);
  assert.equal(out.groups[0].fillCount, 2);
  const past = await restarted.report(0, 11500, 12000);
  assert.equal(past.groups[0].fillCount, 1);
  await assert.rejects(
    () => pool.query("UPDATE execution_quality_events SET kind='fill'"),
    /append-only/,
  );
  await assert.rejects(
    () => pool.query("DELETE FROM execution_quality_intents"),
    /append-only/,
  );
  const conflict = fixture();
  conflict.intent.quantity = 11;
  await assert.rejects(() => restarted.append(conflict), /INTENT_CONFLICT/);
  const duplicate = fixture();
  duplicate.intent.id = "intent-2";
  duplicate.intent.clientOrderId = "client-2";
  duplicate.events = duplicate.events.map((e) => ({
    ...e,
    intentId: "intent-2",
  }));
  await assert.rejects(() => restarted.append(duplicate), /unique constraint/);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM execution_quality_intents",
      )
    ).rows[0].n,
    1,
  );
  assert.deepEqual(await restarted.report(0, 20000, 20000), out);
  const fill = b.events.find((e) => e.kind === "fill")!;
  await assert.rejects(
    () =>
      restarted.append({
        intent: b.intent,
        events: [{ ...fill, fillId: "overfill" }],
      }),
    /OVERFILL/,
  );
});

const request = {
  symbol: "AAPL",
  side: "LONG" as const,
  qty: 10,
  riskNotional: 1000,
  stopLoss: 90,
  orderIntentId: "production-request",
  executionQuality: {
    id: "decision-1",
    at: 1000,
    strategy: "trend",
    quoteCurrency: "USD",
  },
};
const orderResult: BrokerOrderResult = {
  orderId: "venue-order-1",
  symbol: "AAPL",
  side: "LONG",
  qty: 10,
  fillPrice: 101,
  status: "FILLED",
  stopLoss: 90,
  takeProfit: null,
  feesQuote: 1,
};
const audit = async () => undefined;
test("production capture: send once across store restart, receipt replay, request conflict", async () => {
  const store = new ExecutionQualityStore(pool);
  let sends = 0;
  const run = () =>
    captureOrder({
      venue: "ALPACA",
      mode: "paper",
      scope: "db-restart",
      enabled: true,
      request,
      store: new ExecutionQualityStore(pool),
      audit,
      execute: async () => {
        sends++;
        return orderResult;
      },
    });
  await run();
  await run();
  assert.equal(sends, 1);
  const id = newIntent(request, "ALPACA", "paper", "db-restart", Date.now())
    .intent.id;
  const saved = await store.load(id);
  assert.ok(saved);
  assert.equal(summarize(saved.intent, saved.events, Date.now()).fees.value, 1);
  await assert.rejects(
    () =>
      captureOrder({
        venue: "ALPACA",
        mode: "paper",
        scope: "db-restart",
        enabled: true,
        request: { ...request, qty: 11 },
        store,
        audit,
        execute: async () => {
          sends++;
          return orderResult;
        },
      }),
    /SUBMISSION_CONFLICT/,
  );
  assert.equal(sends, 1);
});
test("crash after receipt: retry repairs missing fills without sending again", async () => {
  const store = new ExecutionQualityStore(pool);
  let sends = 0,
    writes = 0;
  const faulty: CaptureStore = {
    load: (id) => store.load(id),
    claim: (id, hash) => store.claim(id, hash),
    receipt: (id) => store.receipt(id),
    saveReceipt: (id, r, at, elapsed) => store.saveReceipt(id, r, at, elapsed),
    append: async (b) => {
      if (++writes === 2) throw new Error("injected");
      return store.append(b);
    },
  };
  const req = { ...request, orderIntentId: "receipt-crash" };
  const common = {
    venue: "ALPACA" as const,
    mode: "paper" as const,
    scope: "receipt-crash",
    enabled: true,
    request: req,
    audit,
    execute: async () => {
      sends++;
      return { ...orderResult, orderId: "receipt-order" };
    },
  };
  await assert.rejects(
    () => captureOrder({ ...common, store: faulty }),
    /RESULT_UNRECORDED/,
  );
  await captureOrder({ ...common, store });
  assert.equal(sends, 1);
  const id = newIntent(req, "ALPACA", "paper", "receipt-crash", Date.now())
    .intent.id;
  const saved = await store.load(id);
  assert.equal(saved?.events.filter((e) => e.kind === "fill").length, 1);
});
test("uncertain submission and concurrent calls cannot cause a second external send", async () => {
  const store = new ExecutionQualityStore(pool),
    req = { ...request, orderIntentId: "uncertain" };
  let sends = 0;
  const run = () =>
    captureOrder({
      venue: "ALPACA",
      mode: "live",
      scope: "uncertain",
      enabled: true,
      request: req,
      store,
      audit,
      execute: async () => {
        sends++;
        throw new Error("wire-disconnect");
      },
    });
  await assert.rejects(run, /wire-disconnect/);
  await assert.rejects(run, /SUBMISSION_UNCERTAIN/);
  assert.equal(sends, 1);
  const base = newIntent(
    { ...request, orderIntentId: "parallel" },
    "ALPACA",
    "live",
    "parallel",
    Date.now(),
  );
  await store.append(base);
  const claims = await Promise.all([
    store.claim(base.intent.id, "a".repeat(64)),
    store.claim(base.intent.id, "a".repeat(64)),
  ]);
  assert.equal(claims.filter(Boolean).length, 1);
});
test("observed partial fills, delayed availability, fee reconciliation and retry roundtrip", async () => {
  const store = new ExecutionQualityStore(pool),
    b = newIntent(
      { ...request, orderIntentId: "venue-evidence" },
      "BITUNIX",
      "live",
      "observed",
      10000,
    );
  await store.append(b);
  const evidence = {
    orderId: "bitunix-1",
    filledQuantity: 4,
    feeQuoteTotal: 0.4,
    fills: [
      { id: "trade-1", quantity: 4, price: 101, feeQuote: 0.4, at: 11000 },
    ],
  };
  await store.append({
    intent: b.intent,
    events: evidenceEvents(b, evidence, 12000),
  });
  const saved = await store.load(b.intent.id);
  assert.ok(saved);
  assert.equal(evidenceEvents(saved, evidence, 15000).length, 0);
  assert.equal(summarize(saved.intent, saved.events, 11500).fillRatio, 0);
  assert.equal(summarize(saved.intent, saved.events, 13000).fillRatio, 0.4);
  assert.throws(
    () => evidenceEvents(saved, { ...evidence, feeQuoteTotal: 0.5 }, 15000),
    /BROKER_FEE_MISMATCH/,
  );
  assert.throws(
    () => evidenceEvents(saved, { ...evidence, filledQuantity: 6 }, 15000),
    /INCOMPLETE_VENUE_FILLS/,
  );
});
test("quote as-of is persisted across restart; late/future quote cannot replace horizon", async () => {
  const store = new ExecutionQualityStore(pool),
    i = fixture().intent;
  await store.sample(i, { mid: 100, eventTime: 12000, availableAt: 12100 });
  await store.sample(i, { mid: 999, eventTime: 12050, availableAt: 16000 });
  const q = await new ExecutionQualityStore(pool).quoteAsOf(i, 13000);
  assert.equal(q?.mid, 100);
  assert.equal(await store.quoteAsOf(i, 11999), null);
  await assert.rejects(
    () => store.sample(i, { mid: 1, eventTime: 100, availableAt: 6000 }),
    /INVALID_QUOTE/,
  );
  await assert.rejects(
    () => pool.query("TRUNCATE execution_quality_quotes"),
    /append-only/,
  );
});
test("parent FK and transaction rollback leave neither business row nor capture behind", async () => {
  const b = fixture();
  b.intent = {
    ...b.intent,
    id: "transaction-child",
    clientOrderId: "transaction-child",
    parentIntentId: "nonexistent-parent",
  };
  b.events = [];
  const database = drizzle(pool);
  await assert.rejects(
    () =>
      database.transaction(async (tx) => {
        await insertQualityBatch(tx, b);
      }),
    /foreign key|Failed query/,
  );
  assert.equal(await new ExecutionQualityStore(pool).load(b.intent.id), null);
});
test("actual PaperBroker submitAtomic persists intent/fill in the position transaction; rollback restores memory", async () => {
  const { PaperBroker } = await import("../src/lib/broker");
  const { killSwitch, resetRuntimeLimits } = await import(
    "../src/lib/riskGuard"
  );
  const oldEnabled = process.env.EXECUTION_QUALITY_ENABLED,
    oldScope = process.env.EXECUTION_QUALITY_SCOPE;
  process.env.EXECUTION_QUALITY_ENABLED = "true";
  process.env.EXECUTION_QUALITY_SCOPE = "core-paper";
  resetRuntimeLimits();
  killSwitch.disarm();
  const broker = new PaperBroker(10000),
    order = {
      symbol: "BTC",
      side: "LONG" as const,
      qty: 0.015,
      riskNotional: 1005,
      stopLoss: 60000,
    };
  try {
    const before = broker.freeCash;
    await assert.rejects(
      () =>
        broker.submitAtomic(order, {
          persistPosition: async () => {
            throw new Error("forced-position-failure");
          },
        }),
      /forced-position-failure/,
    );
    assert.equal(broker.openPositions, 0);
    assert.equal(broker.freeCash, before);
    const decision = {
      id: "core-decision",
      at: Date.now(),
      strategy: "core",
      quoteCurrency: "USD",
    };
    const fill = await broker.submitAtomic(order, {
      executionQuality: decision,
    });
    assert.equal(fill.status, "FILLED");
    const replay = await new PaperBroker(10000).submitAtomic(order, {
      executionQuality: decision,
    });
    assert.equal(replay.orderId, fill.orderId);
    await assert.rejects(
      () =>
        broker.submitAtomic(
          { ...order, qty: 0.016 },
          { executionQuality: decision },
        ),
      /SUBMISSION_CONFLICT/,
    );
    const rows = await pool.query<{
      payload: import("../src/executionQuality/model").Intent;
    }>(
      "SELECT payload FROM execution_quality_intents WHERE scope='core-paper'",
    );
    assert.equal(rows.rows.length, 1);
    const captured = await new ExecutionQualityStore(pool).load(
      rows.rows[0].payload.id,
    );
    assert.ok(captured);
    assert.equal(
      summarize(captured.intent, captured.events, Date.now()).filledQuantity,
      fill.qty,
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int n FROM order_intents WHERE id=$1",
          [captured.intent.id],
        )
      ).rows[0].n,
      1,
    );
  } finally {
    if (oldEnabled === undefined) delete process.env.EXECUTION_QUALITY_ENABLED;
    else process.env.EXECUTION_QUALITY_ENABLED = oldEnabled;
    if (oldScope === undefined) delete process.env.EXECUTION_QUALITY_SCOPE;
    else process.env.EXECUTION_QUALITY_SCOPE = oldScope;
  }
});

test("WalkForward→persistBacktestRun writes quality atomically and replays without duplicate fills", async () => {
  const { runWalkForward } = await import("../src/backtest/walkforward");
  const { persistBacktestRun } = await import("../src/backtest/runStore");
  const { randomUUID } = await import("node:crypto");
  const { ruleSignature } = await import("../src/lib/ruleEngine");
  const old = process.env.EXECUTION_QUALITY_ENABLED;
  process.env.EXECUTION_QUALITY_ENABLED = "true";
  try {
    await pool.query(
      await readFile("drizzle/2026-09-19_backtest_runs.sql", "utf8"),
    );
    await pool.query(
      await readFile("drizzle/2026-09-20_backtest_trades.sql", "utf8"),
    );
    const freezeMigration = await readFile("drizzle/2026-09-22_backtest_walkforward_freezes.sql", "utf8");
    await pool.query(freezeMigration);
    await pool.query(freezeMigration);
    const rule: import("../src/lib/ruleEngine").RuleSpec = {
      name: "quality-rule",
      symbol: "BTC/USDT",
      missionId: null,
      rationale: "fixture",
      sourceRole: "MANUAL",
      riskScore: 0.3,
      condition: {
        logic: "all",
        conditions: [{ field: "price", op: "gt", value: 90 }],
      },
      action: {
        side: "LONG",
        stopLossPct: 5,
        takeProfitRR: 2,
        riskBudgetPct: 0.02,
        maxPositionPct: 0.25,
        positionSizeMode: "risk",
      },
      window: {
        timeframe: "1h",
        validFrom: null,
        validUntil: null,
        maxExecutionsPerDay: 5,
        cooldownMinutes: 0,
        volumeWindow: 20,
      },
    };
    const start = Date.UTC(2024, 0, 1);
    const candles = Array.from({ length: 24 * 5 }, (_, n) => ({
      time: start + n * 3600000,
      open: 100,
      high: 102,
      low: 99,
      close: 101,
      volume: 1000,
    }));
    const report = runWalkForward({
      instrumentId: rule.symbol,
      timeframe: "1h",
      candles,
      engineConfig: { warmupBars: 30 },
      strategies: [{ type: "rule", spec: rule }],
      ruleRef: {
        ruleId: null,
        ruleKey: null,
        name: rule.name,
        signature: ruleSignature(rule),
        ruleSymbol: rule.symbol,
      },
      walkforward: { isDays: 2, oosDays: 1, maxSpanDays: 10 },
      nowMs: start + 10 * 86400000,
    });
    assert.ok(report.executionQuality?.length);
    const result = await persistBacktestRun(
      { report, spec: rule, runId: randomUUID() },
      { db: drizzle(pool), audit },
    );
    assert.equal(result.created, true);
    const ids = report.executionQuality.map((b) => b.intent.id);
    const count = await pool.query(
      "SELECT count(*)::int n FROM execution_quality_intents WHERE id=ANY($1)",
      [ids],
    );
    assert.equal(count.rows[0].n, ids.length);
    const feeRows = await pool.query(
      "SELECT sum((payload->>'feeQuote')::numeric)::float8 total FROM execution_quality_events WHERE kind='fill' AND intent_id=ANY($1)",
      [ids],
    );
    const capturedFees = report.executionQuality.reduce(
      (sum, b) =>
        sum +
        b.events.reduce(
          (sum, e) => sum + (e.kind === "fill" ? (e.feeQuote ?? 0) : 0),
          0,
        ),
      0,
    );
    assert.ok(Math.abs(feeRows.rows[0].total - capturedFees) < 1e-8);
    assert.ok(
      Math.abs(
        capturedFees - (report.aggregateIs.fees + report.aggregateOos.fees),
      ) < 0.1,
      "same simulation fees, rounded trade ledger tolerance",
    );
    const replay = await persistBacktestRun(
      { report, spec: rule, runId: randomUUID() },
      { db: drizzle(pool), audit },
    );
    assert.equal(replay.created, false);
    assert.equal(replay.id, result.id);
  } finally {
    if (old === undefined) delete process.env.EXECUTION_QUALITY_ENABLED;
    else process.env.EXECUTION_QUALITY_ENABLED = old;
  }
});

test("operations worker uses persisted horizon quotes, emits coverage, and retires completed intents", async () => {
  const { reconcileQuality } = await import(
    "../src/executionQuality/reconcile"
  );
  const { synchronousResult } = await import("../src/executionQuality/capture");
  const { PaperBrokerAdapter } = await import("../src/brokers/paper");
  const { PaperBroker } = await import("../src/lib/broker");
  const store = new ExecutionQualityStore(pool),
    b = newIntent(
      { ...request, orderIntentId: "worker" },
      "PAPER",
      "paper",
      "worker",
      10000,
    );
  const complete = synchronousResult(
    b,
    { ...orderResult, orderId: "worker-order" },
    11000,
    1000,
  );
  await store.append(complete);
  for (const at of [11999, 15999, 40999])
    await store.sample(b.intent, { mid: 100, eventTime: at, availableAt: at });
  const adapter = Object.assign(new PaperBrokerAdapter(new PaperBroker()), {
    getExecutionQuote: async () => ({
      symbol: "AAPL",
      bids: [{ price: 98, qty: 1 }],
      asks: [{ price: 100, qty: 1 }],
      ts: 50000,
    }),
  });
  const result = await reconcileQuality(
    adapter,
    "worker",
    "",
    store,
    () => 50000,
    audit,
  );
  assert.equal(result.failures, 0);
  assert.equal(result.captured, 3);
  const saved = await store.load(b.intent.id);
  assert.ok(saved);
  const out = summarize(saved.intent, saved.events, 50000);
  assert.ok(
    out.adverse.every((m) => m.quantityCoverage === 1 && m.bps.value! > 0),
  );
  assert.equal((await store.page("PAPER", "paper", "worker")).length, 0);
  assert.equal(summarize(saved.intent, saved.events, 10999).filledQuantity, 0);
});

test("valid parent/child roundtrip and complete-population API limit", async () => {
  const store = new ExecutionQualityStore(pool),
    child = fixture();
  child.intent = {
    ...child.intent,
    id: "child-1",
    clientOrderId: "child-1",
    parentIntentId: "intent-1",
  };
  child.events = [];
  await store.append(child);
  assert.equal(
    (await store.load("child-1"))?.intent.parentIntentId,
    "intent-1",
  );
  const at = Date.UTC(2099, 0, 1),
    base = {
      ...fixture().intent,
      decisionAt: at,
      submitAt: at,
      computedAt: at,
      scope: "limit",
    };
  await pool.query(
    `INSERT INTO execution_quality_intents(id,venue,mode,scope,client_order_id,submit_at,payload)
    SELECT 'limit-'||n,'PAPER','paper','limit','limit-'||n,$1, $2::jsonb || jsonb_build_object('id','limit-'||n,'clientOrderId','limit-'||n) FROM generate_series(1,501) n`,
    [new Date(at), base],
  );
  await assert.rejects(() => store.report(at, at + 1, at + 1), /REPORT_LIMIT/);
});
