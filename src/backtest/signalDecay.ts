/**
 * Backtest-Adapter für Signal-Decay-Exits (RMA-P5-05, v1.69.0).
 *
 * Ruft dieselbe pure Funktion `decideExit` / `evaluateSignalDecay` wie der
 * Monitor. Ohne `config.signalDecay` wird dieses Modul vom Engine-Pfad nicht
 * betreten — Default-Läufe bleiben byte-identisch.
 *
 * Kerzenzeit: der Engine-Takt behandelt `candle.time` als den Moment, zu dem
 * der Close bekannt ist (`timeBasis: "close"`). Kerzen mit `time > asOf`
 * bleiben draußen. Live-Erfassung nutzt Open-Zeit + Dauer (unvollständige
 * Kerze ausgeschlossen). Die Entscheidungsfunktion ist dieselbe.
 */

import type { CandleLike } from "../lib/ruleEngine";
import { decideExit, type ExitConfig, type ExitDecision } from "../lib/exits";
import {
  buildMarketSignal,
  classKey,
  evaluateSignalDecay,
  resolveSignalDecayConfig,
  type CandleTimeBasis,
  type ClassDecayPolicy,
  type SignalDecayConfig,
  type SignalDecayEvaluation,
  type SignalDecayMode,
  type SignalSnapshot,
  type StrategyClassKey,
} from "../lib/signalDecay";
import type { TradeExitReason } from "./types";

export type BacktestSignalProvider = (args: {
  symbol: string;
  asOfMs: number;
  side: "LONG" | "SHORT" | null;
}) => SignalSnapshot | null;

export type BacktestSignalDecayOptions = {
  mode: Exclude<SignalDecayMode, "off">;
  strategyClass?: StrategyClassKey;
  policy?: Partial<ClassDecayPolicy>;
  timeBasis?: CandleTimeBasis;
  signalAt?: BacktestSignalProvider;
};

export type BacktestSignalDecayRuntime = {
  config: SignalDecayConfig;
  strategyClass: StrategyClassKey;
  timeBasis: CandleTimeBasis;
  barDurationMs: number;
  signalAt?: BacktestSignalProvider;
  evaluations: number;
  compatible: number;
  wouldExit: number;
  exits: number;
  counterfactualPnl: number;
};

export function createBacktestSignalDecayRuntime(
  options: BacktestSignalDecayOptions | undefined,
  barDurationMs: number,
): BacktestSignalDecayRuntime | null {
  if (!options) return null;
  const strategyClass = classKey(options.strategyClass ?? "unclassified");
  const config = resolveSignalDecayConfig({
    mode: options.mode,
    classes: {
      [strategyClass]: {
        enabled: true,
        ...options.policy,
      },
    },
  });
  return {
    config,
    strategyClass,
    timeBasis: options.timeBasis ?? "close",
    barDurationMs,
    signalAt: options.signalAt,
    evaluations: 0,
    compatible: 0,
    wouldExit: 0,
    exits: 0,
    counterfactualPnl: 0,
  };
}

export function signalAtBar(
  runtime: BacktestSignalDecayRuntime,
  args: {
    symbol: string;
    side: "LONG" | "SHORT" | null;
    asOfMs: number;
    candles: readonly CandleLike[];
  },
): SignalSnapshot | null {
  if (runtime.signalAt) {
    return runtime.signalAt({ symbol: args.symbol, asOfMs: args.asOfMs, side: args.side });
  }
  return buildMarketSignal({
    candles: args.candles,
    asOfMs: args.asOfMs,
    barDurationMs: runtime.barDurationMs,
    timeBasis: runtime.timeBasis,
    strategyClass: runtime.strategyClass,
    computedAtMs: args.asOfMs,
  });
}

export type OpenSignalState = {
  side: "LONG" | "SHORT";
  qty: number;
  entryPrice: number;
  openedAtMs: number;
  entrySignal: SignalSnapshot | null;
  streak: number;
  lastKey: string | null;
  policyVersion: string | null;
  strategyClass: StrategyClassKey;
};

/**
 * Ein Bar-Schritt. `close` ist nur true, wenn `decideExit` SIGNAL_DECAY
 * liefert (Modus active, bestätigt, kein höherer Exit — der Aufrufer darf
 * diese Funktion nur rufen, wenn SL/TP/Trailing/Time nicht gegriffen haben).
 */
export function stepBacktestSignalDecay(args: {
  runtime: BacktestSignalDecayRuntime;
  position: OpenSignalState;
  current: SignalSnapshot | null;
  asOfMs: number;
  markPrice: number;
  exitConfig: ExitConfig;
  killSwitchArmed?: boolean;
}): { decision: ExitDecision; evaluation: SignalDecayEvaluation; close: boolean } {
  const evaluation = evaluateSignalDecay({
    entry: args.position.entrySignal,
    current: args.current,
    openedAtMs: args.position.openedAtMs,
    asOfMs: args.asOfMs,
    side: args.position.side,
    qty: args.position.qty,
    entryPrice: args.position.entryPrice,
    markPrice: args.markPrice,
    strategyClass: args.position.strategyClass,
    confirmation: {
      streak: args.position.streak,
      lastObservationKey: args.position.lastKey,
      policyVersion: args.position.policyVersion,
    },
    mode: args.runtime.config.mode,
    config: args.runtime.config,
    killSwitchArmed: args.killSwitchArmed === true,
  });
  const decision = decideExit(
    {
      side: args.position.side,
      entryPrice: args.position.entryPrice,
      price: args.markPrice,
      stopLoss: null,
      takeProfit: null,
      trailingStop: null,
      trailingArmed: false,
      createdAtMs: args.position.openedAtMs,
      nowMs: args.asOfMs,
      signal: {
        entry: args.position.entrySignal,
        current: args.current,
        openedAtMs: args.position.openedAtMs,
        asOfMs: args.asOfMs,
        side: args.position.side,
        qty: args.position.qty,
        entryPrice: args.position.entryPrice,
        markPrice: args.markPrice,
        strategyClass: args.position.strategyClass,
        confirmation: {
          streak: args.position.streak,
          lastObservationKey: args.position.lastKey,
          policyVersion: args.position.policyVersion,
        },
        mode: args.runtime.config.mode,
        config: args.runtime.config,
        killSwitchArmed: args.killSwitchArmed === true,
      },
    },
    args.exitConfig,
  );
  args.runtime.evaluations += 1;
  if (evaluation.status === "COMPATIBLE") args.runtime.compatible += 1;
  if (evaluation.wouldExit || evaluation.shouldExit) {
    args.runtime.wouldExit += 1;
    if (evaluation.counterfactualPnl != null) args.runtime.counterfactualPnl += evaluation.counterfactualPnl;
  }
  const close = decision.reason === "SIGNAL_DECAY";
  if (close) args.runtime.exits += 1;
  return { decision, evaluation, close };
}

export function signalDecayExitReason(reason: ExitDecision["reason"]): TradeExitReason | null {
  return reason === "SIGNAL_DECAY" ? "SIGNAL_DECAY" : null;
}
