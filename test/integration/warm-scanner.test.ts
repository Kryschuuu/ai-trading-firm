/**
 * Goldentest: persistenter Warmup → befüllter Trichter (MDSYNC-001 §4).
 *
 * Der Gesamtdefekt war: `data/history/candles.ndjson` wurde von keinem Prozess
 * befüllt, der Scanner las `candles.length === 0` und lehnte ALLE Instrumente
 * mit `min-candles` ab — ein leerer Trichter, der wie „Markt ungeeignet“
 * aussah. Dieser Test stellt exakt die Produktkette nach:
 *
 *   Fake-Adapter → MarketDataSyncService.syncVenue("FAKE")
 *     → InstrumentRegistry + HistoricalStore (NDJSON auf Disk)
 *     → historicalStoreProvider → scanUniverse()      (pure, kein I/O)
 *     → funnel.scanned === 3, funnel.eligible.length ≥ 1
 *
 * Ohne den Sync muss derselbe Scanner alle Instrumente mit `min-candles`
 * ablehnen — der Kontrast ist Teil des Tests.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { HistoricalStore } from "../../src/lib/marketdata/historicalStore";
import { InstrumentRegistry } from "../../src/universe/registry";
import { MarketDataSyncService, type MarketDataAdapter } from "../../src/marketdata";
import { loadScannerConfig } from "../../src/scanner/config";
import { historicalStoreProvider } from "../../src/scanner/service";
import { scanUniverse } from "../../src/scanner/pipeline";
import { classifyWeekly } from "../../src/scanner/weekly";
import { requiredWarmupCandles } from "../../src/scanner/warmup";
import type { MarketCandle, MarketInstrument, MarketOrderBook, MarketTicker } from "../../src/marketdata";
import { instrumentOf, tempDir, trendingCandles } from "../marketdata/fixtures";

const VENUE = "FAKE";
const SYMBOLS = ["ALPHAUSDT", "BETAUSDT", "GAMMAUSDT"];
const CANDLE_COUNT = 100;
const AS_OF = "2026-08-29T00:00:00.000Z";

/** Fake-Adapter: 3 Instrumente, trendende 100-Kerzen-Serien, enges Orderbuch. */
function warmAdapter(): MarketDataAdapter {
  const instruments: MarketInstrument[] = SYMBOLS.map((symbol) => instrumentOf(symbol, VENUE));
  const candles = new Map<string, MarketCandle[]>(
    instruments.map((instrument, index) => [instrument.symbol, trendingCandles(index * 17, CANDLE_COUNT, 100 + index * 5)])
  );
  const ticker = (symbol: string): MarketTicker => ({
    symbol,
    price: 100,
    source: "fake",
    ts: Date.parse(AS_OF),
    quoteVol: 25_000_000,
    baseVol: 250_000,
  });
  const book = (symbol: string): MarketOrderBook => ({
    symbol,
    bids: [{ price: 99.99, qty: 12 }],
    asks: [{ price: 100.01, qty: 9 }],
    ts: Date.parse(AS_OF),
  });

  return {
    venue: VENUE,
    async discoverInstruments() {
      return instruments;
    },
    async getTickers() {
      return instruments.map((i) => ticker(i.symbol));
    },
    async getTicker(symbol) {
      return ticker(symbol);
    },
    async getOrderBook(symbol) {
      return book(symbol);
    },
    async getCandles(symbol, _timeframe, limit) {
      return (candles.get(symbol) ?? []).slice(-limit);
    },
  };
}

test("Warmup über den Sync füllt Registry + Store und der Scanner findet Eignungskandidaten", async () => {
  const dir = tempDir("warm-");
  const registry = new InstrumentRegistry({ dir, autoSave: true, now: () => new Date(AS_OF) });
  const history = new HistoricalStore(path.join(dir, "history"));
  const config = loadScannerConfig();
  const service = new MarketDataSyncService(registry, history, new Map([[VENUE, warmAdapter()]]), {
    clock: () => new Date(AS_OF),
  });

  // ── Vorher: identischer Scanner, identische Instrumente, leerer Store ─────
  const cold = scanUniverse({
    instruments: SYMBOLS.map((symbol) => instrumentOf(symbol, VENUE)),
    data: historicalStoreProvider(history, config.factors.correlation.benchmarkInstrumentId),
    asOf: new Date(AS_OF),
    config,
  });
  assert.equal(cold.funnel.eligible.length, 0, "ohne Warmup: nichts geeignet");
  assert.equal(cold.rejectionsByRule["min-candles"], SYMBOLS.length, "der Befund heißt min-candles");
  assert.equal(cold.readiness.status, "WARMING", "und ist als Infrastrukturzustand erkennbar");

  // ── Sync: Discovery → Enrichment → Backfill → Persistenz ───────────────────
  const result = await service.syncVenue(VENUE);
  assert.equal(result.discovered, 3);
  assert.equal(result.synced, 3);
  assert.equal(result.degraded, false, JSON.stringify(result.failures));
  assert.equal(result.tickersEnriched, 3);
  assert.equal(result.orderbooksEnriched, 3);

  // Persistiert — nicht nur im RAM: dieselben Dateien, die der Scanner liest.
  const stored = registry.query({ pageSize: 500 }).items;
  assert.equal(stored.length, 3);
  for (const instrument of stored) {
    assert.ok(instrument.volume24h !== null && instrument.volume24h > 0, "24h-Volumen angereichert");
    assert.ok(instrument.spread !== null && instrument.spread > 0, "Spread aus /depth angereichert");
    assert.equal(
      history.query({ instrumentId: instrument.id, timeframe: "1h" }).length,
      CANDLE_COUNT,
      `${instrument.id} hat seine Historie im Store`
    );
  }
  assert.ok(history.count() > 0, "data/history/candles.ndjson ist befüllt");

  // ── Nachher: der reine Scanner, unveränderte Konfiguration ─────────────────
  const warm = scanUniverse({
    instruments: stored,
    data: historicalStoreProvider(history, config.factors.correlation.benchmarkInstrumentId),
    asOf: new Date(AS_OF),
    config,
  });

  assert.equal(warm.stats.scanned, 3);
  assert.equal(warm.funnel.scanned, 3, "Goldentest: funnel.scanned === 3");
  assert.ok(warm.funnel.eligible.length >= 1, `mindestens 1 geeignet, war ${warm.funnel.eligible.length}`);
  assert.equal(warm.rejectionsByRule["min-candles"], undefined, "min-candles trifft nicht mehr");
  assert.equal(warm.rejectionsByRule["max-spread"], undefined, "Spread ist geladen, kein Data-Quality-Abbruch");
  assert.equal(warm.readiness.status, "READY", `Readiness war ${warm.readiness.status}`);
  assert.equal(warm.readiness.requiredCandles, requiredWarmupCandles(config));
  assert.ok(warm.funnel.eligible.every((score) => score.score > 0), "Scores sind berechnet");

  // Weekly-Klassifikation folgt dem Warmup (Folgefehler „EXCLUDED = 26“ heilt mit).
  const weekly = classifyWeekly({ scan: warm, instruments: stored, previous: null });
  const summary = weekly.summary;
  assert.ok(
    summary.CORE + summary.ROTATION + summary.DISCOVERY >= 1,
    `klassifizierte Märkte erwartet, war ${JSON.stringify(summary)}`
  );
  assert.ok(summary.EXCLUDED < SYMBOLS.length, "nicht alles ist ausgeschlossen");
});

test("Warmup überlebt einen Neustart: neuer Store-Leser, gleiche Bars (kein RAM-Warmup)", async () => {
  const dir = tempDir("warm-restart-");
  const registry = new InstrumentRegistry({ dir, autoSave: true, now: () => new Date(AS_OF) });
  const history = new HistoricalStore(path.join(dir, "history"));
  const service = new MarketDataSyncService(registry, history, new Map([[VENUE, warmAdapter()]]), {
    clock: () => new Date(AS_OF),
  });
  await service.syncVenue(VENUE);

  // „Neustart“ = neuer Store, neue Registry, neue Service-Instanz. Alles, was
  // zählt, steht auf Disk — der RAM-Warmup des MicroExecutors wäre weg.
  const reopenedHistory = new HistoricalStore(path.join(dir, "history"));
  const reopenedRegistry = new InstrumentRegistry({ dir, autoSave: true });
  const config = loadScannerConfig();
  const afterRestart = scanUniverse({
    instruments: reopenedRegistry.query({ pageSize: 500 }).items,
    data: historicalStoreProvider(reopenedHistory, config.factors.correlation.benchmarkInstrumentId),
    asOf: new Date(AS_OF),
    config,
  });

  assert.equal(afterRestart.funnel.scanned, 3, "nach dem Neustart sind die Instrumente da");
  assert.ok(afterRestart.funnel.eligible.length >= 1, "und der Trichter bleibt gefüllt");
  assert.equal(afterRestart.readiness.status, "READY");

  // Idempotenz über die Prozessgrenze hinweg: ein zweiter Sync dupliziert keine Bars.
  const before = reopenedHistory.count();
  const again = new MarketDataSyncService(reopenedRegistry, reopenedHistory, new Map([[VENUE, warmAdapter()]]), {
    clock: () => new Date(AS_OF),
  });
  await again.syncVenue(VENUE);
  assert.equal(reopenedHistory.count(), before, "zweiter Lauf schreibt keine Duplikate");
});
