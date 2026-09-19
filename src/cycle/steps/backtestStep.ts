/**
 * Step 8: Backtest-Verifikation (nach Research).
 *
 * Prüft vorgeschlagene Setups deterministisch gegen historische Kursdaten
 * unter Verwendung der Multi-Asset Backtest-Engine (Task 02).
 *
 * HARTE ARCHITEKTUR-REGEL:
 * Reine Arithmetik — KEIN LLM (llmAllowed: false).
 * Ermittelt: Historische Performance, Max Drawdown, Profit Factor, Sharpe, Sortino, Regime-Robustheit.
 */

import type { StepDefinition, StepExecutionContext } from "../types";
import { type BacktestStepOutput, type VerifiedSetupResult, validateBacktestOutput } from "../schemas";
import type { ResearchStepOutput, TradeSetupProposal } from "../schemas";
import { HistoricalStore, DEFAULT_ANALYSIS_TIMEFRAME } from "@/lib/marketdata/historicalStore";
import { historyDir } from "@/lib/marketdata/config";
import { runMultiAssetBacktest, type BacktestStrategyItem } from "@/backtest";
import type { CandleLike } from "@/lib/ruleEngine";

export interface BacktestStepInput {
  setups?: TradeSetupProposal[];
}

export const backtestStep: StepDefinition<BacktestStepInput, BacktestStepOutput> = {
  stepId: "08-backtest-verification",
  name: "Backtest Verification",
  role: "BACKTEST_VERIFICATION",
  timeWindow: "12:00-13:00",
  llmAllowed: false, // VERBINDLICH: Rein mathematische Verifikation
  retryPolicy: {
    maxAttempts: 1,
    backoffMs: 0,
  },

  async execute(context: StepExecutionContext<BacktestStepInput>): Promise<BacktestStepOutput> {
    const researchOutput = context.previousStepOutputs["07-research"] as ResearchStepOutput | undefined;
    const setups = context.input?.setups ?? researchOutput?.setups ?? [];

    context.log(`Verifiziere ${setups.length} Research-Setups deterministisch gegen historische Daten …`);

    // GAP-01 (v1.51.0): Store-Pfad wie researchStep über PAPER_HISTORY_DIR
    // (Default data/history — prod-neutral, Tests injizieren ein Temp-Verz).
    const store = new HistoricalStore(historyDir());
    const verifiedSetups: VerifiedSetupResult[] = [];
    let passedCount = 0;
    let failedCount = 0;

    for (const setup of setups) {
      // Kerzen für dieses Instrument aus dem Store laden
      const history = store.query({ instrumentId: setup.instrumentId, timeframe: DEFAULT_ANALYSIS_TIMEFRAME });
      const candles: CandleLike[] = history.map((h) => ({
        time: h.ts,
        open: h.open,
        high: h.high,
        low: h.low,
        close: h.close,
        volume: h.volume,
      }));

      let maxDrawdownPct = 0;
      let profitFactorValue = 1.0;
      let sharpeVal = 0;
      let sortinoVal = 0;
      let regimeRobustness = 0.5;
      let status: "OK" | "DATA_UNAVAILABLE" = "OK";
      const failureReasons: string[] = [];

      if (candles.length < 5) {
        // GAP-01 (v1.51.0), D4: KEINE erfundene Mindestbewertung mehr.
        // Bei < 5 Kerzen ist keine Messung möglich ⇒ fail-closed:
        // verified=false, sichtbarer DATA_UNAVAILABLE-Status, neutrale
        // Null-Kennzahlen, maschinenlesbarer Grund + Audit + Log (R2/R6).
        status = "DATA_UNAVAILABLE";
        maxDrawdownPct = 0;
        profitFactorValue = 0;
        sharpeVal = 0;
        sortinoVal = 0;
        regimeRobustness = 0;
        const reason = `data:insufficient-candles:${candles.length}-of-5-minimum`;
        failureReasons.push(reason);
        context.log(
          `Setup ${setup.instrumentId} nicht verifizierbar (${candles.length}/5 Kerzen) — DATA_UNAVAILABLE, keine Bewertung.`,
          "WARN"
        );
        await context.ports.audit.logEvent({
          event: "CYCLE_STEP_SKIPPED",
          level: "WARN",
          cycleId: context.cycleId,
          stepId: "08-backtest-verification",
          role: "BACKTEST_VERIFICATION",
          timestamp: context.clock.toISOString(),
          detail: {
            reason,
            instrumentId: setup.instrumentId,
            candles: candles.length,
            minimum: 5,
          },
        });
      } else {
        // Echter Event-Driven Backtest über die Multi-Asset-Engine
        const strategyItem: BacktestStrategyItem = {
          type: "setup",
          setup,
          id: `VERIFY-${setup.instrumentId}`,
        };

        const result = runMultiAssetBacktest({
          candlesBySymbol: new Map([[setup.instrumentId, candles]]),
          strategies: [strategyItem],
          config: {
            timeframe: DEFAULT_ANALYSIS_TIMEFRAME,
            initialCapital: 10_000,
            warmupBars: Math.min(20, Math.floor(candles.length / 3)),
            enableShorts: true,
          },
        });

        maxDrawdownPct = result.metrics.maxDrawdownPct;
        profitFactorValue = result.metrics.profitFactor ?? (result.metrics.winningTrades > 0 ? 2.0 : 0.5);
        sharpeVal = result.metrics.sharpeRatio;
        sortinoVal = result.metrics.sortinoRatio;

        const winRateRatio = result.metrics.winRate / 100;
        regimeRobustness = Number(
          Math.min(1, Math.max(0, winRateRatio * 0.8 + (sharpeVal > 0 ? 0.2 : 0))).toFixed(3)
        );

        // Verifikationskriterien
        if (maxDrawdownPct > 35) {
          failureReasons.push(`Max Drawdown ${maxDrawdownPct.toFixed(1)}% überschreitet Schwelle 35%`);
        }
        if (profitFactorValue < 1.0) {
          failureReasons.push(`Profit Factor ${profitFactorValue.toFixed(2)} ist kleiner als 1.0`);
        }
        if (sharpeVal < -0.5) {
          failureReasons.push(`Sharpe Ratio ${sharpeVal.toFixed(2)} ist negativ`);
        }
      }

      const verified = failureReasons.length === 0;
      if (verified) passedCount++;
      else failedCount++;

      verifiedSetups.push({
        setup,
        verified,
        verdict: verified ? "PASSED" : "FAILED",
        status,
        metrics: {
          maxDrawdownPct: Number(maxDrawdownPct.toFixed(2)),
          profitFactor: Number(profitFactorValue.toFixed(2)),
          sharpeRatio: Number(sharpeVal.toFixed(2)),
          sortinoRatio: Number(sortinoVal.toFixed(2)),
          regimeRobustness,
        },
        failureReasons: failureReasons.length > 0 ? failureReasons : undefined,
      });
    }

    const unavailableCount = verifiedSetups.filter((v) => v.status === "DATA_UNAVAILABLE").length;
    const output: BacktestStepOutput = {
      verifiedSetups,
      summary: {
        total: verifiedSetups.length,
        passed: passedCount,
        failed: failedCount,
        unavailable: unavailableCount,
      },
    };

    return validateBacktestOutput(output).data!;
  },
};
