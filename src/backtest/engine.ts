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
import { evaluateExit, simulateEntry } from "./simulator";
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
import { metricLabel, telemetry } from "../lib/telemetry";
import type { TradeSetupProposal } from "../cycle/schemas";

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
    portfolio.openPosition(
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

    // b) Exits für alle offenen Positionen prüfen (Stop Loss / Take Profit)
    for (const pos of replay ? [] : portfolio.openPositionsList) {
      const candleInfo = currentCandleBySymbol.get(pos.symbol);
      if (!candleInfo) continue;

      if (paper) {
        // Paper-Pfad: Trigger = Marktstruktur (Stop-Vorrang), Fill = Simulator.
        const trigger = detectExitTrigger(pos, candleInfo.candle);
        if (!trigger) continue;
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

      const exitEval = evaluateExit(pos, candleInfo.candle, config);
      if (exitEval && exitEval.triggered) {
        portfolio.closePosition(pos.symbol, exitEval, currentTime, barStep);
      }
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
              spec.action.riskBudgetPct,
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
                portfolio.openPosition(
                  strat.id,
                  strat.symbol,
                  spec.action.side,
                  fill,
                  candleInfo.candle,
                  barStep,
                  stopLoss,
                  takeProfit
                );
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
              evalItem.riskBudgetPct,
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
                portfolio.openPosition(
                  strat.id,
                  strat.symbol,
                  evalItem.side,
                  fill,
                  candleInfo.candle,
                  barStep,
                  evalItem.stopLoss,
                  evalItem.takeProfit
                );
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
