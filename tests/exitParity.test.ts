/**
 * Stop-Vorrang ist in beiden Kerzen-Pfaden dieselbe Invariante (VBF-P3-01).
 * Kein gemeinsamer Exit-Code: Live bleibt auf decideExit.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectExitTrigger } from "../src/backtest/paperExecution";
import { evaluateExit } from "../src/backtest/simulator";
import { DEFAULT_BACKTEST_CONFIG, type BacktestOpenPosition } from "../src/backtest";
import type { CandleLike } from "../src/lib/ruleEngine";

function position(side: "LONG" | "SHORT"): BacktestOpenPosition {
  return {
    id: "P",
    strategyId: "S",
    symbol: "BTC",
    side,
    entryTime: 0,
    entryBarIndex: 0,
    entryPrice: 100,
    qty: 1,
    notional: 100,
    stopLoss: side === "LONG" ? 95 : 105,
    takeProfit: side === "LONG" ? 110 : 90,
    unrealizedPnl: 0,
    highestPrice: 100,
    lowestPrice: 100,
    feesPaid: 0,
    slippagePaid: 0,
  };
}

function collision(side: "LONG" | "SHORT"): CandleLike {
  return side === "LONG"
    ? { time: 1, open: 100, high: 120, low: 90, close: 100, volume: 1 }
    : { time: 1, open: 100, high: 110, low: 80, close: 100, volume: 1 };
}

test("dieselbe Kerze trifft Stop und Target: beide Pfade liefern STOP_LOSS", () => {
  assert.equal(DEFAULT_BACKTEST_CONFIG.executionModel, "legacy");
  for (const side of ["LONG", "SHORT"] as const) {
    const pos = position(side);
    const candle = collision(side);
    assert.equal(detectExitTrigger(pos, candle)?.reason, "STOP_LOSS");
    assert.equal(evaluateExit(pos, candle, DEFAULT_BACKTEST_CONFIG)?.reason, "STOP_LOSS");
  }
});
