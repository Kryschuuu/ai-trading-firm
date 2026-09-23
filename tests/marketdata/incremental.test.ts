/**
 * Tests der v1.37.0-Sync-Optimierungen:
 *
 *  1. Inkrementeller Kerzen-Sync: hält der Store die Kerze des laufenden
 *     Zeitraums, entfällt der Kline-Request je Instrument/Timeframe
 *     (`freshCandlesByTimeframe`); `--full` erzwingt den vollen Abruf.
 *  2. Spread-Cache: frische gecachte Spreads führen zum Wegfall der
 *     Depth-Requests; abgelaufene Werte werden neu geholt; Fehlwerte werden
 *     nie gecacht.
 *
 * Mock-Adapter, keine Netzwerknutzung.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { MarketDataSyncService, type MarketCandle, type SyncOptions } from "../../src/marketdata";
import { instrumentOf, mockMarketDataAdapter, syncHarness } from "./fixtures";
import type { SpreadCache } from "../../src/marketdata/spreadCache";

const HOUR = 3_600_000;
/** Feste Laufuhr: 5 min nach einer vollen Stunde (laufende 1h-Kerze offen). */
const RUN_AT = new Date("2026-08-29T00:05:00.000Z");
const PERIOD_START = Math.floor(RUN_AT.getTime() / HOUR) * HOUR;

/** `count` 1h-Kerzen, endend MIT der Kerze des laufenden Zeitraums. */
function hourlyCandlesThroughCurrentPeriod(count: number): MarketCandle[] {
  const out: MarketCandle[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const time = PERIOD_START - i * HOUR;
    out.push({ time, open: 100, high: 100.1, low: 99.9, close: 100 + (count - i) * 0.01, volume: 1_000 });
  }
  return out;
}

function options(overrides: Partial<SyncOptions> = {}): Partial<SyncOptions> {
  return {
    timeframes: ["1h"],
    candleLimit: 150,
    clock: () => RUN_AT,
    ...overrides,
  };
}

// ── Inkrementeller Kerzen-Sync ───────────────────────────────────────────────

test("Inkrementell: Zweiter Lauf innerhalb desselben Zeitraums stellt KEINE Kline-Requests", async () => {
  const instruments = [instrumentOf("SYM000USDT"), instrumentOf("SYM001USDT")];
  const first = mockMarketDataAdapter({ instruments, candlesFor: () => hourlyCandlesThroughCurrentPeriod(150) });
  const harness = syncHarness(first.adapter, "BITUNIX", options());

  const r1 = await harness.service.syncVenue("BITUNIX");
  assert.equal(first.calls.candles.length, 2, "Erstlauf: ein Kline-Abruf je Instrument");
  assert.equal(r1.freshCandlesByTimeframe, undefined, "Erstlauf hat nichts übersprungen");
  assert.equal((r1.candlesByTimeframe["1h"]?.bars ?? 0) > 0, true);

  // Zweiter Lauf mit frischem Adapter, identische Uhr, derselbe Store.
  const second = mockMarketDataAdapter({ instruments, candlesFor: () => hourlyCandlesThroughCurrentPeriod(150) });
  const service2 = new MarketDataSyncService(
    harness.registry,
    harness.history,
    new Map([["BITUNIX", second.adapter]]),
    options({ requiredWarmupCandles: 61 }),
  ) as typeof harness.service;
  const r2 = await service2.syncVenue("BITUNIX");
  assert.equal(second.calls.candles.length, 0, "die Reihen sind aktuell — null Kline-Requests");
  assert.equal(r2.freshCandlesByTimeframe?.["1h"], 2, "beide Instrumente als frisch gezählt");

  // Discovery/Ticker/Depth laufen weiter (dort gibt es keinen Kerzen-Cache).
  assert.equal(second.calls.discover, 1);
  assert.equal(second.calls.orderBook.length, 2);
});

test("Inkrementell: Nach Ablauf des Zeitraums wird wieder abgerufen", async () => {
  const instruments = [instrumentOf("SYM000USDT")];
  const first = mockMarketDataAdapter({ instruments, candlesFor: () => hourlyCandlesThroughCurrentPeriod(150) });
  const harness = syncHarness(first.adapter, "BITUNIX", options());
  await harness.service.syncVenue("BITUNIX");

  // Eine Stunde später, nächster Periodenrand.
  const later = new Date(RUN_AT.getTime() + HOUR);
  const shiftedPeriodStart = PERIOD_START + HOUR;
  const second = mockMarketDataAdapter({
    instruments,
    candlesFor: () =>
      Array.from({ length: 150 }, (_, k) => {
        const time = shiftedPeriodStart - (149 - k) * HOUR;
        return { time, open: 100, high: 100.1, low: 99.9, close: 100 + k * 0.01, volume: 1_000 } as MarketCandle;
      }),
  });
  const service2 = new MarketDataSyncService(
    harness.registry,
    harness.history,
    new Map([["BITUNIX", second.adapter]]),
    options({ clock: () => later, requiredWarmupCandles: 61 }),
  ) as typeof harness.service;
  const r2 = await service2.syncVenue("BITUNIX");
  assert.equal(second.calls.candles.length, 1, "neuer Zeitraum ⇒ wieder ein Kline-Request");
  assert.equal(r2.freshCandlesByTimeframe, undefined);
});

test("Inkrementell: --full erzwingt den Abruf trotz aktuellem Bestand", async () => {
  const instruments = [instrumentOf("SYM000USDT")];
  const first = mockMarketDataAdapter({ instruments, candlesFor: () => hourlyCandlesThroughCurrentPeriod(150) });
  const harness = syncHarness(first.adapter, "BITUNIX", options());
  await harness.service.syncVenue("BITUNIX");

  const second = mockMarketDataAdapter({ instruments, candlesFor: () => hourlyCandlesThroughCurrentPeriod(150) });
  const service2 = new MarketDataSyncService(
    harness.registry,
    harness.history,
    new Map([["BITUNIX", second.adapter]]),
    options({ fullRefresh: true, requiredWarmupCandles: 61 }),
  ) as typeof harness.service;
  const r2 = await service2.syncVenue("BITUNIX");
  assert.equal(second.calls.candles.length, 1, "--full stellt den Kline-Request");
  assert.equal(r2.freshCandlesByTimeframe, undefined);
});

test("Inkrementell: Ein älterer Zwischenstand (nur alte Kerzen) wird ergänzt, nicht für aktuell gehalten", async () => {
  const instruments = [instrumentOf("SYM000USDT")];
  // Erste Serie endet eine Stunde VOR dem laufenden Zeitrand.
  const stale = mockMarketDataAdapter({
    instruments,
    candlesFor: () => hourlyCandlesThroughCurrentPeriod(150).slice(0, 149),
  });
  const harness = syncHarness(stale.adapter, "BITUNIX", options());
  await harness.service.syncVenue("BITUNIX");

  const second = mockMarketDataAdapter({ instruments, candlesFor: () => hourlyCandlesThroughCurrentPeriod(150) });
  const service2 = new MarketDataSyncService(
    harness.registry,
    harness.history,
    new Map([["BITUNIX", second.adapter]]),
    options({ requiredWarmupCandles: 61 }),
  ) as typeof harness.service;
  const r2 = await service2.syncVenue("BITUNIX");
  assert.equal(second.calls.candles.length, 1, "fehlt die Periodenkerze, wird abgerufen");
  assert.equal(r2.freshCandlesByTimeframe, undefined);
});

// ── Spread-Cache ─────────────────────────────────────────────────────────────

/** Einfacher In-Memory-Cache für die Service-Tests. */
class MemorySpreadCache implements SpreadCache {
  private readonly entries = new Map<string, { spread: number; at: Date }>();
  flushes = 0;
  constructor(private readonly ttlMs: number) {}
  fresh(instrumentId: string, nowMs: number): number | undefined {
    const e = this.entries.get(instrumentId);
    if (!e) return undefined;
    return nowMs - e.at.getTime() <= this.ttlMs ? e.spread : undefined;
  }
  record(instrumentId: string, spread: number, at: Date): void {
    this.entries.set(instrumentId, { spread, at });
  }
  flush(): void {
    this.flushes += 1;
  }
}

test("Spread-Cache: Zweiter Lauf innerhalb der TTL stellt KEINE Depth-Requests", async () => {
  const instruments = [instrumentOf("SYM000USDT"), instrumentOf("SYM001USDT"), instrumentOf("SYM002USDT")];
  const cache = new MemorySpreadCache(6 * HOUR);
  const first = mockMarketDataAdapter({ instruments });
  const harness = syncHarness(first.adapter, "BITUNIX", options({ spreadCache: cache }));

  const r1 = await harness.service.syncVenue("BITUNIX");
  assert.equal(first.calls.orderBook.length, 3, "Erstlauf: Depth je Instrument");
  assert.equal(r1.orderbooksEnriched, 3);
  assert.equal(cache.flushes, 1, "Cache wird einmal je erfolgreichem Lauf geschrieben");

  const second = mockMarketDataAdapter({ instruments });
  const service2 = new MarketDataSyncService(
    harness.registry,
    harness.history,
    new Map([["BITUNIX", second.adapter]]),
    options({ spreadCache: cache, requiredWarmupCandles: 61 }),
  ) as typeof harness.service;
  const r2 = await service2.syncVenue("BITUNIX");
  assert.equal(second.calls.orderBook.length, 0, "alle Bücher innerhalb der TTL — null Depth-Requests");
  assert.equal(r2.orderbooksEnriched, 3, "Caching ändert die Anreicherungszähler nicht");
  assert.equal(r2.spreadsUnknown, 0);
});

test("Spread-Cache: Nach Ablauf der TTL wird die Depth erneut geholt", async () => {
  const instruments = [instrumentOf("SYM000USDT")];
  const cache = new MemorySpreadCache(HOUR);
  const first = mockMarketDataAdapter({ instruments });
  const harness = syncHarness(first.adapter, "BITUNIX", options({ spreadCache: cache }));
  await harness.service.syncVenue("BITUNIX");

  const later = new Date(RUN_AT.getTime() + 2 * HOUR);
  const second = mockMarketDataAdapter({ instruments });
  const service2 = new MarketDataSyncService(
    harness.registry,
    harness.history,
    new Map([["BITUNIX", second.adapter]]),
    options({ spreadCache: cache, clock: () => later, requiredWarmupCandles: 61 }),
  ) as typeof harness.service;
  await service2.syncVenue("BITUNIX");
  assert.equal(second.calls.orderBook.length, 1, "abgelaufener Cache-Wert wird frisch geholt");
});

test("Spread-Cache: Fehlgeschlagene Books werden nicht gecacht (Folgelauf holt erneut)", async () => {
  const instruments = [instrumentOf("SYM000USDT"), instrumentOf("SYM001USDT")];
  const cache = new MemorySpreadCache(6 * HOUR);
  const failing = mockMarketDataAdapter({ instruments, failOrderBookFor: ["SYM000USDT"] });
  const harness = syncHarness(failing.adapter, "BITUNIX", options({ spreadCache: cache }));
  const r1 = await harness.service.syncVenue("BITUNIX");
  assert.equal(r1.spreadsUnknown, 1);

  const healthy = mockMarketDataAdapter({ instruments });
  const service2 = new MarketDataSyncService(
    harness.registry,
    harness.history,
    new Map([["BITUNIX", healthy.adapter]]),
    options({ spreadCache: cache, requiredWarmupCandles: 61 }),
  ) as typeof harness.service;
  const r2 = await service2.syncVenue("BITUNIX");
  // SYM001 war erfolgreich und ist gecacht; SYM000 schlug fehl und wird erneut geholt.
  assert.deepEqual(healthy.calls.orderBook.sort(), ["SYM000USDT"]);
  assert.equal(r2.spreadsUnknown, 0, "der nachgeholte Wert schließt die Lücke");
});
