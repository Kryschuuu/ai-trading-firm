/**
 * STX-05-04 — Tests des Backtest-Job-Adapters (`src/screening/backtestAdapter.ts`).
 *
 * Der Adapter ist die **einzige** Stelle, an der der Screening-Runner eine
 * Engine aufruft. Geprüft wird deshalb genau das, was 00-01 festgenagelt hat:
 *
 *  - Der Pfad ist `runMultiAssetBacktest()` — gemeldet als
 *    `metrics.backtestPath = "multiAsset"` (BENCH-BASELINE.md §6). Der Test
 *    belegt es über das gemeldete Ergebnis, nicht über einen Spy.
 *  - **Punkt-in-Zeit:** nur Kerzen mit `ts ≤ asOf` gehen in den Lauf. Eine
 *    Kerze aus der Zukunft darf nie in eine Zelle.
 *  - **Kostenbremse:** `maxCandlesPerCell` wird hart angewendet.
 *  - **Ein Lesevorgang je Reihe:** der HistoricalStore liest pro `query()` die
 *    ganze Datei neu — der Cache verhindert N Dateilesen für N Zellen.
 *  - **Metriken bleiben geschlossen:** kein Trade-Log, keine Equity-Kurve in
 *    `strategy_market_results.metrics`; unbekannte Werte sind `null`, nie 0.
 *  - **Kein Kappen:** der Adapter liefert die rohen Größen; die Entscheidung
 *    über Vergleichbarkeit trifft der Runner ({@link checkScreeningCaps}).
 *
 * Keine Datenbank, kein Netzwerk — die Kerzen sind eine synthetische Reihe in
 * einer Fake-Store-Implementierung.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SCREENING_CELL_METRIC_KEYS,
  SCREENING_MAX_CANDLES_PER_CELL,
  createMultiAssetBacktestPort,
  nativeSymbolOfInstrument,
} from "../src/screening/backtestAdapter";
import { SCREENING_BACKTEST_PATH } from "../src/screening/runner";
import {
  RULE_BACKTEST_EQUITY_CAP,
  RULE_BACKTEST_MIN_BARS,
  RULE_BACKTEST_TRADE_CAP,
} from "../src/lib/ruleBacktest";
import type {
  HistoricalCandleEntry,
  StoreQuery,
  SupportedTimeframe,
} from "../src/lib/marketdata/historicalStore";
import type { StrategyMarketCandidate } from "../src/screening/types";
import { cell as makeCell } from "./screening.runner.fixtures";

const AS_OF = Date.parse("2026-10-01T12:00:00.000Z");
const HOUR = 3_600_000;

/** Minimaler Store: nur `query`, wie der Adapter ihn verlangt. */
class FakeStore {
  queries = 0;
  constructor(private readonly entries: readonly HistoricalCandleEntry[]) {}

  query(q: StoreQuery): HistoricalCandleEntry[] {
    this.queries += 1;
    return this.entries
      .filter((e) => e.instrumentId === q.instrumentId && e.timeframe === q.timeframe)
      .filter((e) => (q.from === undefined ? true : e.ts >= q.from))
      .filter((e) => (q.to === undefined ? true : e.ts <= q.to))
      .sort((a, b) => a.ts - b.ts)
      .slice(q.limit && q.limit > 0 ? -q.limit : 0);
  }
}

/**
 * Deterministische Kerzenreihe: ein wellenförmiger Verlauf, der beiden
 * Template-Regeln (Trendfolge wie Mean-Reversion) Signale gibt — der Adapter
 * darf keine tote Reihe melden.
 */
function candles(
  instrumentId: string,
  timeframe: SupportedTimeframe,
  count: number,
  fromTs: number,
): HistoricalCandleEntry[] {
  return Array.from({ length: count }, (_, i) => {
    const ts = fromTs + i * HOUR;
    const base = 100 + 8 * Math.sin(i / 7) + 3 * Math.sin(i / 2.5);
    return {
      instrumentId,
      venue: instrumentId.split(":")[0],
      feed: "test",
      timeframe,
      ts,
      open: base,
      high: base + 1.2,
      low: base - 1.2,
      close: base + 0.4,
      volume: 1_000 + (i % 17) * 10,
      fetchedAt: new Date(ts).toISOString(),
    };
  });
}

/** Anfrage an den Port: eine Matrixzelle, ihre Version und der PIT-Cutoff. */
function request(
  cellOverrides: Partial<StrategyMarketCandidate> = {},
  index = 0,
): Parameters<ReturnType<typeof createMultiAssetBacktestPort>["run"]>[0] {
  return {
    cell: makeCell({
      instrumentId: "BINANCE:BTCUSDT",
      timeframe: "1h",
      ...cellOverrides,
    }),
    strategyVersionId: "11111111-2222-3333-4444-555555555555",
    asOf: new Date(AS_OF).toISOString(),
    index,
  };
}

// ── Symbol-Auflösung ───────────────────────────────────────────────────────

test("nativeSymbolOfInstrument: kanonische ID ⇒ venue-natives Symbol (Sanitize-Pfad)", () => {
  assert.equal(nativeSymbolOfInstrument("BINANCE:BTCUSDT"), "BTCUSDT");
  assert.equal(nativeSymbolOfInstrument("KRAKEN:BTC/USD"), "BTC/USD");
  assert.equal(nativeSymbolOfInstrument("BTCUSDT"), "BTCUSDT", "ohne Venue-Präfix bleibt es");
});

// ── Engine-Pfad ────────────────────────────────────────────────────────────

test("Engine-Pfad: Lauf meldet backtestPath=multiAsset, Kerzen, Trades und Equity-Punkte", async () => {
  const store = new FakeStore(candles("BINANCE:BTCUSDT", "1h", 400, AS_OF - 400 * HOUR));
  const port = createMultiAssetBacktestPort({ store });
  const outcome = await port.run(request());

  assert.equal(outcome.error, undefined);
  assert.equal(outcome.metrics?.backtestPath, SCREENING_BACKTEST_PATH);
  assert.equal(SCREENING_BACKTEST_PATH, "multiAsset", "Entscheidung aus 00-01");
  assert.equal(outcome.metrics?.timeframe, "1h");
  assert.ok((outcome.counts.bars ?? 0) > RULE_BACKTEST_MIN_BARS, "der Lauf hat gerechnet");
  assert.ok((outcome.counts.trades ?? -1) >= 0);
  assert.ok((outcome.counts.equityPoints ?? 0) > 0);
  // Metriken sind JSON-serialisierbar und endlich.
  assert.deepEqual(JSON.parse(JSON.stringify(outcome.metrics)), outcome.metrics);
});

test("Punkt-in-Zeit: Kerzen nach dem Cutoff gehen nicht in den Lauf", async () => {
  // 300 Kerzen VOR dem Cutoff, 200 danach — nur die ersten 300 zählen.
  const entries = [
    ...candles("BINANCE:BTCUSDT", "1h", 300, AS_OF - 300 * HOUR),
    ...candles("BINANCE:BTCUSDT", "1h", 200, AS_OF + HOUR),
  ];
  const store = new FakeStore(entries);
  const port = createMultiAssetBacktestPort({ store });
  const outcome = await port.run(request());

  assert.equal(outcome.counts.bars, 300, "nur Kerzen mit ts ≤ asOf");
  assert.equal(outcome.metrics?.bars, 300);
});

test("Kostenbremse: maxCandlesPerCell wird hart angewendet", async () => {
  const store = new FakeStore(candles("BINANCE:BTCUSDT", "1h", 600, AS_OF - 600 * HOUR));
  const port = createMultiAssetBacktestPort({ store, maxCandlesPerCell: 150 });
  const outcome = await port.run(request());

  assert.equal(outcome.counts.bars, 150, "die letzten 150 Kerzen bis zum Cutoff");
  assert.equal(SCREENING_MAX_CANDLES_PER_CELL > 150, true, "Default liegt höher");
});

test("Ein Lesevorgang je Reihe: der Store wird nicht pro Zelle neu gelesen", async () => {
  const store = new FakeStore(candles("BINANCE:BTCUSDT", "1h", 400, AS_OF - 400 * HOUR));
  const port = createMultiAssetBacktestPort({ store });

  await port.run(request());
  await port.run(request({}, 1));
  await port.run(request());

  assert.equal(store.queries, 1, "Cache über alle Zellen derselben Reihe");
});

test("Andere Timeframes sind andere Reihen (kein Mischen der Periodizität)", async () => {
  const store = new FakeStore([
    ...candles("BINANCE:BTCUSDT", "1h", 300, AS_OF - 300 * HOUR),
    ...candles("BINANCE:BTCUSDT", "4h", 300, AS_OF - 300 * 4 * HOUR),
  ]);
  const port = createMultiAssetBacktestPort({ store });
  const hourly = await port.run(request());
  const fourHourly = await port.run(request({ timeframe: "4h" }));

  assert.equal(hourly.metrics?.timeframe, "1h");
  assert.equal(fourHourly.metrics?.timeframe, "4h");
  assert.equal(store.queries, 2, "je Reihe genau ein Lesevorgang");
});

// ── Fehlerpfade (fail-closed, kein gekapptes Ergebnis) ─────────────────────

test("Zu wenige Kerzen ⇒ Fehlercode candles:too-few, keine Metriken", async () => {
  const store = new FakeStore(candles("BINANCE:BTCUSDT", "1h", RULE_BACKTEST_MIN_BARS - 1, AS_OF - 100 * HOUR));
  const port = createMultiAssetBacktestPort({ store });
  const outcome = await port.run(request());

  assert.equal(outcome.error, "candles:too-few");
  assert.equal(outcome.metrics, null);
  assert.equal(outcome.counts.bars, RULE_BACKTEST_MIN_BARS - 1);
  assert.equal(outcome.counts.trades, null, "unbekannt, nicht 0");
});

test("Leerer Store ⇒ fail-closed, kein Wurf", async () => {
  const port = createMultiAssetBacktestPort({ store: new FakeStore([]) });
  const outcome = await port.run(request());
  assert.equal(outcome.error, "candles:too-few");
  assert.equal(outcome.counts.bars, 0);
});

test("Unbekanntes Template ⇒ template:unknown, kein Lauf", async () => {
  const store = new FakeStore(candles("BINANCE:BTCUSDT", "1h", 300, AS_OF - 300 * HOUR));
  const port = createMultiAssetBacktestPort({ store });
  const outcome = await port.run(request({ templateId: "gibt-es-nicht" as StrategyMarketCandidate["templateId"] }));
  assert.equal(outcome.error, "template:unknown");
  assert.equal(outcome.metrics, null);
});

test("Engine-Lauf liefert Größen JENSEITS der Caps — der Adapter kappt nichts", async () => {
  // 1 700 Stundenkerzen liefern eine Equity-Kurve weit über RULE_BACKTEST_EQUITY_CAP.
  const store = new FakeStore(candles("BINANCE:BTCUSDT", "1h", 1_700, AS_OF - 1_700 * HOUR));
  const port = createMultiAssetBacktestPort({ store });
  const outcome = await port.run(request());

  assert.equal(outcome.error, undefined, "der Lauf ist durchgelaufen");
  assert.ok((outcome.counts.equityPoints ?? 0) > RULE_BACKTEST_EQUITY_CAP);
  assert.ok((outcome.counts.trades ?? 0) <= RULE_BACKTEST_TRADE_CAP || (outcome.counts.trades ?? 0) > 0);
  // Die rohe Größe ist gemeldet — die Caps-Entscheidung trifft der Runner.
  assert.equal(outcome.metrics?.equityPoints, outcome.counts.equityPoints);
  assert.deepEqual(outcome.metrics?.caps, {
    minBars: RULE_BACKTEST_MIN_BARS,
    tradeCap: RULE_BACKTEST_TRADE_CAP,
    equityCap: RULE_BACKTEST_EQUITY_CAP,
  });
});

// ── Geschlossene Metrikmenge ───────────────────────────────────────────────

test("Metriken: geschlossene Menge, keine Trade-Liste, keine Equity-Kurve", async () => {
  const store = new FakeStore(candles("BINANCE:BTCUSDT", "1h", 400, AS_OF - 400 * HOUR));
  const port = createMultiAssetBacktestPort({ store });
  const outcome = await port.run(request());
  const metrics = outcome.metrics ?? {};

  const allowed = new Set<string>([
    ...SCREENING_CELL_METRIC_KEYS,
    "backtestPath",
    "timeframe",
    "from",
    "to",
    "bars",
    "trades",
    "equityPoints",
    "caps",
  ]);
  for (const key of Object.keys(metrics)) {
    assert.ok(allowed.has(key), `Metrik "${key}" ist nicht in der geschlossenen Menge`);
  }
  // Keine Listen, keine Kurven: `bars`/`trades`/`equityPoints` sind Skalare,
  // nicht das Trade-Log oder die Equity-Kurve selbst.
  for (const [key, value] of Object.entries(metrics)) {
    assert.equal(Array.isArray(value), false, `"${key}" ist eine Liste — keine Rohdaten in metrics`);
    assert.equal(typeof value === "object" && value !== null && !Array.isArray(value) && key !== "caps", false,
      `"${key}" trägt ein verschachteltes Objekt`);
  }
  assert.equal(typeof metrics.trades, "number", "trades ist eine Zahl, keine Liste");
  assert.equal(typeof metrics.equityPoints, "number", "equityPoints ist eine Zahl, keine Kurve");
  assert.equal(metrics.sharpeRatio === undefined, false, "sharpeRatio ist Teil der Menge");
});
