/**
 * Offline-Import eines Kerzen-CSV in den HistoricalStore (STX-00-01, `v0.6.0`).
 *
 * Der Import ist der netzfreie Zulieferer der Backtest-Benchmark-Reihe. Getestet
 * wird die ganze Kette: Spaltenerkennung, Zeitstempel-Einheiten, Validierung,
 * Dry-Run-Semantik und der echte Store-Write (inkl. Idempotenz) — alles ohne
 * Datenbank und ohne Netz.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  parseCandleRow,
  parseCandleTime,
  parseCsv,
  parseTimeArg,
  resolveColumns,
  runCli,
} from "../../scripts/import-history-csv";
import { HistoricalStore } from "../../src/lib/marketdata/historicalStore";

const HEADER = "unix,date,symbol,open,high,low,close,Volume BTC,Volume USDT,tradecount";

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(path.join(tmpdir(), "csv-import-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("CSV: Spalten werden aus der Kopfzeile aufgelöst (Aliase, Basis-Volumen zuerst)", () => {
  const resolved = resolveColumns(HEADER.split(","));
  assert.ok("columns" in resolved, "Kopfzeile muss auflösbar sein");
  if (!("columns" in resolved)) return;
  assert.equal(resolved.columns.time, 0);
  assert.equal(resolved.columns.open, 3);
  assert.equal(resolved.columns.volume, 7, "Basis-Volumen hat Vorrang vor Quote-Volumen");

  // Fehlende Pflichtspalte wird benannt, nicht nur „Fehler".
  const broken = resolveColumns(["time", "open", "high", "low"]);
  assert.ok("error" in broken && broken.error.includes("close"));
});

test("CSV: Zeitstempel in Sekunden, Millisekunden und ISO-8601", () => {
  const seconds = 1_500_000_000;
  assert.equal(parseCandleTime(String(seconds)), seconds * 1000);
  assert.equal(parseCandleTime("1500000000000"), 1_500_000_000_000);
  assert.equal(parseCandleTime("1500000000.0"), seconds * 1000, "Ganzzahl-Floats sind Sekunden");
  assert.equal(parseCandleTime("2021-06-10T00:00:00Z"), Date.UTC(2021, 5, 10));
  assert.equal(parseCandleTime("2017-08-17 05-AM"), null, "unlesbare Formate werden verworfen");
  assert.equal(parseCandleTime(""), null);
  assert.equal(parseCandleTime("-1"), null);
});

test("CSV: Zeilenvalidierung lehnt kaputte Werte mit Begründung ab", () => {
  const columns = { time: 0, open: 1, high: 2, low: 3, close: 4, volume: 5 };
  const ok = parseCandleRow(["1500000000", "100", "101", "99", "100.5", "12"], columns);
  assert.ok("candle" in ok && ok.candle.close === 100.5);

  for (const cells of [
    ["x", "100", "101", "99", "100.5", "12"],
    ["1500000000", "0", "101", "99", "100.5", "12"],
    ["1500000000", "100", "101", "99", "100.5", "-1"],
    ["1500000000", "100", "98", "99", "100.5", "12"],
  ]) {
    const bad = parseCandleRow(cells, columns);
    assert.ok("reason" in bad, `muss abgelehnt werden: ${cells.join(",")}`);
  }
});

test("CSV: Fensterfilter (from/to) greift vor der Validierung", () => {
  const csv = [
    HEADER,
    "1560000000,2019-06-08,BTC/USDT,100,101,99,100.5,10,1000,1",
    "1600000000,2020-09-13,BTC/USDT,200,201,199,200.5,20,2000,2",
  ].join("\n");
  const parsed = parseCsv(csv, {
    fromMs: Date.UTC(2020, 0, 1),
    toMs: Date.UTC(2021, 0, 1),
  });
  assert.equal(parsed.candles.length, 1);
  assert.equal(parsed.candles[0].time, 1_600_000_000_000);
  assert.equal(parsed.rejected, 0, "gefilterte Zeilen zählen nicht als verworfen");
});

test("CSV-Import: Dry-Run schreibt nichts (Exit 2), --apply schreibt und ist idempotent", () => {
  withTempDir((dir) => {
    const csvPath = path.join(dir, "bars.csv");
    writeFileSync(
      csvPath,
      [
        HEADER,
        "1560000000,2019-06-08 00:00:00,BTC/USDT,100,101,99,100.5,10,1000,1",
        "1560003600,2019-06-08 01:00:00,BTC/USDT,100.5,102,100,101.5,11,1100,2",
        "kaputt,,,,,,,,",
      ].join("\n"),
      "utf8",
    );
    const storeDir = path.join(dir, "history");
    const base = [
      `--file=${csvPath}`,
      "--instrument=BINANCE:BTCUSDT",
      "--timeframe=1h",
      `--dir=${storeDir}`,
      "--max-bars=1000",
    ];

    assert.equal(runCli(base), 2, "ohne --apply ist der Lauf ein Dry-Run (Exit 2)");
    assert.equal(new HistoricalStore(storeDir).count("BINANCE:BTCUSDT", "1h"), 0, "Dry-Run schreibt nichts");

    assert.equal(runCli([...base, "--apply"]), 0);
    const store = new HistoricalStore(storeDir, { maxBarsPerSeries: 1000 });
    const stored = store.query({ instrumentId: "BINANCE:BTCUSDT", timeframe: "1h" });
    assert.equal(stored.length, 2, "nur die zwei gültigen Kerzen landen im Store");
    assert.equal(stored[0].ts, 1_560_000_000_000);
    assert.equal(stored[0].feed, "csv-import");
    assert.equal(stored[0].venue, "BINANCE");
    assert.ok(stored[0].high > stored[0].low);

    // Idempotenz: derselbe Import schreibt nichts Neues (Store-Dedup).
    assert.equal(runCli([...base, "--apply"]), 0);
    assert.equal(store.query({ instrumentId: "BINANCE:BTCUSDT", timeframe: "1h" }).length, 2);
  });
});

test("CSV-Import: harte Fehler brechen mit Exit 1 ab (kein stiller Erfolg)", () => {
  withTempDir((dir) => {
    assert.equal(runCli([]), 1, "fehlende Pflichtflags");
    assert.equal(
      runCli([`--file=${path.join(dir, "fehlt.csv")}`, "--instrument=BINANCE:BTCUSDT"]),
      1,
      "unlesbare Datei",
    );

    const csvPath = path.join(dir, "leer.csv");
    writeFileSync(csvPath, [HEADER, "x,,,,,,,,"].join("\n"), "utf8");
    assert.equal(
      runCli([`--file=${csvPath}`, "--instrument=BINANCE:BTCUSDT", `--dir=${path.join(dir, "h")}`, "--apply"]),
      1,
      "keine gültige Zeile",
    );
    assert.equal(
      runCli([
        `--file=${csvPath}`,
        "--instrument=BINANCE:BTCUSDT",
        "--timeframe=7h",
        `--dir=${path.join(dir, "h")}`,
      ]),
      1,
      "Timeframe außerhalb der Allowlist",
    );
  });
});

test("parseTimeArg: ISO-8601 und Epoch-ms, sonst Fehler", () => {
  assert.equal(parseTimeArg("2019-06-01", "--from"), Date.parse("2019-06-01"));
  assert.equal(parseTimeArg("1560000000000", "--from"), 1_560_000_000_000);
  assert.throws(() => parseTimeArg("irgendwann", "--from"), /keine gültige Zeit/);
});
