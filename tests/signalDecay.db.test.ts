/**
 * RMA-P5-05: Persistenz von Entry-Snapshot, Hysterese und Events.
 * embedded-postgres, Port 55447. Skip, wenn die Binary nicht startet.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { Pool } from "pg";

import {
  SIGNAL_CONTRACT_VERSION,
  SIGNAL_CONFIG_VERSION,
  SIGNAL_FEATURE_VERSION,
  SIGNAL_MODEL_VERSION,
  SIGNAL_SEMANTICS_VERSION,
  evaluateSignalDecay,
  type SignalSnapshot,
} from "../src/lib/signalDecay";
import {
  commitSignalDecay,
  createPgSignalDecayStore,
  persistClosedEntrySignal,
  resetSignalDecayRuntimeForTests,
} from "../src/lib/signalDecayRuntime";

const PG_PORT = 55_447;
const DB_NAME = "signal_decay_test";
const POSITION_ID = "11111111-1111-4111-8111-111111111111";

let pg: EmbeddedPostgres | null = null;
let pool: Pool | null = null;
let startupError: Error | null = null;

function snapshot(availableAt: string, strength: number, direction: "LONG" | "SHORT"): SignalSnapshot {
  return {
    contractVersion: SIGNAL_CONTRACT_VERSION,
    semanticsVersion: SIGNAL_SEMANTICS_VERSION,
    featureVersion: SIGNAL_FEATURE_VERSION,
    modelVersion: SIGNAL_MODEL_VERSION,
    configVersion: SIGNAL_CONFIG_VERSION,
    direction,
    strength,
    confidence: 0.9,
    calculatedAsOf: availableAt,
    availableAt,
    computedAt: availableAt,
    coverage: 1,
    strategyClass: "trend",
    migrationId: null,
  };
}

describe("Signal-Decay Persistenz (RMA-P5-05)", () => {
  before(async () => {
    try {
      process.env.AUDIT_SPOOL_DIR = mkdtempSync(path.join(tmpdir(), "sd-audit-"));
      process.env.AUDIT_RETRY_MAX = "0";
      process.env.SIGNAL_DECAY_MODE = "monitor";
      process.env.SIGNAL_DECAY_CLASS_TREND = "true";
      resetSignalDecayRuntimeForTests();

      const dir = mkdtempSync(path.join(tmpdir(), "sd-pg-"));
      const instance = new EmbeddedPostgres({
        databaseDir: dir,
        user: "postgres",
        password: "postgres",
        port: PG_PORT,
        persistent: false,
      });
      await instance.initialise();
      await instance.start();
      pg = instance;

      const admin = new Pool({
        user: "postgres",
        password: "postgres",
        host: "127.0.0.1",
        port: PG_PORT,
        database: "postgres",
      });
      await admin.query(`CREATE DATABASE ${DB_NAME}`);
      await admin.end();

      pool = new Pool({
        user: "postgres",
        password: "postgres",
        host: "127.0.0.1",
        port: PG_PORT,
        database: DB_NAME,
      });
      await pool.query(`
        CREATE TABLE positions (
          id uuid PRIMARY KEY,
          symbol text NOT NULL,
          side text NOT NULL,
          qty numeric NOT NULL,
          entry_price numeric NOT NULL,
          status text NOT NULL DEFAULT 'OPEN',
          realized_pnl numeric,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      const sql = readFileSync(path.join(process.cwd(), "drizzle", "2026-09-22_signal_decay.sql"), "utf8");
      await pool.query(sql);
      await pool.query(sql);
      await pool.query(
        `INSERT INTO positions (id, symbol, side, qty, entry_price, status) VALUES ($1, 'BTCUSDT', 'LONG', 1, 100, 'OPEN')`,
        [POSITION_ID],
      );
    } catch (e) {
      startupError = e instanceof Error ? e : new Error(String(e));
    }
  });

  after(async () => {
    resetSignalDecayRuntimeForTests();
    delete process.env.SIGNAL_DECAY_MODE;
    delete process.env.SIGNAL_DECAY_CLASS_TREND;
    if (pool) await pool.end().catch(() => {});
    if (pg) await pg.stop().catch(() => {});
  });

  it("Entry-Snapshot ist einmalig und danach unveränderlich", async (t) => {
    if (!pool) return t.skip(startupError?.message ?? "Postgres nicht gestartet");
    const asOf = Date.parse("2026-09-22T12:00:00.000Z");
    const first = await persistClosedEntrySignal({
      positionId: POSITION_ID,
      symbol: "BTCUSDT",
      strategyClass: "trend",
      asOfMs: asOf,
      barDurationMs: 3_600_000,
      timeBasis: "close",
      candles: Array.from({ length: 30 }, (_, i) => ({
        time: asOf - (30 - i) * 3_600_000,
        open: 100 + i * 0.2,
        high: 101 + i * 0.2,
        low: 99 + i * 0.2,
        close: 100 + i * 0.2,
      })),
      pool,
    });
    assert.equal(first, "written");
    const second = await persistClosedEntrySignal({
      positionId: POSITION_ID,
      symbol: "BTCUSDT",
      strategyClass: "trend",
      asOfMs: asOf + 3_600_000,
      barDurationMs: 3_600_000,
      timeBasis: "close",
      candles: Array.from({ length: 30 }, (_, i) => ({
        time: asOf - (30 - i) * 3_600_000,
        open: 80,
        high: 81,
        low: 79,
        close: 80,
      })),
      pool,
    });
    assert.equal(second, "exists");
    await assert.rejects(
      pool.query(`UPDATE positions SET entry_signal = '{"tampered":true}'::jsonb WHERE id = $1`, [POSITION_ID]),
      /immutable/,
    );
  });

  it("Bestätigung überlebt einen neuen Store; Retry schreibt kein zweites Event", async (t) => {
    if (!pool) return t.skip(startupError?.message ?? "Postgres nicht gestartet");
    const store = createPgSignalDecayStore(pool);
    const state = await store.readState(POSITION_ID);
    assert.ok(state);
    const asOf = Date.parse("2026-09-22T15:00:00.000Z");
    const entry = state?.entrySignal ?? snapshot(new Date(asOf - 3_600_000).toISOString(), 0.8, "LONG");
    const current = snapshot(new Date(asOf).toISOString(), 0.2, "LONG");
    const config = (await import("../src/lib/signalDecay")).resolveSignalDecayConfig({
      mode: "monitor",
      classes: { trend: { enabled: true, confirmationCount: 1, minHoldMs: 0, halfLifeMs: null } },
    });
    const evaluation = evaluateSignalDecay({
      entry,
      current,
      openedAtMs: asOf - 3_600_000,
      asOfMs: asOf,
      side: "LONG",
      qty: 1,
      entryPrice: 100,
      markPrice: 101,
      strategyClass: "trend",
      confirmation: {
        streak: state?.streak ?? 0,
        lastObservationKey: state?.lastKey ?? null,
        policyVersion: state?.policyVersion ?? null,
      },
      mode: "monitor",
      config,
      killSwitchArmed: false,
    });
    assert.equal(evaluation.wouldExit, true);
    assert.ok(evaluation.audit);
    const first = await commitSignalDecay({
      store,
      positionId: POSITION_ID,
      evaluation,
      audit: evaluation.audit,
      expected: { lastKey: state?.lastKey ?? null, policyVersion: state?.policyVersion ?? null },
      asOfMs: asOf,
      entrySignalHash: null,
      confirmationRequired: 1,
    });
    assert.equal(first.event, "written");
    const retry = await commitSignalDecay({
      store,
      positionId: POSITION_ID,
      evaluation,
      audit: evaluation.audit,
      expected: { lastKey: state?.lastKey ?? null, policyVersion: state?.policyVersion ?? null },
      asOfMs: asOf,
      entrySignalHash: null,
      confirmationRequired: 1,
    });
    assert.notEqual(retry.event, "written");
    const restarted = await createPgSignalDecayStore(pool).readState(POSITION_ID);
    assert.equal(restarted?.streak, evaluation.streak);
    assert.equal(restarted?.lastKey, evaluation.observationKey);
    const count = await pool.query(`SELECT count(*)::int AS n FROM signal_decay_events WHERE position_id = $1`, [POSITION_ID]);
    assert.equal(count.rows[0]?.n, 1);
    await assert.rejects(pool.query(`DELETE FROM signal_decay_events`), /append-only/);
  });
});
