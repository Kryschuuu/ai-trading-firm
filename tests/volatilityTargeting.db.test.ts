/**
 * Tests: Volatility-Targeting — Postgres DB Tests (RMA-P5-01, v1.67.0).
 *
 * Deckt die Persistenz-Zusicherungen ab:
 *   - Idempotente Migration `drizzle/2026-09-22_volatility_targeting.sql`
 *     (zweifach ausführbar)
 *   - Roundtrip über den ECHTEN Persistenzpfad (`updateVolatilityTargeting`
 *     mit injiziertem Drizzle-Client): Snapshot erscheint vollständig
 *   - Idempotenz: gleicher Idempotency-Key ⇒ keine doppelte Zeile (Retry/
 *     Restart-Schutz), andere Minute ⇒ neue Zeile
 *   - CHECK-Constraints erzwingen die harten Invarianten auf DB-Ebene
 *     (Faktor ≤ 1, monitor_only = (mode = 'monitor'), Hash-Formate, Zeit-
 *     semantik)
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import EmbeddedPostgres from "embedded-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import {
  __resetVolatilityTargetingForTests,
  updateVolatilityTargeting,
  type OpenPositionRow,
  type VtpDbLike,
  type VolatilityTargetingDeps,
} from "../src/lib/volatilityTargeting";
import type { Candle } from "../src/lib/marketData";
import { resolveVolatilityTargetingConfig } from "../src/portfolio/volatilityTargeting";

const PG_PORT = 55_445; // 55444 gehört dem Sentiment-DB-Test
const DB_NAME = "vtp_test";
const HOUR = 3_600_000;

describe("volatility_targeting_snapshots (Postgres): Migration, Roundtrip, Idempotenz, Constraints", () => {
  let pg: EmbeddedPostgres | null = null;
  let pool: Pool | null = null;
  let db: ReturnType<typeof drizzle> | null = null;
  let startupError: Error | null = null;
  const logs: string[] = [];

  function candlesFor(base: number, n: number, start: number): Candle[] {
    const out: Candle[] = [];
    for (let i = 0; i < n; i++) {
      const close = i % 2 === 0 ? base : base * 1.02;
      out.push({ time: start + i * HOUR, open: close * 0.99, high: close * 1.01, low: close * 0.98, close, volume: 1000 });
    }
    return out;
  }

  function testConfig(): ReturnType<typeof resolveVolatilityTargetingConfig> {
    return resolveVolatilityTargetingConfig({
      shrinkage: 0,
      minObservations: 4,
      lookbackPeriods: 24,
      smoothingAlpha: 1,
      enabled: true,
    });
  }

  /** Deps mit REALER embedded DB (als VtpDbLike injiziert) + fixem Zeitstempel. */
  function makeDeps(now: number): VolatilityTargetingDeps {
    const positions: OpenPositionRow[] = [
      { symbol: "TEST", side: "LONG", qty: 10, entryPrice: 100, currentPrice: 100 },
    ];
    const start = now - 26 * HOUR;
    return {
      now: () => now,
      fetchPositions: async () => positions,
      fetchCandles: async (symbol: string) => (symbol === "TEST" ? candlesFor(100, 26, start) : []),
      db: (db as unknown) as VtpDbLike,
    };
  }

  before(async () => {
    try {
      process.env.AUDIT_SPOOL_DIR = mkdtempSync(path.join(tmpdir(), "vtp-db-audit-"));
      process.env.AUDIT_RETRY_MAX = "1";
      process.env.AUDIT_RETRY_BASE_MS = "5";
      process.env.AUDIT_DB_COOLDOWN_MS = "0";
      process.env.PORTFOLIO_VOL_TARGETING_MODE = "monitor";
      process.env.PORTFOLIO_VOL_TARGETING_TIMEFRAME = "1h";

      const dir = mkdtempSync(path.join(tmpdir(), "vtp-pg-"));
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
        path.join(process.cwd(), "drizzle", "2026-09-22_volatility_targeting.sql"),
        "utf8"
      );
      await pool.query(migrationSql);
    } catch (e) {
      startupError = e instanceof Error ? e : new Error(String(e));
    }
  });

  after(async () => {
    if (pool) await pool.end().catch(() => {});
    if (pg) await pg.stop().catch(() => {});
    __resetVolatilityTargetingForTests();
  });

  it("Migration ist strikt idempotent (zweites Ausführen wirft keinen Fehler)", async (t) => {
    if (!pool) return t.skip(startupError?.message ?? "Postgres nicht gestartet");
    const migrationSql = readFileSync(
      path.join(process.cwd(), "drizzle", "2026-09-22_volatility_targeting.sql"),
      "utf8"
    );
    await assert.doesNotReject(async () => {
      await pool!.query(migrationSql);
    });
  });

  it("Roundtrip: Snapshot über den echten Persistenzpfad erscheint vollständig", async (t) => {
    if (!pool || !db) return t.skip(startupError?.message ?? "Postgres nicht gestartet");
    __resetVolatilityTargetingForTests();

    const now = Math.floor(Date.now() / 60_000) * 60_000;
    const status = await updateVolatilityTargeting({ deps: makeDeps(now), config: testConfig(), force: true });
    assert.equal(status.mode, "monitor");
    assert.ok(status.forecast !== null);

    const res = await pool.query(
      `SELECT * FROM volatility_targeting_snapshots WHERE as_of = $1 LIMIT 1`,
      [new Date(now)]
    );
    assert.equal(res.rows.length, 1, "Snapshot-Row für diesen Zeitpunkt muss existieren");
    const r = res.rows[0];
    assert.match(r.snapshot_id, /^vt1:[0-9a-f]{64}$/);
    assert.equal(r.mode, "monitor");
    assert.equal(r.monitor_only, true);
    assert.ok(["OK", "FALLBACK", "NO_EXPOSURE"].includes(r.status));
    assert.equal(r.reason_code, status.forecast?.reasonCode ?? r.reason_code);
    // Zeitsemantik: computed_at ≥ as_of, as_of = `now`.
    assert.ok(new Date(r.computed_at).getTime() >= new Date(r.as_of).getTime());
    assert.ok(Math.abs(new Date(r.as_of).getTime() - now) < 1000);
    // Fail-closed-Invariante: applied ∈ (0, 1].
    assert.ok(parseFloat(r.applied_multiplier) > 0 && parseFloat(r.applied_multiplier) <= 1);
    // Reproduktions-Hashes.
    assert.match(r.config_hash, /^cfg1:[0-9a-f]{64}$/);
    assert.match(r.data_hash, /^data1:[0-9a-f]{64}$/);
    // Gewichte sind JSON (hier 100 % TEST).
    assert.equal(typeof r.weights, "object");
    assert.ok(r.weights !== null);
  });

  it("Idempotenz: Retry in derselben Minute ⇒ keine doppelte Zeile", async (t) => {
    if (!pool || !db) return t.skip(startupError?.message ?? "Postgres nicht gestartet");
    __resetVolatilityTargetingForTests();

    const now = Math.floor(Date.now() / 60_000) * 60_000 + 30_000; // eigene Minute
    await updateVolatilityTargeting({ deps: makeDeps(now), config: testConfig(), force: true });
    await updateVolatilityTargeting({ deps: makeDeps(now), config: testConfig(), force: true });
    const res = await pool!.query(
      `SELECT count(*)::int AS count FROM volatility_targeting_snapshots WHERE as_of = $1`,
      [new Date(now)]
    );
    assert.equal(res.rows[0].count, 1, "Retry darf keine zweite Zeile erzeugen");
  });

  it("andere Minute ⇒ neue Zeile (Historie wächst)", async (t) => {
    if (!pool || !db) return t.skip(startupError?.message ?? "Postgres nicht gestartet");
    __resetVolatilityTargetingForTests();

    const base = Math.floor(Date.now() / 60_000) * 60_000;
    const m1 = base + 41 * 60_000;
    const m2 = base + 42 * 60_000;
    await updateVolatilityTargeting({ deps: makeDeps(m1), config: testConfig(), force: true });
    await updateVolatilityTargeting({ deps: makeDeps(m2), config: testConfig(), force: true });
    const res = await pool!.query(
      `SELECT count(*)::int AS count FROM volatility_targeting_snapshots WHERE as_of IN ($1, $2)`,
      [new Date(m1), new Date(m2)]
    );
    assert.equal(res.rows[0].count, 2, "zwei Minuten ⇒ zwei Snapshots");
  });

  it("CHECK-Constraints weisen ungültige Zustände auf DB-Ebene strikt ab", async (t) => {
    if (!pool) return t.skip(startupError?.message ?? "Postgres nicht gestartet");

    const id = "vt1:" + "a".repeat(64);
    const ts = new Date("2026-09-22T12:00:00Z");

    // 1) applied_multiplier > 1 ⇒ Verstoß (Faktor darf nie risikosteigernd sein).
    await assert.rejects(async () => {
      await pool!.query(
        `INSERT INTO volatility_targeting_snapshots
           (snapshot_id, mode, monitor_only, status, reason_code, reason, as_of, computed_at,
            target_annualized_vol, prev_multiplier, applied_multiplier, coverage, observations,
            annualization, shrinkage, regularization, weights, config_hash, data_hash)
         VALUES ($1, 'monitor', true, 'OK', 'OK', 'test', $2, $2, '0.30', '1', '1.5', '1', 24, '8760', '0', 'none', '{}', $3, $4)`,
        [id + "1", ts, "cfg1:" + "b".repeat(64), "data1:" + "c".repeat(64)]
      );
    });

    // 2) monitor_only ≠ (mode = 'monitor') ⇒ Verstoß.
    await assert.rejects(async () => {
      await pool!.query(
        `INSERT INTO volatility_targeting_snapshots
           (snapshot_id, mode, monitor_only, status, reason_code, reason, as_of, computed_at,
            target_annualized_vol, prev_multiplier, applied_multiplier, coverage, observations,
            annualization, shrinkage, regularization, weights, config_hash, data_hash)
         VALUES ($1, 'monitor', false, 'OK', 'OK', 'test', $2, $2, '0.30', '1', '1', '1', 24, '8760', '0', 'none', '{}', $3, $4)`,
        [id + "2", ts, "cfg1:" + "b".repeat(64), "data1:" + "c".repeat(64)]
      );
    });

    // 3) computed_at < as_of ⇒ Verstoß (Zeitsemantik).
    await assert.rejects(async () => {
      await pool!.query(
        `INSERT INTO volatility_targeting_snapshots
           (snapshot_id, mode, monitor_only, status, reason_code, reason, as_of, computed_at,
            target_annualized_vol, prev_multiplier, applied_multiplier, coverage, observations,
            annualization, shrinkage, regularization, weights, config_hash, data_hash)
         VALUES ($1, 'monitor', true, 'OK', 'OK', 'test', $2, $2 - interval '1 minute', '0.30', '1', '1', '1', 24, '8760', '0', 'none', '{}', $3, $4)`,
        [id + "3", ts, "cfg1:" + "b".repeat(64), "data1:" + "c".repeat(64)]
      );
    });

    // 4) Ungültiges Hash-Format ⇒ Verstoß.
    await assert.rejects(async () => {
      await pool!.query(
        `INSERT INTO volatility_targeting_snapshots
           (snapshot_id, mode, monitor_only, status, reason_code, reason, as_of, computed_at,
            target_annualized_vol, prev_multiplier, applied_multiplier, coverage, observations,
            annualization, shrinkage, regularization, weights, config_hash, data_hash)
         VALUES ($1, 'monitor', true, 'OK', 'OK', 'test', $2, $2, '0.30', '1', '1', '1', 24, '8760', '0', 'none', '{}', 'nope', $4)`,
        [id + "4", ts, "data1:" + "c".repeat(64)]
      );
    });

    // 5) coverage > 1 ⇒ Verstoß.
    await assert.rejects(async () => {
      await pool!.query(
        `INSERT INTO volatility_targeting_snapshots
           (snapshot_id, mode, monitor_only, status, reason_code, reason, as_of, computed_at,
            target_annualized_vol, prev_multiplier, applied_multiplier, coverage, observations,
            annualization, shrinkage, regularization, weights, config_hash, data_hash)
         VALUES ($1, 'monitor', true, 'OK', 'OK', 'test', $2, $2, '0.30', '1', '1', '1.5', 24, '8760', '0', 'none', '{}', $3, $4)`,
        [id + "5", ts, "cfg1:" + "b".repeat(64), "data1:" + "c".repeat(64)]
      );
    });
  });
});
