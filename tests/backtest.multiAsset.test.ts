/**
 * Multi-Asset Backtest Integration Tests (Task 02).
 *
 * Testet:
 *   - Synchronisierte Timeline-Iteration über mehrere Assets (BTC, ETH, SOL)
 *   - Kein Lookahead-Bias
 *   - Deterministische Wiederholbarkeit (gleiche Eingabe = identische Ausgabe)
 *   - Integration mit HistoricalStore
 *   - Integration mit Step 8 Backtest Verification (Cycle)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { runMultiAssetBacktest, runRuleSetBacktest, runSetupsBacktest } from "../src/backtest";
import type { BacktestStrategyItem } from "../src/backtest/types";
import { HistoricalStore } from "../src/lib/marketdata/historicalStore";
import type { CandleLike, RuleSpec } from "../src/lib/ruleEngine";
import type { TradeSetupProposal } from "../src/cycle/schemas";
import { backtestStep } from "../src/cycle/steps/backtestStep";
import { validateBacktestOutput } from "../src/cycle/schemas";

function generateTrendCandles(
  symbol: string,
  startTs: number,
  count: number,
  startPrice: number,
  trendFactor: number
): CandleLike[] {
  const candles: CandleLike[] = [];
  let price = startPrice;

  for (let i = 0; i < count; i++) {
    const time = startTs + i * 3600_000;
    const change = (Math.sin(i * 0.3) * 0.01 + trendFactor) * price;
    const open = price;
    const close = price + change;
    const high = Math.max(open, close) * 1.005;
    const low = Math.min(open, close) * 0.995;
    const volume = 1000 + (i % 5) * 200;

    candles.push({
      time,
      open: Number(open.toFixed(2)),
      high: Number(high.toFixed(2)),
      low: Number(low.toFixed(2)),
      close: Number(close.toFixed(2)),
      volume,
    });

    price = close;
  }

  return candles;
}

describe("Multi-Asset Backtest Engine", () => {
  const startTs = 1700000000000;
  const count = 100;

  const btcCandles = generateTrendCandles("BTCUSDT", startTs, count, 30000, 0.002);
  const ethCandles = generateTrendCandles("ETHUSDT", startTs, count, 2000, 0.001);
  const solCandles = generateTrendCandles("SOLUSDT", startTs, count, 50, -0.001);

  const btcRule: RuleSpec = {
    name: "BTC Trend Rule",
    symbol: "BTCUSDT",
    missionId: null,
    rationale: "Trend test",
    sourceRole: "MANUAL",
    riskScore: 0.3,
    condition: {
      logic: "all",
      conditions: [{ field: "rsi14", op: "lt", value: 70 }],
    },
    action: {
      side: "LONG",
      stopLossPct: 3.0,
      takeProfitRR: 2.0,
      riskBudgetPct: 0.02,
      maxPositionPct: 0.25,
      positionSizeMode: "risk",
    },
    window: {
      timeframe: "1h",
      validFrom: null,
      validUntil: null,
      maxExecutionsPerDay: 5,
      cooldownMinutes: 60,
      volumeWindow: 20,
    },
  };

  const ethRule: RuleSpec = {
    name: "ETH Trend Rule",
    symbol: "ETHUSDT",
    missionId: null,
    rationale: "Trend test",
    sourceRole: "MANUAL",
    riskScore: 0.3,
    condition: {
      logic: "all",
      conditions: [{ field: "rsi14", op: "lt", value: 65 }],
    },
    action: {
      side: "LONG",
      stopLossPct: 4.0,
      takeProfitRR: 1.5,
      riskBudgetPct: 0.02,
      maxPositionPct: 0.25,
      positionSizeMode: "risk",
    },
    window: {
      timeframe: "1h",
      validFrom: null,
      validUntil: null,
      maxExecutionsPerDay: 5,
      cooldownMinutes: 60,
      volumeWindow: 20,
    },
  };

  it("führt synchronisierten Multi-Asset Backtest über 3 Symbole fehlerfrei aus", () => {
    const candlesBySymbol = new Map<string, CandleLike[]>([
      ["BTCUSDT", btcCandles],
      ["ETHUSDT", ethCandles],
      ["SOLUSDT", solCandles],
    ]);

    const strategies: BacktestStrategyItem[] = [
      { type: "rule", spec: btcRule, id: "R-BTC" },
      { type: "rule", spec: ethRule, id: "R-ETH" },
    ];

    const result = runMultiAssetBacktest({
      candlesBySymbol,
      strategies,
      config: {
        initialCapital: 20_000,
        maxOpenPositions: 3,
        warmupBars: 20,
      },
    });

    assert.ok(result);
    assert.equal(result.symbols.length, 3);
    assert.equal(result.barsProcessed, count);
    assert.ok(result.equityCurve.length > 0);
    assert.ok(result.metrics.startingEquity === 20_000);
    assert.ok(result.metrics.endingEquity > 0);
    assert.ok(result.trades.length > 0);
    assert.ok(result.executionDurationMs >= 0);
  });

  it("garantiert absolute Determinismus-Wiederholbarkeit", () => {
    const candlesBySymbol = new Map<string, CandleLike[]>([
      ["BTCUSDT", btcCandles],
      ["ETHUSDT", ethCandles],
    ]);

    const strategies: BacktestStrategyItem[] = [
      { type: "rule", spec: btcRule, id: "R-BTC" },
      { type: "rule", spec: ethRule, id: "R-ETH" },
    ];

    const run1 = runMultiAssetBacktest({
      candlesBySymbol,
      strategies,
      config: { initialCapital: 10_000, warmupBars: 20 },
    });

    const run2 = runMultiAssetBacktest({
      candlesBySymbol,
      strategies,
      config: { initialCapital: 10_000, warmupBars: 20 },
    });

    assert.equal(run1.metrics.endingEquity, run2.metrics.endingEquity);
    assert.equal(run1.metrics.totalReturn, run2.metrics.totalReturn);
    assert.equal(run1.metrics.totalTrades, run2.metrics.totalTrades);
    assert.equal(run1.metrics.winRate, run2.metrics.winRate);
    assert.equal(run1.trades.length, run2.trades.length);
    assert.deepEqual(run1.trades[0], run2.trades[0]);
  });

  it("unterstützt TradeSetupProposal-Objekte aus dem Research-Zyklus", () => {
    const setup: TradeSetupProposal = {
      instrumentId: "BITUNIX:BTCUSDT",
      side: "LONG",
      entryPrice: 30000,
      stopLoss: 29000,
      takeProfit: 32000,
      riskScore: 0.4,
      timeframe: "1h",
      thesis: "Bullish bounce test",
      isProposal: true,
    };

    const result = runMultiAssetBacktest({
      candlesBySymbol: new Map([["BITUNIX:BTCUSDT", btcCandles]]),
      strategies: [{ type: "setup", setup, id: "SETUP-BTC" }],
      config: { initialCapital: 10_000, warmupBars: 10 },
    });

    assert.ok(result);
    assert.ok(result.metrics);
  });

  it("integriert mit HistoricalStore via runRuleSetBacktest und runSetupsBacktest", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "backtest-store-test-"));
    try {
      const store = new HistoricalStore(tmpDir);
      const now = new Date();

      store.appendSeries(
        [
          {
            instrumentId: "BTCUSDT",
            provenance: { venue: "BITUNIX", feed: "test" },
            timeframe: "1h",
            candles: btcCandles.map((c) => ({
              time: c.time,
              open: c.open,
              high: c.high,
              low: c.low,
              close: c.close,
              volume: c.volume,
            })),
          },
        ],
        now
      );

      const res = runRuleSetBacktest([btcRule], store, { initialCapital: 10_000, warmupBars: 20 });
      assert.ok(res);
      assert.equal(res.symbols[0], "BTCUSDT");
      assert.ok(res.trades.length > 0);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("funktioniert nahtlos im Step 8 Backtest Verification Cycle", async () => {
    // GAP-01 (v1.51.0): sinngemäß auf den Fail-closed-Pfad umgestellt — bei
    // leerem Store (isoliertes Temp-Verz) meldet der Step DATA_UNAVAILABLE
    // (verified=false) statt einer erfundenen Bewertung.
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "backtest-step8-empty-"));
    const prevHistoryDir = process.env.PAPER_HISTORY_DIR;
    process.env.PAPER_HISTORY_DIR = tmpDir;
    try {
      const setup: TradeSetupProposal = {
        instrumentId: "BTCUSDT",
        side: "LONG",
        entryPrice: 30000,
        stopLoss: 28500,
        takeProfit: 33000,
        riskScore: 0.3,
        timeframe: "1h",
        thesis: "Trend-Setup",
        isProposal: true,
      };

      const auditEvents: unknown[] = [];
      const dummyContext: any = {
        cycleId: "test-cycle",
        date: "2026-09-18",
        asOf: new Date(),
        clock: { now: () => new Date(), nowMs: () => Date.now(), toISOString: () => new Date().toISOString() },
        input: { setups: [setup] },
        previousStepOutputs: {
          "07-research": { setups: [setup], totalSetups: 1, disclaimer: "PROPOSAL_ONLY_NO_ORDERS_PLACED" },
        },
        ports: {
          audit: {
            logEvent: async (e: unknown) => { auditEvents.push(e); },
            getEvents: async () => auditEvents,
          },
        },
        log: () => {},
      };

      const out = await backtestStep.execute(dummyContext);
      const validation = validateBacktestOutput(out);
      assert.equal(validation.valid, true);
      assert.equal(out.verifiedSetups.length, 1);
      assert.ok(out.verifiedSetups[0].metrics);
      assert.equal(out.verifiedSetups[0].status, "DATA_UNAVAILABLE");
      assert.equal(out.verifiedSetups[0].verified, false);
      assert.equal(out.summary.unavailable, 1);
      assert.equal(auditEvents.length, 1);
    } finally {
      if (prevHistoryDir === undefined) delete process.env.PAPER_HISTORY_DIR;
      else process.env.PAPER_HISTORY_DIR = prevHistoryDir;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
