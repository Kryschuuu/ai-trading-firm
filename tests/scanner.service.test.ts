/**
 * Tests des Produktivpfads des Scanner-Service (Task 04).
 *
 * Geprüft wird die Verdrahtung Registry → Historical Store → Pipeline:
 * seitenweises Laden aller Instrumente, die Kerzen-Anbindung an den
 * append-only Store (Task 03) und das prozessweite Singleton.
 * Kein Netzwerk, keine Datenbank — nur temporäre Verzeichnisse.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { HistoricalStore } from "../src/lib/marketdata/historicalStore";
import { AS_OF, AS_OF_MS, DAY_MS, growthSeries } from "./fixtures/scannerFixtures";

const FIXTURE = path.join(process.cwd(), "tests/fixtures/universe-instruments.ndjson");

let universeDir: string;
let historyDir: string;
let service: typeof import("../src/scanner/service");
let universe: typeof import("../src/universe");

before(async () => {
  universeDir = mkdtempSync(path.join(tmpdir(), "scanner-universe-"));
  historyDir = mkdtempSync(path.join(tmpdir(), "scanner-history-"));
  mkdirSync(universeDir, { recursive: true });
  cpSync(FIXTURE, path.join(universeDir, "instruments.ndjson"));
  process.env.UNIVERSE_DATA_DIR = universeDir;

  universe = await import("../src/universe");
  service = await import("../src/scanner/service");
});

after(() => {
  rmSync(universeDir, { recursive: true, force: true });
  rmSync(historyDir, { recursive: true, force: true });
  delete process.env.UNIVERSE_DATA_DIR;
  service.setScannerServiceForTests(null);
  universe.resetRegistryForTests();
});

test("Service: loadAllInstruments liest die Registry seitenweise und stabil sortiert", () => {
  const all = service.loadAllInstruments();
  assert.ok(all.length > 0);
  const ids = all.map((i) => i.id);
  assert.deepEqual(ids, [...ids].sort());
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(service.loadAllInstruments(2).length, 2);
});

test("Service: historicalStoreProvider gruppiert Kerzen je Instrument und liefert den Benchmark", () => {
  const store = new HistoricalStore(historyDir);
  const closes = growthSeries(100, 1.004, 80);
  const candles = closes.map((close, i) => ({
    time: AS_OF_MS - (closes.length - 1 - i) * DAY_MS,
    open: close,
    high: close * 1.01,
    low: close * 0.99,
    close,
    volume: 1000,
  }));
  store.append([...candles].reverse(), "BINANCE:BTCUSDT", { venue: "BINANCE", feed: "test" });
  store.append(candles, "BINANCE:ETHUSDT", { venue: "BINANCE", feed: "test" });

  const provider = service.historicalStoreProvider(store, "BINANCE:BTCUSDT");
  const btc = provider.candles({ id: "BINANCE:BTCUSDT" } as never);
  assert.equal(btc.length, 80);
  assert.deepEqual(
    btc.map((c) => c.time),
    [...btc.map((c) => c.time)].sort((a, b) => a - b),
    "Kerzen müssen aufsteigend sortiert sein"
  );
  assert.equal(provider.candles({ id: "BINANCE:UNBEKANNT" } as never).length, 0);
  assert.equal(provider.benchmarkCandles?.({ id: "BINANCE:BTCUSDT" } as never), null);
  assert.equal(provider.benchmarkCandles?.({ id: "BINANCE:ETHUSDT" } as never)?.length, 80);
});

test("Service: Produktivpfad Registry + Store liefert ein vollständiges Scan-Ergebnis", () => {
  const store = new HistoricalStore(historyDir);
  const instruments = service.loadAllInstruments();
  const provider = service.historicalStoreProvider(store, "BINANCE:BTCUSDT");
  const instance = new service.ScannerService({
    now: () => new Date(AS_OF),
    instruments: () => instruments,
    data: provider,
  });
  const scan = instance.getScan();
  assert.equal(scan.stats.scanned, instruments.length);
  assert.equal(scan.asOf, AS_OF);
  // Nur die beiden Instrumente mit Historie können die Filter überhaupt erreichen.
  const withHistory = scan.rejections.filter((r) => r.ruleId === "min-candles").length;
  assert.equal(withHistory, instruments.length - 2);
  const weekly = instance.getWeekly();
  assert.equal(weekly.entries.length, instruments.length);
});

test("Service: getScannerService liefert ein prozessweites Singleton", () => {
  service.setScannerServiceForTests(null);
  const first = service.getScannerService();
  assert.equal(service.getScannerService(), first);
  const injected = new service.ScannerService({ instruments: () => [] });
  service.setScannerServiceForTests(injected);
  assert.equal(service.getScannerService(), injected);
  assert.equal(injected.getScan().stats.scanned, 0);
});
