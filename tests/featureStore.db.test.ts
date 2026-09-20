/**
 * Point-in-Time Feature Store — Postgres-Variante (RMA-P6-01, v1.53.0).
 *
 * Deckt genau die Zusicherungen ab, die **nur** die Datenbank geben kann:
 * UNIQUE-/CHECK-Constraints, Transaktionsatomarität, Replay-Idempotenz gegen
 * die echte Tabelle, Revisionsschutz, Retention und der as-of-Lesepfad samt
 * Index. Die reinen Semantik-Tests (Planer, PIT-Join, Parität, Leakage)
 * liegen in `tests/featureStore.test.ts` und brauchen keine Datenbank.
 *
 * Die Datenbank ist eine **eingebettete** Postgres-Instanz
 * (`embedded-postgres`, Binaries im Repo-Node-Modules): kein Netzwerk, keine
 * externen Zugangsdaten, kein `DATABASE_URL` aus der Umgebung. Lässt sich die
 * Instanz nicht starten, überspringt sich die Suite sauber (Skip statt Rot) —
 * die restliche Testsuite bleibt grün.
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

import {
  FEATURE_EXECUTORS,
  FeatureRegistry,
  emptyCounts,
  getSliceRegistry,
  materializationRunKey,
  planMaterialization,
  sliceDefinitions,
  type FeatureCursor,
  type FeatureRef,
  type MaterializationRunRecord,
} from "../src/features";
import { DrizzleFeatureStore, type FeatureDb } from "../src/features/store";
import { DEFAULT_ANALYSIS_TIMEFRAME, SUPPORTED_TIMEFRAME_MS, type SupportedTimeframe } from "../src/lib/marketdata/historicalStore";

const TF: SupportedTimeframe = DEFAULT_ANALYSIS_TIMEFRAME;
const HOUR = SUPPORTED_TIMEFRAME_MS[TF];
const MINUTE = 60_000;
/** Montag, 2026-09-07T00:00:00Z — fester Bezugspunkt. */
const T0 = Date.parse("2026-09-07T00:00:00.000Z");
const COMPUTED_AT = new Date(T0 + 80 * HOUR);
const ENTITY = "SIM:FEATURE-DB";
const RSI: FeatureRef = { featureId: "scanner.rsi", version: 1 };
const ATR: FeatureRef = { featureId: "scanner.atr", version: 1 };
const BAND: FeatureRef = { featureId: "scanner.atr_band", version: 1 };
const SLICE: readonly FeatureRef[] = [RSI, ATR, BAND];

function closeOf(index: number): number {
  return T0 + (index + 1) * HOUR;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  fetchedAt: string;
}

function bar(index: number, fetchedAtMs?: number): Bar {
  const close = 100 + index * 0.5 + Math.sin(index) * 4;
  return {
    time: T0 + index * HOUR,
    open: close - 0.4,
    high: close + 1.2,
    low: close - 1.1,
    close,
    volume: 1000 + index * 7,
    fetchedAt: iso(fetchedAtMs ?? closeOf(index) + MINUTE),
  };
}

function series(count: number): Bar[] {
  return Array.from({ length: count }, (_, index) => bar(index));
}

/** Lauf-Manifest für einen Plan (alle Pflichtfelder, deterministische ID). */
function runFor(
  plan: ReturnType<typeof planMaterialization>,
  overrides: Partial<MaterializationRunRecord> = {}
): MaterializationRunRecord {
  const eventTimes = plan.drafts.map((draft) => draft.eventTime);
  const refs = [...new Set(plan.drafts.map((draft) => `${draft.featureId}@${draft.featureVersion}`))];
  const counts = { ...emptyCounts(), valuesWritten: plan.drafts.length, nullValues: plan.drafts.filter((d) => d.value === null).length };
  return {
    id: overrides.id ?? "11111111-1111-4111-8111-111111111111",
    idempotencyKey: materializationRunKey({
      registry: getSliceRegistry(),
      refs: plan.drafts.map((draft) => ({ featureId: draft.featureId, version: draft.featureVersion })),
      entityIds: [plan.entityId],
      timeframe: TF,
      availabilityPolicy: "ingested",
      mode: "INCREMENTAL",
      fromTs: Math.min(...eventTimes.map((time) => time.getTime())),
      toTs: Math.max(...eventTimes.map((time) => time.getTime())),
      datasetHashes: plan.sourceManifest ? { [ENTITY]: plan.sourceManifest.datasetHash } : {},
      codeVersion: "1.53.0-test",
    }),
    mode: "INCREMENTAL",
    status: "SUCCEEDED",
    timeframe: TF,
    availabilityPolicy: "ingested",
    featureRefs: refs.map((ref) => {
      const [featureId, version] = ref.split("@");
      return { featureId, version: Number(version) };
    }),
    entityIds: [plan.entityId],
    fromTs: new Date(Math.min(...eventTimes.map((time) => time.getTime()))),
    toTs: new Date(Math.max(...eventTimes.map((time) => time.getTime()))),
    counts,
    definitionHashes: Object.fromEntries(
      getSliceRegistry()
        .topoOrder(plan.drafts.map((draft) => ({ featureId: draft.featureId, version: draft.featureVersion })))
        .map((def) => [`${def.featureId}@${def.version}`, def.definitionHash])
    ),
    sourceManifests: plan.sourceManifest ? { [ENTITY]: plan.sourceManifest } : {},
    cursorBefore: [],
    cursorAfter: plan.cursors,
    codeVersion: "1.53.0-test",
    errorCode: null,
    startedAt: COMPUTED_AT,
    finishedAt: COMPUTED_AT,
    ...overrides,
  };
}

describe("featureStore (Postgres): Constraints, Atomarität, Idempotenz", () => {
  let pg: EmbeddedPostgres | null = null;
  let pool: Pool | null = null;
  let store: DrizzleFeatureStore | null = null;
  let startupError: Error | null = null;
  const logs: string[] = [];

/**
 * Zugriff auf die eingebettete Datenbank — oder sauberer Skip.
 *
 * Die `let`-Variablen aus dem `before`-Block sind in Callbacks (z. B.
 * `assert.rejects(...)`) nicht mehr genarrowt; `liveOrNull` liefert deshalb für
 * jeden Test einen konstanten, nicht-nullbaren Zugriff.
 */
interface LiveDb {
  store: DrizzleFeatureStore;
  pool: Pool;
}

function liveOrNull(t: { skip: (reason?: string) => void }): LiveDb | null {
  if (!store || !pool) {
    t.skip(`eingebettete Postgres nicht verfügbar: ${startupError?.message ?? "unbekannt"}`);
    return null;
  }
  return { store, pool };
}

  before(async () => {
    try {
      const dir = mkdtempSync(path.join(tmpdir(), "feature-store-pg-"));
      const instance = new EmbeddedPostgres({
        databaseDir: dir,
        user: "postgres",
        password: "postgres",
        port: 55_433,
        persistent: false,
        // Server-/initdb-Ausgaben nicht in die Testausgabe spiegeln: sie gehören
        // nur dann in den Fehlerbericht, wenn der Start scheitert.
        onLog: (message) => logs.push(message),
        onError: (message) => logs.push(message instanceof Error ? message.message : String(message)),
      });
      await instance.initialise();
      await instance.start();
      await instance.createDatabase("feature_store_test");
      const localPool = new Pool({
        host: "127.0.0.1",
        port: 55_433,
        user: "postgres",
        password: "postgres",
        database: "feature_store_test",
        max: 4,
      });
      const migration = readFileSync(path.resolve(process.cwd(), "drizzle/2026-09-20_feature_store.sql"), "utf8");
      await localPool.query(migration);
      pg = instance;
      pool = localPool;
      store = new DrizzleFeatureStore({
        db: drizzle(localPool) as unknown as FeatureDb,
        audit: async () => undefined,
        now: () => COMPUTED_AT,
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

  it("Definitionen sind auf DB-Ebene unveränderlich (Immutabilität)", async (t) => {
    const ctx = liveOrNull(t);
    if (!ctx) return;
    const registry = getSliceRegistry();
    const first = await ctx.store.registerDefinitions(registry.definitions());
    assert.deepEqual(first, { registered: 3, existing: 0 });
    const second = await ctx.store.registerDefinitions(registry.definitions());
    assert.deepEqual(second, { registered: 0, existing: 3 });

    // Gleiche (featureId, version), andere Semantik ⇒ andere Definition ⇒ Ablehnung.
    const [rsiInput, atrInput] = sliceDefinitions();
    const mutated = FeatureRegistry.create([{ ...atrInput, unit: "percent_0_100" }], FEATURE_EXECUTORS);
    assert.notEqual(mutated.definitions()[0].definitionHash, registry.require(ATR).definitionHash);
    await assert.rejects(
      () => ctx.store.registerDefinitions(mutated.definitions()),
      (error: unknown) =>
        error instanceof Error && (error as { code?: string }).code === "definition:immutable"
    );
    const rows = await ctx.pool.query<{ count: string }>("select count(*)::text as count from feature_definitions");
    assert.equal(rows.rows[0].count, "3", "die abgelehnte Deklaration darf keine Zeile hinterlassen");
    assert.equal(rsiInput.dtype, "number");
  });

  it("Materialisierung schreibt Manifest + Werte + Cursor atomar und ist idempotent (Replay)", async (t) => {
    const ctx = liveOrNull(t);
    if (!ctx) return;
    const bars = series(30);
    const plan = planMaterialization({
      registry: getSliceRegistry(),
      refs: SLICE,
      entityId: ENTITY,
      timeframe: TF,
      bars,
      asOf: closeOf(29),
      availabilityPolicy: "ingested",
      computedAt: COMPUTED_AT,
      maxRows: 1000,
    });
    const run = runFor(plan);
    const first = await ctx.store.commitRun({ run, values: plan.drafts, revisions: [] });
    assert.equal(first.created, true);
    assert.equal(first.valuesInserted, 90);

    const values = await ctx.pool.query<{ count: string }>("select count(*)::text as count from feature_values where entity_id = $1", [ENTITY]);
    assert.equal(values.rows[0].count, "90");
    const cursors = await ctx.pool.query<{ count: string; max: string }>(
      "select count(*)::text as count, max(watermark_event_time)::text as max from feature_materialization_cursors where entity_id = $1",
      [ENTITY]
    );
    assert.equal(cursors.rows[0].count, "3", "ein Cursor je Feature");
    assert.equal(new Date(cursors.rows[0].max).getTime(), closeOf(29));

    // Replay: gleicher Idempotency-Key ⇒ kein zweiter Wert, kein Duplikat.
    const replay = await ctx.store.commitRun({ run: { ...run, id: "22222222-2222-4222-8222-222222222222" }, values: plan.drafts, revisions: [] });
    assert.equal(replay.created, false);
    assert.equal(replay.runId, first.runId, "das bestehende Manifest bleibt die Wahrheit");
    const afterReplay = await ctx.pool.query<{ count: string }>("select count(*)::text as count from feature_values");
    assert.equal(afterReplay.rows[0].count, "90");
    const manifests = await ctx.pool.query<{ count: string }>(
      "select count(*)::text as count from feature_materialization_runs where idempotency_key = $1",
      [run.idempotencyKey]
    );
    assert.equal(manifests.rows[0].count, "1");
  });

  it("CHECK-Constraints halten NULL-Semantik, Zeitordnung und Dtype-Disziplin", async (t) => {
    const ctx = liveOrNull(t);
    if (!ctx) return;
    const definition = getSliceRegistry().require(RSI);
    // Eigene Entity: sonst kollidiert eine gültige Zeile mit Werten aus einem
    // anderen Test — und ein Reject wäre dann ein Duplikat statt eines CHECK.
    const entity = "SIM:FEATURE-CHECK";
    const base = {
      featureId: definition.featureId,
      featureVersion: definition.version,
      entityId: entity,
      timeframe: TF,
      dtype: "number",
      qualityStatus: "UNKNOWN",
      definitionHash: definition.definitionHash,
      valueHash: `fv1:${"a".repeat(64)}`,
      sourceManifest: JSON.stringify({ datasetHash: `ds1:${"b".repeat(64)}`, availabilityPolicy: "ingested", candleCount: 1 }),
    };
    // JS-Feldname → echte Spalte (ein Fehler hier wäre eine stillschweigend
    // ungeprüfte Tabelle — deshalb explizit statt String-Ersetzung).
    const COLUMNS: Readonly<Record<string, string>> = {
      featureId: "feature_id",
      featureVersion: "feature_version",
      entityId: "entity_id",
      timeframe: "timeframe",
      eventTime: "event_time",
      availableAt: "available_at",
      computedAt: "computed_at",
      dtype: "dtype",
      qualityStatus: "quality_status",
      definitionHash: "definition_hash",
      valueHash: "value_hash",
      sourceManifest: "source_manifest",
      valueNum: "value_num",
      valueBool: "value_bool",
      valueText: "value_text",
      nullReason: "null_reason",
    };
    /**
     * Fügt eine Zeile mit eigenem `event_time` ein (jede Verletzung ist damit
     * eindeutig eine Regelverletzung und kein Schlüsselkonflikt).
     */
    const insert = async (columns: Record<string, unknown>, eventTimeMs: number, availableMs = eventTimeMs): Promise<void> => {
      const payload: Record<string, unknown> = {
        ...base,
        eventTime: iso(eventTimeMs),
        availableAt: iso(availableMs),
        computedAt: iso(Math.max(availableMs, eventTimeMs)),
        ...columns,
      };
      const names = Object.keys(payload);
      assert.ok(names.every((name) => COLUMNS[name]), `unbekannte Spalte: ${names.filter((n) => !COLUMNS[n]).join(", ")}`);
      const targets = names.map((name) => COLUMNS[name]);
      const placeholders = targets.map((_, index) => `$${index + 1}`);
      await ctx.pool.query(
        `insert into feature_values (${targets.join(", ")}) values (${placeholders.join(", ")})`,
        names.map((name) => payload[name])
      );
    };
    /** Erwartet eine CHECK-Verletzung (SQLSTATE 23514) — nicht irgendeinen Fehler. */
    const rejectsCheck = async (columns: Record<string, unknown>, eventTimeMs: number, availableMs?: number): Promise<void> => {
      await assert.rejects(
        () => insert(columns, eventTimeMs, availableMs),
        (error: unknown) => (error as { code?: string }).code === "23514"
      );
    };

    // Weder Wert noch Null-Grund.
    await rejectsCheck({ valueNum: null, nullReason: null }, closeOf(5));
    // Wert UND Null-Grund.
    await rejectsCheck({ valueNum: "42.5", nullReason: "INSUFFICIENT_LOOKBACK" }, closeOf(6));
    // available_at < event_time (Look-ahead auf DB-Ebene verboten).
    await rejectsCheck({ valueNum: "42.5" }, closeOf(7), closeOf(7) - HOUR);
    // computed_at < available_at.
    await rejectsCheck({ valueNum: "42.5", computedAt: iso(closeOf(8) - HOUR) }, closeOf(8));
    // dtype=number mit Enum-Spalte statt Zahlenwert.
    await rejectsCheck({ valueText: "LOW" }, closeOf(9));
    await rejectsCheck({ valueBool: true }, closeOf(10));
    // Unbekannter Null-Grund / unzulässiger Qualitätsstatus.
    await rejectsCheck({ nullReason: "KEIN_GRUND" }, closeOf(11));
    await rejectsCheck({ valueNum: "42.5", qualityStatus: "SUPER" }, closeOf(12));
    // Hash muss dem Format `fv1:<64 hex>` entsprechen.
    await rejectsCheck({ valueNum: "42.5", valueHash: "fv1:kurz" }, closeOf(13));
    // Ein zweiter Wert zum selben Schlüssel ist verboten (append-only, ein Wert
    // je Feature/Entity/Timeframe/Bar).
    await insert({ valueNum: "42.5" }, closeOf(14));
    await assert.rejects(
      () => insert({ valueNum: "99.5" }, closeOf(14)),
      (error: unknown) => (error as { code?: string }).code === "23505"
    );
    // Gültige Zeilen bleiben gültig (Gegenprobe, damit der Test nicht nur „alles rot“ zeigt).
    await insert({ valueNum: "42.5" }, closeOf(15));
    await insert({ nullReason: "MISSING_BARS", valueNum: null }, closeOf(16));
    await insert({ valueNum: "0.0135" }, closeOf(17));
  });

  it("As-of-Filter greift im SQL-Pfad: verspätete Kerze ist vor `available_at` unsichtbar", async (t) => {
    const ctx = liveOrNull(t);
    if (!ctx) return;
    const entity = "SIM:FEATURE-LATE";
    const lateBars = series(30).map((entry, index) => (index === 20 ? bar(20, T0 + 26 * HOUR) : entry));
    const plan = planMaterialization({
      registry: getSliceRegistry(),
      refs: SLICE,
      entityId: entity,
      timeframe: TF,
      bars: lateBars,
      asOf: closeOf(29),
      availabilityPolicy: "ingested",
      computedAt: COMPUTED_AT,
      maxRows: 1000,
    });
    const run = runFor(plan, { id: "33333333-3333-4333-8333-333333333333", entityIds: [entity] });
    await ctx.store.commitRun({ run, values: plan.drafts, revisions: [] });

    const beforeIngestion = await ctx.store.readValues({
      entities: [entity],
      refs: [RSI],
      timeframe: TF,
      targetTime: new Date(closeOf(20)),
      asOf: new Date(T0 + 22 * HOUR),
      limit: 500,
    });
    assert.ok(beforeIngestion.length > 0);
    assert.equal(
      Math.max(...beforeIngestion.map((row) => row.eventTime.getTime())),
      closeOf(19),
      "der Wert der verspäteten Kerze darf vor ihrem available_at nicht sichtbar sein"
    );

    const afterIngestion = await ctx.store.readValues({
      entities: [entity],
      refs: [RSI],
      timeframe: TF,
      targetTime: new Date(closeOf(20)),
      asOf: new Date(T0 + 27 * HOUR),
      limit: 500,
    });
    assert.equal(Math.max(...afterIngestion.map((row) => row.eventTime.getTime())), closeOf(20));

    // Index-Beleg: der as-of-Pfad ist über einen Index bedienbar (kein Seq-Scan).
    const indexes = await ctx.pool.query<{ indexname: string }>(
      "select indexname from pg_indexes where tablename = 'feature_values' order by indexname"
    );
    assert.ok(
      indexes.rows.some((row) => row.indexname === "feature_values_pit_idx"),
      `PIT-Index fehlt: ${indexes.rows.map((row) => row.indexname).join(", ")}`
    );
    await ctx.pool.query("set enable_seqscan = off");
    try {
      const explain = await ctx.pool.query<{ "QUERY PLAN": string }>(
        `explain select id from feature_values
          where entity_id = $1 and feature_id = $2 and feature_version = $3 and timeframe = $4
            and event_time <= $5 and available_at <= $6`,
        [entity, RSI.featureId, RSI.version, TF, iso(closeOf(20)), iso(T0 + 27 * HOUR)]
      );
      const plan = explain.rows.map((row) => row["QUERY PLAN"]).join("\n");
      assert.match(plan, /Index/i, `as-of-Abfrage muss über einen Index laufen, Plan war:\n${plan}`);
    } finally {
      await ctx.pool.query("set enable_seqscan = on");
    }
  });

  it("Atomarität: ein ungültiger Wert rollt Manifest und alle Werte des Batches zurück", async (t) => {
    const ctx = liveOrNull(t);
    if (!ctx) return;
    const entity = "SIM:FEATURE-ROLLBACK";
    const plan = planMaterialization({
      registry: getSliceRegistry(),
      refs: SLICE,
      entityId: entity,
      timeframe: TF,
      bars: series(30),
      asOf: closeOf(29),
      availabilityPolicy: "ingested",
      computedAt: COMPUTED_AT,
      maxRows: 1000,
    });
    const broken = plan.drafts.map((draft, index) =>
      index === 40 ? { ...draft, value: null, nullReason: null } : draft
    );
    const run = runFor(plan, { id: "44444444-4444-4444-8444-444444444444", entityIds: [entity] });
    await assert.rejects(() => ctx.store.commitRun({ run, values: broken, revisions: [] }));

    const values = await ctx.pool.query<{ count: string }>("select count(*)::text as count from feature_values where entity_id = $1", [entity]);
    assert.equal(values.rows[0].count, "0", "die bereits eingefügten Chunks müssen zurückgerollt sein");
    const manifests = await ctx.pool.query<{ count: string }>(
      "select count(*)::text as count from feature_materialization_runs where idempotency_key = $1",
      [run.idempotencyKey]
    );
    assert.equal(manifests.rows[0].count, "0", "ein fehlgeschlagener Commit darf kein Manifest hinterlassen");
  });

  it("Revisionen: Batch-Verwurf wird protokolliert, Wiederholung bleibt idempotent (UNIQUE)", async (t) => {
    const ctx = liveOrNull(t);
    if (!ctx) return;
    const entity = "SIM:FEATURE-REVISION";
    const manifest = await ctx.pool.query<{ id: string }>("select id::text as id from feature_materialization_runs limit 1");
    const revision = {
      featureId: ATR.featureId,
      featureVersion: ATR.version,
      entityId: entity,
      timeframe: TF,
      eventTime: new Date(closeOf(25)),
      existingValueHash: `fv1:${"1".repeat(64)}`,
      incomingValueHash: `fv1:${"2".repeat(64)}`,
      detectedAt: COMPUTED_AT,
      runId: null,
    };
    void manifest;
    const run: MaterializationRunRecord = {
      id: "55555555-5555-4555-8555-555555555555",
      idempotencyKey: `fm1:${"7".repeat(64)}`,
      mode: "INCREMENTAL",
      status: "FAILED",
      timeframe: TF,
      availabilityPolicy: "ingested",
      featureRefs: [ATR],
      entityIds: [entity],
      fromTs: new Date(closeOf(24)),
      toTs: new Date(closeOf(25)),
      counts: emptyCounts(),
      definitionHashes: { [`${ATR.featureId}@${ATR.version}`]: getSliceRegistry().require(ATR).definitionHash },
      sourceManifests: {},
      cursorBefore: [] as FeatureCursor[],
      cursorAfter: [] as FeatureCursor[],
      codeVersion: "1.53.0-test",
      errorCode: "FEATURE_DATA_REVISION_DETECTED",
      startedAt: COMPUTED_AT,
      finishedAt: COMPUTED_AT,
    };
    const first = await ctx.store.commitRun({ run, values: [], revisions: [revision] });
    assert.equal(first.created, true);
    assert.equal(first.revisionsRecorded, 1);

    const rows = await ctx.pool.query<{ run_id: string; count: string }>(
      "select run_id::text as run_id, count(*)::text as count from feature_data_revisions where entity_id = $1 group by run_id",
      [entity]
    );
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].count, "1", "genau eine Revision, verknüpft mit dem Manifest");
    assert.equal(rows.rows[0].run_id, first.runId);

    // Retry mit demselben Key: Manifest wird ersetzt (nicht dupliziert), Revision bleibt einmalig.
    const retry = await ctx.store.commitRun({ run: { ...run, id: "66666666-6666-4666-8666-666666666666" }, values: [], revisions: [revision] });
    assert.equal(retry.runId, first.runId);
    const manifests = await ctx.pool.query<{ count: string; status: string }>(
      "select count(*)::text as count, min(status) as status from feature_materialization_runs where idempotency_key = $1",
      [run.idempotencyKey]
    );
    assert.equal(manifests.rows[0].count, "1");
    assert.equal(manifests.rows[0].status, "FAILED");
    const revisions = await ctx.pool.query<{ count: string }>(
      "select count(*)::text as count from feature_data_revisions where entity_id = $1",
      [entity]
    );
    assert.equal(revisions.rows[0].count, "1");

    // Ein NEUER eingehender Hash zum selben Schlüssel ist eine zweite Revision (Historie wächst).
    const second = await ctx.store.commitRun({
      run: { ...run, id: "77777777-7777-4777-8777-777777777777", idempotencyKey: `fm1:${"8".repeat(64)}` },
      values: [],
      revisions: [{ ...revision, incomingValueHash: `fv1:${"3".repeat(64)}` }],
    });
    assert.equal(second.revisionsRecorded, 1);
    const allRevisions = await ctx.pool.query<{ count: string }>(
      "select count(*)::text as count from feature_data_revisions where entity_id = $1",
      [entity]
    );
    assert.equal(allRevisions.rows[0].count, "2");
  });

  it("Retention löscht nur wertfreie, unreferenzierte Manifeste (Werte und Revisionen bleiben)", async (t) => {
    const ctx = liveOrNull(t);
    if (!ctx) return;
    const successful = await ctx.pool.query<{ id: string }>(
      "select id::text as id from feature_materialization_runs where counts_json->>'valuesWritten' <> '0' order by finished_at desc limit 1"
    );
    const revisionRun = await ctx.pool.query<{ id: string }>(
      "select r.id::text as id from feature_materialization_runs r join feature_data_revisions d on d.run_id = r.id limit 1"
    );
    const failedId = "88888888-8888-4888-8888-888888888888";
    await ctx.store.recordFailedRun({
      id: failedId,
      idempotencyKey: `fm1:${"9".repeat(64)}`,
      mode: "INCREMENTAL",
      status: "FAILED",
      timeframe: TF,
      availabilityPolicy: "ingested",
      featureRefs: [RSI],
      entityIds: ["SIM:FEATURE-RETENTION"],
      fromTs: null,
      toTs: null,
      counts: emptyCounts(),
      definitionHashes: {},
      sourceManifests: {},
      cursorBefore: [],
      cursorAfter: [],
      codeVersion: "1.53.0-test",
      errorCode: "FEATURE_PLAN_INVALID",
      startedAt: COMPUTED_AT,
      finishedAt: COMPUTED_AT,
    });
    const pruned = await ctx.store.pruneRuns(0);
    assert.ok(pruned >= 1, "das wertfreie Fehlschlag-Manifest muss gelöscht werden");
    const remaining = await ctx.pool.query<{ id: string }>("select id::text as id from feature_materialization_runs");
    const ids = remaining.rows.map((row) => row.id);
    assert.ok(!ids.includes(failedId), "wertfreies Fehlschlag-Manifest bleibt nicht liegen");
    assert.ok(ids.includes(successful.rows[0].id), "Manifest mit Werten bleibt (Wahrheitsquelle)");
    assert.ok(ids.includes(revisionRun.rows[0].id), "Manifest mit protokollierter Revision bleibt (Nachvollziehbarkeit)");
    const revisions = await ctx.pool.query<{ count: string }>("select count(*)::text as count from feature_data_revisions");
    assert.ok(Number(revisions.rows[0].count) >= 2, "Revisionen werden nie gelöscht");
  });
});
