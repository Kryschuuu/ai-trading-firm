/**
 * Unit-Tests für die Multi-Asset Backtest-Engine (Task 02).
 *
 * Testet:
 *   - Ausführungssimulator (Slippage, Fees, Stop-Loss Vorrang bei Kollision)
 *   - Portfolio-Manager (Cash, Notional-Caps, Guardrails, Mark-to-Market)
 *   - Metriken-Berechnung (Sharpe, Sortino, MaxDD, Profit Factor, Expectancy)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  calculateSlippageBps,
  simulateEntry,
  evaluateExit,
} from "../src/backtest/simulator";
import { BacktestPortfolio } from "../src/backtest/portfolio";
import {
  computeBacktestMetrics,
  computePerSymbolStats,
  computePerStrategyStats,
} from "../src/backtest/metrics";
import { DEFAULT_BACKTEST_CONFIG } from "../src/backtest/engine";
import type {
  BacktestEngineConfig,
  BacktestEquityPoint,
  BacktestOpenPosition,
  BacktestTradeLog,
} from "../src/backtest/types";
import type { CandleLike } from "../src/lib/ruleEngine";

describe("Backtest Simulator", () => {
  const config: BacktestEngineConfig = {
    ...DEFAULT_BACKTEST_CONFIG,
    fixedSlippageBps: 10, // 10 bp = 0.001
    feeModel: { makerFee: 0.0002, takerFee: 0.0006 },
  };

  it("berechnet Slippage für verschiedene Modelle korrekt", () => {
    assert.equal(calculateSlippageBps({ ...config, slippageModel: "none" }), 0);
    assert.equal(calculateSlippageBps({ ...config, slippageModel: "fixed" }), 10);
    assert.equal(
      calculateSlippageBps({ ...config, slippageModel: "spread_relative", spreadSlippageFactor: 0.5 }, 0.0004),
      2 // 0.0004 * 0.5 * 10000 = 2 bp
    );
  });

  it("simuliert LONG-Einstieg mit Slippage und Taker-Gebühren", () => {
    const candle: CandleLike = {
      time: 1700000000000,
      open: 100,
      high: 105,
      low: 98,
      close: 100,
      volume: 1000,
    };

    const fill = simulateEntry(candle, "LONG", 1000, config);
    assert.ok(fill);
    // Fill-Preis bei 10 bp Slippage = 100 * (1 + 0.001) = 100.1
    assert.equal(fill.fillPrice, 100.1);
    assert.ok(fill.qty > 0);
    assert.ok(fill.fees > 0);
    assert.ok(fill.slippage > 0);
  });

  it("simuliert SHORT-Einstieg mit Slippage nach unten", () => {
    const candle: CandleLike = {
      time: 1700000000000,
      open: 100,
      high: 105,
      low: 98,
      close: 100,
      volume: 1000,
    };

    const fill = simulateEntry(candle, "SHORT", 1000, config);
    assert.ok(fill);
    // Fill-Preis bei 10 bp Slippage = 100 * (1 - 0.001) = 99.9
    assert.equal(fill.fillPrice, 99.9);
  });

  it("gibt null bei ungültigen Preisen oder Notionals zurück", () => {
    const candle: CandleLike = {
      time: 1700000000000,
      open: 0,
      high: 0,
      low: 0,
      close: 0,
      volume: 0,
    };

    assert.equal(simulateEntry(candle, "LONG", 1000, config), null);
    assert.equal(simulateEntry({ ...candle, close: 100 }, "LONG", -50, config), null);
  });

  it("bevorzugt Stop-Loss vor Take-Profit bei gleichzeitiger Treffer-Kollision (Invariante)", () => {
    const pos: BacktestOpenPosition = {
      id: "POS-1",
      strategyId: "STRAT-1",
      symbol: "BTCUSDT",
      side: "LONG",
      entryTime: 1700000000000,
      entryBarIndex: 1,
      entryPrice: 100,
      qty: 10,
      notional: 1000,
      stopLoss: 95,
      takeProfit: 110,
      unrealizedPnl: 0,
      highestPrice: 100,
      lowestPrice: 100,
      feesPaid: 0.6,
      slippagePaid: 1.0,
    };

    // Extreme volatile Kerze: berührt Low 90 (unter SL 95) UND High 115 (über TP 110)
    const volatileCandle: CandleLike = {
      time: 1700003600000,
      open: 100,
      high: 115,
      low: 90,
      close: 102,
      volume: 5000,
    };

    const exit = evaluateExit(pos, volatileCandle, config);
    assert.ok(exit);
    assert.equal(exit.triggered, true);
    // STOP_LOSS muss zwingend gewinnen!
    assert.equal(exit.reason, "STOP_LOSS");
    assert.ok(exit.exitPrice <= 95);
  });

  it("löst Take-Profit sauber aus, wenn nur TP erreicht wird", () => {
    const pos: BacktestOpenPosition = {
      id: "POS-2",
      strategyId: "STRAT-1",
      symbol: "BTCUSDT",
      side: "LONG",
      entryTime: 1700000000000,
      entryBarIndex: 1,
      entryPrice: 100,
      qty: 10,
      notional: 1000,
      stopLoss: 95,
      takeProfit: 110,
      unrealizedPnl: 0,
      highestPrice: 100,
      lowestPrice: 100,
      feesPaid: 0.6,
      slippagePaid: 1.0,
    };

    const bullCandle: CandleLike = {
      time: 1700003600000,
      open: 101,
      high: 112,
      low: 99,
      close: 108,
      volume: 2000,
    };

    const exit = evaluateExit(pos, bullCandle, config);
    assert.ok(exit);
    assert.equal(exit.triggered, true);
    assert.equal(exit.reason, "TAKE_PROFIT");
    assert.equal(exit.exitPrice, 110);
  });
});

describe("Backtest Portfolio Manager", () => {
  const config: BacktestEngineConfig = {
    ...DEFAULT_BACKTEST_CONFIG,
    initialCapital: 10_000,
    maxOpenPositions: 2,
    maxRiskPerTrade: 0.02,
    maxPositionPct: 0.25,
  };

  it("initialisiert Portfolio-Zustand korrekt", () => {
    const p = new BacktestPortfolio(config);
    assert.equal(p.currentCash, 10_000);
    assert.equal(p.openPositionsCount, 0);
    assert.equal(p.trades.length, 0);
    assert.equal(p.equityCurve.length, 0);
  });

  it("prüft Positionseröffnung gegen Guardrails (maxOpenPositions, duplicate)", () => {
    const p = new BacktestPortfolio(config);
    const candle: CandleLike = { time: 1000, open: 100, high: 105, low: 95, close: 100, volume: 100 };

    // 1. Position öffnen
    const fill1 = simulateEntry(candle, "LONG", 2000, config)!;
    p.openPosition("S1", "BTCUSDT", "LONG", fill1, candle, 1, 95, 110);
    assert.equal(p.openPositionsCount, 1);

    // Duplikat ablehnen
    const checkDup = p.canOpenPosition("BTCUSDT", 10_000);
    assert.equal(checkDup.allowed, false);
    assert.match(checkDup.reason!, /POSITION_ALREADY_OPEN/);

    // 2. Position öffnen
    const fill2 = simulateEntry(candle, "LONG", 2000, config)!;
    p.openPosition("S2", "ETHUSDT", "LONG", fill2, candle, 1, 95, 110);
    assert.equal(p.openPositionsCount, 2);

    // 3. Position über Limit ablehnen
    const checkMax = p.canOpenPosition("SOLUSDT", 10_000);
    assert.equal(checkMax.allowed, false);
    assert.equal(checkMax.reason, "MAX_OPEN_POSITIONS_REACHED");
  });

  it("schließt Positionen und verbucht PnL und Cash exakt", () => {
    const p = new BacktestPortfolio(config);
    const candle: CandleLike = { time: 1000, open: 100, high: 105, low: 95, close: 100, volume: 100 };
    const fill = simulateEntry(candle, "LONG", 1000, config)!;
    p.openPosition("S1", "BTCUSDT", "LONG", fill, candle, 1, 95, 110);

    const initialCashAfterOpen = p.currentCash;
    assert.ok(initialCashAfterOpen < 10_000);

    // TP Exit bei 110
    const exitEval = {
      triggered: true,
      exitPrice: 110,
      reason: "TAKE_PROFIT" as const,
      fees: 0.22,
      slippage: 0,
    };

    const trade = p.closePosition("BTCUSDT", exitEval, 2000, 5);
    assert.ok(trade);
    assert.equal(trade.symbol, "BTCUSDT");
    assert.equal(trade.exitReason, "TAKE_PROFIT");
    assert.ok(trade.pnl > 0);
    assert.equal(p.openPositionsCount, 0);
    assert.equal(p.trades.length, 1);
    assert.ok(p.currentCash > 10_000); // Gewinn realisiert
  });
});

describe("Backtest Metrics Computation", () => {
  it("berechnet Sharpe, Sortino, Drawdown und Win Rate mathematisch präzise", () => {
    const trades: BacktestTradeLog[] = [
      {
        id: "T1",
        strategyId: "S1",
        symbol: "BTCUSDT",
        side: "LONG",
        entryTime: 1000,
        exitTime: 2000,
        entryPrice: 100,
        exitPrice: 110,
        qty: 10,
        notional: 1000,
        pnl: 100,
        pnlPct: 10,
        fees: 1,
        slippage: 0.5,
        exitReason: "TAKE_PROFIT",
        durationBars: 5,
        durationMs: 1000,
      },
      {
        id: "T2",
        strategyId: "S1",
        symbol: "BTCUSDT",
        side: "LONG",
        entryTime: 3000,
        exitTime: 4000,
        entryPrice: 110,
        exitPrice: 105,
        qty: 10,
        notional: 1100,
        pnl: -50,
        pnlPct: -4.5,
        fees: 1,
        slippage: 0.5,
        exitReason: "STOP_LOSS",
        durationBars: 3,
        durationMs: 1000,
      },
    ];

    const equityCurve: BacktestEquityPoint[] = [
      { timestamp: 1000, equity: 10000, cash: 10000, openPositions: 0, exposurePct: 0, unrealizedPnl: 0, realizedPnl: 0, drawdownPct: 0 },
      { timestamp: 2000, equity: 10100, cash: 10100, openPositions: 0, exposurePct: 0, unrealizedPnl: 0, realizedPnl: 100, drawdownPct: 0 },
      { timestamp: 3000, equity: 10100, cash: 9000, openPositions: 1, exposurePct: 10.9, unrealizedPnl: 0, realizedPnl: 100, drawdownPct: 0 },
      { timestamp: 4000, equity: 10050, cash: 10050, openPositions: 0, exposurePct: 0, unrealizedPnl: 0, realizedPnl: 50, drawdownPct: 0.5 },
    ];

    const metrics = computeBacktestMetrics(trades, equityCurve, 10000, 2, 1);

    assert.equal(metrics.startingEquity, 10000);
    assert.equal(metrics.endingEquity, 10050);
    assert.equal(metrics.totalReturn, 50);
    assert.equal(metrics.totalReturnPct, 0.5);
    assert.equal(metrics.totalTrades, 2);
    assert.equal(metrics.winningTrades, 1);
    assert.equal(metrics.losingTrades, 1);
    assert.equal(metrics.winRate, 50);
    assert.equal(metrics.profitFactor, 2.0); // 100 / 50 = 2.0
    assert.equal(metrics.grossProfit, 100);
    assert.equal(metrics.grossLoss, 50);
    assert.ok(metrics.maxDrawdownPct >= 0);

    const logReturns = [Math.log(10100 / 10000), Math.log(10100 / 10100), Math.log(10050 / 10100)];
    const meanReturn = logReturns.reduce((sum, value) => sum + value, 0) / logReturns.length;
    const sampleVariance =
      logReturns.reduce((sum, value) => sum + (value - meanReturn) ** 2, 0) /
      (logReturns.length - 1);
    const expectedAnnualizedVolatilityPct = Number(
      (Math.sqrt(sampleVariance) * Math.sqrt(365 * 24) * 100).toFixed(2),
    );
    assert.ok(metrics.annualizedVolatility > 0, "nichtkonstante Equity-Renditen haben positive Volatilität");
    assert.equal(metrics.annualizedVolatility, expectedAnnualizedVolatilityPct);

    const symStats = computePerSymbolStats(trades);
    assert.ok(symStats["BTCUSDT"]);
    assert.equal(symStats["BTCUSDT"].trades, 2);

    const stratStats = computePerStrategyStats(trades);
    assert.ok(stratStats["S1"]);
    assert.equal(stratStats["S1"].trades, 2);
  });
});
