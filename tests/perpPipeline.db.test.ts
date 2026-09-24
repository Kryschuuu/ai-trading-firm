/**
 * Perp-Ablage in Postgres (RMA-P2-02) — was nur die Datenbank beweisen kann:
 * UNIQUE-/CHECK-Constraints, Transaktionsatomarität, Replay-Idempotenz gegen
 * die echten Tabellen, Revisionsschutz und der as-of-Lesepfad.
 *
 * Wie `tests/featureStore.db.test.ts` gegen eine **eingebettete** Instanz
 * (`embedded-postgres`, Binaries im Repo-`node_modules`): kein Netzwerk, keine
 * Zugangsdaten aus der Umgebung. Startet sie nicht, überspringt die Suite
 * sauber — die restliche Testsuite bleibt grün.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import EmbeddedPostgres from "embedded-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { loadPerpConfig } from "../src/perpdata/config";
import { PerpStore, perpRunIdempotencyKey, type PerpDb } from "../src/perpdata/store";
import { syncPerpVenue } from "../src/perpdata/sync";
import { createFixturePerpAdapter } from "../src/perpdata/adapters/fixture";
import { normalizeFundingRow, normalizeOpenInterestRow, type PerpNormalizeContext } from "../src/perpdata/normalize";
import type { PerpCommit, PerpRunRecord } from "../src/perpdata/ports";
import type { MarketInstrument } from "../src/universe/types";

const NOW = new Date("2026-09-20T12:00:00.000Z");
const NOW_MS = NOW.getTime();
const HOUR = 3_600_000;
const INTERVAL = 8 * HOUR;
/** Fester Bezugspunkt (identische Werte bei jedem Lauf). */
const T0 = NOW_MS - 4 * INTERVAL;

const ENV = {
  PERP_DATA_ENABLED: "true",
  PERP_DATA_SYNC_ENABLED: "true",
  PERP_DATA_VENUES: "SIM",
  PERP_DATA_SAFETY_LAG_MS: "0",
} as const;

const BTC: MarketInstrument = {
  id: "SIM:BTCUSDT",
  venue: "SIM",
  symbol: "BTCUSDT",
  base: "BTC",
  quote: "USDT",
  assetClass: "crypto",
  marketType: "perpetual",
  status: "active",
  minQuantity: 0.001,
  priceStep: 0.1,
  quantityStep: 0.001,
  makerFee: 0.0002,
  takerFee: 0.0006,
  leverageAvailable: true,
  shortAvailable: true,
  paperAvailable: true,
  liveTradable: false,
  liveAvailable: false,
  volume24h: null,
  spread: null,
  bookDepthUsd: null,
  volatility: null,
  lastSeen: NOW.toISOString(),
};

function ctx(overrides: Partial<PerpNormalizeContext> = {}): PerpNormalizeContext {
  return {
    venue: "SIM",
    instrumentId: BTC.id,
    symbol: BTC.symbol,
    sourceId: "sim:v1",
    fetchedAt: NOW,
    availabilityPolicy: "ingested",
    maxAbsFundingRate: 0.0075,
    ...overrides,
  };
}

function fundingRowAt(eventMs: number, rate: number | string | null, fetchedAt: Date = NOW) {
  return normalizeFundingRow({ eventTime: eventMs, fundingRate: rate, intervalHours: 8 }, 0, ctx({ fetchedAt })).row!;
}

function runRecord(idempotencyKey: string, overrides: Partial<PerpRunRecord> = {}): PerpRunRecord {
  return {
    id: crypto.randomUUID(),
    idempotencyKey,
    venue: "SIM",
    mode: "BACKFILL",
    status: "SUCCEEDED",
    availabilityPolicy: "ingested",
    fromTs: new Date(T0),
    toTs: new Date(NOW_MS),
    kinds: ["funding", "openInterest"],
    instrumentIds: [BTC.id],
    counts: {},
    capabilities: {
      funding: { supported: true, sourceId: "sim:funding" },
      openInterest: { supported: true, sourceId: "sim:oi" },
      liquidations: { supported: true, sourceId: "sim:liq" },
    },
    failures: [],
    codeVersion: "1.54.0-test",
    errorCode: null,
    startedAt: NOW,
    finishedAt: NOW,
    ...overrides,
  };
}

describe("perpStore (Postgres): Constraints, Idempotenz, Punkt-für-Punkt-Lesen", () => {
  let pg: EmbeddedPostgres | null = null;
  let pool: Pool | null = null;
  let store: PerpStore | null = null;
  let dir = "";
  let startupError: Error | null = null;
  const logs: string[] = [];

  interface LiveDb {
    store: PerpStore;
    pool: Pool;
  }

  /** Zugriff auf die eingebettete Datenbank — oder sauberer Skip. */
  function liveOrNull(t: { skip: (reason?: string) => void }): LiveDb | null {
    if (!store || !pool) {
      t.skip(`eingebettete Postgres nicht verfügbar: ${startupError?.message ?? "unbekannt"}`);
      return null;
    }
    return { store, pool };
  }

  async function count(pool_: Pool, table: string, where = ""): Promise<number> {
    const result = await pool_.query(`SELECT count(*)::int AS n FROM ${table}${where ? ` WHERE ${where}` : ""}`);
    return Number((result.rows[0] as { n: number | string }).n);
  }

  before(async () => {
    try {
      dir = mkdtempSync(path.join(tmpdir(), "perp-store-pg-"));
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
      await instance.createDatabase("perp_store_test");
      const localPool = new Pool({
        host: "127.0.0.1",
        port: 55_434,
        user: "postgres",
        password: "postgres",
        database: "perp_store_test",
        max: 4,
      });
      const migration = readFileSync(path.resolve(process.cwd(), "drizzle/2026-09-20_perpetual_data.sql"), "utf8");
      await localPool.query(migration);
      pg = instance;
      pool = localPool;
      store = new PerpStore({
        db: drizzle(localPool) as unknown as PerpDb,
        audit: async () => undefined,
        now: () => NOW,
      });
    } catch (error) {
      const tail = logs.slice(-8).join(" | ");
      startupError = new Error(`${error instanceof Error ? error.message : String(error)}${tail ? ` :: ${tail}` : ""}`);
    }
  });

  after(async () => {
    if (pool) await pool.end().catch(() => undefined);
    if (pg) await pg.stop().catch(() => undefined);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("Roundtrip: geschriebene Sätze kommen unverändert (und as-of-gefiltert) zurück", async (t) => {
    const ctxLive = liveOrNull(t);
    if (!ctxLive) return;
    const rows = [fundingRowAt(T0, "0.000125", new Date(T0)), fundingRowAt(T0 + INTERVAL, -0.0002, new Date(T0 + INTERVAL))];
    const result = await ctxLive.store.commitRun({
      run: runRecord("prk1:roundtrip-1"),
      batch: { funding: rows, openInterest: [], liquidations: [] },
      cursors: [
        {
          venue: "SIM",
          instrumentId: BTC.id,
          kind: "funding",
          watermarkEventTime: new Date(T0 + INTERVAL),
          watermarkAvailableAt: NOW,
          lastRunId: null,
          consecutiveFailures: 0,
          lastStatus: "OK",
          unsupportedReason: null,
        },
      ],
    });
    assert.equal(result.created, true);
    assert.equal(result.inserted.funding, 2);
    assert.equal(await count(ctxLive.pool, "perp_funding_rates"), 2);

    const read = await ctxLive.store.readFunding({
      venue: "SIM",
      instrumentIds: [BTC.id],
      kinds: ["funding"],
      fromMs: null,
      toMs: null,
      asOfMs: NOW_MS,
      limit: 50,
      qualityMode: "log",
    });
    assert.equal(read.length, 2);
    const byTime = new Map(read.map((row) => [row.eventTime.getTime(), row]));
    assert.equal(byTime.get(T0)?.fundingRate, 0.000125, "Dezimalstelle 8 bleibt erhalten (numeric, kein Float)");
    assert.equal(byTime.get(T0 + INTERVAL)?.fundingRate, -0.0002, "Vorzeichen überlebt die Ablage");
    assert.equal(byTime.get(T0)?.unit, "fraction_per_interval");

    // as-of eine Stunde vor dem zweiten Settlement: nur der ältere Satz.
    const asOfEarlier = await ctxLive.store.readFunding({
      venue: "SIM",
      instrumentIds: [BTC.id],
      kinds: ["funding"],
      fromMs: null,
      toMs: null,
      asOfMs: T0 + INTERVAL - 1,
      limit: 50,
      qualityMode: "log",
    });
    assert.equal(asOfEarlier.length, 1);
    assert.equal(asOfEarlier[0]?.eventTime.getTime(), T0);
  });

  it("Replay desselben Laufs schreibt nichts (Idempotenzschlüssel)", async (t) => {
    const ctxLive = liveOrNull(t);
    if (!ctxLive) return;
    const key = perpRunIdempotencyKey({
      venue: "SIM",
      mode: "BACKFILL",
      fromMs: T0,
      toMs: NOW_MS,
      instrumentIds: [BTC.id],
      kinds: ["funding"],
      availabilityPolicy: "ingested",
      codeVersion: "1.54.0-test",
    });
    const first = await ctxLive.store.commitRun({
      run: runRecord(key, { kinds: ["funding"] }),
      batch: { funding: [fundingRowAt(T0 + 3 * INTERVAL, 0.0003)], openInterest: [], liquidations: [] },
      cursors: [],
    });
    const second = await ctxLive.store.commitRun({
      run: runRecord(key, { kinds: ["funding"] }),
      batch: { funding: [fundingRowAt(T0 + 3 * INTERVAL, 0.0009)], openInterest: [], liquidations: [] },
      cursors: [],
    });
    assert.equal(first.created, true);
    assert.equal(second.created, false, "zweiter Lauf mit gleichem Schlüssel ist ein Replay");
    assert.equal(second.inserted.funding, 0);
    const rows = await ctxLive.pool.query("SELECT funding_rate FROM perp_funding_rates WHERE event_time = $1", [new Date(T0 + 3 * INTERVAL).toISOString()]);
    assert.equal(rows.rowCount, 1);
    assert.equal(Number(rows.rows[0].funding_rate), 0.0003, "das Replay überschreibt den ersten Satz nicht");
  });

  it("natürlicher Schlüssel + Wert-Grund-Check: die Datenbank lehnt Unsinn ab", async (t) => {
    const ctxLive = liveOrNull(t);
    if (!ctxLive) return;
    // Derselbe (venue, instrument, event_time) ein zweites Mal ⇒ UNIQUE-Index.
    await assert.rejects(
      ctxLive.pool.query(
        `INSERT INTO perp_funding_rates
           (venue, instrument_id, symbol, source_id, schema_version, event_time, available_at, fetched_at, funding_rate, interval_hours, unit, quality_status, content_hash)
         VALUES ('SIM','SIM:BTCUSDT','BTCUSDT','sim:v1',1,$1,$1,$1,0.0005,8,'fraction_per_interval','OK',$2)`,
        [new Date(T0).toISOString(), "pv1:" + "a".repeat(64)]
      ),
      /duplicate key|perp_funding_rates_key_unique/i
    );
    // Kein Wert und kein Grund ⇒ CHECK-Verstoß (0 ist eine Aussage, kein Fallback).
    await assert.rejects(
      ctxLive.pool.query(
        `INSERT INTO perp_funding_rates
           (venue, instrument_id, symbol, source_id, schema_version, event_time, available_at, fetched_at, funding_rate, unit, quality_status, content_hash)
         VALUES ('SIM','SIM:BTCUSDT','BTCUSDT','sim:v1',1,$1,$1,$1,NULL,'fraction_per_interval','OK',$2)`,
        [new Date(T0 + 100 * INTERVAL).toISOString(), "pv1:" + "b".repeat(64)]
      ),
      /violates check constraint/i
    );
    // `available_at < event_time` (Look-ahead) ist ebenfalls gesperrt.
    await assert.rejects(
      ctxLive.pool.query(
        `INSERT INTO perp_funding_rates
           (venue, instrument_id, symbol, source_id, schema_version, event_time, available_at, fetched_at, funding_rate, unit, quality_status, content_hash)
         VALUES ('SIM','SIM:BTCUSDT','BTCUSDT','sim:v1',1,$1,$2,$1,0.0001,'fraction_per_interval','OK',$3)`,
        [new Date(T0 + 101 * INTERVAL).toISOString(), new Date(T0).toISOString(), "pv1:" + "c".repeat(64)]
      ),
      /violates check constraint/i
    );
  });

  it("Revision: abweichender Satz zum selben Schlüssel überschreibt nichts", async (t) => {
    const ctxLive = liveOrNull(t);
    if (!ctxLive) return;
    const eventMs = T0 + 2 * INTERVAL;
    const commitFor = (key: string) => {
      const row = fundingRowAt(eventMs, 0.0004);
      return ctxLive.store.commitRun({
        run: runRecord(key, { kinds: ["funding"] }),
        batch: { funding: [{ ...row, contentHash: "pv1:" + "0".repeat(64) }], openInterest: [], liquidations: [] },
        cursors: [],
      });
    };
    const first = await commitFor("prk1:revision-a");
    assert.equal(first.created, true);
    const inserted = await ctxLive.pool.query("SELECT funding_rate FROM perp_funding_rates WHERE event_time = $1", [new Date(eventMs).toISOString()]);
    assert.equal(inserted.rows.length, 1);
    // Gleicher Schlüssel, anderer Inhalt ⇒ als Revision gemeldet, Original bleibt.
    const diverging = fundingRowAt(eventMs, 0.0077);
    const second = await ctxLive.store.commitRun({
      run: runRecord("prk1:revision-b", { kinds: ["funding"] }),
      batch: { funding: [diverging], openInterest: [], liquidations: [] },
      cursors: [],
    });
    assert.equal(second.inserted.funding, 0, "append-only: kein UPDATE auf eine bestehende Zeile");
    assert.equal(second.revisionConflicts, 1, "die Abweichung ist ein zählbarer Befund");
    const after = await ctxLive.pool.query("SELECT funding_rate FROM perp_funding_rates WHERE event_time = $1", [new Date(eventMs).toISOString()]);
    assert.equal(after.rows.length, 1);
    assert.equal(Number(after.rows[0].funding_rate), Number(inserted.rows[0].funding_rate), "der alte Satz bleibt stehen");
  });

  it("Cursor überlebt einen Neustart; der Increment läuft ab Wasserstand, ohne Duplikate", async (t) =>
    {
      const ctxLive = liveOrNull(t);
      if (!ctxLive) return;
      const config = loadPerpConfig(ENV);
      const adapter = createFixturePerpAdapter({ profile: {}, now: () => NOW });
      const first = await syncPerpVenue({
        venue: "SIM",
        adapter,
        store: ctxLive.store,
        config,
        instruments: [BTC],
        mode: "BACKFILL",
        now: () => NOW,
        sleep: async () => undefined,
        writeQualityArtifact: false,
      });
      assert.notEqual(first[0].status, "FAILED", `Lauf 1 fehlgeschlagen: ${JSON.stringify(first[0].failures.slice(0, 2))}`);
      const rowsAfterFirst = await count(ctxLive.pool, "perp_funding_rates");
      assert.ok(rowsAfterFirst > 0);

      // Neuer Store auf derselben Datenbank = Prozessneustart: der Wasserstand
      // kommt aus `perp_sync_cursors`, nicht aus Speicher.
      const restarted = new PerpStore({
        db: drizzle(ctxLive.pool) as unknown as PerpDb,
        audit: async () => undefined,
        now: () => NOW,
      });
      const cursors = await restarted.readCursors({ venue: "SIM", instrumentIds: [BTC.id] });
      assert.ok(cursors.some((cursor) => cursor.kind === "funding" && cursor.watermarkEventTime.getTime() > T0), "Wasserstand ist persistiert");

      // Zweiter Backfill über dasselbe Fenster: gleicher Idempotenzschlüssel ⇒
      // Replay; und gäbe es neue Sätze, würden die UNIQUE-Keys greifen.
      const second = await syncPerpVenue({
        venue: "SIM",
        adapter: createFixturePerpAdapter({ profile: {}, now: () => NOW }),
        store: restarted,
        config,
        instruments: [BTC],
        mode: "BACKFILL",
        now: () => NOW,
        sleep: async () => undefined,
        writeQualityArtifact: false,
      });
      assert.equal(second[0].replayed, true, "derselbe Lauf wird als Replay erkannt");
      assert.equal(await count(ctxLive.pool, "perp_funding_rates"), rowsAfterFirst, "kein einziger Satz doppelt");
      const dupes = await ctxLive.pool.query(
        `SELECT count(*) AS n FROM (
           SELECT venue, instrument_id, event_time FROM perp_funding_rates
           GROUP BY 1,2,3 HAVING count(*) > 1
         ) d`
      );
      assert.equal(Number((dupes.rows[0] as { n: string }).n), 0, "UNIQUE-Schlüssel hält, was er verspricht");
    });

  it("späte Verfügbarkeit bleibt hinter der as-of-Grenze verborgen", async (t) => {
    const ctxLive = liveOrNull(t);
    if (!ctxLive) return;
    const eventMs = T0 + 5 * HOUR;
    const late = normalizeFundingRow({ eventTime: eventMs, fundingRate: 0.0006, intervalHours: 8 }, 0, ctx({ fetchedAt: new Date(NOW_MS + 6 * HOUR) })).row!;
    assert.equal(late.availableAt.getTime(), NOW_MS + 6 * HOUR, "ingested-Politik: verfügbar ab Abruf");
    await ctxLive.store.commitRun({
      run: runRecord("prk1:late-availability"),
      batch: { funding: [late], openInterest: [], liquidations: [] },
      cursors: [],
    });
    const before = await ctxLive.store.readFunding({
      venue: "SIM",
      instrumentIds: [BTC.id],
      kinds: ["funding"],
      fromMs: null,
      toMs: null,
      asOfMs: NOW_MS,
      limit: 200,
      qualityMode: "log",
    });
    assert.equal(before.some((row) => row.eventTime.getTime() === eventMs), false, "Satz vor seiner Verfügbarkeit ist unsichtbar");
    const after = await ctxLive.store.readFunding({
      venue: "SIM",
      instrumentIds: [BTC.id],
      kinds: ["funding"],
      fromMs: null,
      toMs: null,
      asOfMs: NOW_MS + 7 * HOUR,
      limit: 200,
      qualityMode: "log",
    });
    assert.equal(after.some((row) => row.eventTime.getTime() === eventMs), true, "danach lesbar");
  });

  it("Ablage-Fehler wird klassifiziert gemeldet, nie als leerer Bestand", async (t) => {
    const ctxLive = liveOrNull(t);
    if (!ctxLive) return;
    const broken = new PerpStore({
      db: {
        select: () => {
          throw new Error("connection terminated unexpectedly");
        },
      } as unknown as PerpDb,
      audit: async () => undefined,
      now: () => NOW,
    });
    await assert.rejects(
      broken.coverage(NOW_MS, "SIM"),
      (error: Error) => /perp:store_unavailable|Ablage/i.test(error.message),
      "Ausfall != leer"
    );
  });

  it("Retention räumt Manifeste, nie Datenzeilen", async (t) => {
    const ctxLive = liveOrNull(t);
    if (!ctxLive) return;
    for (let index = 0; index < 3; index += 1) {
      await ctxLive.store.commitRun({
        run: runRecord(`prk1:retention-${index}`, { status: "SUCCEEDED" }),
        batch: { funding: [], openInterest: [normalizeOpenInterestRow({ eventTime: T0 + index * HOUR, quoteValue: 1_000_000 + index, basis: "quote_units", quoteCurrency: "USDT" }, 0, ctx()).row!], liquidations: [] },
        cursors: [],
      });
    }
    const before = await count(ctxLive.pool, "perp_open_interest");
    const pruned = await ctxLive.store.pruneRuns(1);
    assert.ok(pruned >= 2, `mindestens zwei Manifeste entfernt, war ${pruned}`);
    assert.equal(await count(ctxLive.pool, "perp_open_interest"), before, "Datenzeilen bleiben vollständig");
  });
});
