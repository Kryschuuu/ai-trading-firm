/**
 * Kostenbewusster Regel-Backtest (VBF-P1-01).
 * `backtestRule` bleibt der Referenzpfad; der Paper-Pfad liest nur den Store.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { HistoricalStore } from "../src/lib/marketdata/historicalStore";
import type { FillSimulatorConfig } from "../src/lib/marketdata/config";
import { backtestRule, sanitizeRuleSpec, type CandleLike, type RuleSpec } from "../src/lib/ruleEngine";
import {
  executeRuleBacktest,
  parseRuleBacktestBody,
  resolvePaperInstrumentId,
  RULE_BACKTEST_MIN_BARS,
} from "../src/lib/ruleBacktest";
import type { HistoricalCandleEntry } from "../src/lib/marketdata/historicalStore";
import { DEFAULT_BACKTEST_CONFIG } from "../src/backtest";

const H = 15 * 60_000;
const T0 = Date.UTC(2024, 0, 1);

function bar(i: number, close: number, low = close * 0.998, high = close * 1.002): CandleLike {
  return { time: T0 + i * H, open: close, high, low, close, volume: 1000 };
}

/** Ein Dip unter 95, danach Erholung über das Ziel — genau ein abgeschlossener Trade. */
function oneDip(): CandleLike[] {
  const out: CandleLike[] = [];
  for (let i = 0; i < 45; i++) out.push(bar(i, 100));
  out.push(bar(45, 90, 89, 91));
  for (let i = 46; i < 70; i++) out.push(bar(i, 110, 100, 112));
  return out;
}

function specFor(symbol: string): RuleSpec {
  const parsed = sanitizeRuleSpec({
    name: "Preis über 100",
    symbol,
    rationale: "Test",
    condition: { logic: "all", conditions: [{ field: "price", op: "lt", value: 95 }] },
    action: { side: "LONG", stopLossPct: 8, takeProfitRR: 1.2, riskBudgetPct: 0.02, maxPositionPct: 0.25 },
    window: { timeframe: "15m", maxExecutionsPerDay: 5, cooldownMinutes: 0, volumeWindow: 20 },
    riskScore: 0.2,
  }, "MANUAL");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("spec");
  return parsed.spec;
}

function spec(): RuleSpec {
  return specFor("BTC");
}

class RecordingStore extends HistoricalStore {
  readonly queried: string[] = [];
  override query(q: Parameters<HistoricalStore["query"]>[0]) {
    this.queried.push(q.instrumentId);
    return super.query(q);
  }
}

function zeroFrictionSimulator(): FillSimulatorConfig {
  return {
    makerFeeFallback: 0,
    takerFeeFallback: 0.001,
    latencyMs: 0,
    slippageBpsBase: 0,
    slippageBpsPerParticipation: 0,
    slippageJitterBps: 0,
    partialFillEnabled: false,
    partialFillMaxFraction: 1,
    seed: 1,
    volume24hFallback: 10_000_000,
    syntheticSpreadBps: 0,
  };
}

test("parseRuleBacktestBody: fehlendes model ist paper, anderes model ist 400", () => {
  const missing = parseRuleBacktestBody({});
  assert.equal(missing.ok, true);
  if (missing.ok) {
    assert.equal(missing.value.model, "paper");
    assert.equal(missing.value.limit, 300);
    assert.equal(missing.value.startingEquity, 10_000);
    assert.equal(missing.value.instrumentId, null);
  }
  const bad = parseRuleBacktestBody({ model: "legacy" });
  assert.equal(bad.ok, false);
  const equity = parseRuleBacktestBody({ startingEquity: 0 });
  assert.equal(equity.ok, false);
  const storeId = parseRuleBacktestBody({ instrumentId: " bitunix:btcusdt " });
  assert.equal(storeId.ok, true);
  if (storeId.ok) assert.equal(storeId.value.instrumentId, "BITUNIX:BTCUSDT");
  const bare = parseRuleBacktestBody({ instrumentId: "BTC" });
  assert.equal(bare.ok, false);
  const traversal = parseRuleBacktestBody({ instrumentId: "BITUNIX:../BTCUSDT" });
  assert.equal(traversal.ok, false);
});

test("Paper-Pfad: leerer Store ist 422 und ruft keine Referenzquelle", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rule-bt-empty-"));
  let called = 0;
  try {
    const parsed = parseRuleBacktestBody({});
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    const run = await executeRuleBacktest({
      spec: spec(),
      request: parsed.value,
      store: new HistoricalStore(dir),
      loadReferenceCandles: async () => {
        called += 1;
        return [];
      },
    });
    assert.equal(run.ok, false);
    if (!run.ok) assert.equal(run.status, 422);
    assert.equal(called, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Paper-Pfad bucht Taker-Fee; Netto-PnL ≤ Referenz nur wenn beide handeln", async () => {
  assert.equal(DEFAULT_BACKTEST_CONFIG.executionModel, "legacy");
  const dir = mkdtempSync(path.join(tmpdir(), "rule-bt-paper-"));
    const candles = oneDip();
  const rule = spec();
  try {
    const store = new HistoricalStore(dir);
    store.append(candles, rule.symbol, { venue: "PAPER", feed: "test" }, "15m", new Date(T0));
    const parsed = parseRuleBacktestBody({ model: "paper", interval: "1h", limit: 300 });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    const paper = await executeRuleBacktest({
      spec: rule,
      request: parsed.value,
      store,
      loadReferenceCandles: async () => {
        throw new Error("Yahoo darf auf dem Paper-Pfad nicht laufen");
      },
      paper: { simulator: zeroFrictionSimulator(), takerFee: 0.001, makerFee: 0, spreadBpsFallback: 0 },
    });
    assert.equal(paper.ok, true);
    if (!paper.ok) return;
    assert.equal(paper.body.executionModel, "paper");
    assert.equal(paper.body.interval, "15m");
    assert.equal(paper.persist.from.getTime(), candles[candles.length - Math.min(candles.length, 300)].time || candles[0].time);
    const reference = backtestRule(rule, candles, { startingEquity: 10_000 });
    if (paper.body.result.stats.trades >= 1 && reference.stats.trades >= 1) {
      assert.ok((paper.body.result.stats.totalFeesPaid ?? 0) > 0);
      assert.ok(paper.body.result.stats.pnl <= reference.stats.pnl);
    }
    assert.equal(paper.body.result.equityCurve.length > 0, paper.body.result.stats.trades >= 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Referenzpfad bleibt gebührenfrei und ohne erfundene Equity-Kurve", async () => {
  const candles = oneDip().slice(0, RULE_BACKTEST_MIN_BARS + 5);
  const parsed = parseRuleBacktestBody({ model: "reference", limit: 80 });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const run = await executeRuleBacktest({
    spec: spec(),
    request: parsed.value,
    store: new HistoricalStore(mkdtempSync(path.join(tmpdir(), "rule-bt-ref-"))),
    loadReferenceCandles: async () => candles,
  });
  assert.equal(run.ok, true);
  if (!run.ok) return;
  assert.equal(run.body.executionModel, "reference");
  assert.equal(run.body.result.stats.totalFeesPaid, null);
  assert.deepEqual(run.body.result.equityCurve, []);
  assert.equal(run.body.instrumentId, null);
  assert.equal(run.persist.from.toISOString(), new Date(candles[0].time).toISOString());
});

test("Paper-Pfad: Regel-Symbol BTC findet BITUNIX:BTCUSDT nicht und ruft keine Kursquelle", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rule-bt-bare-"));
  let called = 0;
  try {
    const store = new RecordingStore(dir);
    store.append(oneDip(), "BITUNIX:BTCUSDT", { venue: "BITUNIX", feed: "test" }, "15m", new Date(T0));
    const parsed = parseRuleBacktestBody({});
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    const run = await executeRuleBacktest({
      spec: spec(),
      request: parsed.value,
      store,
      loadReferenceCandles: async () => {
        called += 1;
        return oneDip();
      },
    });
    assert.equal(run.ok, false);
    if (!run.ok) assert.equal(run.status, 422);
    assert.equal(called, 0);
    assert.deepEqual(store.queried, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Paper-Pfad: BTC/USDT löst eindeutig BITUNIX:BTCUSDT auf und handelt diese Reihe", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rule-bt-resolve-"));
  try {
    const store = new RecordingStore(dir);
    const candles = oneDip();
    store.append(candles, "BITUNIX:BTCUSDT", { venue: "BITUNIX", feed: "test" }, "15m", new Date(T0));
    const rule = specFor("BTC/USDT");
    assert.equal(rule.symbol, "BTC/USDT");
    const parsed = parseRuleBacktestBody({ model: "paper", limit: 300 });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    const run = await executeRuleBacktest({
      spec: rule,
      request: parsed.value,
      store,
      loadReferenceCandles: async () => {
        throw new Error("Yahoo darf auf dem Paper-Pfad nicht laufen");
      },
      paper: { simulator: zeroFrictionSimulator(), takerFee: 0.001, makerFee: 0, spreadBpsFallback: 0 },
    });
    assert.equal(run.ok, true);
    if (!run.ok) return;
    assert.equal(run.body.instrumentId, "BITUNIX:BTCUSDT");
    assert.equal(run.body.ruleSymbol, "BTC/USDT");
    assert.equal(run.body.seriesWarning, null);
    assert.ok(run.body.result.stats.trades >= 1);
    assert.ok(store.queried.includes("BITUNIX:BTCUSDT"));
    assert.equal(store.queried.includes("BTC/USDT"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Paper-Pfad: zwei Venues ohne instrumentId sind 422, keine wird geraten", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rule-bt-ambig-"));
  let called = 0;
  try {
    const store = new HistoricalStore(dir);
    const candles = oneDip();
    store.append(candles, "BINANCE:BTCUSDT", { venue: "BINANCE", feed: "test" }, "15m", new Date(T0));
    store.append(candles, "BITUNIX:BTCUSDT", { venue: "BITUNIX", feed: "test" }, "15m", new Date(T0));
    const parsed = parseRuleBacktestBody({});
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    const run = await executeRuleBacktest({
      spec: specFor("BTC/USDT"),
      request: parsed.value,
      store,
      loadReferenceCandles: async () => {
        called += 1;
        return candles;
      },
    });
    assert.equal(run.ok, false);
    if (!run.ok) {
      assert.equal(run.status, 422);
      assert.match(run.error, /BITUNIX:BTCUSDT/);
      assert.match(run.error, /BINANCE:BTCUSDT/);
    }
    assert.equal(called, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Paper-Pfad: gesetzte instrumentId liest nur diese Reihe, auch wenn das Regel-Symbol Kerzen hat", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rule-bt-explicit-"));
  let called = 0;
  try {
    const store = new RecordingStore(dir);
    store.append(oneDip(), "BTC/USDT", { venue: "PAPER", feed: "test" }, "15m", new Date(T0));
    const parsed = parseRuleBacktestBody({ instrumentId: "BITUNIX:BTCUSDT" });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    const run = await executeRuleBacktest({
      spec: specFor("BTC/USDT"),
      request: parsed.value,
      store,
      loadReferenceCandles: async () => {
        called += 1;
        return oneDip();
      },
    });
    assert.equal(run.ok, false);
    if (!run.ok) {
      assert.equal(run.status, 422);
      assert.match(run.error, /BITUNIX:BTCUSDT/);
    }
    assert.equal(called, 0);
    assert.deepEqual(store.queried, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Paper-Pfad: abweichende instrumentId wird gemessen und als Warnung ausgewiesen", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rule-bt-warn-"));
  try {
    const store = new HistoricalStore(dir);
    store.append(oneDip(), "PAPER:ETH/USDT", { venue: "PAPER", feed: "test" }, "15m", new Date(T0));
    const parsed = parseRuleBacktestBody({ instrumentId: "PAPER:ETH/USDT" });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    const run = await executeRuleBacktest({
      spec: specFor("BTC/USDT"),
      request: parsed.value,
      store,
      loadReferenceCandles: async () => {
        throw new Error("Yahoo darf auf dem Paper-Pfad nicht laufen");
      },
      paper: { simulator: zeroFrictionSimulator(), takerFee: 0.001, makerFee: 0, spreadBpsFallback: 0 },
    });
    assert.equal(run.ok, true);
    if (!run.ok) return;
    assert.equal(run.body.instrumentId, "PAPER:ETH/USDT");
    assert.match(run.body.seriesWarning ?? "", /nicht das Regel-Symbol/);
    assert.ok(run.body.result.stats.trades >= 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolvePaperInstrumentId nennt höchstens fünf IDs und rät nicht", () => {
  const ids = [
    "ALPACA:BTC/USDT",
    "BINANCE:BTCUSDT",
    "BITUNIX:BTCUSDT",
    "DYDX:BTC-USDT",
    "KRAKEN:XBTUSDT",
    "PAPER:BTC/USDT",
  ];
  const entries: Pick<HistoricalCandleEntry, "instrumentId" | "timeframe">[] = [];
  for (const instrumentId of ids) {
    for (let i = 0; i < RULE_BACKTEST_MIN_BARS; i++) entries.push({ instrumentId, timeframe: "15m" });
  }
  const resolved = resolvePaperInstrumentId({
    entries,
    ruleSymbol: "BTC/USDT",
    timeframe: "15m",
    limit: 300,
    instrumentId: null,
  });
  assert.equal(resolved.ok, false);
  if (!resolved.ok) {
    assert.match(resolved.error, /\(\+1\)/);
    assert.equal(resolved.error.includes("PAPER:BTC/USDT"), false);
    assert.match(resolved.error, /ALPACA:BTC\/USDT/);
  }
});
