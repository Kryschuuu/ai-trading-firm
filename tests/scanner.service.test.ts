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
import {
  AS_OF,
  AS_OF_MS,
  DAY_MS,
  growthSeries,
} from "./fixtures/scannerFixtures";

const FIXTURE = path.join(
  process.cwd(),
  "tests/fixtures/universe-instruments.ndjson",
);

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
  store.append(
    [...candles].reverse(),
    "BINANCE:BTCUSDT",
    { venue: "BINANCE", feed: "test" },
    "1h",
    new Date(AS_OF),
  );
  store.append(
    candles,
    "BINANCE:ETHUSDT",
    { venue: "BINANCE", feed: "test" },
    "1h",
    new Date(AS_OF),
  );

  const provider = service.historicalStoreProvider(store, "BINANCE:BTCUSDT");
  const btc = provider.candles({ id: "BINANCE:BTCUSDT" } as never);
  assert.equal(btc.length, 80);
  assert.deepEqual(
    btc.map((c) => c.time),
    [...btc.map((c) => c.time)].sort((a, b) => a - b),
    "Kerzen müssen aufsteigend sortiert sein",
  );
  assert.equal(
    provider.candles({ id: "BINANCE:UNBEKANNT" } as never).length,
    0,
  );
  assert.equal(
    provider.benchmarkCandles?.({ id: "BINANCE:BTCUSDT" } as never),
    null,
  );
  assert.equal(
    provider.benchmarkCandles?.({ id: "BINANCE:ETHUSDT" } as never)?.length,
    80,
  );
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
  const withHistory = scan.rejections.filter(
    (r) => r.ruleId === "min-candles",
  ).length;
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

// ── Benchmark-Auflösung und Cache-TTL (v1.37.0) ─────────────────────────────

import { instrument as fixtureInstrument } from "./fixtures/scannerFixtures";

test("resolveBenchmarkId: exakte ID, venue-Fremdsymbol, gleiches Paar, null", () => {
  const instruments = [
    fixtureInstrument({
      venue: "BITUNIX",
      symbol: "BTCUSDT",
      base: "BTC",
      quote: "USDT",
    }),
    fixtureInstrument({
      venue: "BITUNIX",
      symbol: "ETHUSDT",
      base: "ETH",
      quote: "USDT",
    }),
  ];
  // 1. Exakte ID.
  assert.equal(
    service.resolveBenchmarkId("BITUNIX:BTCUSDT", instruments),
    "BITUNIX:BTCUSDT",
  );
  // 2. Konfigurierte Fremd-Venue, gleiches venue-natives Symbol.
  assert.equal(
    service.resolveBenchmarkId("BINANCE:BTCUSDT", instruments),
    "BITUNIX:BTCUSDT",
  );
  // 3. Gleiche Basis/Quote bei abweichendem Symbol (bevorzugt deterministisch
  //    die erste ID sortiert nach ID).
  const cross = [
    fixtureInstrument({
      venue: "BITUNIX",
      symbol: "XBTUSD",
      base: "BTC",
      quote: "USD",
    }),
    fixtureInstrument({
      venue: "KRAKEN",
      symbol: "XXBTZUSD",
      base: "BTC",
      quote: "USD",
    }),
  ];
  assert.ok(
    ["BITUNIX:XBTUSD", "KRAKEN:XXBTZUSD"].includes(
      service.resolveBenchmarkId("BINANCE:BTCUSD", cross) as string,
    ),
  );
  // 4. Gar nicht vorhanden ⇒ null (Faktor fällt auf Neutral).
  assert.equal(
    service.resolveBenchmarkId("BINANCE:DOGEUSDT", instruments),
    null,
  );
  assert.equal(service.resolveBenchmarkId("", instruments), null);
});

test("historicalStoreProvider löst einen fremd-venue Benchmark gegen Store-Bestand auf", () => {
  const store = new HistoricalStore(historyDir);
  const closes = growthSeries(100, 1.002, 80);
  const candles = closes.map((close, i) => ({
    time: AS_OF_MS - (closes.length - 1 - i) * DAY_MS,
    open: close,
    high: close * 1.01,
    low: close * 0.99,
    close,
    volume: 1000,
  }));
  store.append(
    candles,
    "BITUNIX:BTCUSDT",
    { venue: "BITUNIX", feed: "test" },
    "1h",
    new Date(AS_OF),
  );
  store.append(
    candles.map((c) => ({ ...c, close: c.close * 10 })),
    "BITUNIX:ETHUSDT",
    { venue: "BITUNIX", feed: "test" },
    "1h",
    new Date(AS_OF),
  );
  const instruments = [
    fixtureInstrument({
      venue: "BITUNIX",
      symbol: "BTCUSDT",
      base: "BTC",
      quote: "USDT",
    }),
    fixtureInstrument({
      venue: "BITUNIX",
      symbol: "ETHUSDT",
      base: "ETH",
      quote: "USDT",
    }),
  ];
  // Konfiguriert ist das nicht angebundene BINANCE-Pendant.
  const provider = service.historicalStoreProvider(
    store,
    "BINANCE:BTCUSDT",
    instruments,
  );
  assert.equal(
    provider.benchmarkCandles?.({ id: "BITUNIX:BTCUSDT" } as never),
    null,
    "Benchmark selbst bleibt null",
  );
  assert.equal(
    provider.benchmarkCandles?.({ id: "BITUNIX:ETHUSDT" } as never)?.length,
    80,
    "ETH erhält die BITUNIX-BTC-Reihe",
  );
});

test("ScannerService: getScan liefert innerhalb der TTL den Cache, danach eine Neuberechnung", () => {
  // Vorschiebbare Uhr.
  let nowMs = AS_OF_MS;
  const svc = new service.ScannerService({
    now: () => new Date(nowMs),
    cacheTtlMs: 5 * 60_000,
    instruments: () => [],
    data: { candles: () => [], benchmarkCandles: () => null },
  });
  const first = svc.getScan();
  assert.equal(svc.getScan(), first, "innerhalb der TTL wird wiederverwendet");
  nowMs += 4 * 60_000;
  assert.equal(svc.getScan(), first, "nach 4 Minuten noch immer Cache");
  nowMs += 61_000;
  assert.notEqual(
    svc.getScan(),
    first,
    "nach Ablauf der 5-Minuten-TTL wird neu gerechnet",
  );

  // cacheTtlMs = 0 ⇒ immer neu.
  const eager = new service.ScannerService({
    now: () => new Date(AS_OF_MS),
    cacheTtlMs: 0,
    instruments: () => [],
    data: { candles: () => [], benchmarkCandles: () => null },
  });
  const a = eager.getScan();
  assert.notEqual(
    eager.getScan(),
    a,
    "cacheTtlMs=0 erzwingt jede Abfrage eine Neuberechnung",
  );
});
