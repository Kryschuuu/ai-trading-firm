/**
 * Multi-Asset Backtest-Engine — Typdefinitionen & Verträge (Task 02).
 *
 * Deterministische Typen für die Event-Driven Multi-Asset-Simulation
 * historischer Strategieregeln und Research-Setups.
 *
 * Alle Geldbeträge und Metriken sind deterministisch und mathematisch fundiert.
 */

import type { SupportedTimeframe } from "../lib/marketdata/historicalStore";
import type { RuleSpec } from "../lib/ruleEngine";
import type { TradeSetupProposal } from "../cycle/schemas";
import type { CandleLike } from "../lib/ruleEngine";

export type SlippageModel = "fixed" | "spread_relative" | "none";

/** Konfigurationsparameter für einen Backtest-Lauf. */
export interface BacktestEngineConfig {
  /** Startkapital in Kontowährung (Default: 10_000). */
  initialCapital: number;
  /** Periodizität der analysierten Kerzen (Default: "1h"). */
  timeframe: SupportedTimeframe;
  /** Optionaler Start-Zeitstempel (ms). */
  from?: number;
  /** Optionaler End-Zeitstempel (ms). */
  to?: number;
  /** Anzahl Kerzen für den Warmup von Indikatoren (Default: 30). */
  warmupBars: number;
  /** Maximale Anzahl gleichzeitiger offener Positionen (Default: 5). */
  maxOpenPositions: number;
  /** Maximales Risiko pro Trade als Anteil des Eigenkapitals (Default: 0.02 = 2 %). */
  maxRiskPerTrade: number;
  /** Maximale Positionsgröße bezogen auf das Gesamtkapital (Default: 0.25 = 25 %). */
  maxPositionPct: number;
  /** Verwendetes Slippage-Modell (Default: "fixed"). */
  slippageModel: SlippageModel;
  /** Fester Slippage in Basispunkten bei Modell "fixed" (Default: 5 bp = 0.0005). */
  fixedSlippageBps: number;
  /** Multiplikator auf den relativen Spread bei Modell "spread_relative" (Default: 0.5). */
  spreadSlippageFactor: number;
  /** Gebührenmodell in Dezimalform (z. B. VIP0: maker 0.02 %, taker 0.06 %). */
  feeModel: {
    makerFee: number;
    takerFee: number;
  };
  /** Erlaube Short-Positionen (Default: false). */
  enableShorts: boolean;
}

/** Teilkonfiguration für Aufrufer mit sinnvollen Defaults. */
export type BacktestEngineOptions = Partial<BacktestEngineConfig>;

/** Repräsentation einer offenen Position während des Backtests. */
export interface BacktestOpenPosition {
  id: string;
  strategyId: string;
  symbol: string;
  side: "LONG" | "SHORT";
  entryTime: number;
  entryBarIndex: number;
  entryPrice: number;
  qty: number;
  notional: number;
  stopLoss: number | null;
  takeProfit: number | null;
  unrealizedPnl: number;
  highestPrice: number;
  lowestPrice: number;
  feesPaid: number;
  slippagePaid: number;
}

/** Grund für die Schließung eines Trades. */
export type TradeExitReason =
  | "STOP_LOSS"
  | "TAKE_PROFIT"
  | "SIGNAL_EXIT"
  | "MAX_HOLDING"
  | "RISK_STOP"
  | "END_OF_DATA";

/** Vollständig abgeschlossener Trade im Backtest-Log. */
export interface BacktestTradeLog {
  id: string;
  strategyId: string;
  symbol: string;
  side: "LONG" | "SHORT";
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  qty: number;
  notional: number;
  pnl: number;
  pnlPct: number;
  fees: number;
  slippage: number;
  exitReason: TradeExitReason;
  durationBars: number;
  durationMs: number;
}

/** Einzelner Datenpunkt der simulierten Equity-Kurve. */
export interface BacktestEquityPoint {
  timestamp: number;
  equity: number;
  cash: number;
  openPositions: number;
  exposurePct: number;
  unrealizedPnl: number;
  realizedPnl: number;
  drawdownPct: number;
}

/** Performance- und Risikokennzahlen des Backtests. */
export interface BacktestMetrics {
  startingEquity: number;
  endingEquity: number;
  totalReturn: number;
  totalReturnPct: number;
  cagr: number | null;
  annualizedReturn: number;
  annualizedVolatility: number;
  sharpeRatio: number;
  sortinoRatio: number;
  calmarRatio: number | null;
  maxDrawdownPct: number;
  maxDrawdownDurationBars: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  breakevenTrades: number;
  winRate: number;
  profitFactor: number | null;
  grossProfit: number;
  grossLoss: number;
  averageTradePnl: number;
  averageWin: number;
  averageLoss: number;
  winLossRatio: number | null;
  expectancy: number;
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
  averageHoldingBars: number;
  exposureTimePct: number;
  totalFeesPaid: number;
  totalSlippagePaid: number;
}

/** Einzelstatistik je Symbol. */
export interface SymbolBacktestStats {
  symbol: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  pnl: number;
  profitFactor: number | null;
  maxDrawdownPct: number;
}

/** Einzelstatistik je Strategie/Regel. */
export interface StrategyBacktestStats {
  strategyId: string;
  symbol: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  pnl: number;
  profitFactor: number | null;
}

/** Gesamtergebnis eines Multi-Asset-Backtests. */
export interface MultiAssetBacktestResult {
  config: BacktestEngineConfig;
  symbols: string[];
  timeframe: SupportedTimeframe;
  from: number;
  to: number;
  barsProcessed: number;
  metrics: BacktestMetrics;
  equityCurve: BacktestEquityPoint[];
  trades: BacktestTradeLog[];
  perSymbolStats: Record<string, SymbolBacktestStats>;
  perStrategyStats: Record<string, StrategyBacktestStats>;
  executionDurationMs: number;
}

/** Eingabe-Kerzenzuordnung für die Engine: Symbol -> Kerzen. */
export type MultiAssetCandleMap = Map<string, CandleLike[]> | Record<string, CandleLike[]>;

/** Vereinheitlichter Strategie-Kandidat für die Backtest-Engine. */
export type BacktestStrategyItem =
  | { type: "rule"; spec: RuleSpec; id?: string }
  | { type: "setup"; setup: TradeSetupProposal; id?: string };
