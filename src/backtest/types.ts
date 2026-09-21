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
import type { PaperBacktestOptions } from "./paperExecution";
import type { EventReplayOptions, EventReplayRunSummary } from "./replayEvents";

export type SlippageModel = "fixed" | "spread_relative" | "none";

/**
 * Ausführungspfad der Engine (GAP-01, v1.51.0; RMA-P1-01, v1.58.0):
 *   - `"legacy"` — der eingefrorene Task-02-Simulator (`./simulator.ts`).
 *     Default (Byte-kompatibel zu allen bestehenden Tests/Läufen).
 *   - `"paper"` — DERSELBE `FillSimulator` wie der PaperBroker
 *     (`./paperExecution.ts`) + Funding-Accrual. Default für
 *     Walk-Forward-Runs (vergleichbar persistiert).
 *   - `"event_replay"` — deterministischer Event-Replayer mit Order-
 *     Lifecycle (Partial Fills + Restmenge), Latenz, Depth-Impact und
 *     punktgenauen Funding-Ereignissen (`./replayExecution.ts`).
 *     Explizites Opt-in — kein bestehender Lauf wechselt still den Pfad.
 */
export type BacktestExecutionModel = "legacy" | "paper" | "event_replay";

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
  /**
   * Ausführungspfad (GAP-01, v1.51.0): `"legacy"` (Default, eingefroren)
   * oder `"paper"` (Paper-Fill-Simulator + Funding).
   */
  executionModel: BacktestExecutionModel;
  /** Kostenprofil des `"paper"`-Pfads (nur dort gelesen). */
  paper?: PaperBacktestOptions;
  /**
   * Friktions-/Eventkonfiguration des `"event_replay"`-Pfads (RMA-P1-01,
   * v1.58.0; nur dort gelesen): Latenz, Impact, Depth-/Quote-/Funding-
   * Ereignisse, Order-TTL, Seed. Siehe `./replayEvents.ts`.
   */
  replay?: EventReplayOptions;
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
  /**
   * Kumuliertes Funding dieser Position in Kontowährung (GAP-01, v1.51.0;
   * nur `"paper"`-Pfad, Kontosicht wie `funding.ts`: negativ = gezahlt).
   * Optional = Legacy-Läufe ohne Funding (0-Semantik).
   */
  fundingPaid?: number;
  /**
   * Partial-Exit-Buchhaltung (RMA-P1-01, v1.58.0; nur `"event_replay"`-Pfad —
   * Legacy/Paper lassen die Felder weg und schließen weiterhin atomar):
   * kumulierte geschlossene Menge, Exit-Erlös (Σ qty×price), realisierter
   * Brutto-PnL der geschlossenen Menge sowie Exit-Gebühren/-Slippage.
   */
  closedQty?: number;
  exitNotional?: number;
  realizedGrossPnl?: number;
  exitFees?: number;
  exitSlippage?: number;
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
  /**
   * Funding-Anteil dieses Trades in Kontowährung (GAP-01, v1.51.0;
   * nur `"paper"`-Pfad; im `pnl` bereits enthalten via Cash-Buchung).
   */
  funding?: number;
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
  /**
   * Kumuliertes Funding aller Positionen in Kontowährung (GAP-01, v1.51.0;
   * nur `"paper"`-Pfad; negativ = gezahlt). Legacy-Läufe: immer 0.
   */
  totalFundingPaid: number;
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
  executionQuality?: import("../executionQuality/model").Batch[];
  /**
   * Replay-Evidenz des `"event_replay"`-Pfads (RMA-P1-01, v1.58.0):
   * Datenmanifest, aufgelöste Friktionskonfiguration, Event-Coverage,
   * degradierte Annahmen, Order-Eventlog und Fill-/Funding-Details je
   * Trade. Fehlt bei `"legacy"`/`"paper"` (additiv, kein Bruch).
   */
  replay?: EventReplayRunSummary;
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
