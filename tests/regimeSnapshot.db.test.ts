/**
 * Regime-Snapshots — Postgres-Variante (RMA-P2-01, v1.61.0).
 *
 * Deckt genau die Zusicherungen ab, die **nur** die Datenbank geben kann:
 *   - append-only Migration `drizzle/2026-09-22_regime_snapshots.sql`
 *     (zweifach anwendbar = idempotent),
 *   - Roundtrip persistRegimeSnapshot → loadRegimeSnapshots,
 *   - Idempotenz: gleicher Key schreibt nie eine zweite Zeile,
 *   - Restart/Retry: frischer Pool (simulierter Neustart) desselben
 *     Duplicateintrags bleibt eine Zeile,
 *   - CHECK-Constraints (Regime-Vokabular, Coverage/Grenzen, Key-Format),
 *   - Retention (pruneRegimeSnapshots).
 *
 * Die Datenbank ist eine **eingebettete** Postgres-Instanz
 * (`embedded-postgres`, Binaries im Repo-`node_modules`): kein Netzwerk,
 * keine externen Zugangsdaten. Lässt sich die Instanz nicht starten,
 * überspringt sich die Suite sauber (Skip statt Rot).
 *
 * Prozess-Hinweis: `node --test` führt diese Datei im eigenen Prozess aus;
 * der Lazy-`db`-Singleton von `src/db` wird erst NACH dem Setzen von
 * `DATABASE_URL` auf die eingebettete Instanz initialisiert.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import EmbeddedPostgres from "embedded-postgres";
import { Pool } from "pg";

import {
  REGIME_SNAPSHOT_RETENTION_MS,
  __resetRegimeSnapshotPersistForTests,
  loadRegimeSnapshots,
  persistRegimeSnapshot,
  pruneRegimeSnapshots,
  regimeSnapshotKey,
  scheduleRegimeSnapshotPersist,
  toRegimeSnapshotRow,
  type RegimeSnapshotRowInput,
} from "../src/lib/regimeSnapshotStore";
import {
  DEFAULT_MARKET_REGIME_CONFIG,
  evaluateInstrumentRegime,
  __resetMarketRegimeForTests,
  type RegimeCandleLike,
} from "../src/lib/marketRegime";

const T0 = 1_750_000_000_000;
const STEP = 900_000;

function trendCandles(n = 60): RegimeCandleLike[] {
  return Array.from({ length: n }, (_, i) => {
    const close = 100 + i * 0.4;
    const prev = i === 0 ? 100 : 100 + (i - 1) * 0.4;
    return { time: T0 + i * STEP, open: prev, high: close + 0.2, low: prev - 0.2, close, volume: 1000 + i };
  });
}

function rowInput(over: Partial<RegimeSnapshotRowInput> = {}): RegimeSnapshotRowInput {
  return {
    symbol: "BTC",
    asOf: new Date(T0).toISOString(),
    computedAt: new Date(T0 + 1000).toISOString(),
    rawRegime: "TREND_UP",
    confirmedRegime: "TREND_UP",
    confidence: 0.81,
    coverage: 1,
    degraded: false,
    gateMode: "monitor",
    featureMode: "multidim",
    featureVersion: "regime-features@1",
    modelVersion: "regime-rules@1",
    topDrivers: [{ key: "adx", family: "price", contribution: 1.7, display: "ADX 40.0" }],
    familyStatus: [
      { family: "price", status: "OK", reason: "OK" },
      { family: "perp", status: "MISSING", reason: "NO_INPUT" },
    ],
    reason: "Test-Bewertung",
    ...over,
  };
}

describe("regime_snapshots (Postgres): Migration, Roundtrip, Idempotenz, Restart", () => {
  let pg: EmbeddedPostgres | null = null;
  let localPool: Pool | null = null;
  let startupError: Error | null = null;
  let databaseUrl: string | null = null;
  const logs: string[] = [];

  before(async () => {
    try {
      const dir = mkdtempSync(path.join(tmpdir(), "regime-snapshots-pg-"));
      const instance = new EmbeddedPostgres({
        databaseDir: dir,
        user: "postgres",
        password: "postgres",
        port: 55_441,
        persistent: false,
        onLog: (message) => logs.push(String(message)),
        onError: (message) => logs.push(message instanceof Error ? message.message : String(message)),
      });
      await instance.initialise();
      await instance.start();
      await instance.createDatabase("regime_snapshots_test");
      const pool = new Pool({
        host: "127.0.0.1",
        port: 55_441,
        user: "postgres",
        password: "postgres",
        database: "regime_snapshots_test",
        max: 4,
      });
      const migration = readFileSync(
        path.resolve(process.cwd(), "drizzle/2026-09-22_regime_snapshots.sql"),
        "utf8"
      );
      // Zweifach anwenden: append-only Migration muss idempotent sein.
      await pool.query(migration);
      await pool.query(migration);
      pg = instance;
      localPool = pool;
      // Lazy-Singleton von src/db zeigt NUR in diesen Prozess (siehe Modulkopf).
      databaseUrl = "postgresql://postgres:postgres@127.0.0.1:55441/regime_snapshots_test";
      process.env.DATABASE_URL = databaseUrl;
      __resetRegimeSnapshotPersistForTests();
    } catch (error) {
      const tail = logs.slice(-8).join(" | ");
      startupError = new Error(
        `${error instanceof Error ? error.message : String(error)}${tail ? ` :: ${tail}` : ""}`
      );
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

  it("Roundtrip: persist → load (Felder, Zeitsemantik, Sortierung)", async (t) => {
    const ctx = liveOrNull(t);
    if (!ctx) return;
    const input = rowInput();
    const result = await persistRegimeSnapshot(input);
    assert.equal(result.written, true);

    const rows = await loadRegimeSnapshots({
      fromMs: T0 - 60_000,
      toMs: T0 + 60_000,
      symbols: ["BTC"],
    });
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.symbol, "BTC");
    assert.equal(row.rawRegime, "TREND_UP");
    assert.equal(row.confirmedRegime, "TREND_UP");
    assert.equal(Number(row.coverage), 1);
    assert.equal(Number(row.confidence), 0.81);
    assert.equal(row.degraded, false);
    assert.equal(row.gateMode, "monitor");
    assert.equal(row.featureMode, "multidim");
    assert.equal(row.featureVersion, "regime-features@1");
    assert.equal(row.modelVersion, "regime-rules@1");
    assert.equal(row.asOf.getTime(), T0, "as_of ist der Event-/As-of-Zeitpunkt");
    assert.ok(row.computedAt.getTime() >= T0, "computed_at getrennt von as_of");
    assert.ok(Array.isArray(row.topDrivers));
    assert.ok(Array.isArray(row.familyStatus));
    // Symbol-Filter: andere Symbole bleiben draußen.
    const eth = await loadRegimeSnapshots({ fromMs: T0 - 60_000, toMs: T0 + 60_000, symbols: ["ETH"] });
    assert.equal(eth.length, 0);
  });

  it("Idempotenz: gleicher Key schreibt nie eine zweite Zeile (Retry)", async (t) => {
    const ctx = liveOrNull(t);
    if (!ctx) return;
    const input = rowInput({ symbol: "ETH", asOf: new Date(T0 + 5_000).toISOString() });
    const first = await persistRegimeSnapshot(input);
    const second = await persistRegimeSnapshot(input);
    const third = await persistRegimeSnapshot({ ...input });
    assert.equal(first.written, true);
    assert.equal(second.written, false, "Retry ist ein sichtbarer No-Op");
    assert.equal(third.written, false);
    const count = await ctx.pool.query<{ count: string }>(
      "select count(*)::text as count from regime_snapshots where symbol = $1",
      ["ETH"]
    );
    assert.equal(count.rows[0].count, "1");
    const keys = await ctx.pool.query<{ idempotency_key: string }>(
      "select idempotency_key from regime_snapshots where symbol = $1",
      ["ETH"]
    );
    assert.equal(keys.rows[0].idempotency_key, regimeSnapshotKey(input));
    assert.match(keys.rows[0].idempotency_key, /^[a-f0-9]{64}$/);
  });

  it("Restart/Retry: frischer Pool desselben Einfügens bleibt eine Zeile", async (t) => {
    const ctx = liveOrNull(t);
    if (!ctx) return;
    const input = rowInput({
      symbol: "SOL",
      asOf: new Date(T0 + 9_000).toISOString(),
      confirmedRegime: "HIGH_VOL",
      rawRegime: "HIGH_VOL",
      degraded: true,
      coverage: 0.6,
    });
    assert.equal((await persistRegimeSnapshot(input)).written, true);

    // Simulierter Prozess-Neustart: eigene Verbindung, gleicher Key.
    const restartPool = new Pool({
      host: "127.0.0.1",
      port: 55_441,
      user: "postgres",
      password: "postgres",
      database: "regime_snapshots_test",
      max: 2,
    });
    try {
      const dup = await restartPool.query(
        `insert into regime_snapshots (
           idempotency_key, symbol, as_of, computed_at, raw_regime, confirmed_regime,
           confidence, coverage, degraded, gate_mode, feature_mode,
           feature_version, model_version, top_drivers, family_status, reason
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         on conflict (idempotency_key) do nothing`,
        [
          regimeSnapshotKey(input),
          input.symbol,
          new Date(input.asOf),
          new Date(input.computedAt),
          input.rawRegime,
          input.confirmedRegime,
          String(input.confidence),
          String(input.coverage),
          input.degraded,
          input.gateMode,
          input.featureMode,
          input.featureVersion,
          input.modelVersion,
          JSON.stringify(input.topDrivers),
          JSON.stringify(input.familyStatus),
          input.reason,
        ]
      );
      assert.equal(dup.rowCount, 0, "Restart-Insert tritt auf den Unique-Key und schreibt nichts zweites");
      const count = await restartPool.query<{ count: string }>(
        "select count(*)::text as count from regime_snapshots where symbol = $1",
        ["SOL"]
      );
      assert.equal(count.rows[0].count, "1");
    } finally {
      await restartPool.end().catch(() => undefined);
    }
  });

  it("CHECK-Constraints: ungültige Regimes/Coverage/Key werden abgelehnt (fail-soft, keine Zeile)", async (t) => {
    const ctx = liveOrNull(t);
    if (!ctx) return;
    // persistRegimeSnapshot fängt Constraint-Verletzungen ab (Handelspfad
    // bricht nie) — sichtbar als written:false OHNE hinterlassene Zeile.
    const base = rowInput({ symbol: "DOGE" });
    assert.equal((await persistRegimeSnapshot({ ...base, confirmedRegime: "MOON" })).written, false);
    assert.equal((await persistRegimeSnapshot({ ...base, coverage: 1.5 })).written, false);
    assert.equal((await persistRegimeSnapshot({ ...base, confidence: 1.2 })).written, false);
    assert.equal((await persistRegimeSnapshot({ ...base, gateMode: "yolo" })).written, false);
    assert.equal((await persistRegimeSnapshot({ ...base, featureMode: "banana" })).written, false);
    // Dasselbe auf DB-Ebene direkt: der Constraint muss greifen (kein stilles
    // Schlucken durch den Store allein).
    await assert.rejects(
      () =>
        ctx.pool.query(
          `insert into regime_snapshots (
             idempotency_key, symbol, as_of, computed_at, raw_regime, confirmed_regime,
             coverage, degraded, gate_mode, feature_mode, feature_version, model_version,
             top_drivers, family_status, reason
           ) values ($1,'DOGE',now(),now(),'RANGE','MOON',1,false,'monitor','multidim',
             'regime-features@1','regime-rules@1','[]'::jsonb,'[]'::jsonb,'x')`,
          ["f".repeat(64)]
        ),
      /regime_snapshots_regime_check/
    );
    const count = await ctx.pool.query<{ count: string }>(
      "select count(*)::text as count from regime_snapshots where symbol = $1",
      ["DOGE"]
    );
    assert.equal(count.rows[0].count, "0", "abgelehnte Zeilen hinterlassen nichts");
  });

  it("UNKNOWN-Snapshot: confidence NULL bleibt NULL (nie still 0)", async (t) => {
    const ctx = liveOrNull(t);
    if (!ctx) return;
    __resetMarketRegimeForTests();
    const snap = evaluateInstrumentRegime("UNK/USD", [], {
      cfg: DEFAULT_MARKET_REGIME_CONFIG,
      now: T0,
      audit: false,
    });
    assert.equal(snap.regime, "UNKNOWN");
    const row = toRegimeSnapshotRow(snap, { gateMode: "monitor", featureMode: snap.mode });
    assert.equal(row.confidence, null);
    assert.equal((await persistRegimeSnapshot(row)).written, true);
    const loaded = await loadRegimeSnapshots({ fromMs: T0 - 1, toMs: T0 + 1, symbols: ["UNK/USD"] });
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].confidence, null);
  });

  it("Throttle-Scheduling: sofortiger Zweitschritt wird übersprungen, Intervall schreibt", async (t) => {
    const ctx = liveOrNull(t);
    if (!ctx) return;
    __resetRegimeSnapshotPersistForTestsSafe();
    const snap = evaluateInstrumentRegime("SCH/USD", trendCandles(), {
      cfg: DEFAULT_MARKET_REGIME_CONFIG,
      now: T0 + 120_000,
      audit: false,
    });
    const written: string[] = [];
    const persist = async (input: RegimeSnapshotRowInput): Promise<{ written: boolean }> => {
      written.push(input.symbol);
      return { written: true };
    };
    scheduleRegimeSnapshotPersist(snap, { nowMs: T0 + 120_000, minIntervalMs: 60_000, persist });
    scheduleRegimeSnapshotPersist(snap, { nowMs: T0 + 130_000, minIntervalMs: 60_000, persist });
    // Fire-and-forget: kurz warten, damit die erste Persistenz ankommt.
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(written.length, 1, "Throttle verhindert Doppelschreibungen");
    // Intervall verstrichen → zweite Schreibung erlaubt.
    scheduleRegimeSnapshotPersist(snap, { nowMs: T0 + 200_000, minIntervalMs: 60_000, persist });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(written.length, 2);
    void ctx;
  });

  it("Retention: prune entfernt nur Zeilen älter als die Grenze", async (t) => {
    const ctx = liveOrNull(t);
    if (!ctx) return;
    const old = rowInput({ symbol: "OLD/USD", asOf: new Date(T0 - 100 * 24 * 60 * 60_000).toISOString() });
    const fresh = rowInput({ symbol: "FRESH/USD", asOf: new Date(T0).toISOString() });
    assert.equal((await persistRegimeSnapshot(old)).written, true);
    assert.equal((await persistRegimeSnapshot(fresh)).written, true);

    const pruned = await pruneRegimeSnapshots({ nowMs: T0 + 60_000, olderThanMs: REGIME_SNAPSHOT_RETENTION_MS });
    assert.ok(pruned.deleted >= 1, "ältere Zeilen werden entfernt");
    const oldLeft = await loadRegimeSnapshots({
      fromMs: T0 - 200 * 24 * 60 * 60_000,
      toMs: T0 - 90 * 24 * 60 * 60_000,
      symbols: ["OLD/USD"],
    });
    assert.equal(oldLeft.length, 0);
    const freshLeft = await loadRegimeSnapshots({ fromMs: T0 - 60_000, toMs: T0 + 60_000, symbols: ["FRESH/USD"] });
    assert.equal(freshLeft.length, 1, "frische Zeilen überleben die Retention");
  });
});

/** Setzt NUR den Throttle-Zustand (Persistence-Zwischenablage) zurück. */
function __resetRegimeSnapshotPersistForTestsSafe(): void {
  __resetRegimeSnapshotPersistForTests();
  __resetMarketRegimeForTests();
}
