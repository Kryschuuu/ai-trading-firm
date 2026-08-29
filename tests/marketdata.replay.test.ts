/**
 * Replay-/Backtest-Determinismus (Task 03).
 * Gleicher Seed + gleicher Store-Stand → identische Fills und byte-identische
 * Ergebnisdateien (Golden-Test).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { HistoricalStore } from "../src/lib/marketdata/historicalStore";
import { ReplayFeed } from "../src/lib/marketdata/feeds/replay";
import { FillSimulator } from "../src/lib/marketdata/simulator";
import { loadSimulatorConfig } from "../src/lib/marketdata/config";
import { FeedNotSupportedError } from "../src/lib/marketdata/types";
import type { MarketInstrument } from "../src/universe/types";
import type { MarketSnapshot } from "../src/lib/marketdata/types";
import { tempStore } from "./fixtures/marketdataTestUtil";

const instrument: MarketInstrument = {
  id: "PAPER:BTC",
  venue: "PAPER",
  symbol: "BTC",
  base: "BTC",
  quote: "USD",
  assetClass: "crypto",
  marketType: "spot",
  status: "active",
  minQuantity: 0.00001,
  priceStep: 0.01,
  quantityStep: 0.00001,
  makerFee: 0.0004,
  takerFee: 0.001,
  leverageAvailable: false,
  shortAvailable: false,
  paperAvailable: true,
  liveTradable: false,
  liveAvailable: false,
  volume24h: 2_000_000_000,
  spread: 0.0004,
  volatility: null,
  lastSeen: "2026-08-27T00:00:00.000Z",
};

function seedStore(store: HistoricalStore): void {
  let close = 60_000;
  const bars = [];
  for (let i = 0; i < 50; i++) {
    close = Math.round(close * (1 + (i % 5 === 0 ? 0.001 : -0.0004)));
    bars.push({ time: 1_700_000_000_000 + i * 3_600_000, open: close, high: close + 10, low: close - 10, close, volume: 1000 });
  }
  // Replay/Backtest läuft auf dem Analyse-Timeframe (1h) — die Bars werden
  // explizit als 1h persistiert (Pflicht-Parameter).
  store.append(bars, instrument.id, { venue: "PAPER", feed: "replay-seed" }, "1h", new Date("2026-08-20T00:00:00.000Z"));
}

/**
 * Führt einen Mini-Backtest aus und liefert eine deterministische Ergebniszeile.
 * `over` kann Simulator-Overrides tragen (z. B. Jitter, um Seed-Wirkung zu zeigen).
 */
function runBacktest(store: HistoricalStore, seed: number, over: Record<string, unknown> = {}): string {
  const sim = new FillSimulator({ ...loadSimulatorConfig({}), seed, ...over });
  const lines: string[] = [];
  const candles = store.query({ instrumentId: instrument.id, timeframe: "1h" });
  for (const c of candles) {
    const spread = 0.0004;
    const half = spread / 2;
    const snap: MarketSnapshot = {
      instrumentId: instrument.id,
      symbol: instrument.symbol,
      base: instrument.base,
      quote: instrument.quote,
      bid: c.close * (1 - half),
      ask: c.close * (1 + half),
      last: c.close,
      ts: c.ts,
      source: "replay",
      venue: c.venue,
      feed: c.feed,
      spread,
      volume24h: 2_000_000_000,
    };
    const f = sim.simulate({ symbol: "BTC", side: "LONG", qty: 0.5 }, snap, instrument);
    lines.push(JSON.stringify({ ts: c.ts, fillPrice: f.fillPrice, qty: f.filledQty, fees: f.fees, status: f.status, slippageBps: f.slippageBps }));
  }
  return lines.join("\n") + "\n";
}

test("Replay: ReplayFeed liefert deterministische Snapshots aus dem Store", async () => {
  const store = tempStore();
  seedStore(store);
  const feed = new ReplayFeed(store);
  const s1 = await feed.getTicker(instrument);
  const s2 = await feed.getTicker(instrument);
  assert.ok(s1.last > 0 && s2.last > 0);
  assert.notEqual(s1.ts, s2.ts, "Cursor schreitet voran");
  // zweiter Feed über denselben Store liefert identische Folge
  const feed2 = new ReplayFeed(store);
  const r1 = await feed2.getTicker(instrument);
  assert.equal(r1.last, s1.last);
});

test("Replay: Feed erschöpft den Store → FeedNotSupportedError", async () => {
  const store = tempStore();
  seedStore(store);
  const feed = new ReplayFeed(store);
  const n = store.count(instrument.id);
  for (let i = 0; i < n; i++) await feed.getTicker(instrument);
  await assert.rejects(() => feed.getTicker(instrument), FeedNotSupportedError);
});

test("Golden-Test: Backtest zweimal → byte-identische Ergebnisdatei", () => {
  const storeA = tempStore();
  seedStore(storeA);
  const outA = runBacktest(storeA, 42);

  const storeB = tempStore();
  seedStore(storeB);
  const outB = runBacktest(storeB, 42);

  assert.equal(outA, outB, "gleicher Seed + gleicher Store → identische Ergebnisse");
  assert.ok(outA.length > 0);
});

test("Golden-Test: unterschiedliche Seeds (mit Jitter) → unterschiedliche Ergebnisse", () => {
  const jitter = { slippageJitterBps: 20 };
  const outA = runBacktest(seedStoreAndGet(), 42, jitter);
  const outB = runBacktest(seedStoreAndGet(), 7, jitter);
  assert.notEqual(outA, outB, "Jitter + unterschiedliche Seeds → andere Fills");
});

// Hilfsfunktion: neuen Store seeden und zurückgeben.
function seedStoreAndGet(): HistoricalStore {
  const s = tempStore();
  seedStore(s);
  return s;
}
