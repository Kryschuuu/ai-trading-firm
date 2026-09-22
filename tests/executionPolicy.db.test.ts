/**
 * Tests: Execution-Policy — Postgres-Persistenz (RMA-P4-02, v1.70.0).
 *
 * Über eingebettetes Postgres (Port 55448, exklusiv für diese Datei):
 *   - Idempotente Migration (zweifach ausführbar, append-only)
 *   - Roundtrip über den ECHTEN Persistenzpfad (create/mutate/Listen)
 *   - Idempotenz (Key-Duplikat, Fill-Duplikat ⇒ keine Doppelzeilen)
 *   - Neustart-Rekonstruktion über eine frische Store-Instanz
 *   - Optimistic Locking (stale Version ⇒ Konflikt, kein Teilzustand)
 *   - CHECK-Constraints auf DB-Ebene (Zustände, Key-Formate, Zeit-Semantik)
 *   - Overfill ⇒ Fehler ohne Teilzustand
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Pool as PoolType } from "pg";

import EmbeddedPostgres from "embedded-postgres";
import { Pool } from "pg";

import { DEFAULT_EXECUTION_POLICY } from "../src/execution/policy";
import {
  ExecutionStoreConflict,
  ExecutionStoreError,
  PostgresExecutionStore,
  buildWorkflowEventId,
  buildWorkflowKey,
  type WorkflowEventInput,
} from "../src/execution/store";

const PG_PORT = 55_448;
const DB_NAME = "execpolicy_test";
const NOW = 1_750_000_000_000;

function eventInput(over: Partial<WorkflowEventInput> = {}): WorkflowEventInput {
  return {
    toState: "SUBMITTED",
    reason: "SUBMIT_POST_ONLY",
    eventTime: NOW,
    availableAt: NOW,
    computedAt: NOW,
    ...over,
  };
}

describe("execution_workflows (Postgres): Migration, Roundtrip, Idempotenz, Constraints", () => {
  let pg: EmbeddedPostgres | null = null;
  let pool: PoolType | null = null;
  let startupError: Error | null = null;
  const logs: string[] = [];

  function store(): PostgresExecutionStore {
    assert.ok(pool);
    return new PostgresExecutionStore(pool);
  }

  before(async () => {
    try {
      const dir = mkdtempSync(path.join(tmpdir(), "execpolicy-pg-"));
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

      const adminPool = new Pool({ user: "postgres", password: "postgres", host: "127.0.0.1", port: PG_PORT, database: "postgres" });
      await adminPool.query(`CREATE DATABASE ${DB_NAME}`);
      await adminPool.end();

      pool = new Pool({ user: "postgres", password: "postgres", host: "127.0.0.1", port: PG_PORT, database: DB_NAME });
      const migration = readFileSync(path.join(process.cwd(), "drizzle/2026-09-22_post_only_fallback.sql"), "utf8");
      // Idempotenz: zweimaliges Einspielen muss gelingen.
      await pool.query(migration);
      await pool.query(migration);
    } catch (e) {
      startupError = e instanceof Error ? e : new Error(String(e));
    }
  });

  after(async () => {
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
    pool = null;
    pg = null;
  });

  function requirePg(): void {
    assert.ok(!startupError, `embedded Postgres fehlgeschlagen: ${startupError?.message}\n${logs.slice(-5).join("\n")}`);
    assert.ok(pool);
  }

  it("Migration ist idempotent und legt alle Tabellen/Indizes an", async () => {
    requirePg();
    const tables = await pool!.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'execution_%' ORDER BY tablename"
    );
    assert.deepEqual(
      tables.rows.map((r) => r.tablename),
      ["execution_workflow_events", "execution_workflow_fills", "execution_workflows"]
    );
  });

  it("Roundtrip: create → mutate (Transition + Fills + Event) → loadByKey", async () => {
    requirePg();
    const s = store();
    const key = buildWorkflowKey({ venue: "PAPER", mode: "paper", symbol: "BTC", side: "LONG", targetQty: 1, seed: "db-roundtrip" });
    const { record: created, created: isNew } = await s.create({
      workflowKey: key,
      venue: "PAPER",
      mode: "paper",
      symbol: "BTC",
      side: "LONG",
      targetQty: 1,
      policy: { ...DEFAULT_EXECUTION_POLICY },
      policyVersion: DEFAULT_EXECUTION_POLICY.policyVersion,
      clientOrderBase: "eoc1:testbase",
      hasStopLoss: true,
      limitPrice: 99.95,
      now: NOW,
    });
    assert.equal(isNew, true);
    assert.equal(created.state, "NEW");
    assert.equal(created.version, 1);
    assert.equal(created.hasStopLoss, true);

    const next = await s.mutate(created.id, 1, {
      patch: { state: "SUBMITTED", activeOrderId: "paper-1", activeClientOrderId: "eoc1:testbaseL0", submittedAt: NOW },
      event: eventInput({ orderId: "paper-1", clientOrderId: "eoc1:testbaseL0", quoteMid: 100, spreadBps: 2 }),
      newFills: [
        { fillId: "f1", orderId: "paper-1", qty: 0.4, price: 99.95, feeQuote: 0.01, eventTime: NOW, availableAt: NOW },
        { fillId: "f2", orderId: "paper-1", qty: 0.1, price: 99.95, feeQuote: null, eventTime: NOW, availableAt: NOW },
      ],
    });
    assert.equal(next.state, "SUBMITTED");
    assert.equal(next.version, 2);
    assert.equal(next.filledQty, 0.5);
    // Ein Fill mit unbekannter Gebühr ⇒ Summe NULL (unbekannt ≠ 0).
    assert.equal(next.feeQuoteTotal, null);

    const loaded = await s.loadByKey(key);
    assert.ok(loaded);
    assert.equal(loaded.id, created.id);
    assert.equal(loaded.version, 2);
    assert.equal(loaded.filledQty, 0.5);
    assert.equal(loaded.feeQuoteTotal, null);
    assert.equal(loaded.policyVersion, DEFAULT_EXECUTION_POLICY.policyVersion);
    assert.deepEqual(loaded.policy, { ...DEFAULT_EXECUTION_POLICY });
    assert.equal(loaded.hasStopLoss, true);

    const events = await s.listEvents(created.id);
    assert.equal(events.length, 1);
    assert.equal(events[0].seq, 1);
    assert.equal(events[0].fromState, "NEW");
    assert.equal(events[0].toState, "SUBMITTED");
    assert.match(events[0].eventId, /^eoe1:[0-9a-f]{64}$/);

    const fills = await s.listFills(created.id);
    assert.equal(fills.length, 2);
    assert.equal(fills[0].fillId, "f1");
    assert.equal(fills[1].feeQuote, null);
  });

  it("Idempotenz: Key-Duplikat und Fill-Duplikat erzeugen keine Doppelzeilen", async () => {
    requirePg();
    const s = store();
    const key = buildWorkflowKey({ venue: "PAPER", mode: "paper", symbol: "BTC", side: "LONG", targetQty: 1, seed: "db-idem" });
    const input = {
      workflowKey: key,
      venue: "PAPER" as const,
      mode: "paper" as const,
      symbol: "BTC",
      side: "LONG" as const,
      targetQty: 1,
      policy: { ...DEFAULT_EXECUTION_POLICY },
      policyVersion: DEFAULT_EXECUTION_POLICY.policyVersion,
      clientOrderBase: "eoc1:idem",
      hasStopLoss: false,
      limitPrice: null,
      now: NOW,
    };
    const first = await s.create(input);
    const second = await s.create(input);
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(first.record.id, second.record.id);
    const count = await pool!.query("SELECT COUNT(*)::int AS n FROM execution_workflows WHERE workflow_key = $1", [key]);
    assert.equal(count.rows[0].n, 1);

    // Fill erneut melden ⇒ ON CONFLICT DO NOTHING, keine Dublette.
    await s.mutate(first.record.id, 1, {
      patch: { state: "SUBMITTED" },
      event: eventInput(),
      newFills: [{ fillId: "dup", orderId: "o", qty: 0.2, price: 100, feeQuote: 0, eventTime: NOW, availableAt: NOW }],
    });
    await s.mutate(first.record.id, 2, {
      patch: {},
      event: eventInput({ toState: "SUBMITTED", reason: "FILLS_RECONCILED" }),
      newFills: [{ fillId: "dup", orderId: "o", qty: 0.2, price: 100, feeQuote: 0, eventTime: NOW, availableAt: NOW }],
    });
    const fills = await s.listFills(first.record.id);
    assert.equal(fills.length, 1);
    const loaded = await s.loadById(first.record.id);
    assert.equal(loaded?.filledQty, 0.2);
  });

  it("Neustart: frische Store-Instanz rekonstruiert Zustand, Events und Fills", async () => {
    requirePg();
    const key = buildWorkflowKey({ venue: "PAPER", mode: "paper", symbol: "BTC", side: "LONG", targetQty: 2, seed: "db-restart" });
    const writer = store();
    const { record } = await writer.create({
      workflowKey: key,
      venue: "PAPER",
      mode: "paper",
      symbol: "BTC",
      side: "SHORT",
      targetQty: 2,
      policy: { ...DEFAULT_EXECUTION_POLICY },
      policyVersion: DEFAULT_EXECUTION_POLICY.policyVersion,
      clientOrderBase: "eoc1:restart",
      hasStopLoss: true,
      limitPrice: 101,
      now: NOW,
    });
    await writer.mutate(record.id, 1, {
      patch: { state: "SUBMITTED", attempt: 0, submittedAt: NOW },
      event: eventInput(),
    });

    // „Neustart“: neue Store-Instanz, dieselbe DB.
    const reader = new PostgresExecutionStore(pool!);
    const open = await reader.listOpen(10);
    assert.ok(open.some((r) => r.id === record.id));
    const loaded = await reader.loadById(record.id);
    assert.ok(loaded);
    assert.equal(loaded.state, "SUBMITTED");
    assert.equal(loaded.version, 2);
    assert.equal(loaded.side, "SHORT");
    assert.equal(loaded.targetQty, 2);
    assert.equal((await reader.listEvents(record.id)).length, 1);
  });

  it("Optimistic Locking: stale Version ⇒ Konflikt, kein Teilzustand", async () => {
    requirePg();
    const s = store();
    const key = buildWorkflowKey({ venue: "PAPER", mode: "paper", symbol: "BTC", side: "LONG", targetQty: 1, seed: "db-lock" });
    const { record } = await s.create({
      workflowKey: key,
      venue: "PAPER",
      mode: "paper",
      symbol: "BTC",
      side: "LONG",
      targetQty: 1,
      policy: { ...DEFAULT_EXECUTION_POLICY },
      policyVersion: DEFAULT_EXECUTION_POLICY.policyVersion,
      clientOrderBase: "eoc1:lock",
      hasStopLoss: true,
      limitPrice: null,
      now: NOW,
    });
    await s.mutate(record.id, 1, { patch: { state: "SUBMITTED" }, event: eventInput() });
    await assert.rejects(
      s.mutate(record.id, 1, { patch: { state: "ACK" }, event: eventInput({ toState: "ACK", reason: "ORDER_ACK" }) }),
      (e: unknown) => e instanceof ExecutionStoreConflict
    );
    const loaded = await s.loadById(record.id);
    assert.equal(loaded?.version, 2);
    assert.equal(loaded?.state, "SUBMITTED");
    assert.equal((await s.listEvents(record.id)).length, 1);
  });

  it("Overfill ⇒ Fehler ohne Teilzustand (Version und Fills unverändert)", async () => {
    requirePg();
    const s = store();
    const key = buildWorkflowKey({ venue: "PAPER", mode: "paper", symbol: "BTC", side: "LONG", targetQty: 1, seed: "db-overfill" });
    const { record } = await s.create({
      workflowKey: key,
      venue: "PAPER",
      mode: "paper",
      symbol: "BTC",
      side: "LONG",
      targetQty: 1,
      policy: { ...DEFAULT_EXECUTION_POLICY },
      policyVersion: DEFAULT_EXECUTION_POLICY.policyVersion,
      clientOrderBase: "eoc1:overfill",
      hasStopLoss: true,
      limitPrice: null,
      now: NOW,
    });
    await assert.rejects(
      s.mutate(record.id, 1, {
        patch: { state: "SUBMITTED" },
        event: eventInput(),
        newFills: [{ fillId: "big", orderId: "o", qty: 5, price: 100, feeQuote: 0, eventTime: NOW, availableAt: NOW }],
      }),
      (e: unknown) => e instanceof ExecutionStoreError && e.code === "OVERFILL_DETECTED"
    );
    const loaded = await s.loadById(record.id);
    assert.equal(loaded?.version, 1);
    assert.equal(loaded?.state, "NEW");
    assert.equal((await s.listFills(record.id)).length, 0);
    assert.equal((await s.listEvents(record.id)).length, 0);
  });

  it("CHECK-Constraints weisen ungültige Zeilen auf DB-Ebene ab", async () => {
    requirePg();
    const badKey = "kein-key";
    await assert.rejects(
      pool!.query(
        `INSERT INTO execution_workflows
          (workflow_key, venue, mode, symbol, side, target_qty, policy_version, policy_json, client_order_base)
         VALUES ($1,'PAPER','paper','BTC','LONG',1,'eop1:x','{}','eoc1:x')`,
        [badKey]
      ),
      /execution_workflows_key_check/
    );
    const goodKey = `eow1:${"ab".repeat(32)}`;
    const goodPolicy = `eop1:${"cd".repeat(32)}`;
    await assert.rejects(
      pool!.query(
        `INSERT INTO execution_workflows
          (workflow_key, venue, mode, symbol, side, target_qty, policy_version, policy_json, client_order_base, state)
         VALUES ($1,'PAPER','paper','BTC','LONG',1,$2,'{}','eoc1:x','FLIEGEND')`,
        [goodKey, goodPolicy]
      ),
      /execution_workflows_state_check/
    );
    // Zeit-Semantik: event_time > available_at verletzt den CHECK.
    const { record } = await store().create({
      workflowKey: buildWorkflowKey({ venue: "PAPER", mode: "paper", symbol: "BTC", side: "LONG", targetQty: 1, seed: "db-time" }),
      venue: "PAPER",
      mode: "paper",
      symbol: "BTC",
      side: "LONG",
      targetQty: 1,
      policy: { ...DEFAULT_EXECUTION_POLICY },
      policyVersion: DEFAULT_EXECUTION_POLICY.policyVersion,
      clientOrderBase: "eoc1:time",
      hasStopLoss: true,
      limitPrice: null,
      now: NOW,
    });
    const eventId = buildWorkflowEventId({ workflowId: record.id, seq: 1, toState: "SUBMITTED", reason: "X", orderId: null, eventTime: NOW });
    const eventPolicy = `eop1:${"ef".repeat(32)}`;
    await assert.rejects(
      pool!.query(
        `INSERT INTO execution_workflow_events
          (workflow_id, seq, event_id, from_state, to_state, reason, policy_version,
           filled_qty_total, event_time, available_at, computed_at, detail)
         VALUES ($1,1,$2,'NEW','SUBMITTED','X',$6,0,$3,$4,$5,'{}')`,
        [record.id, eventId, new Date(NOW + 1000), new Date(NOW), new Date(NOW), eventPolicy]
      ),
      /execution_workflow_events_time_check/
    );
  });
});
