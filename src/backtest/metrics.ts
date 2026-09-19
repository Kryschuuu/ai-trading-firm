/**
 * Multi-Asset Backtest — Metriken-Berechnung (Task 02).
 *
 * Berechnet mathematisch fundierte Kennzahlen über Trade-Logs und Equity-Kurve:
 *   - Sharpe & Sortino Ratios (unter Nutzung von src/portfolio/metrics.ts)
 *   - Max Drawdown (Peak to Trough & Duration)
 *   - Profit Factor, Win Rate, Expectancy, Streak-Statistiken
 *   - Einzelstatistiken je Symbol und je Strategie
 */

import type {
  BacktestEquityPoint,
  BacktestMetrics,
  BacktestTradeLog,
  StrategyBacktestStats,
  SymbolBacktestStats,
} from "./types";
import { maxDrawdown, profitFactor, sharpeRatio, sortinoRatio } from "../portfolio/metrics";

/**
 * Berechnet die Gesamtkennzahlen aus den Trade-Logs und der Equity-Kurve.
 */
export function computeBacktestMetrics(
  trades: BacktestTradeLog[],
  equityCurve: BacktestEquityPoint[],
  initialCapital: number,
  totalFeesPaid: number,
  totalSlippagePaid: number,
  annualizationFactor: number = 365 * 24, // 1h-Kerzen -> 8760 Perioden p. a.
  /**
   * Kumuliertes Funding in Kontowährung (GAP-01, v1.51.0; nur „paper“-Pfad,
   * negativ = gezahlt). Default 0 = Legacy-Läufe unverändert.
   */
  totalFundingPaid: number = 0
): BacktestMetrics {
  const endingEquity = equityCurve.length > 0 ? equityCurve[equityCurve.length - 1].equity : initialCapital;
  const totalReturn = endingEquity - initialCapital;
  const totalReturnPct = initialCapital > 0 ? (totalReturn / initialCapital) * 100 : 0;

  // Renditen-Serie aus der Equity-Kurve für Sharpe / Sortino
  const periodicReturns: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const prev = equityCurve[i - 1].equity;
    const curr = equityCurve[i].equity;
    if (prev > 0) {
      periodicReturns.push(Math.log(curr / prev));
    }
  }

  const sharpeRes =
    periodicReturns.length >= 2
      ? sharpeRatio(periodicReturns, { annualization: annualizationFactor })
      : { perPeriod: 0, annualized: 0 };
  const sortinoRes =
    periodicReturns.length >= 2
      ? sortinoRatio(periodicReturns, { annualization: annualizationFactor })
      : { perPeriod: 0, annualized: 0 };

  const equityValues = equityCurve.map((p) => p.equity);
  const mddRes = equityValues.length > 0 ? maxDrawdown(equityValues) : { value: 0, durationPeriods: 0 };
  const maxDrawdownPct = mddRes.value * 100;
  const maxDrawdownDurationBars = mddRes.durationPeriods;

  const totalTrades = trades.length;
  const winningTrades = trades.filter((t) => t.pnl > 0);
  const losingTrades = trades.filter((t) => t.pnl < 0);
  const breakevenTrades = trades.filter((t) => t.pnl === 0);

  const winRate = totalTrades > 0 ? (winningTrades.length / totalTrades) * 100 : 0;

  const tradePnls = trades.map((t) => t.pnl);
  const pfRes =
    tradePnls.length > 0
      ? profitFactor(tradePnls)
      : { value: null, grossProfit: 0, grossLoss: 0 };
  const profitFactorValue = pfRes.value;
  const grossProfit = pfRes.grossProfit;
  const grossLoss = pfRes.grossLoss;

  const averageTradePnl = totalTrades > 0 ? totalReturn / totalTrades : 0;
  const averageWin = winningTrades.length > 0 ? grossProfit / winningTrades.length : 0;
  const averageLoss = losingTrades.length > 0 ? grossLoss / losingTrades.length : 0;
  const winLossRatio = averageLoss > 0 ? averageWin / averageLoss : null;

  // Expectancy = (Win Rate * Avg Win) - (Loss Rate * Avg Loss)
  const winProb = totalTrades > 0 ? winningTrades.length / totalTrades : 0;
  const lossProb = totalTrades > 0 ? losingTrades.length / totalTrades : 0;
  const expectancy = winProb * averageWin - lossProb * averageLoss;

  // Streak-Statistiken
  let maxConsecutiveWins = 0;
  let maxConsecutiveLosses = 0;
  let currWins = 0;
  let currLosses = 0;

  for (const t of trades) {
    if (t.pnl > 0) {
      currWins++;
      currLosses = 0;
      maxConsecutiveWins = Math.max(maxConsecutiveWins, currWins);
    } else if (t.pnl < 0) {
      currLosses++;
      currWins = 0;
      maxConsecutiveLosses = Math.max(maxConsecutiveLosses, currLosses);
    } else {
      currWins = 0;
      currLosses = 0;
    }
  }

  const totalHoldingBars = trades.reduce((sum, t) => sum + t.durationBars, 0);
  const averageHoldingBars = totalTrades > 0 ? totalHoldingBars / totalTrades : 0;

  // Exposure-Zeit: Anteil der Perioden mit mindestens einer offenen Position
  const activeBars = equityCurve.filter((p) => p.openPositions > 0).length;
  const exposureTimePct = equityCurve.length > 0 ? (activeBars / equityCurve.length) * 100 : 0;

  // CAGR Berechnung (wenn Zeitspanne > 1 Tag)
  let cagr: number | null = null;
  if (equityCurve.length > 1) {
    const firstTs = equityCurve[0].timestamp;
    const lastTs = equityCurve[equityCurve.length - 1].timestamp;
    const years = (lastTs - firstTs) / (1000 * 3600 * 24 * 365.25);
    if (years > 0.05 && endingEquity > 0 && initialCapital > 0) {
      cagr = Number(((Math.pow(endingEquity / initialCapital, 1 / years) - 1) * 100).toFixed(2));
    }
  }

  const calmarRatio = maxDrawdownPct > 0 && cagr !== null ? Number((cagr / maxDrawdownPct).toFixed(2)) : null;

  return {
    startingEquity: Number(initialCapital.toFixed(2)),
    endingEquity: Number(endingEquity.toFixed(2)),
    totalReturn: Number(totalReturn.toFixed(2)),
    totalReturnPct: Number(totalReturnPct.toFixed(2)),
    cagr,
    annualizedReturn: Number((sharpeRes.annualized !== undefined ? (totalReturnPct * (annualizationFactor / Math.max(1, equityCurve.length))) : 0).toFixed(2)),
    annualizedVolatility: Number((((sharpeRes as any).volatility ?? 0) * 100).toFixed(2)),
    sharpeRatio: Number((sharpeRes.annualized ?? 0).toFixed(2)),
    sortinoRatio: Number((sortinoRes.annualized ?? 0).toFixed(2)),
    calmarRatio,
    maxDrawdownPct: Number(maxDrawdownPct.toFixed(2)),
    maxDrawdownDurationBars,
    totalTrades,
    winningTrades: winningTrades.length,
    losingTrades: losingTrades.length,
    breakevenTrades: breakevenTrades.length,
    winRate: Number(winRate.toFixed(2)),
    profitFactor: profitFactorValue !== null && Number.isFinite(profitFactorValue) ? Number(profitFactorValue.toFixed(2)) : null,
    grossProfit: Number(grossProfit.toFixed(2)),
    grossLoss: Number(grossLoss.toFixed(2)),
    averageTradePnl: Number(averageTradePnl.toFixed(2)),
    averageWin: Number(averageWin.toFixed(2)),
    averageLoss: Number(averageLoss.toFixed(2)),
    winLossRatio: winLossRatio !== null && Number.isFinite(winLossRatio) ? Number(winLossRatio.toFixed(2)) : null,
    expectancy: Number(expectancy.toFixed(2)),
    maxConsecutiveWins,
    maxConsecutiveLosses,
    averageHoldingBars: Number(averageHoldingBars.toFixed(1)),
    exposureTimePct: Number(exposureTimePct.toFixed(2)),
    totalFeesPaid: Number(totalFeesPaid.toFixed(2)),
    totalSlippagePaid: Number(totalSlippagePaid.toFixed(2)),
    totalFundingPaid: Number((Number.isFinite(totalFundingPaid) ? totalFundingPaid : 0).toFixed(8)),
  };
}

/**
 * Erstellt Symbol-spezifische Auswertungen.
 */
export function computePerSymbolStats(trades: BacktestTradeLog[]): Record<string, SymbolBacktestStats> {
  const bySymbol = new Map<string, BacktestTradeLog[]>();
  for (const t of trades) {
    const list = bySymbol.get(t.symbol) ?? [];
    list.push(t);
    bySymbol.set(t.symbol, list);
  }

  const out: Record<string, SymbolBacktestStats> = {};
  for (const [symbol, symTrades] of bySymbol.entries()) {
    const wins = symTrades.filter((t) => t.pnl > 0).length;
    const losses = symTrades.filter((t) => t.pnl < 0).length;
    const pnl = Number(symTrades.reduce((sum, t) => sum + t.pnl, 0).toFixed(2));
    const winRate = symTrades.length > 0 ? Number(((wins / symTrades.length) * 100).toFixed(2)) : 0;
    const pf = symTrades.length > 0 ? profitFactor(symTrades.map((t) => t.pnl)).value : null;

    out[symbol] = {
      symbol,
      trades: symTrades.length,
      wins,
      losses,
      winRate,
      pnl,
      profitFactor: pf !== null && Number.isFinite(pf) ? Number(pf.toFixed(2)) : null,
      maxDrawdownPct: 0,
    };
  }

  return out;
}

/**
 * Erstellt Strategie-spezifische Auswertungen.
 */
export function computePerStrategyStats(trades: BacktestTradeLog[]): Record<string, StrategyBacktestStats> {
  const byStrat = new Map<string, BacktestTradeLog[]>();
  for (const t of trades) {
    const list = byStrat.get(t.strategyId) ?? [];
    list.push(t);
    byStrat.set(t.strategyId, list);
  }

  const out: Record<string, StrategyBacktestStats> = {};
  for (const [strategyId, stratTrades] of byStrat.entries()) {
    const wins = stratTrades.filter((t) => t.pnl > 0).length;
    const losses = stratTrades.filter((t) => t.pnl < 0).length;
    const pnl = Number(stratTrades.reduce((sum, t) => sum + t.pnl, 0).toFixed(2));
    const winRate = stratTrades.length > 0 ? Number(((wins / stratTrades.length) * 100).toFixed(2)) : 0;
    const pf = stratTrades.length > 0 ? profitFactor(stratTrades.map((t) => t.pnl)).value : null;

    out[strategyId] = {
      strategyId,
      symbol: stratTrades[0]?.symbol ?? "",
      trades: stratTrades.length,
      wins,
      losses,
      winRate,
      pnl,
      profitFactor: pf !== null && Number.isFinite(pf) ? Number(pf.toFixed(2)) : null,
    };
  }

  return out;
}
