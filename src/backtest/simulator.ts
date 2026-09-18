/**
 * Multi-Asset Backtest — Ausführungssimulator (Task 02).
 *
 * Modelliert realistische Orderausführungen im Backtest:
 *   - Slippage: Fixed Basis-Points oder Spread-Relativ
 *   - Gebühren: Taker-Fee beim Einstieg und Ausstieg (Market Orders)
 *   - Stop-Loss / Take-Profit Auswertung mit Stop-Vorrang bei Kerzen-Kollision
 */

import type { BacktestEngineConfig, BacktestOpenPosition, TradeExitReason } from "./types";
import type { CandleLike } from "../lib/ruleEngine";

export interface SimulatedFill {
  fillPrice: number;
  qty: number;
  fees: number;
  slippage: number;
}

export interface ExitEvaluation {
  triggered: boolean;
  exitPrice: number;
  reason: TradeExitReason;
  fees: number;
  slippage: number;
}

/**
 * Berechnet den wirksamen Slippage-Faktor in Basispunkten.
 */
export function calculateSlippageBps(
  config: BacktestEngineConfig,
  spreadEstimate: number = 0.0004
): number {
  switch (config.slippageModel) {
    case "none":
      return 0;
    case "fixed":
      return Math.max(0, config.fixedSlippageBps);
    case "spread_relative":
      return Math.max(0, spreadEstimate * config.spreadSlippageFactor * 10_000);
    default:
      return 5;
  }
}

/**
 * Simuliert den Einstiegs-Fill für eine Long- oder Short-Order.
 */
export function simulateEntry(
  candle: CandleLike,
  side: "LONG" | "SHORT",
  requestedNotional: number,
  config: BacktestEngineConfig,
  spreadEstimate: number = 0.0004
): SimulatedFill | null {
  const basePrice = candle.close;
  if (!Number.isFinite(basePrice) || basePrice <= 0 || requestedNotional <= 0) {
    return null;
  }

  const slippageBps = calculateSlippageBps(config, spreadEstimate);
  const slippageRate = slippageBps / 10_000;

  // Long kauft zum Ask (+ Half-Spread + Slippage), Short verkauft zum Bid (- Half-Spread - Slippage)
  const halfSpread = config.slippageModel === "spread_relative" ? spreadEstimate / 2 : 0;
  const priceAdjustment = side === "LONG" ? 1 + halfSpread + slippageRate : 1 - halfSpread - slippageRate;
  const fillPrice = basePrice * priceAdjustment;

  if (!Number.isFinite(fillPrice) || fillPrice <= 0) {
    return null;
  }

  const qty = requestedNotional / fillPrice;
  if (!Number.isFinite(qty) || qty <= 0) {
    return null;
  }

  const effectiveNotional = qty * fillPrice;
  const fees = effectiveNotional * config.feeModel.takerFee;
  const slippage = Math.abs(fillPrice - basePrice) * qty;

  return {
    fillPrice: Number(fillPrice.toFixed(6)),
    qty: Number(qty.toFixed(6)),
    fees: Number(fees.toFixed(4)),
    slippage: Number(slippage.toFixed(4)),
  };
}

/**
 * Prüft eine offene Position gegen eine Kerze auf Stop-Loss, Take-Profit oder Max-Holding.
 *
 * ARCHITEKTUR-GARANTIE:
 * Wenn sowohl Stop-Loss als auch Take-Profit innerhalb derselben Kerze getroffen
 * werden (z. B. extrem volatile Bar), hat der STOP-LOSS aus Risiko- und Konservatismus-
 * Gründen immer Vorrang.
 */
export function evaluateExit(
  pos: BacktestOpenPosition,
  candle: CandleLike,
  config: BacktestEngineConfig,
  spreadEstimate: number = 0.0004,
  maxHoldingBars?: number
): ExitEvaluation | null {
  const slippageBps = calculateSlippageBps(config, spreadEstimate);
  const slippageRate = slippageBps / 10_000;

  if (pos.side === "LONG") {
    const stopHit = pos.stopLoss !== null && candle.low <= pos.stopLoss;
    const targetHit = pos.takeProfit !== null && candle.high >= pos.takeProfit;

    if (stopHit) {
      // Stop Loss greift (Slippage nach unten)
      const executionPrice = pos.stopLoss! * (1 - slippageRate);
      const fees = pos.qty * executionPrice * config.feeModel.takerFee;
      const slippage = Math.abs(pos.stopLoss! - executionPrice) * pos.qty;
      return {
        triggered: true,
        exitPrice: Number(executionPrice.toFixed(6)),
        reason: "STOP_LOSS",
        fees: Number(fees.toFixed(4)),
        slippage: Number(slippage.toFixed(4)),
      };
    }

    if (targetHit) {
      // Take Profit greift (Limit Fill zum Zielpreis)
      const executionPrice = pos.takeProfit!;
      const fees = pos.qty * executionPrice * config.feeModel.makerFee;
      return {
        triggered: true,
        exitPrice: Number(executionPrice.toFixed(6)),
        reason: "TAKE_PROFIT",
        fees: Number(fees.toFixed(4)),
        slippage: 0,
      };
    }
  } else {
    // SHORT Position
    const stopHit = pos.stopLoss !== null && candle.high >= pos.stopLoss;
    const targetHit = pos.takeProfit !== null && candle.low <= pos.takeProfit;

    if (stopHit) {
      // Stop Loss greift (Slippage nach oben)
      const executionPrice = pos.stopLoss! * (1 + slippageRate);
      const fees = pos.qty * executionPrice * config.feeModel.takerFee;
      const slippage = Math.abs(executionPrice - pos.stopLoss!) * pos.qty;
      return {
        triggered: true,
        exitPrice: Number(executionPrice.toFixed(6)),
        reason: "STOP_LOSS",
        fees: Number(fees.toFixed(4)),
        slippage: Number(slippage.toFixed(4)),
      };
    }

    if (targetHit) {
      // Take Profit greift
      const executionPrice = pos.takeProfit!;
      const fees = pos.qty * executionPrice * config.feeModel.makerFee;
      return {
        triggered: true,
        exitPrice: Number(executionPrice.toFixed(6)),
        reason: "TAKE_PROFIT",
        fees: Number(fees.toFixed(4)),
        slippage: 0,
      };
    }
  }

  // Max Holding Bars Prüfung (falls konfiguriert)
  if (maxHoldingBars && maxHoldingBars > 0) {
    // Wird extern vom Portfolio Manager getriggert
  }

  return null;
}
