/**
 * Tests des Benchmark-Katalogs und der Lese-Schicht
 * (`src/lib/equityBenchmarkCatalog.ts`, `src/lib/equityBenchmark.ts`).
 *
 * Kernzusage: Eine Referenzlinie gibt es **nur** mit echter Kurshistorie.
 * Fehlt die Reihe, liefert `readBenchmarkSeries` `null` (die UI schreibt dann
 * „keine Daten“) — statt eine gerade Linie, einen Nullwert oder eine
 * synthetische Kurve zu erfinden.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BENCHMARK_IDS,
  BENCHMARKS,
  isBenchmarkId,
  normalizeBenchmarkId,
} from "../src/lib/equityBenchmarkCatalog";
import { readBenchmarkSeries } from "../src/lib/equityBenchmark";
import type { HistoricalStore } from "../src/lib/marketdata/historicalStore";

/** Minimaler Store-Ersatz: nur `query` wird von der Lese-Schicht benutzt. */
function fakeStore(rows: Record<string, Array<{ ts: number; close: number }>>, failing: string[] = []) {
  const calls: string[] = [];
  const store = {
    query({ instrumentId, timeframe }: { instrumentId: string; timeframe: string }) {
      const key = `${instrumentId}|${timeframe}`;
      calls.push(key);
      if (failing.includes(key)) throw new Error("unbekannter Timeframe");
      return rows[key] ?? [];
    },
  };
  return { store: store as unknown as HistoricalStore, calls };
}

const SINCE = new Date("2026-09-01T00:00:00.000Z");
const UNTIL = new Date("2026-09-03T00:00:00.000Z");

test("Katalog: Ids, Labels und Reihenfolge sind stabil", () => {
  assert.deepEqual([...BENCHMARK_IDS], ["BTC", "ETH", "SPY", "QQQ"]);
  for (const id of BENCHMARK_IDS) {
    assert.ok(BENCHMARKS[id].label.length > 0, `${id} braucht einen Anzeigenamen`);
    assert.ok(BENCHMARKS[id].instrumentIds.length > 0, `${id} braucht Kandidaten-Reihen`);
  }
  // Kein Instrument doppelt über alle Benchmarks (sonst zeigt die Legende
  // dieselbe Kurve unter zwei Namen).
  const all = BENCHMARK_IDS.flatMap((id) => [...BENCHMARKS[id].instrumentIds]);
  assert.equal(new Set(all).size, all.length);
});

test("normalizeBenchmarkId: Alias-Namen schalten ab, Unbekanntes ebenso", () => {
  assert.equal(normalizeBenchmarkId("btc"), "BTC");
  assert.equal(normalizeBenchmarkId(" QQQ "), "QQQ");
  for (const off of ["", null, undefined, "off", "none", "keine", "DAX", "1"]) {
    assert.equal(normalizeBenchmarkId(off), null, `${String(off)} darf keine Referenz sein`);
  }
  assert.equal(isBenchmarkId("ETH"), true);
  assert.equal(isBenchmarkId("eth"), false, "Groß-/Kleinschreibung nur über normalizeBenchmarkId");
});

test("readBenchmarkSeries: nimmt die erste Reihe mit mindestens zwei Kerzen", () => {
  const { store, calls } = fakeStore({
    "BINANCE:BTCUSDT|1d": [{ ts: SINCE.getTime(), close: 60_000 }], // zu wenig
    "BINANCE:BTCUSDT|4h": [
      { ts: Date.parse("2026-08-31T20:00:00.000Z"), close: 30_000 }, // vor dem Fenster
      { ts: Date.parse("2026-09-01T04:00:00.000Z"), close: 60_000 },
      { ts: Date.parse("2026-09-02T04:00:00.000Z"), close: 66_000 },
    ],
  });
  const bench = readBenchmarkSeries("BTC", { since: SINCE, until: UNTIL, equityAtStart: 10_000, store });
  assert.ok(bench);
  assert.equal(bench.source, "BINANCE:BTCUSDT");
  assert.equal(bench.timeframe, "4h", "1d hat zu wenige Kerzen → nächster Timeframe");
  assert.deepEqual(calls.slice(0, 2), ["BINANCE:BTCUSDT|1d", "BINANCE:BTCUSDT|4h"]);
  // Buy-and-Hold auf 10 000 skaliert: 60 000 → 66 000 = +10 %.
  assert.deepEqual(bench.points.map((p) => p.value), [10_000, 11_000]);
  assert.equal(bench.returnPct, 10);
  assert.equal(bench.firstTs, "2026-09-01T04:00:00.000Z");
  assert.equal(bench.lastTs, "2026-09-02T04:00:00.000Z");
});

test("readBenchmarkSeries: keine Daten ⇒ null (keine erfundene Linie)", () => {
  const { store } = fakeStore({});
  assert.equal(readBenchmarkSeries("SPY", { since: SINCE, until: UNTIL, equityAtStart: 10_000, store }), null);

  // Ein werfender `query` (z. B. unbekannter Timeframe) wird übersprungen.
  const { store: throwing } = fakeStore({}, ["BINANCE:BTCUSDT|1d"]);
  assert.equal(
    readBenchmarkSeries("BTC", { since: SINCE, until: UNTIL, equityAtStart: 10_000, store: throwing }),
    null
  );
});

test("readBenchmarkSeries: leere Reihen und Fenster ohne Kerzen ergeben null", () => {
  const { store } = fakeStore({
    "BINANCE:ETHUSDT|1d": [
      { ts: Date.parse("2026-08-28T00:00:00.000Z"), close: 3_000 },
      { ts: Date.parse("2026-08-29T00:00:00.000Z"), close: 3_100 },
    ],
  });
  // Beide Kerzen liegen vor dem Fenster → keine Linie im Fenster.
  assert.equal(readBenchmarkSeries("ETH", { since: SINCE, until: UNTIL, equityAtStart: 10_000, store }), null);
});
