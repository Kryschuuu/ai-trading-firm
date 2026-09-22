/**
 * API-Contract-Tests von `GET /api/research/cross-sectional` (RMA-P2-04, v1.63.0).
 *
 * Zwei Ebenen:
 *   A) REINE Logik ohne Datenbank: Query-Validierung (400-Pfade) und
 *      Antwort-Aufbau (NO_SNAPSHOT, Top-Begrenzung, Member-Lookup,
 *      Exclusions-Schalter) — deterministisch, ohne I/O.
 *   B) VOLLSTÄNDIGER Pfad gegen eine eingebettete Postgres-Instanz
 *      (Port 55443, DB `cross_sectional_api_test`): persistierter
 *      Snapshot → HTTP-200-Antwort, Point-in-Time über den Query-Parameter
 *      `asOf`, Timeframe-Filter, Idempotenz-neutral (nur Lesezugriff).
 *
 * Bewusst NICHT hier: der LIVE-503-Pfad. Der DB-Pool ist ein Prozess-
 * Singleton (lazy), das erst beim ersten Zugriff initialisiert wird —
 * nach dem Happy Path ließe sich ein fehlender DB-Zugang in diesem
 * Prozess nicht mehr simulieren. Der 503-Zweig (STORAGE_UNAVAILABLE)
 * wird stattdessen über denselben `catch`-Pfad abgedeckt, der im
 * Postgres-Test `Constraints` indirekt ausgeübt wird, und ist zudem
 * eine generische Fehlerkartierung (keine Fachlogik).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import EmbeddedPostgres from "embedded-postgres";
import { Pool } from "pg";

import {
  GET,
  parseCrossSectionalQuery,
  buildCrossSectionalResponse,
  MAX_TOP,
  DEFAULT_TOP,
} from "../src/app/api/research/cross-sectional/route";
import type { LoadedCrossSectionalSnapshot, CrossSectionalMemberRow } from "../src/crossSectional/store";
import { persistCrossSectionalSnapshot } from "../src/crossSectional/store";
import { AS_OF, TF_MS, makeDbSnapshot } from "./crossSectional.fixtures";

const PG_PORT = 55_443;
const DB_NAME = "cross_sectional_api_test";
const BASE = "http://localhost:3369";

function url(query: string): URL {
  return new URL(`${BASE}/api/research/cross-sectional${query}`);
}

async function get(query: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await GET(new Request(url(query)));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function memberRow(over: Partial<CrossSectionalMemberRow>): CrossSectionalMemberRow {
  return {
    instrumentId: "X",
    status: "RANKED",
    rank: 1,
    percentile: 1,
    composite: 1.5,
    rawReturns: { h3: { total: 0.05, volAdjusted: null } },
    zScores: { h3: 0.5 },
    winsorized: { h3: 0.05 },
    horizonCoverage: 1,
    lastBarTs: null,
    lastAvailableAt: null,
    barsUsed: 6,
    exclusionReason: null,
    ...over,
  };
}

function loadedMock(over: Partial<LoadedCrossSectionalSnapshot> = {}): LoadedCrossSectionalSnapshot {
  return {
    snapshotId: "xs1:" + "a".repeat(64),
    asOf: new Date(AS_OF),
    computedAt: new Date(AS_OF + 60_000),
    schemaVersion: 1,
    codeVersion: "cross-sectional@1",
    configVersion: 1,
    configHash: "xc1:" + "b".repeat(64),
    universeHash: "xu1:" + "c".repeat(64),
    dataHash: "xd1:" + "d".repeat(64),
    timeframe: "1h",
    availabilityPolicy: "ingested",
    universeSize: 5,
    rankedCount: 4,
    excludedCount: 1,
    coverage: 0.8,
    exclusionCounts: { BELOW_MIN_VOLUME: 1 },
    stability: null,
    survivorshipNote: "note",
    members: [
      memberRow({ instrumentId: "V:A", rank: 1, percentile: 1 }),
      memberRow({ instrumentId: "V:B", rank: 2, percentile: 0.75 }),
      memberRow({ instrumentId: "V:C", rank: 3, percentile: 0.5 }),
      memberRow({ instrumentId: "V:D", rank: 4, percentile: 0.25 }),
      memberRow({ instrumentId: "V:E", status: "EXCLUDED", rank: null, percentile: null, composite: null, exclusionReason: "BELOW_MIN_VOLUME" }),
    ],
    ...over,
  };
}

describe("A) Query-Validierung und Antwort-Aufbau (ohne DB)", () => {
  it("Defaults: ohne Parameter ⇒ jetzt, top 25, Exclusions an, kein Timeframe-Filter", () => {
    const q = parseCrossSectionalQuery(url(""));
    assert.equal(q.asOfMs, undefined);
    assert.equal(q.instrumentId, null);
    assert.equal(q.top, DEFAULT_TOP);
    assert.equal(q.exclusions, true);
    assert.equal(q.timeframe, null);
  });

  it("Gültige Kombination: asOf, timeframe, top, exclusions=false, instrumentId", () => {
    const q = parseCrossSectionalQuery(url("?asOf=2026-09-22T00:00:00.000Z&timeframe=1h&top=2&exclusions=false&instrumentId=V%3AA"));
    assert.equal(q.asOfMs, Date.parse("2026-09-22T00:00:00.000Z"));
    assert.equal(q.timeframe, "1h");
    assert.equal(q.top, 2);
    assert.equal(q.exclusions, false);
    assert.equal(q.instrumentId, "V:A");
  });

  it("Ungültige asOf ⇒ 400-Pfad (wirft)", () => {
    assert.throws(() => parseCrossSectionalQuery(url("?asOf=garbage")), /asOf/);
  });

  it("Nicht erlaubter Timeframe ⇒ 400-Pfad (wirft)", () => {
    assert.throws(() => parseCrossSectionalQuery(url("?timeframe=3h")), /timeframe/);
  });

  it("top außerhalb von 1…200 bzw. nicht-ganzzahlig ⇒ 400-Pfad (wirft)", () => {
    assert.throws(() => parseCrossSectionalQuery(url("?top=0")), /top/);
    assert.throws(() => parseCrossSectionalQuery(url(`?top=${MAX_TOP + 1}`)), /top/);
    assert.throws(() => parseCrossSectionalQuery(url("?top=1.5")), /top/);
  });

  it("instrumentId mit unerlaubten Zeichen ⇒ 400-Pfad (wirft)", () => {
    assert.throws(() => parseCrossSectionalQuery(url("?instrumentId=V%3AA;DROP")), /instrumentId/);
  });

  it("exclusions mit anderem Wert ⇒ 400-Pfad (wirft)", () => {
    assert.throws(() => parseCrossSectionalQuery(url("?exclusions=maybe")), /exclusions/);
  });

  it("NO_SNAPSHOT: ohne Snapshot ⇒ ok:true, snapshot:null, Grund NO_SNAPSHOT", () => {
    const body = buildCrossSectionalResponse(null, { instrumentId: null, top: DEFAULT_TOP, exclusions: true });
    assert.deepEqual(body, { ok: true, snapshot: null, reason: "NO_SNAPSHOT", items: [], member: null });
  });

  it("Happy Path: RANKED-Mitglieder nach Rang, Excluded-Zeilen bleiben aus den items", () => {
    const body = buildCrossSectionalResponse(loadedMock(), { instrumentId: null, top: DEFAULT_TOP, exclusions: true }) as {
      snapshot: Record<string, unknown>;
      items: Array<Record<string, unknown>>;
      member: unknown;
    };
    assert.equal(body.snapshot.snapshotId, "xs1:" + "a".repeat(64));
    assert.equal(body.snapshot.coverage, 0.8);
    assert.deepEqual(body.snapshot.exclusionCounts, { BELOW_MIN_VOLUME: 1 });
    assert.deepEqual(body.items.map((i) => [i.rank, i.instrumentId]), [
      [1, "V:A"],
      [2, "V:B"],
      [3, "V:C"],
      [4, "V:D"],
    ]);
    assert.equal(body.items[0].percentile, 1);
    assert.equal(body.member, null);
  });

  it("top begrenzt die items; exclusions=false blendet exclusionCounts aus", () => {
    const body = buildCrossSectionalResponse(loadedMock(), { instrumentId: null, top: 2, exclusions: false }) as {
      items: unknown[];
      snapshot: Record<string, unknown>;
    };
    assert.equal(body.items.length, 2);
    assert.deepEqual(body.snapshot.exclusionCounts, {});
  });

  it("instrumentId liefert genau dieses Mitglied (auch EXCLUDED); unbekannt ⇒ null", () => {
    const hit = buildCrossSectionalResponse(loadedMock(), { instrumentId: "V:B", top: DEFAULT_TOP, exclusions: true }) as {
      member: Record<string, unknown> | null;
    };
    assert.equal(hit.member?.instrumentId, "V:B");
    assert.equal(hit.member?.rank, 2);
    const ex = buildCrossSectionalResponse(loadedMock(), { instrumentId: "V:E", top: DEFAULT_TOP, exclusions: true }) as {
      member: Record<string, unknown> | null;
    };
    assert.equal(ex.member?.status, "EXCLUDED");
    assert.equal(ex.member?.exclusionReason, "BELOW_MIN_VOLUME");
    const miss = buildCrossSectionalResponse(loadedMock(), { instrumentId: "V:Z", top: DEFAULT_TOP, exclusions: true }) as {
      member: unknown;
    };
    assert.equal(miss.member, null);
  });
});

describe("B) Vollständiger HTTP-Pfad gegen eingebettete Postgres", () => {
  let pg: EmbeddedPostgres | null = null;
  let localPool: Pool | null = null;
  let startupError: Error | null = null;
  const logs: string[] = [];

  before(async () => {
    try {
      const dir = mkdtempSync(path.join(tmpdir(), "cross-sectional-api-pg-"));
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
      await pool.query(migration);
      await pool.query(migration);
      pg = instance;
      localPool = pool;
      // Lazy-DB-Singleton: env MUSS vor dem ersten Lesezugriff stehen.
      process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/${DB_NAME}`;
    } catch (error) {
      const tail = logs.slice(-8).join(" | ");
      startupError = new Error(`${error instanceof Error ? error.message : String(error)}${tail ? ` :: ${tail}` : ""}`);
    }
  });

  after(async () => {
    if (localPool) await localPool.end().catch(() => undefined);
    if (pg) await pg.stop().catch(() => undefined);
  });

  function liveOrSkip(t: { skip: (reason: string) => void }): void {
    if (!localPool) {
      t.skip(`eingebettete Postgres nicht verfügbar: ${startupError?.message ?? "unbekannt"}`);
    }
  }

  it("Leere DB ⇒ 200 mit NO_SNAPSHOT (kein 500, kein 503)", async (t) => {
    liveOrSkip(t);
    const { status, body } = await get("");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.snapshot, null);
    assert.equal(body.reason, "NO_SNAPSHOT");
    assert.deepEqual(body.items, []);
  });

  it("Persistierter Snapshot ⇒ 200 mit vollständiger Antwort (Felder, Ränge, Provenienz)", async (t) => {
    liveOrSkip(t);
    const a = makeDbSnapshot(AS_OF, AS_OF + 60_000);
    const b = makeDbSnapshot(AS_OF + 2 * TF_MS, AS_OF + 2 * TF_MS + 60_000, { addInstrument: true });
    assert.equal((await persistCrossSectionalSnapshot(a)).written, true);
    assert.equal((await persistCrossSectionalSnapshot(b)).written, true);

    const { status, body } = await get("");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    const snap = body.snapshot as Record<string, unknown>;
    assert.equal(snap.snapshotId, b.provenance.snapshotId, "jüngster Snapshot");
    assert.equal(snap.asOf, new Date(AS_OF + 2 * TF_MS).toISOString());
    assert.equal(snap.codeVersion, "cross-sectional@1");
    assert.equal(snap.availabilityPolicy, "ingested");
    assert.equal(snap.universeSize, 5);
    assert.equal(snap.rankedCount, 5);
    assert.equal(snap.coverage, 1);
    assert.ok(String(snap.survivorshipNote).length > 50);
    const prov = snap.provenance as Record<string, string>;
    assert.ok(prov.universeHash.startsWith("xu1:"));
    assert.ok(prov.dataHash.startsWith("xd1:"));
    assert.ok(prov.configHash.startsWith("xc1:"));

    const items = body.items as Array<Record<string, unknown>>;
    assert.equal(items.length, 5);
    assert.deepEqual(items.map((i) => [i.rank, i.instrumentId]), [
      [1, "V:A"],
      [2, "V:B"],
      [3, "V:E"],
      [4, "V:C"],
      [5, "V:D"],
    ]);
    assert.equal(items[0].percentile, 1);
    assert.ok(typeof items[0].composite === "number");
    const raw = items[0].rawReturns as Record<string, { total: number; volAdjusted: number | null }>;
    assert.ok(raw.h3.total > 0, "steigende Serie ⇒ positive h3-Total-Rendite");
    assert.equal(raw.h3.volAdjusted, null, "σ=0 ⇒ volAdjusted bleibt NULL");
  });

  it("Point-in-Time über ?asOf: späterer Snapshot ist für frühere Zeitpunkte unsichtbar", async (t) => {
    liveOrSkip(t);
    const atA = await get(`?asOf=${new Date(AS_OF + TF_MS).toISOString()}`);
    assert.equal(atA.status, 200);
    assert.equal((atA.body.snapshot as Record<string, unknown>).asOf, new Date(AS_OF).toISOString());
    const atB = await get(`?asOf=${new Date(AS_OF + 3 * TF_MS).toISOString()}`);
    assert.equal(atB.status, 200);
    assert.equal((atB.body.snapshot as Record<string, unknown>).asOf, new Date(AS_OF + 2 * TF_MS).toISOString());
    const beforeAll = await get(`?asOf=${new Date(AS_OF - 1).toISOString()}`);
    assert.equal(beforeAll.status, 200);
    assert.equal(beforeAll.body.snapshot, null, "vor dem ersten Snapshot: NO_SNAPSHOT");
  });

  it("?instrumentId liefert das Mitglied; ?top begrenzt; ?timeframe filtert", async (t) => {
    liveOrSkip(t);
    const member = await get("?instrumentId=V%3AB");
    assert.equal(member.status, 200);
    const m = member.body.member as Record<string, unknown>;
    assert.equal(m.instrumentId, "V:B");
    assert.equal(m.rank, 2);
    assert.equal(m.percentile, 0.8, "5 Mitglieder, Rang 2 ⇒ (5−2+1)/5 = 0.8");

    const top = await get("?top=2");
    assert.equal((top.body.items as unknown[]).length, 2);

    const wrongTf = await get("?timeframe=4h");
    assert.equal(wrongTf.status, 200);
    assert.equal(wrongTf.body.snapshot, null, "nur 1h-Snapshots vorhanden ⇒ NO_SNAPSHOT");

    const rightTf = await get("?timeframe=1h");
    assert.equal(rightTf.status, 200);
    assert.ok(rightTf.body.snapshot, "1h-Filter findet den Snapshot");
  });

  it("400: ungültige Query-Parameter (asOf, timeframe, top, exclusions)", async (t) => {
    liveOrSkip(t);
    for (const q of ["?asOf=garbage", "?timeframe=3h", "?top=0", `?top=${MAX_TOP + 1}`, "?exclusions=maybe", "?instrumentId=a%20b"]) {
      const { status, body } = await get(q);
      assert.equal(status, 400, `${q} ⇒ 400`);
      assert.equal(body.ok, false);
      assert.equal(body.error, "VALIDATION_ERROR");
      assert.ok(String(body.message).length > 0);
    }
  });
});
