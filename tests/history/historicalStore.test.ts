/**
 * Tests des Historical Store mit Timeframe-Dimension (Schema v2).
 *
 * Kerninvarianten:
 *   - Timeframes werden nie gemischt (logischer Schlüssel instrumentId+tf+ts)
 *   - deterministische Deduplizierung (jüngstes fetchedAt gewinnt)
 *   - query() verlangt timeframe (Compile + Runtime-Guard)
 *   - robuster Loader (fehlende Datei, kaputte Zeilen, Legacy-Zeilen)
 *   - append ist idempotent
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  HistoricalStore,
  HistoricalStoreError,
  HISTORY_SCHEMA_VERSION,
  LEGACY_UNKNOWN,
  parseCandleLine,
} from "../../src/lib/marketdata/historicalStore";
import type { MarketCandle } from "../../src/lib/marketdata/types";

let dir: string;

function makeStore(maxBars?: number): HistoricalStore {
  return new HistoricalStore(dir, maxBars !== undefined ? { maxBarsPerSeries: maxBars } : {});
}

function bars(tsStart: number, n: number, stepMs = 3_600_000, close0 = 100): MarketCandle[] {
  const out: MarketCandle[] = [];
  for (let i = 0; i < n; i++) {
    const close = close0 + i;
    out.push({ time: tsStart + i * stepMs, open: close - 0.5, high: close + 1, low: close - 1, close, volume: 1000 + i });
  }
  return out;
}

const NOW = new Date("2026-08-29T00:00:00.000Z");
const PROV = { venue: "BITUNIX", feed: "BITUNIX:rest" };
const ID = "BITUNIX:BTCUSDT";

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "history-store-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("historical store never mixes timeframes", () => {
  const store = makeStore();
  const candles5m = bars(1_700_000_000_000, 10, 300_000);
  const candles1h = bars(1_700_000_000_000, 10, 3_600_000);
  store.append(candles5m, ID, PROV, "5m", NOW);
  store.append(candles1h, ID, PROV, "1h", NOW);

  assert.equal(store.query({ instrumentId: ID, timeframe: "5m" }).length, candles5m.length);
  assert.equal(store.query({ instrumentId: ID, timeframe: "1h" }).length, candles1h.length);
  // Jede Reihe hat ihre eigenen ts-Werte (5m-Schritt vs 1h-Schritt).
  const five = store.query({ instrumentId: ID, timeframe: "5m" });
  assert.deepEqual(
    five.map((c) => c.ts),
    candles5m.map((c) => c.time),
  );
});

test("duplicate bars with same instrumentId+timeframe+ts are deduplicated", () => {
  const store = makeStore();
  const data = bars(1_700_000_000_000, 5);
  const r1 = store.append(data, ID, PROV, "1h", NOW);
  assert.equal(r1.written, 5);
  assert.equal(r1.deduplicated, 0);
  // Gleicher Batch erneut: keine neue Zeile.
  const r2 = store.append(data, ID, PROV, "1h", NOW);
  assert.equal(r2.written, 0);
  assert.equal(r2.deduplicated, 5);
  assert.equal(store.query({ instrumentId: ID, timeframe: "1h" }).length, 5);
});

test("newest fetchedAt wins on duplicate key", () => {
  const store = makeStore();
  const older = bars(1_700_000_000_000, 3, 3_600_000, 100);
  const newer = bars(1_700_000_000_000, 3, 3_600_000, 200); // gleiche ts, anderer close
  store.append(older, ID, PROV, "1h", new Date("2026-08-01T00:00:00.000Z"));
  const r = store.append(newer, ID, PROV, "1h", new Date("2026-08-20T00:00:00.000Z"));
  assert.equal(r.written, 0);
  assert.equal(r.deduplicated, 3);
  const got = store.query({ instrumentId: ID, timeframe: "1h" });
  assert.equal(got.length, 3);
  // Neuere Version (close ab 200) hat die ältere überschrieben.
  assert.deepEqual(
    got.map((c) => c.close),
    [200, 201, 202],
  );
});

test("older fetchedAt does NOT overwrite newer on duplicate key", () => {
  const store = makeStore();
  const newer = bars(1_700_000_000_000, 2, 3_600_000, 200);
  const older = bars(1_700_000_000_000, 2, 3_600_000, 100);
  store.append(newer, ID, PROV, "1h", new Date("2026-08-20T00:00:00.000Z"));
  store.append(older, ID, PROV, "1h", new Date("2026-08-01T00:00:00.000Z"));
  const got = store.query({ instrumentId: ID, timeframe: "1h" });
  assert.deepEqual(
    got.map((c) => c.close),
    [200, 201],
    "die neuere Fassung bleibt erhalten",
  );
});

test("same ts in different timeframes are both preserved", () => {
  const store = makeStore();
  const ts = 1_700_000_000_000;
  store.append(bars(ts, 1, 300_000, 100), ID, PROV, "5m", NOW);
  store.append(bars(ts, 1, 3_600_000, 200), ID, PROV, "1h", NOW);
  assert.equal(store.query({ instrumentId: ID, timeframe: "5m" }).length, 1);
  assert.equal(store.query({ instrumentId: ID, timeframe: "1h" }).length, 1);
  assert.equal(store.query({ instrumentId: ID, timeframe: "5m" })[0].close, 100);
  assert.equal(store.query({ instrumentId: ID, timeframe: "1h" })[0].close, 200);
  assert.equal(store.readAll().length, 2, "beide Reihen bleiben persistent");
});

test("query returns bars sorted ascending by ts", () => {
  const store = makeStore();
  const data = bars(1_700_000_000_000, 8);
  store.append([...data].reverse(), ID, PROV, "1h", NOW); // unsortiert schreiben
  const got = store.query({ instrumentId: ID, timeframe: "1h" });
  const ts = got.map((c) => c.ts);
  assert.deepEqual(ts, [...ts].sort((a, b) => a - b));
});

test("query limit returns the most recent N bars (sorted asc)", () => {
  const store = makeStore();
  const data = bars(1_700_000_000_000, 10);
  store.append(data, ID, PROV, "1h", NOW);
  const got = store.query({ instrumentId: ID, timeframe: "1h", limit: 3 });
  assert.equal(got.length, 3);
  // Die drei jüngsten Bars …
  const allTs = data.map((c) => c.time);
  assert.deepEqual(
    got.map((c) => c.ts),
    allTs.slice(-3),
    "… und aufsteigend sortiert",
  );
});

test("from/to filter is inclusive on both boundaries", () => {
  const store = makeStore();
  const data = bars(1_700_000_000_000, 5, 3_600_000);
  store.append(data, ID, PROV, "1h", NOW);
  const ts = data.map((c) => c.time);
  const got = store.query({ instrumentId: ID, timeframe: "1h", from: ts[1], to: ts[3] });
  assert.deepEqual(
    got.map((c) => c.ts),
    [ts[1], ts[2], ts[3]],
    "Grenzen sind inklusive",
  );
});

test("missing file yields empty array without throwing", () => {
  const store = new HistoricalStore(path.join(dir, "gibt-es-nicht"));
  assert.doesNotThrow(() => store.query({ instrumentId: ID, timeframe: "1h" }));
  assert.deepEqual(store.query({ instrumentId: ID, timeframe: "1h" }), []);
  assert.equal(store.count(), 0);
});

test("query without timeframe throws (runtime guard for JS callers)", () => {
  const store = makeStore();
  store.append(bars(1_700_000_000_000, 2), ID, PROV, "1h", NOW);
  assert.throws(
    () => store.query({ instrumentId: ID } as never),
    (e: unknown) => {
      assert.ok(e instanceof HistoricalStoreError);
      assert.equal((e as HistoricalStoreError).code, "QUERY_REQUIRES_TIMEFRAME");
      assert.match((e as Error).message, /ohne timeframe ist nicht zulaessig/);
      assert.match((e as Error).message, /timeframe: "15m"/);
      return true;
    },
  );
});

test("append with invalid timeframe throws", () => {
  const store = makeStore();
  assert.throws(
    () => store.append(bars(1_700_000_000_000, 1), ID, PROV, "99x" as never, NOW),
    (e: unknown) => {
      assert.ok(e instanceof HistoricalStoreError);
      assert.equal((e as HistoricalStoreError).code, "INVALID_TIMEFRAME");
      return true;
    },
  );
});

test("corrupted line is skipped and logged, remaining lines load", () => {
  const store = makeStore();
  store.append(bars(1_700_000_000_000, 2), ID, PROV, "1h", NOW);
  // Kaputte + gültige Zeile anhängen.
  const valid = JSON.stringify({
    v: HISTORY_SCHEMA_VERSION,
    instrumentId: ID,
    venue: "BITUNIX",
    feed: "BITUNIX:rest",
    timeframe: "1h",
    ts: 1_700_000_000_000 + 5 * 3_600_000,
    open: 1,
    high: 2,
    low: 0.5,
    close: 1.5,
    volume: 9,
    fetchedAt: NOW.toISOString(),
  });
  // (appendFileSync siehe Top-Level-Import)
  appendFileSync(store.filePath, "{ das ist kein json\n" + valid + "\n", "utf8");

  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (m: string) => warnings.push(String(m));
  try {
    const got = store.query({ instrumentId: ID, timeframe: "1h" });
    assert.equal(got.length, 3, "kaputte Zeile übersprungen, beide gültigen geladen");
  } finally {
    console.warn = origWarn;
  }
  assert.ok(warnings.some((w) => w.includes("kaputte") || w.includes("ungültige")));
});

test("legacy rows (without timeframe) are marked and never returned by query", () => {
  const store = makeStore();
  // v1-Zeile ohne timeframe schreiben.
  const legacy = JSON.stringify({
    instrumentId: ID,
    venue: "BITUNIX",
    feed: "old",
    ts: 1_700_000_000_000,
    open: 1,
    high: 2,
    low: 0.5,
    close: 1.5,
    volume: 9,
    fetchedAt: "2025-01-01T00:00:00.000Z",
  });
  // (appendFileSync siehe Top-Level-Import)
  // (mkdirSync siehe Top-Level-Import)
  mkdirSync(store.dir, { recursive: true });
  appendFileSync(store.filePath, legacy + "\n", "utf8");

  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (m: string) => warnings.push(String(m));
  let stats;
  try {
    const loaded = store.loadAll();
    stats = loaded.stats;
  } finally {
    console.warn = origWarn;
  }
  assert.equal(stats.legacy, 1);
  assert.equal(stats.valid, 0);
  // Timeframe-Queries liefern die Legacy-Bars NICHT.
  assert.deepEqual(store.query({ instrumentId: ID, timeframe: "1h" }), []);
  assert.deepEqual(store.query({ instrumentId: ID, timeframe: "15m" }), []);
  assert.ok(warnings.some((w) => w.includes("Legacy-Schema") && w.includes("npm run history:migrate")));
});

test("append is idempotent: appending same bars twice leaves count unchanged", () => {
  const store = makeStore();
  const data = bars(1_700_000_000_000, 6);
  store.append(data, ID, PROV, "1h", NOW);
  const afterFirst = store.query({ instrumentId: ID, timeframe: "1h" }).length;
  store.append(data, ID, PROV, "1h", NOW);
  store.append(data, ID, PROV, "1h", NOW);
  assert.equal(store.query({ instrumentId: ID, timeframe: "1h" }).length, afterFirst);
  assert.equal(store.count(ID, "1h"), afterFirst);
});

test("written rows carry schema version v2 and timeframe", () => {
  const store = makeStore();
  store.append(bars(1_700_000_000_000, 1), ID, PROV, "15m", NOW);
  // (readFileSync siehe Top-Level-Import)
  const line = JSON.parse(readFileSync(store.filePath, "utf8").trim().split("\n")[0]);
  assert.equal(line.v, HISTORY_SCHEMA_VERSION);
  assert.equal(line.timeframe, "15m");
  assert.equal(line.instrumentId, ID);
});

test("maxBarsPerSeries compacts: only the newest N bars per series remain", () => {
  const store = makeStore(3);
  store.append(bars(1_700_000_000_000, 10), ID, PROV, "1h", NOW);
  const got = store.query({ instrumentId: ID, timeframe: "1h" });
  assert.equal(got.length, 3);
  assert.equal(got[got.length - 1].ts, 1_700_000_000_000 + 9 * 3_600_000, "jüngste Bars bleiben");
});

test("file is written with restrictive permissions (0600)", () => {
  const store = makeStore();
  store.append(bars(1_700_000_000_000, 1), ID, PROV, "1h", NOW);
  const mode = statSync(store.filePath).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("prototype-pollution: __proto__/constructor in JSON are discarded", () => {
  const evil = JSON.stringify({
    __proto__: { polluted: true },
    instrumentId: ID,
    venue: "BITUNIX",
    feed: "x",
    timeframe: "1h",
    ts: 1_700_000_000_000,
    open: 1,
    high: 2,
    low: 0.5,
    close: 1.5,
    volume: 1,
    fetchedAt: NOW.toISOString(),
  });
  const parsed = parseCandleLine(JSON.parse(evil));
  assert.ok(parsed && !parsed.legacy);
  assert.equal(({} as Record<string, unknown>).polluted, undefined, "keine Prototype-Verunreinigung");

  // Ein "constructor"-Feld im Rohobjekt darf niemals auf den Konstruktor
  // durchschlagen: der geparste Eintrag bleibt eine saubere Kerze ohne
  // vererbten/übernommenen constructor-Wert.
  const evil2 = JSON.stringify({
    constructor: { polluted: true },
    instrumentId: ID,
    venue: "BITUNIX",
    feed: "x",
    timeframe: "1h",
    ts: 1_700_000_000_000,
    open: 1,
    high: 2,
    low: 0.5,
    close: 1.5,
    volume: 1,
    fetchedAt: NOW.toISOString(),
  });
  const parsed2 = parseCandleLine(JSON.parse(evil2));
  assert.ok(parsed2 && !parsed2.legacy, "gültige Kerze wird trotz constructor-Feld geladen");
  assert.equal((parsed2.entry as unknown as Record<string, unknown>).constructor, Object.prototype.constructor, "constructor wird nicht übernommen");
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("field values with newlines cannot inject lines (JSON.stringify)", () => {
  const store = makeStore();
  const malicious: MarketCandle[] = [
    { time: 1_700_000_000_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 },
  ];
  // feed mit eingebettetem Newline + JSON-Fragment.
  store.append(malicious, ID, { venue: "BITUNIX", feed: "rest\n{\"injected\":true}" }, "1h", NOW);
  // (readFileSync siehe Top-Level-Import)
  const raw = readFileSync(store.filePath, "utf8").trim();
  const lines = raw.split("\n");
  assert.equal(lines.length, 1, "genau eine Zeile — kein Zeilen-Einbruch via Feldwert");
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.feed, "rest\n{\"injected\":true}");
});

test("invalid OHLCV input bars are rejected at append", () => {
  const store = makeStore();
  const bad: MarketCandle[] = [
    { time: 1_700_000_000_000, open: -1, high: 2, low: 0.5, close: 1.5, volume: 1 }, // negativer Preis
    { time: 1_700_000_003_600_000, open: 1, high: 2, low: 0.5, close: Number.NaN, volume: 1 }, // NaN
  ];
  const r = store.append(bad, ID, PROV, "1h", NOW);
  assert.equal(r.written, 0);
  assert.equal(r.invalid, 2, "ungültige Bars werden als invalid gezählt");
  assert.equal(r.deduplicated, 0);
  assert.equal(store.query({ instrumentId: ID, timeframe: "1h" }).length, 0);
});

test("LEGACY_UNKNOWN marker is exported for tooling", () => {
  assert.equal(LEGACY_UNKNOWN, "__legacy_unknown__");
});
