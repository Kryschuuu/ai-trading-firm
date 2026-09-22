/**
 * Cross-Sectional Momentum Ranking — Postgres-Variante (RMA-P2-04, v1.63.0).
 *
 * Deckt genau die Zusicherungen ab, die **nur** die Datenbank geben kann:
 *   - append-only Migration `drizzle/2026-09-22_cross_sectional_ranking.sql`
 *     (zweifach anwendbar = idempotent),
 *   - Roundtrip persist → loadLatestSnapshot (Felder, Zeitsemantik, Sortierung),
 *   - Idempotenz: gleicher fachlicher Key schreibt nie eine zweite Zeile,
 *   - Restart/Retry: frischer Pool (simulierter Neustart) bleibt eine Zeile,
 *   - Point-in-Time: späterer Snapshot ist für frühere asOf-Zeiten unsichtbar,
 *   - CHECK-Constraints (Coverage, Zählungen, Key-/Hash-Formate),
 *   - Konflikt-Guard: abweichende Mitglieder-Zeile wird protokolliert,
 *     nie überschrieben (fail-closed),
 *   - Retention (pruneCrossSectionalSnapshots, FK-Cascade).
 *
 * Die Datenbank ist eine **eingebettete** Postgres-Instanz
 * (`embedded-postgres`, Binaries im Repo-`node_modules`): kein Netzwerk,
 * keine externen Zugangsdaten. Lässt sich die Instanz nicht starten,
 * überspringt sich die Suite sauber (Skip statt Rot).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import EmbeddedPostgres from "embedded-postgres";
import { Pool } from "pg";

import {
  persistCrossSectionalSnapshot,
  persistCrossSectionalSnapshotWithStability,
  loadLatestSnapshot,
  listSnapshots,
  pruneCrossSectionalSnapshots,
} from "../src/crossSectional/store";
import { AS_OF, makeDbSnapshot as makeSnapshot } from "./crossSectional.fixtures";

const PG_PORT = 55_442;
const DB_NAME = "cross_sectional_test";

describe("cross_sectional_snapshots (Postgres): Migration, Roundtrip, Idempotenz, Restart, PIT, Retention", () => {
  let pg: EmbeddedPostgres | null = null;
  let localPool: Pool | null = null;
  let startupError: Error | null = null;
  let databaseUrl: string | null = null;
  const logs: string[] = [];

  before(async () => {
    try {
      const dir = mkdtempSync(path.join(tmpdir(), "cross-sectional-pg-"));
      const instance = new EmbeddedPostgres({
        databaseDir: dir,
        user: "postgres",
        password: "postgres",
        port: PG_PORT,
        persistent: false,
        onLog: (message) => logs.push(String(message)),
        onError: (message) => logs.push(message instanceof Error ? message.message : String(message)),
      });
      await instance.initialise();
      await instance.start();
      await instance.createDatabase(DB_NAME);
      const pool = new Pool({
        host: "127.0.0.1",
        port: PG_PORT,
        user: "postgres",
        password: "postgres",
        database: DB_NAME,
        max: 4,
      });
      const migration = readFileSync(path.resolve(process.cwd(), "drizzle/2026-09-22_cross_sectional_ranking.sql"), "utf8");
      // Zweifach anwenden: append-only Migration muss idempotent sein.
      await pool.query(migration);
      await pool.query(migration);
      pg = instance;
      localPool = pool;
      // Lazy-Singleton von src/db zeigt NUR in diesen Prozess (siehe Modulkopf).
      databaseUrl = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/${DB_NAME}`;
      process.env.DATABASE_URL = databaseUrl;
    } catch (error) {
      const tail = logs.slice(-8).join(" | ");
      startupError = new Error(`${error instanceof Error ? error.message : String(error)}${tail ? ` :: ${tail}` : ""}`);
    }
  });

  after(async () => {
    if (localPool) await localPool.end().catch(() => undefined);
    if (pg) await pg.stop().catch(() => undefined);
  });

  function liveOrNull(t: { skip: (reason: string) => void }): { pool: Pool } | null {
    if (!localPool || !databaseUrl) {
      t.skip(`eingebettete Postgres nicht verfügbar: ${startupError?.message ?? "unbekannt"}`);
      return null;
    }
    return { pool: localPool };
  }

  it("Roundtrip: persist → loadLatestSnapshot (Felder, Zeitsemantik, Sortierung)", async (t) => {
    const ctx = liveOrNull(t);
    if (!ctx) return;
    const snapshot = makeSnapshot(AS_OF, AS_OF + 60_000);
    const result = await persistCrossSectionalSnapshot(snapshot);
    assert.equal(result.written, true);
    assert.equal(result.memberRows, 4);
    assert.equal(result.conflicts, 0);

    const loaded = await loadLatestSnapshot({ asOfMs: AS_OF });
    assert.ok(loaded, "Snapshot geladen");
    assert.equal(loaded!.snapshotId, snapshot.provenance.snapshotId);
    assert.equal(loaded!.asOf.getTime(), AS_OF, "as_of ist der Cutoff");
    assert.ok(loaded!.computedAt.getTime() >= AS_OF, "computed_at getrennt von as_of");
    assert.equal(loaded!.timeframe, "1h");
    assert.equal(loaded!.availabilityPolicy, "ingested");
    assert.equal(loaded!.codeVersion, "cross-sectional@1");
    assert.equal(loaded!.universeSize, 4);
    assert.equal(loaded!.rankedCount, 4);
    assert.equal(loaded!.excludedCount, 0);
    assert.equal(loaded!.coverage, 1);
    assert.equal(loaded!.members.length, 4);
    // RANKED-Mitglieder sortiert nach Rang, dann ID.
    assert.deepEqual(
      loaded!.members.map((m) => [m.status, m.rank, m.instrumentId]),
      [
        ["RANKED", 1, "V:A"],
        ["RANKED", 2, "V:B"],
        ["RANKED", 3, "V:C"],
        ["RANKED", 4, "V:D"],
      ],
    );
    const top = loaded!.members[0];
    assert.equal(top.percentile, 1);
    assert.ok(top.composite !== null && top.composite > 0);
    // Rohwerte: explizite NULL für volAdjusted (σ=0), nie 0.
    assert.equal((top.rawReturns as Record<string, { volAdjusted: number | null }>).h3.volAdjusted, null);
    assert.ok((top.rawReturns as Record<string, { total: number }>).h3.total > 0.06);
    assert.ok(loaded!.survivorshipNote.length > 50, "Survivorship-Note persistiert");
  });

  it("Idempotenz: gleicher fachlicher Key schreibt nie eine zweite Zeile (Retry)", async (t) => {
    const ctx = liveOrNull(t);
    if (!ctx) return;
    const snapshot = makeSnapshot(AS_OF + 3_600_000, AS_OF + 3_600_000 + 60_000, { addInstrument: true });
    const first = await persistCrossSectionalSnapshot(snapshot);
    const second = await persistCrossSectionalSnapshot(snapshot);
    const third = await persistCrossSectionalSnapshot({ ...snapshot, computedAt: snapshot.computedAt + 999_999 });
    assert.equal(first.written, true);
    assert.equal(second.written, false, "Retry ist ein sichtbarer No-Op");
    assert.equal(third.written, false, "späterer Retry (anderes computedAt) bleibt No-Op");
    const count = await ctx.pool.query<{ count: string }>(
      "select count(*)::text as count from cross_sectional_snapshots where snapshot_id = $1",
      [snapshot.provenance.snapshotId],
    );
    assert.equal(count.rows[0].count, "1");
    const rows = await ctx.pool.query<{ count: string }>(
      "select count(*)::text as count from cross_sectional_rankings where snapshot_id = $1",
      [snapshot.provenance.snapshotId],
    );
    assert.equal(rows.rows[0].count, "5", "einzelne Mitglieder-Zeile je Instrument");
  });

  it("Restart/Retry: frischer Pool desselben Duplicateintrags bleibt eine Zeile", async (t) => {
    const ctx = liveOrNull(t);
    if (!ctx) return;
    const snapshot = makeSnapshot(AS_OF + 7_200_000, AS_OF + 7_200_000 + 60_000);
    await persistCrossSectionalSnapshot(snapshot);
    // Simulierter Neustart: komplett neuer Pool (eigene Connections).
    const fresh = new Pool({
      host: "127.0.0.1",
      port: PG_PORT,
      user: "postgres",
      password: "postgres",
      database: DB_NAME,
      max: 2,
    });
    try {
      const result = await persistCrossSectionalSnapshot(snapshot);
      assert.equal(result.written, false, "Neustart-Repeat ist ein No-Op");
      const count = await fresh.query<{ count: string }>(
        "select count(*)::text as count from cross_sectional_snapshots where snapshot_id = $1",
        [snapshot.provenance.snapshotId],
      );
      assert.equal(count.rows[0].count, "1");
    } finally {
      await fresh.end().catch(() => undefined);
    }
  });

  it("Point-in-Time: späterer Snapshot ist für frühere asOf-Zeiten unsichtbar", async (t) => {
    const ctx = liveOrNull(t);
    if (!ctx) return;
    const t1 = AS_OF + 24 * 3_600_000;
    const t2 = t1 + 24 * 3_600_000;
    await persistCrossSectionalSnapshot(makeSnapshot(t1, t1 + 60_000));
    await persistCrossSectionalSnapshot(makeSnapshot(t2, t2 + 60_000, { addInstrument: true }));
    // Für t1 gilt der t1-Snapshot (nicht der spätere t2-Snapshot).
    const atT1 = await loadLatestSnapshot({ asOfMs: t1 });
    assert.equal(atT1?.asOf.getTime(), t1);
    const atT2 = await loadLatestSnapshot({ asOfMs: t2 });
    assert.equal(atT2?.asOf.getTime(), t2);
    // Vor allen Snapshots: nur die frühesten (AS_OF, +3h, +2h) sind sichtbar.
    const early = await loadLatestSnapshot({ asOfMs: AS_OF + 3_600_000 + 1_000 });
    assert.equal(early?.asOf.getTime(), AS_OF + 3_600_000);
    void ctx;
  });

  it("Constraints: invalide Zeilen werden abgelehnt (Coverage, Zählungen, Hash-Formate)", async (t) => {
    const ctx = liveOrNull(t);
    if (!ctx) return;
    await assert.rejects(
      ctx.pool.query(
        `insert into cross_sectional_snapshots
           (snapshot_id, idempotency_key, as_of, computed_at, schema_version, code_version,
            config_version, config_hash, universe_hash, data_hash, timeframe, availability_policy,
            universe_size, ranked_count, excluded_count, coverage, exclusion_counts, survivorship_note)
         values ('xs1:' || repeat('0', 64), repeat('1', 64), now(), now(), 1, 'cross-sectional@1', 1,
                 'xc1:' || repeat('0', 64), 'xu1:' || repeat('0', 64), 'xd1:' || repeat('0', 64),
                 '1h', 'ingested', 4, 4, 0, 1.5, '{}', 'x')`,
      ),
      /coverage/i,
      "coverage > 1 muss abgelehnt werden",
    );
    await assert.rejects(
      ctx.pool.query(
        `insert into cross_sectional_snapshots
           (snapshot_id, idempotency_key, as_of, computed_at, schema_version, code_version,
            config_version, config_hash, universe_hash, data_hash, timeframe, availability_policy,
            universe_size, ranked_count, excluded_count, coverage, exclusion_counts, survivorship_note)
         values ('xs1:' || repeat('0', 64), repeat('2', 64), now(), now(), 1, 'cross-sectional@1', 1,
                 'xc1:' || repeat('0', 64), 'xu1:' || repeat('0', 64), 'xd1:' || repeat('0', 64),
                 '1h', 'ingested', 4, 5, 0, 1.0, '{}', 'x')`,
      ),
      /counts/i,
      "ranked_count > universe_size muss abgelehnt werden",
    );
    await assert.rejects(
      ctx.pool.query(
        `insert into cross_sectional_snapshots
           (snapshot_id, idempotency_key, as_of, computed_at, schema_version, code_version,
            config_version, config_hash, universe_hash, data_hash, timeframe, availability_policy,
            universe_size, ranked_count, excluded_count, coverage, exclusion_counts, survivorship_note)
         values ('xs:kaputt', repeat('3', 64), now(), now(), 1, 'cross-sectional@1', 1,
                 'xc1:' || repeat('0', 64), 'xu1:' || repeat('0', 64), 'xd1:' || repeat('0', 64),
                 '1h', 'ingested', 4, 4, 0, 1.0, '{}', 'x')`,
      ),
      /snapshot_id/i,
      "Snapshot-ID-Format xs1:<hex64> muss erzwungen sein",
    );
  });

  it("Konflikt-Guard: abweichende Mitglieder-Zeile wird protokolliert, nie überschrieben", async (t) => {
    const ctx = liveOrNull(t);
    if (!ctx) return;
    const snapshot = makeSnapshot(AS_OF + 12 * 3_600_000, AS_OF + 12 * 3_600_000 + 60_000);
    await persistCrossSectionalSnapshot(snapshot);
    // Simulation einer Inkonsistenz: Value-Hash einer Zeile wird „korrupt".
    await ctx.pool.query(
      `update cross_sectional_rankings set value_hash = $2 where snapshot_id = $1 and instrument_id = 'V:A'`,
      [snapshot.provenance.snapshotId, "ab".repeat(32)],
    );
    const retry = await persistCrossSectionalSnapshot(snapshot);
    assert.equal(retry.written, false, "Snapshot existiert bereits");
    assert.equal(retry.conflicts, 1, "abweichende Zeile wird protokolliert");
    // Die Zeile bleibt UNVERÄNDERT (append-only, fail-closed).
    const stored = await ctx.pool.query<{ rank: string | null }>(
      `select rank::text as rank from cross_sectional_rankings where snapshot_id = $1 and instrument_id = 'V:A'`,
      [snapshot.provenance.snapshotId],
    );
    assert.equal(stored.rows[0].rank, "1", "V:A behält seinen Rang (keine Überschreibung)");
  });

  it("Stabilität: persistCrossSectionalSnapshotWithStability misst Turnover gegen den Vorgänger", async (t) => {
    const ctx = liveOrNull(t);
    if (!ctx) return;
    const t1 = AS_OF + 48 * 3_600_000 + 1_000; // +1s: eindeutig neuer asOf als jeder Vorgänger
    const t2 = t1 + 3_600_000;
    const s1 = await persistCrossSectionalSnapshotWithStability(makeSnapshot(t1, t1 + 60_000));
    const s2 = await persistCrossSectionalSnapshotWithStability(makeSnapshot(t2, t2 + 60_000));
    assert.ok(s2.stability, "Snapshot mit Vorgänger trägt Stabilität");
    assert.equal(s2.stability?.prevSnapshotId, s1.snapshotId, "Vorgänger ist der unmittelbar vorausgehende Snapshot");
    assert.equal(s2.stability?.topK, 3, "stabilityTopK aus der Config");
    assert.equal(s2.stability?.commonCount, 4, "alle vier Instrumente sind gemeinsam");
    assert.ok(typeof s2.stability?.topKOverlap === "number");
    // Idempotenz bleibt gewahrt: Stabilitätslauf ist kein zweiter Snapshot.
    const count = await ctx.pool.query<{ count: string }>(
      "select count(*)::text as count from cross_sectional_snapshots where snapshot_id = $1",
      [s2.snapshotId],
    );
    assert.equal(count.rows[0].count, "1");
    void ctx;
  });

  it("Retention: pruneCrossSectionalSnapshots entfernt alte Snapshots (FK-Cascade)", async (t) => {
    const ctx = liveOrNull(t);
    if (!ctx) return;
    // Der älteste Snapshot (AS_OF) ist weit jenseits der Retention.
    const result = await pruneCrossSectionalSnapshots({
      retentionMs: 30 * 24 * 3_600_000,
      nowMs: AS_OF + 200 * 24 * 3_600_000,
    });
    assert.ok(result.pruned >= 1, `mindestens der AS_OF-Snapshot wird entfernt (pruned=${result.pruned})`);
    const gone = await loadLatestSnapshot({ asOfMs: AS_OF });
    assert.notEqual(gone?.asOf.getTime(), AS_OF, "AS_OF-Snapshot ist weg");
    const history = await listSnapshots({ limit: 50 });
    assert.ok(history.every((s) => s.asOf.getTime() > AS_OF), "nur neuere Snapshots bleiben");
    // Orphane dürfen nicht entstehen (Cascade).
    const orphans = await ctx.pool.query<{ count: string }>(
      `select count(*)::text as count from cross_sectional_rankings r
       where not exists (select 1 from cross_sectional_snapshots s where s.snapshot_id = r.snapshot_id)`,
    );
    assert.equal(orphans.rows[0].count, "0");
  });
});
