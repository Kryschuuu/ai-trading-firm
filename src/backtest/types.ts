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
import type { VolatilityTargetingConfig } from "../portfolio/volatilityTargeting";
import type { ClassDecayPolicy, SignalSnapshot, StrategyClassKey } from "../lib/signalDecay";

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
  /**
   * RMA-P5-01 (v1.67.0): Portfolio-Volatility-Targeting für den Backtest.
   *
   * `undefined` (Default) = DEAKTIVIERT — der Lauf ist Byte-identisch zu
   * allen bisherigen Ausführungen (kein stilles Verhalten). Ein Objekt
   * aktiviert den kontinuierlichen Risikomultiplikator: in jedem Bar-Schritt
   * wird derselbe pure Kern (`src/portfolio/volatilityTargeting.ts`) wie im
   * Live-Pfad auf die aktuellen offenen Positionen + as-of-sicheren Returns
   * angewendet; der resultierende Faktor (≤ 1) skaliert das Risikobudget.
   *
   * `annualization` überschreibt die Auto-Ableitung (Perioden/Jahr, Default
   * 24/7-Krypto: `msPerYear / timeframeMs`).
   */
  volatilityTargeting?: BacktestVolatilityTargetingConfig;
  /**
   * RMA-P5-05 (v1.69.0): versionierte Signal-Decay-Exits.
   *
   * `undefined` (Default) = deaktiviert — der Lauf ist byte-identisch zu
   * bisherigen Ausführungen. Ein Objekt aktiviert dieselbe pure Funktion wie
   * der Monitor (`decideExit` + `evaluateSignalDecay`). `mode: "monitor"`
   * schließt nicht, zählt aber Counterfactuals. Safety-Exits (SL/TP) bleiben
   * vorrangig. Der `event_replay`-Pfad wendet Signal-Decay in dieser Version
   * nicht an (Partial-Fill-Lifecycle bleibt unangetastet).
   */
  signalDecay?: BacktestSignalDecayConfig;
}

/** Opt-in-Konfiguration der Signal-Decay-Exits im Backtest. */
export interface BacktestSignalDecayConfig {
  mode: "monitor" | "active";
  /** Default `unclassified` (Policy nur aktiv, weil dieses Objekt die Klasse einschaltet). */
  strategyClass?: StrategyClassKey;
  /** Schwellen-Override der gewählten Klasse (wird auf Bounds geklemmt). */
  policy?: Partial<ClassDecayPolicy>;
  /**
   * `close` (Default): `candle.time` ist der Moment, zu dem der Close der
   * Engine bekannt ist. `open`: verfügbar erst bei time + Bar-Dauer.
   */
  timeBasis?: "open" | "close";
  /**
   * Optionaler Point-in-Time-Lieferant. Fehlt er, baut die Engine `mkt-sig-1`
   * aus Kerzen mit time ≤ asOf. Der Lieferant darf keine Zukunft liefern —
   * `availableAt > asOf` wird von der pure Funktion verworfen.
   */
  signalAt?: (args: {
    symbol: string;
    asOfMs: number;
    side: "LONG" | "SHORT" | null;
  }) => SignalSnapshot | null;
}

/** Teilkonfiguration des Backtest-Volatility-Targetings (additiv, Opt-in). */
export interface BacktestVolatilityTargetingConfig {
  /**
   * Volle Konfiguration des pure Kernels (Default:
   * `DEFAULT_VOLATILITY_TARGETING_CONFIG` mit `mode: "active"`). `mode` wird
   * hier bewusst ignoriert — die Engine wendet den Faktor an, wenn dieses
   * Objekt gesetzt ist (Rollout-Flag ist die Anwesenheit).
   */
  config?: Partial<VolatilityTargetingConfig>;
  /**
   * Annualisierungsfaktor (Perioden/Jahr) für ALLE Serien. Default:
   * `msPerYear / timeframeMs` (24/7, z. B. 8760 für 1h). Überschreibt die
   * Live-Ableitung (Asset-Klasse), weil die Backtest-Engine keine
   * Asset-Klassenzuordnung pro Symbol kennt.
   */
  annualization?: number;
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
  /**
   * RMA-P5-05: Entry-Signal und Hysterese-Zustand. Fehlen bei Läufen ohne
   * `signalDecay` (Legacy/Paper/Replay unverändert).
   */
  entrySignal?: SignalSnapshot | null;
  signalDecayStreak?: number;
  signalDecayLastKey?: string | null;
  signalDecayPolicyVersion?: string | null;
  strategyClass?: StrategyClassKey;
}

/** Grund für die Schließung eines Trades. */
export type TradeExitReason =
  | "STOP_LOSS"
  | "TAKE_PROFIT"
  | "SIGNAL_EXIT"
  | "MAX_HOLDING"
  | "RISK_STOP"
  | "END_OF_DATA"
  | "SIGNAL_DECAY";

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
  /**
   * RMA-P5-01 (v1.67.0): Volatility-Targeting-Evidenz (additiv; fehlt bei
   * deaktiviertem Feature — Byte-kompatible Default-Läufe). Deterministisch:
   * gleicher Input ⇒ identisches Objekt. `factorByBar[t]` ist der auf das
   * Risikobudget angewendete Multiplikator am Bar-Schritt t (1 = neutral).
   */
  volatilityTargeting?: BacktestVolatilityTargetingSummary;
  /**
   * RMA-P5-05: Signal-Decay-Evidenz. Fehlt, wenn das Feature nicht gesetzt
   * war — Default-Läufe bekommen das Feld nicht.
   */
  signalDecay?: BacktestSignalDecaySummary;
}

/** Zusammenfassung eines Signal-Decay-Backtests. */
export interface BacktestSignalDecaySummary {
  mode: "monitor" | "active";
  strategyClass: StrategyClassKey;
  policyVersion: string;
  evaluations: number;
  compatible: number;
  /** compatible / evaluations; null, wenn nichts bewertet wurde. */
  triggerCoverage: number | null;
  wouldExit: number;
  exits: number;
  /** Summe der MTM-Counterfactuals an Would-Exit-Schritten. null = keine. */
  counterfactualPnl: number | null;
}

/** Zusammenfassung des Volatility-Targetings eines Backtest-Laufs. */
export interface BacktestVolatilityTargetingSummary {
  /** Konfiguration des Laufs (resolved). */
  config: VolatilityTargetingConfig;
  /** Anzahl Bar-Schritte, in denen ein Faktor berechnet wurde. */
  updates: number;
  /** Anzahl der Fallback-Schritte (fail-closed → minMultiplier). */
  fallbacks: number;
  /** Fallbacks je geschlossenem Grund-Code. */
  fallbacksByReason: Record<string, number>;
  /** Anzahl der NO_EXPOSURE-Schritte (keine offenen Positionen). */
  noExposureSteps: number;
  /** Letzter Forecast (null wenn nie berechenbar). */
  lastForecastAnnualizedVol: number | null;
  /** Letzter angewendeter Multiplikator. */
  lastAppliedMultiplier: number;
  /**
   * Multiplikator je Bar-Schritt (Index = barStep − 1; 1 = kein Schritt
   * berechnet / neutral). Bounded durch die Laufdauer.
   */
  factorByBar: number[];
}

/** Eingabe-Kerzenzuordnung für die Engine: Symbol -> Kerzen. */
export type MultiAssetCandleMap = Map<string, CandleLike[]> | Record<string, CandleLike[]>;

/** Vereinheitlichter Strategie-Kandidat für die Backtest-Engine. */
export type BacktestStrategyItem =
  | { type: "rule"; spec: RuleSpec; id?: string }
  | { type: "setup"; setup: TradeSetupProposal; id?: string };
