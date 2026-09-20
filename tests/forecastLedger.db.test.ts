/**
 * Forecast-Ledger — Postgres-Variante (RMA-P3-01, v1.55.0).
 *
 * Deckt die Zusicherungen ab, die NUR die Datenbank geben kann:
 * Migration (append-only, idempotent), UNIQUE-/CHECK-Constraints,
 * Idempotenz von Forecast- und Resolution-Writes, Versionierung statt
 * Überschreiben, Parallelität (Zeilensperre), Cursor-Monotonie und die
 * Versöhnung (Reconciliation) von Segmentaggregaten gegen die
 * Einzelresolutions.
 *
 * Die Datenbank ist eine **eingebettete** Postgres-Instanz
 * (`embedded-postgres`): kein Netzwerk, keine externen Zugangsdaten. Lässt
 * sich die Instanz nicht starten, überspringt sich die Suite sauber
 * (Skip statt Rot) — die restliche Testsuite bleibt grün.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import EmbeddedPostgres from "embedded-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { DrizzleForecastLedger, type ForecastDb } from "../src/forecasts/ledger";
import { buildScoreReport, scoreRowOf } from "../src/forecasts/metrics";
import {
  FORECAST_SETTLE_GRACE_MS,
  forecastKeyPayload,
  type ForecastContract,
} from "../src/forecasts/types";
import { forecastIdempotencyKey } from "../src/forecasts/hashes";
import { stableStringify } from "../src/lib/ruleEngine";
import { FC_HOUR, FC_T0 } from "./fixtures/forecastTestUtil";

const HOUR = FC_HOUR;
const RESOLVED_AT = new Date(FC_T0 + 7 * HOUR);

function contract(overrides: Partial<ForecastContract> = {}): ForecastContract {
  const asOfMs = overrides.asOf?.getTime() ?? FC_T0 + 30 * 60_000;
  const referenceMs = Math.floor(asOfMs / HOUR) * HOUR;
  const resolvesMs = overrides.resolvesAt?.getTime() ?? referenceMs + 4 * HOUR;
  return {
    agentRole: "TECHNICAL_ANALYST",
    promptVersion: 1,
    model: "test-model",
    entityType: "instrument",
    entityId: overrides.entityId ?? "PAPER:TEST",
    symbol: overrides.symbol ?? "TEST",
    targetKind: "CLOSE_DIRECTION",
    categories: ["DOWN", "UP"],
    probabilities: overrides.probabilities ?? [0.3, 0.7],
    targetCategory: "UP",
    horizonId: overrides.horizonId ?? "4h",
    timeframe: "1h",
    asOf: new Date(asOfMs),
    referenceTime: new Date(referenceMs),
    referenceClose: overrides.referenceClose ?? 100,
    resolvesAt: new Date(resolvesMs),
    availabilityDeadline: new Date(resolvesMs + FORECAST_SETTLE_GRACE_MS),
    regime: overrides.regime ?? "UNKNOWN",
    policyVersion: "fp1",
    contractVersion: 1,
    ...overrides,
  };
}

interface LiveDb {
  ledger: DrizzleForecastLedger;
  pool: Pool;
}

describe("forecastLedger (Postgres): Migration, Constraints, Idempotenz", () => {
  let pg: EmbeddedPostgres | null = null;
  let pool: Pool | null = null;
  let ledger: DrizzleForecastLedger | null = null;
  let startupError: Error | null = null;
  const logs: string[] = [];

  function liveOrNull(t: { skip: (reason?: string) => void }): LiveDb | null {
    if (!ledger || !pool) {
      t.skip(`eingebettete Postgres nicht verfügbar: ${startupError?.message ?? "unbekannt"}`);
      return null;
    }
    return { ledger, pool };
  }

  before(async () => {
    try {
      const dir = mkdtempSync(path.join(tmpdir(), "forecast-ledger-pg-"));
      const instance = new EmbeddedPostgres({
        databaseDir: dir,
        user: "postgres",
        password: "postgres",
        port: 55_434,
        persistent: false,
        onLog: (message) => logs.push(message),
        onError: (message) => logs.push(message instanceof Error ? message.message : String(message)),
      });
      await instance.initialise();
      await instance.start();
      await instance.createDatabase("forecast_ledger_test");
      const localPool = new Pool({
        host: "127.0.0.1",
        port: 55_434,
        user: "postgres",
        password: "postgres",
        database: "forecast_ledger_test",
        max: 6,
      });
      const migration = readFileSync(path.resolve(process.cwd(), "drizzle/2026-09-20_forecast_ledger.sql"), "utf8");
      await localPool.query(migration);
      // Migration ist idempotent: ein zweiter Durchlauf darf nicht scheitern.
      await localPool.query(migration);
      pg = instance;
      pool = localPool;
      ledger = new DrizzleForecastLedger({
        db: drizzle(localPool) as unknown as ForecastDb,
        audit: async () => undefined,
        now: () => RESOLVED_AT,
      });
    } catch (error) {
      const tail = logs.slice(-8).join(" | ");
      startupError = new Error(`${error instanceof Error ? error.message : String(error)}${tail ? ` :: ${tail}` : ""}`);
    }
  });

  after(async () => {
    if (pool) await pool.end().catch(() => undefined);
    if (pg) await pg.stop().catch(() => undefined);
  });

  it("Forecast-Insert ist idempotent über den natürlichen Schlüssel", async (t) => {
    const ctx = liveOrNull(t);
    if (!ctx) return;
    const c = contract();
    const first = await ctx.ledger.recordForecast(c, { source: "test" });
    assert.equal(first.created, true);
    const second = await ctx.ledger.recordForecast(c, { source: "test" });
    assert.equal(second.created, false);
    assert.equal(second.forecastId, first.forecastId);
    const rows = await ctx.pool.query<{ count: string }>("select count(*)::text as count from forecasts");
    assert.equal(rows.rows[0].count, "1", "Retry schreibt keine zweite Zeile");
  });

  it("CHECK-Constraints erzwingen den Vertrag (Probability, Zeitordnung, Hash-Format)", async (t) => {
    const ctx = liveOrNull(t);
    if (!ctx) return;
    // probability > 1
    await assert.rejects(
      ctx.pool.query(
        `insert into forecasts (idempotency_key, agent_role, prompt_version, model, entity_id, symbol, target_kind, categories, probabilities, target_category, probability, horizon_id, horizon_minutes, timeframe, as_of, reference_time, reference_close, resolves_at, availability_deadline, policy_version, contract_version, source_manifest)
         values ('fk1:' || repeat('0', 64), 'R', 1, 'm', 'E', 'S', 'CLOSE_DIRECTION', '["DOWN","UP"]', '[0.5,0.5]', 'UP', 1.5, '4h', 240, '1h', now(), now(), 1, now() + interval '4 hours', now() + interval '6 hours', 'fp1', 1, '{}')`
      ),
      (e: unknown) => (e as { code?: string }).code === "23514"
    );
    // Zeitordnung: resolves_at vor as_of
    await assert.rejects(
      ctx.pool.query(
        `insert into forecasts (idempotency_key, agent_role, prompt_version, model, entity_id, symbol, target_kind, categories, probabilities, target_category, probability, horizon_id, horizon_minutes, timeframe, as_of, reference_time, reference_close, resolves_at, availability_deadline, policy_version, contract_version, source_manifest)
         values ('fk1:' || repeat('1', 64), 'R', 1, 'm', 'E', 'S', 'CLOSE_DIRECTION', '["DOWN","UP"]', '[0.5,0.5]', 'UP', 0.5, '4h', 240, '1h', now(), now(), 1, now() - interval '1 hours', now() + interval '6 hours', 'fp1', 1, '{}')`
      ),
      (e: unknown) => (e as { code?: string }).code === "23514"
    );
    // Idempotenzschlüssel ohne fk1-Präfix
    await assert.rejects(
      ctx.pool.query(
        `insert into forecasts (idempotency_key, agent_role, prompt_version, model, entity_id, symbol, target_kind, categories, probabilities, target_category, probability, horizon_id, horizon_minutes, timeframe, as_of, reference_time, reference_close, resolves_at, availability_deadline, policy_version, contract_version, source_manifest)
         values ('xx1:' || repeat('2', 64), 'R', 1, 'm', 'E', 'S', 'CLOSE_DIRECTION', '["DOWN","UP"]', '[0.5,0.5]', 'UP', 0.5, '4h', 240, '1h', now(), now(), 1, now() + interval '4 hours', now() + interval '6 hours', 'fp1', 1, '{}')`
      ),
      (e: unknown) => (e as { code?: string }).code === "23514"
    );
    // Regime außerhalb der geschlossenen Liste
    await assert.rejects(
      ctx.pool.query(
        `insert into forecasts (idempotency_key, agent_role, prompt_version, model, entity_id, symbol, target_kind, categories, probabilities, target_category, probability, horizon_id, horizon_minutes, timeframe, as_of, reference_time, reference_close, resolves_at, availability_deadline, regime, policy_version, contract_version, source_manifest)
         values ('fk1:' || repeat('3', 64), 'R', 1, 'm', 'E', 'S', 'CLOSE_DIRECTION', '["DOWN","UP"]', '[0.5,0.5]', 'UP', 0.5, '4h', 240, '1h', now(), now(), 1, now() + interval '4 hours', now() + interval '6 hours', 'FREITEXT', 'fp1', 1, '{}')`
      ),
      (e: unknown) => (e as { code?: string }).code === "23514"
    );
  });

  it("Resolution: identisches Outcome ist idempotent, abweichendes erhält neue Version", async (t) => {
    const ctx = liveOrNull(t);
    if (!ctx) return;
    const c = contract({ asOf: new Date(FC_T0 + 90 * 60_000) });
    const { forecastId } = await ctx.ledger.recordForecast(c, { source: "test" });

    const draft = {
      forecastId,
      status: "RESOLVED" as const,
      outcomeIndex: 1,
      outcomeLabel: "UP",
      outcomeBinary: 1 as const,
      referenceClose: 100,
      outcomeClose: 105,
      voidReason: null,
      resolutionKind: "AUTOMATIC" as const,
      resolvedAt: RESOLVED_AT,
      policyVersion: "fp1",
      outcomeManifest: { datasetHash: `ds1:${"a".repeat(64)}` },
    };
    const first = await ctx.ledger.appendResolution(draft);
    assert.equal(first.created, true);
    assert.equal(first.resolutionVersion, 1);

    // Retry mit identischem Inhalt (anderer Zeitstempel!) ⇒ no-op.
    const retry = await ctx.ledger.appendResolution({ ...draft, resolvedAt: new Date(RESOLVED_AT.getTime() + 60_000) });
    assert.equal(retry.created, false);
    assert.equal(retry.resolutionVersion, 1);

    // Datenkorrektur ⇒ neue Version, Historie bleibt.
    const corrected = await ctx.ledger.appendResolution({
      ...draft,
      outcomeIndex: 0,
      outcomeLabel: "DOWN",
      outcomeBinary: 0,
      outcomeClose: 92,
      resolutionKind: "OPERATOR",
      outcomeManifest: { datasetHash: `ds1:${"b".repeat(64)}` },
    });
    assert.equal(corrected.created, true);
    assert.equal(corrected.resolutionVersion, 2);

    const view = await ctx.ledger.loadForecast(forecastId);
    assert.equal(view?.status, "RESOLVED");
    assert.equal(view?.latestResolution?.resolutionVersion, 2);
    assert.equal(view?.latestResolution?.outcome?.outcomeClose, 92);
    const rows = await ctx.pool.query<{ count: string }>(
      "select count(*)::text as count from forecast_resolutions where forecast_id = $1",
      [forecastId]
    );
    assert.equal(rows.rows[0].count, "2", "beide Versionen append-only erhalten");
  });

  it("parallele Resolution-Writes werden durch die Zeilensperre serialisiert", async (t) => {
    const ctx = liveOrNull(t);
    if (!ctx) return;
    const c = contract({ asOf: new Date(FC_T0 + 150 * 60_000) });
    const { forecastId } = await ctx.ledger.recordForecast(c, { source: "test" });
    const draft = {
      forecastId,
      status: "RESOLVED" as const,
      outcomeIndex: 1,
      outcomeLabel: "UP",
      outcomeBinary: 1 as const,
      referenceClose: 100,
      outcomeClose: 110,
      voidReason: null,
      resolutionKind: "AUTOMATIC" as const,
      resolvedAt: RESOLVED_AT,
      policyVersion: "fp1",
      outcomeManifest: { datasetHash: `ds1:${"c".repeat(64)}` },
    };
    const results = await Promise.all([
      ctx.ledger.appendResolution(draft),
      ctx.ledger.appendResolution(draft),
      ctx.ledger.appendResolution(draft),
    ]);
    const created = results.filter((r) => r.created).length;
    assert.equal(created, 1, "exakt ein Write gewinnt");
    assert.ok(results.every((r) => r.resolutionVersion === 1));
    const rows = await ctx.pool.query<{ count: string }>(
      "select count(*)::text as count from forecast_resolutions where forecast_id = $1",
      [forecastId]
    );
    assert.equal(rows.rows[0].count, "1");
  });

  it("dueForecasts liefert nur ungelöste Forecasts mit erreichter Deadline", async (t) => {
    const ctx = liveOrNull(t);
    if (!ctx) return;
    const due = contract({ asOf: new Date(FC_T0 + 210 * 60_000) });
    const pending = contract({
      asOf: new Date(FC_T0 + 210 * 60_000),
      entityId: "PAPER:FUTURE",
      symbol: "FUTURE",
      resolvesAt: new Date(FC_T0 + 48 * HOUR),
      availabilityDeadline: new Date(FC_T0 + 48 * HOUR + FORECAST_SETTLE_GRACE_MS),
    });
    await ctx.ledger.recordForecast(due, { source: "test" });
    await ctx.ledger.recordForecast(pending, { source: "test" });

    const list = await ctx.ledger.dueForecasts(new Date(FC_T0 + 24 * HOUR), 100);
    const ids = list.map((f) => f.contract.entityId);
    assert.ok(ids.includes("PAPER:TEST"), "fälliger Forecast ist enthalten");
    assert.ok(!ids.includes("PAPER:FUTURE"), "unreifer Forecast ist nicht enthalten");
  });

  it("Wasserstand ist monoton (kein Rücksprung)", async (t) => {
    const ctx = liveOrNull(t);
    if (!ctx) return;
    const late = new Date(FC_T0 + 40 * HOUR);
    const early = new Date(FC_T0 + 20 * HOUR);
    const w1 = await ctx.ledger.advanceCursor(late, null);
    assert.equal(w1.getTime(), late.getTime());
    const w2 = await ctx.ledger.advanceCursor(early, null);
    assert.equal(w2.getTime(), late.getTime(), "rückspringende Marke wird ignoriert");
    const cursor = await ctx.ledger.readCursor();
    assert.ok(cursor);
    assert.equal(cursor.watermarkDeadline.getTime(), late.getTime());
  });

  it("Lauf-Manifeste sind idempotent über ihren Schlüssel", async (t) => {
    const ctx = liveOrNull(t);
    if (!ctx) return;
    const manifest = {
      idempotencyKey: `frk1:${"d".repeat(64)}`,
      mode: "AUTOMATIC" as const,
      status: "SUCCEEDED" as const,
      counts: { dueConsidered: 1, resolved: 1, voided: 0, duplicates: 0, failed: 0 },
      cursorBefore: { watermarkDeadline: null },
      cursorAfter: { watermarkDeadline: RESOLVED_AT },
      codeVersion: "test",
      errorCode: null,
      startedAt: RESOLVED_AT,
      finishedAt: RESOLVED_AT,
    };
    const first = await ctx.ledger.recordRun(manifest);
    assert.equal(first.created, true);
    const second = await ctx.ledger.recordRun(manifest);
    assert.equal(second.created, false);
    assert.equal(second.runId, first.runId);
  });

  it("Segmentaggregate reconciliieren gegen Einzelresolutions (DB-Roundtrip)", async (t) => {
    const ctx = liveOrNull(t);
    if (!ctx) return;
    // Drei weitere Forecasts derselben Rolle: zwei resolved, einer VOID.
    const base = FC_T0 + 10 * HOUR;
    const cases = [
      { offset: 0, p: 0.8, outcome: 1 as const },
      { offset: 1, p: 0.6, outcome: 0 as const },
      { offset: 2, p: 0.7, outcome: null },
    ];
    for (const c of cases) {
      const fc = contract({
        asOf: new Date(base + c.offset * HOUR + 30 * 60_000),
        entityId: "PAPER:SCORE",
        symbol: "SCORE",
        probabilities: [Number((1 - c.p).toFixed(9)), Number(c.p.toFixed(9))],
        resolvesAt: new Date(base + c.offset * HOUR + 4 * HOUR),
        availabilityDeadline: new Date(base + c.offset * HOUR + 4 * HOUR + FORECAST_SETTLE_GRACE_MS),
      });
      const { forecastId } = await ctx.ledger.recordForecast(fc, { source: "test" });
      if (c.outcome === null) {
        await ctx.ledger.appendResolution({
          forecastId,
          status: "VOID",
          outcomeIndex: null,
          outcomeLabel: null,
          outcomeBinary: null,
          referenceClose: null,
          outcomeClose: null,
          voidReason: "MISSING_DATA",
          resolutionKind: "AUTOMATIC",
          resolvedAt: RESOLVED_AT,
          policyVersion: "fp1",
          outcomeManifest: { note: "void" },
        });
      } else {
        await ctx.ledger.appendResolution({
          forecastId,
          status: "RESOLVED",
          outcomeIndex: c.outcome,
          outcomeLabel: c.outcome === 1 ? "UP" : "DOWN",
          outcomeBinary: c.outcome,
          referenceClose: 100,
          outcomeClose: c.outcome === 1 ? 120 : 80,
          voidReason: null,
          resolutionKind: "AUTOMATIC",
          resolvedAt: RESOLVED_AT,
          policyVersion: "fp1",
          outcomeManifest: { datasetHash: `ds1:${"e".repeat(63)}${c.offset}` },
        });
      }
    }

    const { rows } = await ctx.ledger.queryForecasts({ entityId: "PAPER:SCORE" }, 100);
    assert.equal(rows.length, 3);
    const report = buildScoreReport(rows, {
      truncated: false,
      minSample: 2,
      now: new Date(FC_T0 + 60 * HOUR),
      filters: { entityId: "PAPER:SCORE" },
    });
    assert.equal(report.overall.resolvedCount, 2);
    assert.equal(report.overall.voidCount, 1);
    assert.equal(report.overall.status, "ok");
    // Analytisch: BS = ((0.8−1)² + (0.6−0)²)/2 = (0.04 + 0.36)/2 = 0.2
    assert.ok(Math.abs((report.overall.brierScore ?? Number.NaN) - 0.2) < 1e-12);
    // Coverage: alle drei fällig, alle bearbeitet ⇒ 1.
    assert.equal(report.overall.coverage, 1);
    // Segment = genau diese Entity/Rolle: identische Zahlen (Reconciliation).
    assert.equal(report.segments.length, 1);
    assert.equal(report.segments[0].score.resolvedCount, 2);
    assert.equal(report.segments[0].score.voidCount, 1);
    assert.ok(Math.abs((report.segments[0].score.brierScore ?? Number.NaN) - 0.2) < 1e-12);
    // Einzelzeilen-Reconciliation über scoreRowOf.
    const scoreRows = rows.map(scoreRowOf);
    const resolvedRows = scoreRows.filter((r) => r.status === "RESOLVED");
    assert.equal(resolvedRows.length, 2);
    assert.ok(resolvedRows.every((r) => r.outcomeBinary !== null));
  });

  it("DB-Roundtrip: gespeicherter Vertrag kommt inhaltlich identisch zurück", async (t) => {
    const ctx = liveOrNull(t);
    if (!ctx) return;
    const c = contract({ asOf: new Date(FC_T0 + 330 * 60_000), entityId: "PAPER:ROUND", symbol: "ROUND" });
    const { forecastId } = await ctx.ledger.recordForecast(c, { source: "roundtrip" });
    const view = await ctx.ledger.loadForecast(forecastId);
    assert.ok(view);
    assert.equal(view.contract.entityId, "PAPER:ROUND");
    assert.deepEqual([...view.contract.probabilities], [0.3, 0.7]);
    assert.equal(view.contract.referenceClose, 100);
    assert.equal(view.contract.horizonId, "4h");
    assert.equal(view.status, "PENDING");
    assert.equal(view.latestResolution, null);
    // Der Idempotenzschlüssel ist kanonisch (zweimal dieselbe Eingabe ⇒ derselbe Wert).
    assert.equal(
      forecastIdempotencyKey(c),
      forecastIdempotencyKey(contract({ asOf: new Date(FC_T0 + 330 * 60_000), entityId: "PAPER:ROUND", symbol: "ROUND" }))
    );
    assert.match(forecastIdempotencyKey(c), /^fk1:[0-9a-f]{64}$/);
    assert.equal(typeof stableStringify(forecastKeyPayload(c)), "string");
  });
});
