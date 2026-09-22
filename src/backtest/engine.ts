/**
 * Multi-Asset Backtest-Engine — Event-Driven Replay Simulator (Task 02).
 *
 * Simuliert synchronisierte Zeitreihen über N Instrumente und N Regeln/Setups:
 *   - Kein Lookahead-Bias: Signalberechnung ausschließlich auf bis zum jeweiligen
 *     Zeitpunkt geschlossenen Kerzen.
 *   - Deterministische Mehrfachausführung: Feste Sortierung nach Zeitstempel und Symbol.
 *   - Integriertes Portfolio-Management mit Cash-Tracking und Guardrails.
 *   - Realistische Ausführung mit Slippage, Gebühren und Stop-Vorrang.
 *
 * Ausführungspfade (GAP-01, v1.51.0): `executionModel: "legacy"` (Default,
 * eingefrorener Task-02-Simulator — Byte-kompatibel) oder `"paper"`
 * (DERSELBE `FillSimulator` wie der PaperBroker + Funding-Accrual, siehe
 * `./paperExecution.ts`). Walk-Forward-Runs nutzen immer `"paper"`.
 */

import type {
  BacktestEngineConfig,
  BacktestEngineOptions,
  BacktestStrategyItem,
  MultiAssetBacktestResult,
  MultiAssetCandleMap,
} from "./types";
import { BacktestPortfolio } from "./portfolio";
import { calculateSlippageBps, evaluateExit, simulateEntry } from "./simulator";
import {
  createPaperExecutionRuntime,
  detectExitTrigger,
  type PaperExecutionRuntime,
} from "./paperExecution";
import {
  createEventReplayRuntime,
  type EventReplayRuntime,
  type ReplayBarInfo,
} from "./replayExecution";
import { computeBacktestMetrics, computePerStrategyStats, computePerSymbolStats } from "./metrics";
import {
  buildSnapshotFromCandles,
  compileRuleSpec,
  isWindowOpen,
  type CandleLike,
  type RuleSpec,
} from "../lib/ruleEngine";
import {
  DEFAULT_ANALYSIS_TIMEFRAME,
  SUPPORTED_TIMEFRAME_MS,
  type HistoricalStore,
  type SupportedTimeframe,
} from "../lib/marketdata/historicalStore";
import {
  DEFAULT_VOLATILITY_TARGETING_CONFIG,
  computeVolatilityTargetingFromInput,
  resolveVolatilityTargetingConfig,
  type VolatilityForecastInput,
  type VolatilityForecastSeries,
  type VolatilityTargetingConfig,
} from "../portfolio/volatilityTargeting";
import type {
  BacktestVolatilityTargetingConfig,
  BacktestVolatilityTargetingSummary,
} from "./types";
import { metricLabel, telemetry } from "../lib/telemetry";
import type { TradeSetupProposal } from "../cycle/schemas";
import {
  createBacktestSignalDecayRuntime,
  signalAtBar,
  stepBacktestSignalDecay,
  type BacktestSignalDecayRuntime,
} from "./signalDecay";
import { policyVersionOf, type SignalSnapshot } from "../lib/signalDecay";
import { DEFAULT_EXIT_CONFIG, type ExitConfig } from "../lib/exits";

/** Standard-Konfiguration der Engine. */
export const DEFAULT_BACKTEST_CONFIG: BacktestEngineConfig = {
  initialCapital: 10_000,
  timeframe: DEFAULT_ANALYSIS_TIMEFRAME,
  warmupBars: 30,
  maxOpenPositions: 5,
  maxRiskPerTrade: 0.02,
  maxPositionPct: 0.25,
  slippageModel: "fixed",
  fixedSlippageBps: 5,
  spreadSlippageFactor: 0.5,
  feeModel: {
    makerFee: 0.0002, // 2 bp
    takerFee: 0.0006, // 6 bp
  },
  enableShorts: false,
  // GAP-01: Legacy-Default = Byte-kompatibel zu allen bestehenden Läufen.
  executionModel: "legacy",
};

export interface MultiAssetBacktestInput {
  candlesBySymbol: MultiAssetCandleMap;
  strategies: BacktestStrategyItem[];
  config?: BacktestEngineOptions;
}

/**
 * Wandelt ein TradeSetupProposal in eine evaluierbare Ausführungsregel um.
 */
function setupToEvaluator(setup: TradeSetupProposal, id: string) {
  const symbol = setup.instrumentId.includes(":") ? setup.instrumentId.split(":")[1] : setup.instrumentId;
  const isLong = setup.side === "LONG";
  const stopLoss = setup.stopLoss;
  const takeProfit = setup.takeProfit;
  const entryPrice = setup.entryPrice;

  return {
    id,
    symbol: setup.instrumentId,
    nativeSymbol: symbol,
    side: setup.side as "LONG" | "SHORT",
    stopLoss,
    takeProfit,
    entryPrice,
    riskBudgetPct: setup.riskScore ? Math.min(Math.max(setup.riskScore * 0.05, 0.01), 0.05) : 0.02,
    evaluate: (candles: CandleLike[], currentIdx: number): boolean => {
      // Setup triggert, wenn der Kurs das Entry-Niveau berührt / kreuzt
      const c = candles[currentIdx];
      if (isLong) {
        return c.low <= entryPrice && c.high >= entryPrice * 0.98;
      } else {
        return c.high >= entryPrice && c.low <= entryPrice * 1.02;
      }
    },
  };
}

/**
 * Führt einen Multi-Asset Backtest synchron über eine Zeitachse aus.
 */
export function runMultiAssetBacktest(input: MultiAssetBacktestInput): MultiAssetBacktestResult {
  const startTime = performance.now();
  const config: BacktestEngineConfig = {
    ...DEFAULT_BACKTEST_CONFIG,
    ...input.config,
    feeModel: {
      ...DEFAULT_BACKTEST_CONFIG.feeModel,
      ...(input.config?.feeModel ?? {}),
    },
  };

  // 1. Kerzenmap normalisieren
  const rawMap = input.candlesBySymbol instanceof Map
    ? input.candlesBySymbol
    : new Map(Object.entries(input.candlesBySymbol));

  const symbols = Array.from(rawMap.keys()).sort();

  // 2. Einheitliche, sortierte Zeitachse aller Zeitstempel aufbauen
  const allTimestampsSet = new Set<number>();
  const candlesIndexed = new Map<string, CandleLike[]>();

  for (const sym of symbols) {
    const rawCandles = rawMap.get(sym) ?? [];
    // Sortieren nach Zeitstempel
    const sorted = [...rawCandles].sort((a, b) => a.time - b.time);
    candlesIndexed.set(sym, sorted);

    for (const c of sorted) {
      if (config.from !== undefined && c.time < config.from) continue;
      if (config.to !== undefined && c.time > config.to) continue;
      allTimestampsSet.add(c.time);
    }
  }

  const timeline = Array.from(allTimestampsSet).sort((a, b) => a - b);
  const portfolio = new BacktestPortfolio(config);

  // GAP-01: Paper-Laufzeit EINMAL pro Lauf erzeugen (frischer Simulator-seq
  // ⇒ deterministische Order-IDs; Legacy-Läufe bleiben unberührt).
  const paper: PaperExecutionRuntime | null =
    config.executionModel === "paper"
      ? createPaperExecutionRuntime(config.paper ?? {}, config.feeModel, SUPPORTED_TIMEFRAME_MS[config.timeframe])
      : null;

  // RMA-P1-01: Event-Replay-Laufzeit (Order-Lifecycle, Latenz, Depth-Impact,
  // punktgenaues Funding). Validiert alle Input-Ereignisse fail-closed,
  // BEVOR simuliert wird; wirft `EventReplayError` bei invalider Config.
  const replay: EventReplayRuntime | null =
    config.executionModel === "event_replay"
      ? createEventReplayRuntime({
          options: config.replay ?? {},
          engineFeeModel: config.feeModel,
          barMs: SUPPORTED_TIMEFRAME_MS[config.timeframe],
          candlesBySymbol: candlesIndexed,
        })
      : null;

  // 3. Strategien kompilieren & vorbereiten
  const compiledRules = input.strategies.map((item, idx) => {
    if (item.type === "rule") {
      const spec = item.spec;
      const compiler = compileRuleSpec(spec);
      const symbol = spec.symbol.includes(":") ? spec.symbol.split(":")[1] : spec.symbol;
      return {
        type: "rule" as const,
        id: item.id ?? `RULE-${idx + 1}-${spec.name ?? spec.symbol}`,
        symbol: spec.symbol,
        nativeSymbol: symbol,
        spec,
        compiler,
      };
    } else {
      const setup = item.setup;
      const id = item.id ?? `SETUP-${idx + 1}-${setup.instrumentId}`;
      const evalItem = setupToEvaluator(setup, id);
      return {
        type: "setup" as const,
        id,
        symbol: setup.instrumentId,
        nativeSymbol: evalItem.nativeSymbol,
        setup,
        evalItem,
      };
    }
  });

  // Zeiger auf aktuelle Kerzenindizes je Symbol
  const symbolPointers = new Map<string, number>();
  for (const sym of symbols) {
    symbolPointers.set(sym, 0);
  }

  const currentPrices = new Map<string, number>();

  // RMA-P5-01 (v1.67.0): Volatility-Targeting-Laufzeit (Opt-in).
  // `undefined` (Default) ⇒ komplett inaktiv: gleicher Code-Pfad wie vor
  // v1.67.0, Byte-identische Default-Läufe.
  const vtRuntime = createVolatilityTargetingRuntime(config.volatilityTargeting, config.timeframe);
  const factorByBar = vtRuntime
    ? new Array<number>(timeline.length).fill(1)
    : [];
  const vtRiskBudget = (budget: number | undefined): number | undefined =>
    vtRuntime ? (budget ?? config.maxRiskPerTrade) * vtRuntime.currentFactor : budget;

  // RMA-P5-05 (v1.69.0): Signal-Decay nur wenn explizit konfiguriert.
  const sdRuntime = createBacktestSignalDecayRuntime(
    config.signalDecay,
    SUPPORTED_TIMEFRAME_MS[config.timeframe] ?? 3_600_000,
  );
  const signalExitConfig: ExitConfig = {
    ...DEFAULT_EXIT_CONFIG,
    trailingEnabled: false,
    timeStopHours: 0,
  };
  const stampEntrySignal = (
    position: {
      symbol: string;
      side: "LONG" | "SHORT";
      entrySignal?: SignalSnapshot | null;
      signalDecayStreak?: number;
      signalDecayLastKey?: string | null;
      signalDecayPolicyVersion?: string | null;
      strategyClass?: BacktestSignalDecayRuntime["strategyClass"];
    },
    asOfMs: number,
    series: readonly CandleLike[],
  ): void => {
    if (!sdRuntime) return;
    position.entrySignal = signalAtBar(sdRuntime, {
      symbol: position.symbol,
      side: position.side,
      asOfMs,
      candles: series,
    });
    position.signalDecayStreak = 0;
    position.signalDecayLastKey = null;
    position.signalDecayPolicyVersion = null;
    position.strategyClass = sdRuntime.strategyClass;
  };

  // GAP-01: Paper-Einstieg (Regel- und Setup-Pfad teilen sich diese Abwicklung).
  const openPaperEntry = (
    strategyId: string,
    symbol: string,
    side: "LONG" | "SHORT",
    notional: number,
    candle: CandleLike,
    atTime: number,
    atBar: number,
    stopLoss: number | null,
    takeProfit: number | null
  ): void => {
    if (!paper || notional <= 0) return;
    const fill = paper.fillEntry(symbol, side, notional, candle.close, atTime, strategyId);
    // Fail-closed: Simulator-Reject ⇒ kein Einstieg (kein erfundener Fill).
    if (!fill) return;
    const opened = portfolio.openPosition(
      strategyId,
      symbol,
      side,
      {
        fillPrice: fill.fillPrice,
        qty: fill.filledQty,
        fees: fill.fees,
        slippage: fill.slippageCost,
      },
      candle,
      atBar,
      stopLoss,
      takeProfit
    );
    stampEntrySignal(opened, atTime, (candlesIndexed.get(symbol) ?? []).slice(0, atBar + 1));
  };

  // 4. Haupt-Event-Schleife: Schrittweise entlang der synchronisierten Zeitachse
  let barStep = 0;
  for (const currentTime of timeline) {
    barStep++;

    // a) Aktuelle Kerzen für diesen Zeitstempel aktualisieren
    const currentCandleBySymbol = new Map<string, { candle: CandleLike; index: number }>();

    for (const sym of symbols) {
      const series = candlesIndexed.get(sym) ?? [];
      let ptr = symbolPointers.get(sym) ?? 0;

      while (ptr < series.length && series[ptr].time <= currentTime) {
        if (series[ptr].time === currentTime) {
          currentCandleBySymbol.set(sym, { candle: series[ptr], index: ptr });
          currentPrices.set(sym, series[ptr].close);
        }
        ptr++;
      }
      symbolPointers.set(sym, ptr);
    }

    // b0) RMA-P1-01: Event-Replay verarbeitet je Zeitschritt Funding-
    //     Ereignisse, offene Order-Restmengen und Exit-Trigger in EINEM
    //     deterministischen Durchlauf (Order-Lifecycle mit Partial Fills).
    if (replay) {
      const bars: ReadonlyMap<string, ReplayBarInfo> = currentCandleBySymbol;
      replay.beginBar(currentTime, barStep, bars, currentPrices, portfolio);
    }

    // b) Exits für alle offenen Positionen prüfen (Stop Loss / Take Profit,
    //    danach — nur wenn konfiguriert — SIGNAL_DECAY). Safety-Exits zuerst.
    //    event_replay bleibt in dieser Version ohne Signal-Decay.
    for (const pos of replay ? [] : portfolio.openPositionsList) {
      const candleInfo = currentCandleBySymbol.get(pos.symbol);
      if (!candleInfo) continue;

      if (paper) {
        // Paper-Pfad: Trigger = Marktstruktur (Stop-Vorrang), Fill = Simulator.
        const trigger = detectExitTrigger(pos, candleInfo.candle);
        if (trigger) {
          const closingSide = pos.side === "LONG" ? "SHORT" : "LONG";
          const fill = paper.fillExit(pos.symbol, closingSide, pos.qty, trigger.price, currentTime, pos.strategyId);
          // Fail-closed: Simulator-Reject ⇒ Position bleibt offen (kein
          // erfundener Ausstiegspreis; mit Default-Konfig unerreichbar).
          if (!fill) continue;
          portfolio.closePosition(
            pos.symbol,
            {
              triggered: true,
              exitPrice: fill.fillPrice,
              reason: trigger.reason,
              fees: fill.fees,
              slippage: fill.slippageCost,
            },
            currentTime,
            barStep
          );
          continue;
        }
      } else {
        const exitEval = evaluateExit(pos, candleInfo.candle, config);
        if (exitEval && exitEval.triggered) {
          portfolio.closePosition(pos.symbol, exitEval, currentTime, barStep);
          continue;
        }
      }

      if (!sdRuntime) continue;
      const series = candlesIndexed.get(pos.symbol) ?? [];
      const slice = series.slice(0, candleInfo.index + 1);
      const currentSignal = signalAtBar(sdRuntime, {
        symbol: pos.symbol,
        side: pos.side,
        asOfMs: currentTime,
        candles: slice,
      });
      const step = stepBacktestSignalDecay({
        runtime: sdRuntime,
        position: {
          side: pos.side,
          qty: pos.qty,
          entryPrice: pos.entryPrice,
          openedAtMs: pos.entryTime,
          entrySignal: pos.entrySignal ?? null,
          streak: pos.signalDecayStreak ?? 0,
          lastKey: pos.signalDecayLastKey ?? null,
          policyVersion: pos.signalDecayPolicyVersion ?? null,
          strategyClass: pos.strategyClass ?? sdRuntime.strategyClass,
        },
        current: currentSignal,
        asOfMs: currentTime,
        markPrice: candleInfo.candle.close,
        exitConfig: signalExitConfig,
      });
      pos.signalDecayStreak = step.evaluation.streak;
      pos.signalDecayLastKey = step.evaluation.observationKey;
      pos.signalDecayPolicyVersion = step.evaluation.policyVersion;
      if (!step.close) continue;

      if (paper) {
        const closingSide = pos.side === "LONG" ? "SHORT" : "LONG";
        const fill = paper.fillExit(
          pos.symbol,
          closingSide,
          pos.qty,
          candleInfo.candle.close,
          currentTime,
          pos.strategyId,
        );
        if (!fill) continue;
        portfolio.closePosition(
          pos.symbol,
          {
            triggered: true,
            exitPrice: fill.fillPrice,
            reason: "SIGNAL_DECAY",
            fees: fill.fees,
            slippage: fill.slippageCost,
          },
          currentTime,
          barStep,
        );
        continue;
      }

      const slipBps = calculateSlippageBps(config);
      const slipRate = slipBps / 10_000;
      const executionPrice = pos.side === "LONG"
        ? candleInfo.candle.close * (1 - slipRate)
        : candleInfo.candle.close * (1 + slipRate);
      const fees = pos.qty * executionPrice * config.feeModel.takerFee;
      const slippage = Math.abs(candleInfo.candle.close - executionPrice) * pos.qty;
      portfolio.closePosition(
        pos.symbol,
        {
          triggered: true,
          exitPrice: executionPrice,
          reason: "SIGNAL_DECAY",
          fees: Number(fees.toFixed(4)),
          slippage: Number(slippage.toFixed(4)),
        },
        currentTime,
        barStep,
      );
    }

    // c-vt) RMA-P5-01: Volatility-Targeting-Faktor für diesen Bar-Schritt
    // (einmal je Bar, deterministisch; as-of = currentTime, identisch zur
    // Verfügbarkeitskonvention der Engine: Kerzen mit time ≤ currentTime).
    if (vtRuntime) {
      const factor = computeVtFactorForBar({
        runtime: vtRuntime,
        portfolio,
        candlesIndexed,
        symbolPointers,
        currentPrices,
        currentTime,
      });
      vtRuntime.currentFactor = factor;
      factorByBar[barStep - 1] = factor;
    }

    // c) Signal-Prüfung & Neueinstiege
    // Nur nach Warmup-Phase
    if (barStep >= config.warmupBars) {
      const currentEquity = portfolio.computeCurrentEquity(currentPrices);

      for (const strat of compiledRules) {
        const candleInfo = currentCandleBySymbol.get(strat.symbol) ?? currentCandleBySymbol.get(strat.nativeSymbol);
        if (!candleInfo) continue;

        const series = candlesIndexed.get(strat.symbol) ?? candlesIndexed.get(strat.nativeSymbol) ?? [];
        const subSeries = series.slice(0, candleInfo.index + 1);
        if (subSeries.length < config.warmupBars) continue;

        // Guardrails vorab prüfen
        const canOpen = portfolio.canOpenPosition(strat.symbol, currentEquity);
        if (!canOpen.allowed) continue;
        // RMA-P1-01: eine offene (Teil-)Order zählt wie eine Position —
        // kein zweiter Entry, solange der Lifecycle des ersten läuft.
        if (replay && replay.hasPendingOrder(strat.symbol)) continue;

        if (strat.type === "rule") {
          const spec = strat.spec;
          if ((spec.action.side as string) === "SHORT" && !config.enableShorts) continue;

          const snap = buildSnapshotFromCandles(strat.symbol, subSeries, spec.window.volumeWindow);
          if (!snap) continue;

          if (!isWindowOpen(spec, snap.ts)) continue;

          // Regel-Evaluierung ohne Lookahead
          if (strat.compiler.evaluate(snap)) {
            const stopPct = spec.action.stopLossPct / 100;
            const entryPrice = candleInfo.candle.close;
            const stopLoss = entryPrice * (1 - stopPct);
            const takeProfit = entryPrice * (1 + spec.action.takeProfitRR * stopPct);

            const notional = portfolio.calculatePositionSize(
              currentEquity,
              entryPrice,
              stopLoss,
              // RMA-P5-01: Volatility-Targeting-Faktor skaliert das
              // Risikobudget (≤ 1 — kann nur senken).
              vtRiskBudget(spec.action.riskBudgetPct),
              spec.action.maxPositionPct
            );

            if (replay) {
              replay.submitEntry({
                strategyId: strat.id,
                symbol: strat.symbol,
                side: spec.action.side,
                notional,
                candle: candleInfo.candle,
                now: currentTime,
                barStep,
                stopLoss,
                takeProfit,
                portfolio,
              });
            } else if (paper) {
              openPaperEntry(
                strat.id,
                strat.symbol,
                spec.action.side,
                notional,
                candleInfo.candle,
                currentTime,
                barStep,
                stopLoss,
                takeProfit
              );
            } else if (notional > 0) {
              const fill = simulateEntry(candleInfo.candle, spec.action.side, notional, config);
              if (fill) {
                const opened = portfolio.openPosition(
                  strat.id,
                  strat.symbol,
                  spec.action.side,
                  fill,
                  candleInfo.candle,
                  barStep,
                  stopLoss,
                  takeProfit
                );
                stampEntrySignal(opened, currentTime, series.slice(0, candleInfo.index + 1));
              }
            }
          }
        } else {
          // TradeSetupProposal
          const evalItem = strat.evalItem;
          if (evalItem.side === "SHORT" && !config.enableShorts) continue;

          if (evalItem.evaluate(series, candleInfo.index)) {
            const entryPrice = candleInfo.candle.close;
            const notional = portfolio.calculatePositionSize(
              currentEquity,
              entryPrice,
              evalItem.stopLoss,
              // RMA-P5-01: Volatility-Targeting-Faktor skaliert das
              // Risikobudget (≤ 1 — kann nur senken).
              vtRiskBudget(evalItem.riskBudgetPct),
              config.maxPositionPct
            );

            if (replay) {
              replay.submitEntry({
                strategyId: strat.id,
                symbol: strat.symbol,
                side: evalItem.side,
                notional,
                candle: candleInfo.candle,
                now: currentTime,
                barStep,
                stopLoss: evalItem.stopLoss,
                takeProfit: evalItem.takeProfit,
                portfolio,
              });
            } else if (paper) {
              openPaperEntry(
                strat.id,
                strat.symbol,
                evalItem.side,
                notional,
                candleInfo.candle,
                currentTime,
                barStep,
                evalItem.stopLoss,
                evalItem.takeProfit
              );
            } else if (notional > 0) {
              const fill = simulateEntry(candleInfo.candle, evalItem.side, notional, config);
              if (fill) {
                const opened = portfolio.openPosition(
                  strat.id,
                  strat.symbol,
                  evalItem.side,
                  fill,
                  candleInfo.candle,
                  barStep,
                  evalItem.stopLoss,
                  evalItem.takeProfit
                );
                stampEntrySignal(opened, currentTime, series.slice(0, candleInfo.index + 1));
              }
            }
          }
        }
      }
    }

    // c2) Funding-Accrual offener Perpetual-Positionen (nur „paper“-Pfad —
    //     DIESELBE Engine + Formel wie der Paper-Monitor-Tick).
    if (paper && portfolio.openPositionsCount > 0) {
      const openRows = portfolio.openPositionsList.map((p) => ({
        symbol: p.symbol,
        side: p.side,
        qty: p.qty,
        price: currentPrices.get(p.symbol) ?? p.entryPrice,
      }));
      for (const accrual of paper.accrueFunding(openRows, currentTime)) {
        portfolio.applyFunding(accrual.symbol, accrual.funding);
      }
    }

    // d) Equity-Snapshot für diesen Zeitschritt aufzeichnen
    portfolio.recordSnapshot(currentTime, currentPrices);
  }

  // 5. Noch offene Positionen am Ende schließen
  const lastTime = timeline.length > 0 ? timeline[timeline.length - 1] : Date.now();
  if (replay) {
    // Event-Replay: offene Orders canceln + Positionen deterministisch
    // zwangsglattstellen (FORCED_FINAL, siehe replayExecution.ts). Der
    // Legacy-/Paper-Schlusspfad wird NICHT zusätzlich durchlaufen — die
    // Partial-Exit-Buchhaltung wäre mit `closePosition` nicht kompatibel.
    replay.finish(lastTime, barStep, currentPrices, portfolio);
  } else {
    portfolio.closeAllAtEnd(
      currentPrices,
      lastTime,
      barStep,
      paper
        ? (pos, price) => {
            const closingSide = pos.side === "LONG" ? "SHORT" : "LONG";
            const fill = paper.fillExit(pos.symbol, closingSide, pos.qty, price, lastTime, pos.strategyId);
            // null ⇒ Legacy-Schlussrechnung (defensiv; mit Default-Konfig
            // unerreichbar, siehe portfolio.closeAllAtEnd).
            if (!fill) return null;
            return {
              triggered: true,
              exitPrice: fill.fillPrice,
              reason: "END_OF_DATA" as const,
              fees: fill.fees,
              slippage: fill.slippageCost,
            };
          }
        : undefined
    );
  }

  // 6. Kennzahlen berechnen
  const metrics = computeBacktestMetrics(
    portfolio.trades,
    portfolio.equityCurve,
    config.initialCapital,
    portfolio.feesPaid,
    portfolio.slippagePaid,
    365 * 24,
    portfolio.fundingPaidTotal
  );

  const perSymbolStats = computePerSymbolStats(portfolio.trades);
  const perStrategyStats = computePerStrategyStats(portfolio.trades);

  const fromTime = timeline.length > 0 ? timeline[0] : 0;
  const toTime = timeline.length > 0 ? timeline[timeline.length - 1] : 0;

  // RMA-P1-01: bounded Metriken je Replay-Lauf (Grund-Vokabular ist die
  // geschlossene `ReplayDegradedReason`-Union — nie Symbole/IDs als Label).
  const replaySummary = replay ? replay.summary() : null;
  if (replaySummary) {
    telemetry.backtest.replayRuns.inc({
      result: "ok",
      degraded: replaySummary.degradedReasons.length > 0 ? "degraded" : "none",
    });
    for (const reason of replaySummary.degradedReasons) {
      telemetry.backtest.replayDegraded.inc({ reason: metricLabel(reason, "OTHER") });
    }
  }

  return {
    executionQuality: paper?.qualityBatches ?? [],
    ...(replaySummary ? { replay: replaySummary } : {}),
    config,
    symbols,
    timeframe: config.timeframe,
    from: fromTime,
    to: toTime,
    barsProcessed: timeline.length,
    metrics,
    equityCurve: portfolio.equityCurve,
    trades: portfolio.trades,
    perSymbolStats,
    perStrategyStats,
    executionDurationMs: Number((performance.now() - startTime).toFixed(2)),
    // RMA-P5-01 (v1.67.0): Volatility-Targeting-Evidenz (nur wenn aktiviert).
    ...(vtRuntime ? { volatilityTargeting: buildVtSummary(vtRuntime, factorByBar) } : {}),
    ...(sdRuntime
      ? {
          signalDecay: {
            mode: sdRuntime.config.mode === "active" ? "active" as const : "monitor" as const,
            strategyClass: sdRuntime.strategyClass,
            policyVersion: policyVersionOf(sdRuntime.config),
            evaluations: sdRuntime.evaluations,
            compatible: sdRuntime.compatible,
            triggerCoverage: sdRuntime.evaluations > 0
              ? sdRuntime.compatible / sdRuntime.evaluations
              : null,
            wouldExit: sdRuntime.wouldExit,
            exits: sdRuntime.exits,
            counterfactualPnl: sdRuntime.wouldExit > 0 ? sdRuntime.counterfactualPnl : null,
          },
        }
      : {}),
  };
}

/**
 * Führt einen Multi-Asset-Backtest für ein Set von Rules direkt gegen den HistoricalStore aus.
 */
export function runRuleSetBacktest(
  rules: RuleSpec[],
  store: HistoricalStore,
  options?: BacktestEngineOptions
): MultiAssetBacktestResult {
  const timeframe = options?.timeframe ?? DEFAULT_ANALYSIS_TIMEFRAME;
  const candlesBySymbol = new Map<string, CandleLike[]>();

  for (const rule of rules) {
    if (!candlesBySymbol.has(rule.symbol)) {
      const entries = store.query({ instrumentId: rule.symbol, timeframe });
      const candles: CandleLike[] = entries.map((e) => ({
        time: e.ts,
        open: e.open,
        high: e.high,
        low: e.low,
        close: e.close,
        volume: e.volume,
      }));
      candlesBySymbol.set(rule.symbol, candles);
    }
  }

  const strategies: BacktestStrategyItem[] = rules.map((spec, i) => ({
    type: "rule",
    spec,
    id: `RULE-${i + 1}-${spec.symbol}`,
  }));

  return runMultiAssetBacktest({
    candlesBySymbol,
    strategies,
    config: { ...options, timeframe },
  });
}

/**
 * Führt einen Multi-Asset-Backtest für ein Set von Research-Setups direkt gegen den HistoricalStore aus.
 */
export function runSetupsBacktest(
  setups: TradeSetupProposal[],
  store: HistoricalStore,
  options?: BacktestEngineOptions
): MultiAssetBacktestResult {
  const timeframe = options?.timeframe ?? DEFAULT_ANALYSIS_TIMEFRAME;
  const candlesBySymbol = new Map<string, CandleLike[]>();

  for (const setup of setups) {
    if (!candlesBySymbol.has(setup.instrumentId)) {
      const entries = store.query({ instrumentId: setup.instrumentId, timeframe });
      const candles: CandleLike[] = entries.map((e) => ({
        time: e.ts,
        open: e.open,
        high: e.high,
        low: e.low,
        close: e.close,
        volume: e.volume,
      }));
      candlesBySymbol.set(setup.instrumentId, candles);
    }
  }

  const strategies: BacktestStrategyItem[] = setups.map((setup, i) => ({
    type: "setup",
    setup,
    id: `SETUP-${i + 1}-${setup.instrumentId}`,
  }));

  return runMultiAssetBacktest({
    candlesBySymbol,
    strategies,
    config: { ...options, timeframe },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// RMA-P5-01 (v1.67.0): Volatility-Targeting für den Backtest
//
// Teilt mit dem Live-Pfad die PURE Kernfunktion `computeVolatilityTargetingFromInput`
// (`src/portfolio/volatilityTargeting.ts`). Die Engine unterscheidet sich nur
// im Datenzugriff (replay aus `candlesIndexed` statt DB/Kerzen-Fetcher) und
// der Zeitsemantik: as-of = `currentTime`, identisch zur Verfügbarkeits-
// konvention der Engine (Kerzen mit `time ≤ currentTime` sind verfügbar).
//
// Determinismus: gleicher Input ⇒ bit-identischer Faktor-Verlauf (reine
// Funktion, keine Uhr, kein Zufall). Fail-closed: stale/ill-conditioned/
// geringe Abdeckung ⇒ minMultiplier (konservativ ≤ 1).
// ─────────────────────────────────────────────────────────────────────────────

/** Laufzeit-Zustand des Backtest-Volatility-Targetings (pro Lauf). */
interface VtRuntime {
  config: VolatilityTargetingConfig;
  /** Annualisierung für alle Serien (Perioden/Jahr). */
  annualization: number;
  /** Letzter angewendeter Multiplikator (Smoothing-/Step-Anker). */
  prevMultiplier: number;
  /** Multiplikator für den aktuellen Bar-Schritt (1 = neutral). */
  currentFactor: number;
  /** Anzahl berechneter Bar-Schritte. */
  updates: number;
  /** Anzahl Fallback-Schritte. */
  fallbacks: number;
  /** Fallbacks je geschlossenen Grund-Code. */
  fallbacksByReason: Record<string, number>;
  /** Anzahl NO_EXPOSURE-Schritte. */
  noExposureSteps: number;
  /** Letzter Forecast (null wenn nie berechenbar). */
  lastForecast: number | null;
}

/**
 * Erzeugt die VT-Laufzeit aus der (optionalen) Konfiguration.
 * `undefined` ⇒ `null` (Feature deaktiviert, Byte-kompatible Default-Läufe).
 */
function createVolatilityTargetingRuntime(
  input: BacktestVolatilityTargetingConfig | undefined,
  timeframe: SupportedTimeframe
): VtRuntime | null {
  if (!input) return null;
  const tfMs = SUPPORTED_TIMEFRAME_MS[timeframe];
  const annualization =
    input.annualization && Number.isFinite(input.annualization) && input.annualization > 0
      ? input.annualization
      : (365 * 86_400_000) / tfMs; // 24/7-Krypto-Default (Perioden/Jahr)
  const config = resolveVolatilityTargetingConfig({
    ...(input.config ?? {}),
    // Der Backtest wendet den Faktor an, wenn dieses Objekt gesetzt ist —
    // `mode` ist im Backtest-Kontext ohne Bedeutung und wird neutralisiert.
    enabled: true,
    mode: "active" as const,
  });
  return {
    config,
    annualization,
    prevMultiplier: config.maxMultiplier,
    currentFactor: 1,
    updates: 0,
    fallbacks: 0,
    fallbacksByReason: {},
    noExposureSteps: 0,
    lastForecast: null,
  };
}

/**
 * Berechnet den Volatility-Targeting-Faktor für einen Bar-Schritt.
 *
 * Input: aktuelle offenen Positionen (Gewichte = Notional-Anteile,
 * Long-only Total-Exposure) + as-of-sichere Returns aus `candlesIndexed`
 * (nur Kerzen mit `time ≤ currentTime`). Derselbe pure Kern wie Live.
 */
function computeVtFactorForBar(args: {
  runtime: VtRuntime;
  portfolio: BacktestPortfolio;
  candlesIndexed: Map<string, CandleLike[]>;
  symbolPointers: Map<string, number>;
  currentPrices: Map<string, number>;
  currentTime: number;
}): number {
  const { runtime, portfolio, candlesIndexed, symbolPointers, currentPrices, currentTime } = args;
  const cfg = runtime.config;

  // 1) Gewichte aus offenen Positionen (Notional-Anteile, |qty| × Preis).
  const posList = portfolio.openPositionsList;
  if (posList.length === 0) {
    runtime.noExposureSteps++;
    runtime.currentFactor = cfg.maxMultiplier;
    runtime.prevMultiplier = cfg.maxMultiplier;
    return cfg.maxMultiplier;
  }
  const notional: Record<string, number> = {};
  for (const p of posList) {
    const price = currentPrices.get(p.symbol) ?? p.entryPrice;
    const px = Number.isFinite(price) && price > 0 ? price : p.entryPrice;
    const n = Math.abs(p.qty) * px;
    if (!Number.isFinite(n) || n <= 0) continue;
    notional[p.symbol] = (notional[p.symbol] ?? 0) + n;
  }
  const totalNotional = Object.values(notional).reduce((a, b) => a + b, 0);
  if (totalNotional <= 0) {
    runtime.noExposureSteps++;
    runtime.currentFactor = cfg.maxMultiplier;
    runtime.prevMultiplier = cfg.maxMultiplier;
    return cfg.maxMultiplier;
  }

  // 2) Returns aus as-of-sicheren Kerzen (time ≤ currentTime).
  const lookback = cfg.lookbackPeriods;
  const series: VolatilityForecastSeries[] = [];
  for (const sym of Object.keys(notional).sort()) {
    const candles = candlesIndexed.get(sym) ?? candlesIndexed.get(nativeSymbolOf(sym));
    if (!candles || candles.length === 0) continue;
    const ptr = symbolPointers.get(sym) ?? symbolPointers.get(nativeSymbolOf(sym)) ?? 0;
    // Letztens (lookback+1) Kerze vor dem Pointer (index-aligned, kein Look-ahead).
    const from = Math.max(0, ptr - (lookback + 1));
    const window = candles.slice(from, ptr);
    if (window.length < 2) continue;
    const returns: number[] = [];
    const eventTimes: number[] = [];
    for (let i = 1; i < window.length; i++) {
      const prev = window[i - 1].close;
      const cur = window[i].close;
      if (!Number.isFinite(prev) || !Number.isFinite(cur) || prev <= 0 || cur <= 0) continue;
      returns.push(Math.log(cur / prev));
      eventTimes.push(window[i].time);
    }
    if (returns.length === 0) continue;
    series.push({
      symbol: sym,
      weight: notional[sym] / totalNotional,
      annualization: runtime.annualization,
      logReturns: returns,
      eventTimes,
    });
  }

  // 3) Gemeinsame Länge (index-aligned vom jüngsten Zeitpunkt).
  if (series.length > 0) {
    const commonLength = Math.min(...series.map((s) => s.logReturns.length));
    if (commonLength >= 2) {
      for (const s of series) {
        s.logReturns = s.logReturns.slice(-commonLength);
        s.eventTimes = s.eventTimes.slice(-commonLength);
      }
    }
  }

  // 4) Pure Forecast + Multiplikator (gemeinsam mit Live).
  const input: VolatilityForecastInput = {
    series,
    asOf: currentTime,
    computedAt: currentTime,
    config: cfg,
  };
  const result = computeVolatilityTargetingFromInput(input, runtime.prevMultiplier);

  runtime.updates++;
  runtime.prevMultiplier = result.appliedMultiplier;
  runtime.lastForecast = result.forecast.forecastAnnualizedVol;
  if (result.outcome === "fallback") {
    runtime.fallbacks++;
    const code = result.forecast.reasonCode;
    runtime.fallbacksByReason[code] = (runtime.fallbacksByReason[code] ?? 0) + 1;
  } else if (result.outcome === "no_exposure") {
    runtime.noExposureSteps++;
  }

  return result.appliedMultiplier;
}

/** Löst ein Symbol auf den venue-nativen Teil auf (für Candle-Map-Lookup). */
function nativeSymbolOf(symbol: string): string {
  const idx = symbol.indexOf(":");
  return idx > 0 && idx < symbol.length - 1 ? symbol.slice(idx + 1) : symbol;
}

/** Baut die Summary für das Ergebnis-Objekt. */
function buildVtSummary(
  runtime: VtRuntime,
  factorByBar: number[]
): BacktestVolatilityTargetingSummary {
  return {
    config: { ...runtime.config },
    updates: runtime.updates,
    fallbacks: runtime.fallbacks,
    fallbacksByReason: { ...runtime.fallbacksByReason },
    noExposureSteps: runtime.noExposureSteps,
    lastForecastAnnualizedVol: runtime.lastForecast,
    lastAppliedMultiplier: runtime.currentFactor,
    factorByBar: factorByBar.slice(),
  };
}
