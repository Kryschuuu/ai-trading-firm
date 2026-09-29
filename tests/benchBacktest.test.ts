/**
 * Backtest-Performance-Baseline (STX-00-01, `v0.6.0`).
 *
 * Zwei Ebenen:
 *   - die reinen Rechen-Helfer (Median, log-log-Fit, Matrix-Kosten, Regel-Bau),
 *   - das Messprotokoll selbst (`runBench`) plus der CLI-Vertrag: Der Benchmark
 *     MUSS ohne Datenbank laufen und bei fehlender Messreihe laut und
 *     handlungsanweisend abbrechen statt still 0-Werte zu berichten.
 *
 * Die Zahlen in diesen Tests sind Spielzeuggrößen; die auditierte Baseline steht
 * in docs/audits/2026-09-29-strategy-template-ausbau/remediation/BENCH-BASELINE.md.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  BENCH_PATHS,
  BENCH_SIZES,
  MATRIX_CELLS,
  buildBenchSpec,
  coreHoursForMatrix,
  gapStats,
  logLogExponent,
  median,
  msPer1000Bars,
  nativeSymbolOf,
  runBench,
  runCli,
  toCandles,
} from "../scripts/bench-backtest";
import type { CandleLike } from "../src/lib/ruleEngine";

const H = 3_600_000;
const ROOT = process.cwd();

/** Deterministische, rein lokale Testreihe (keine Zufallszahlen). */
function testSeries(n: number): CandleLike[] {
  const out: CandleLike[] = [];
  let price = 20_000;
  for (let i = 0; i < n; i++) {
    const wave = Math.sin(i / 11) * 120 + Math.cos(i / 37) * 260;
    const trend = i * 0.9;
    const close = price + trend + wave;
    out.push({
      time: Date.UTC(2021, 0, 1) + i * H,
      open: close - 15,
      high: close + 40,
      low: close - 45,
      close,
      volume: 100 + (i % 17) * 3,
    });
  }
  return out;
}

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(path.join(tmpdir(), "bench-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("median: unsortiert, gerade und ungerade Anzahl, Fehler bei leerer Eingabe", () => {
  assert.equal(median([3]), 3);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.throws(() => median([]), /mindestens einen Wert/);
});

test("logLogExponent: ≈ 2 für quadratische, ≈ 1 für lineare Kosten, sonst null", () => {
  const quadratic = [1000, 5000, 17520].map((n) => ({ n, ms: 0.001 * n * n }));
  const linear = [1000, 5000, 17520].map((n) => ({ n, ms: 0.05 * n }));
  assert.ok(Math.abs((logLogExponent(quadratic) as number) - 2) < 1e-9);
  assert.ok(Math.abs((logLogExponent(linear) as number) - 1) < 1e-9);
  assert.equal(logLogExponent([{ n: 1000, ms: 5 }]), null, "ein Punkt trägt keinen Fit");
  assert.equal(logLogExponent([{ n: 0, ms: 5 }, { n: 0, ms: 9 }]), null);
});

test("Normierung und Matrix-Rechnung: ms/1000 Kerzen und Kernstunden", () => {
  assert.equal(msPer1000Bars(2_000, 5_000), 400);
  assert.throws(() => msPer1000Bars(1, 0), /n > 0/);
  // 7 500 Zellen à 3 600 000 ms = 7 500 Kernstunden.
  assert.equal(coreHoursForMatrix(3_600_000, 7_500), 7_500);
  assert.equal(coreHoursForMatrix(213.5, MATRIX_CELLS).toFixed(4), "0.4448");
});

test("nativeSymbolOf + buildBenchSpec: Instrument-ID bleibt Symbol, Timeframe wird gemessen", () => {
  assert.equal(nativeSymbolOf("BINANCE:BTCUSDT"), "BTCUSDT");
  assert.equal(nativeSymbolOf("BTCUSDT"), "BTCUSDT");
  assert.equal(nativeSymbolOf("BINANCE:BTC/USDT"), "BTC/USDT");

  const spec = buildBenchSpec("BINANCE:BTCUSDT", "1h");
  assert.equal(spec.symbol, "BINANCE:BTCUSDT", "Engine-Lookup nutzt die Instrument-ID als Map-Key");
  assert.equal(spec.window.timeframe, "1h");
  assert.equal(spec.action.side, "LONG", "global gesperrte Seite bleibt LONG");
  assert.ok(spec.condition.conditions.length >= 3, "Bench-Regel berührt mehrere Snapshot-Felder");

  assert.throws(() => buildBenchSpec("BINANCE:!!!", "1h"), /Bench-Regel ungültig/);
});

test("toCandles + gapStats: Store-Einträge werden messbar, Lücken werden gezählt", () => {
  const entries = [
    { ts: 1000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 3 },
    { ts: 1000 + H, open: 1, high: 2, low: 0.5, close: 1.5, volume: 3 },
    { ts: 1000 + 4 * H, open: 1, high: 2, low: 0.5, close: 1.5, volume: 3 },
  ] as unknown as Parameters<typeof toCandles>[0];
  const candles = toCandles(entries);
  assert.equal(candles.length, 3);
  assert.equal(candles[1].time, 1000 + H);
  const gaps = gapStats(candles, H);
  assert.equal(gaps.gapCount, 1);
  assert.equal(gaps.maxGapMs, 2 * H);
});

test("runBench: drei Pfade, Rohwerte je Wiederholung, Exponent und Matrix-Kosten", () => {
  const candles = testSeries(400);
  const spec = buildBenchSpec("TEST:BTCUSDT", "1h");
  const result = runBench({
    candles,
    spec,
    instrumentId: "TEST:BTCUSDT",
    timeframe: "1h",
    sizes: [200, 400],
    repeats: 2,
    warmupRuns: 1,
    warmup: 30,
  });

  assert.equal(result.points.length, 2);
  for (const point of result.points) {
    for (const benchPath of BENCH_PATHS) {
      const measured = point.paths[benchPath];
      assert.ok(measured, `${benchPath} muss gemessen werden`);
      assert.equal(measured.rawMs.length, 2, "jede Wiederholung ist als Rohwert sichtbar");
      assert.equal(measured.medianMs, median(measured.rawMs));
      assert.ok(measured.medianMs > 0);
      assert.ok(measured.msPer1000Bars > 0);
    }
  }

  assert.ok(typeof result.exponents.rule === "number");
  assert.ok(typeof result.exponents.cache === "number");
  assert.ok((result.comparison.speedupMultiAsset ?? 0) > 0);
  assert.equal(result.matrix.cells, MATRIX_CELLS);
  assert.ok(result.matrix.perPath.rule.coreHours > result.matrix.perPath.multiAsset.coreHours);
  assert.equal(result.config.repeats, 2);
  assert.equal(result.config.warmupRuns, 1);

  // Detailbelege zeigen, dass wirklich gerechnet wurde.
  const last = result.points[result.points.length - 1];
  assert.ok((last.detail.cache?.snapshots ?? 0) > 0);
  assert.equal(last.detail.cache?.bars, 400);

  // Teilmenge der Pfade ist möglich (Protokoll bleibt steuerbar).
  const onlyCache = runBench({
    candles,
    spec,
    instrumentId: "TEST:BTCUSDT",
    timeframe: "1h",
    sizes: [200, 400],
    repeats: 1,
    paths: ["cache"],
  });
  assert.deepEqual(Object.keys(onlyCache.points[0].paths), ["cache"]);
  assert.equal(onlyCache.comparison.speedupCache, null, "ohne rule-Pfad kein Faktor");
});

test("runBench: zu kurze Reihe bricht ab, statt stille Null-Messungen zu berichten", () => {
  const candles = testSeries(100);
  const spec = buildBenchSpec("TEST:BTCUSDT", "1h");
  assert.throws(
    () =>
      runBench({
        candles,
        spec,
        instrumentId: "TEST:BTCUSDT",
        timeframe: "1h",
        sizes: [200],
        repeats: 1,
      }),
    /nur 100 Kerzen/,
  );
});

test("CLI: läuft ohne Datenbank (kein src/db) und schreibt mit --no-write nichts", () => {
  withTempDir((dir) => {
    const csvPath = path.join(dir, "bars.csv");
    const rows = ["unix,date,symbol,open,high,low,close,Volume BTC,Volume USDT,tradecount"];
    for (let i = 0; i < 400; i++) {
      const close = 20_000 + i * 3 + Math.sin(i / 9) * 150;
      rows.push(
        `${Math.floor((Date.UTC(2021, 0, 1) + i * H) / 1000)},2021,BTC/USDT,${close},${close + 40},${close - 45},${close + 10},100,2000,5`,
      );
    }
    writeFileSync(csvPath, rows.join("\n"), "utf8");
    const storeDir = path.join(dir, "history");

    const imported = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/import-history-csv.ts",
        `--file=${csvPath}`,
        "--instrument=TEST:BTCUSDT",
        "--timeframe=1h",
        `--dir=${storeDir}`,
        "--max-bars=1000",
        "--apply",
      ],
      { cwd: ROOT, encoding: "utf8" },
    );
    assert.equal(imported.status, 0, imported.stderr);

    // Absichtlich unerreichbare DB: der Benchmark darf sie nie kontaktieren.
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/bench-backtest.ts",
        "--instrument=TEST:BTCUSDT",
        `--dir=${storeDir}`,
        "--sizes=200,400",
        "--repeat=1",
        "--no-write",
      ],
      {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 120_000,
        env: {
          ...process.env,
          DATABASE_URL: "postgresql://niemand:niemand@127.0.0.1:1/nie",
          STARTING_EQUITY: "10000",
        },
      },
    );
    assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.match(result.stdout, /## Messpunkte/);
    assert.match(result.stdout, /\| cache \| 400 \|/);
    assert.match(result.stdout, /Kernstunden seriell/);
  });
});

test("CLI: fehlende Reihe und unbekannte Optionen brechen mit Exit 1 ab", () => {
  withTempDir((dir) => {
    const storeDir = path.join(dir, "leer");
    const missing = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/bench-backtest.ts", "--instrument=TEST:BTCUSDT", `--dir=${storeDir}`],
      { cwd: ROOT, encoding: "utf8", timeout: 60_000 },
    );
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /keine Kerzen/);
    assert.match(missing.stderr, /history:import-csv|market-sync/, "Fehler nennt den Weg zur Messreihe");
    assert.match(missing.stderr, /--help/);

    const badTimeframe = runCli(["--instrument=TEST:BTCUSDT", "--timeframe=7h"]);
    assert.equal(badTimeframe.exitCode, 1);
    assert.equal(badTimeframe.report, null);

    const badModel = runCli(["--instrument=TEST:BTCUSDT", "--execution-model=event_replay"]);
    assert.equal(badModel.exitCode, 1, "nur legacy/paper sind für dieses Protokoll zulässig");

    const badPaths = runCli(["--instrument=TEST:BTCUSDT", "--paths=quatsch"]);
    assert.equal(badPaths.exitCode, 1);
  });
});

test("Default-Messpunkte des Protokolls bleiben 1k / 5k / 2 Jahre 1h", () => {
  assert.deepEqual([...BENCH_SIZES], [1_000, 5_000, 17_520]);
  assert.deepEqual([...BENCH_PATHS], ["rule", "multiAsset", "cache"]);
});
