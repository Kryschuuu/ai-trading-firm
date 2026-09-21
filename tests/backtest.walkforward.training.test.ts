import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  runWalkForward,
  selectWalkForwardCandidate,
  type BacktestStrategyItem,
  type WalkForwardCandidate,
  type WalkForwardSelectionConfig,
  WalkForwardTrainingError,
} from "../src/backtest";
import type { CandleLike, RuleSpec } from "../src/lib/ruleEngine";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const START = Date.UTC(2026, 1, 1);

function candles(count: number, start = 100): CandleLike[] {
  return Array.from({ length: count }, (_, index) => {
    const close = Number((start + Math.sin(index / 4) * 4 + index * 0.03).toFixed(4));
    const previous = index === 0 ? close : Number((start + Math.sin((index - 1) / 4) * 4 + (index - 1) * 0.03).toFixed(4));
    return {
      time: START + index * HOUR,
      open: previous,
      high: Math.max(previous, close) + 0.2,
      low: Math.min(previous, close) - 0.2,
      close,
      volume: 10_000,
    };
  });
}

function rule(symbol: string, threshold: number): RuleSpec {
  return {
    name: `threshold-${threshold}`,
    symbol,
    missionId: null,
    rationale: "bounded test candidate",
    sourceRole: "MANUAL",
    riskScore: 0.2,
    condition: { logic: "all", conditions: [{ field: "price", op: "gt", value: threshold }] },
    action: { side: "LONG", stopLossPct: 5, takeProfitRR: 2, riskBudgetPct: 0.02, maxPositionPct: 0.25, positionSizeMode: "risk" },
    window: { timeframe: "1h", validFrom: null, validUntil: null, maxExecutionsPerDay: 5, cooldownMinutes: 0, volumeWindow: 20 },
  };
}

function candidate(id: string, threshold: number): WalkForwardCandidate {
  const strategy: BacktestStrategyItem = { type: "rule", id: `${id}-strategy`, spec: rule("WFTRAIN", threshold) };
  return { id, strategyVersion: "rule-v1", config: { threshold }, strategies: [strategy] };
}

function input(overrides: Partial<Parameters<typeof runWalkForward>[0]> = {}) {
  return {
    instrumentId: "WFTRAIN",
    timeframe: "1h" as const,
    candles: candles(21 * 24 + 1),
    strategies: [candidate("a", 99).strategies[0]],
    ruleRef: { ruleId: null, ruleKey: null, name: "training", signature: "training", ruleSymbol: "WFTRAIN" },
    engineConfig: { executionModel: "paper" as const, initialCapital: 10_000, warmupBars: 2 },
    walkforward: { isDays: 14, oosDays: 7, maxSpanDays: 730 },
    selection: { metric: "netPnl" as const, minTrades: 0 },
    candidates: [candidate("a", 99), candidate("b", 102)],
    nowMs: START,
    ...overrides,
  };
}

describe("90d/30d train-select-freeze-test", () => {
  it("uses only IS for selection and repeats the selected ID exactly on OOS", () => {
    const first = runWalkForward(input());
    const mutatedOos = input().candles.map((candle) => candle.time >= START + 14 * DAY ? { ...candle, close: candle.close + 20, high: candle.high + 20 } : candle);
    const second = runWalkForward(input({ candles: mutatedOos }));
    assert.ok(first.training);
    assert.ok(second.training);
    assert.equal(first.windows.length, 1);
    assert.equal(first.windows[0].selectedCandidateId, first.windows[0].selection?.selectedCandidateId);
    assert.equal(second.windows[0].selection?.selectedCandidateId, first.windows[0].selection?.selectedCandidateId);
    assert.equal(first.windows[0].selectedCandidateId, first.training?.holdout?.selectedCandidateId ?? first.windows[0].selectedCandidateId);
    assert.notEqual(first.training?.finalDecision.freezeHash, second.training?.finalDecision.freezeHash, "Datenmanifest muss OOS-Mutationen sichtbar machen");
  });

  it("is order-independent and gates unavailable IS results fail-closed", () => {
    const cfg: WalkForwardSelectionConfig = { metric: "netPnl", minTrades: 1, tieBreak: ["score", "candidateId"] };
    const a = candidate("a", 99);
    const b = candidate("b", 102);
    const summary = (netPnl: number) => ({ from: 1, to: 2, bars: 1, trades: 2, wins: 1, winRate: 50, pnl: netPnl, profitFactor: 1, maxDrawdownPct: 2, sharpeRatio: 0, sortinoRatio: 0, fees: 0, funding: 0, netPnl, slippage: 0, tradeHash: "x".repeat(64) });
    assert.equal(selectWalkForwardCandidate([{ candidate: b, is: summary(10) }, { candidate: a, is: summary(10) }], cfg).selectedCandidateId, "a");
    assert.throws(() => selectWalkForwardCandidate([{ candidate: a, is: { ...summary(0), trades: 0 } }], cfg), (error: unknown) => error instanceof WalkForwardTrainingError && error.code === "training:no-eligible-candidate");
  });

  it("freezes candidate/config/manifest changes and purges horizon overlap", () => {
    const base = runWalkForward(input({ leakage: { purgeBars: 2, labelHorizonBars: 2, embargoBars: 1 } }));
    assert.ok(base.training);
    const freeze = base.training?.freezes[0];
    assert.ok(freeze);
    assert.equal(freeze?.leakage.purgeBars, 2);
    assert.equal(freeze?.cutoffs.selectionIsTo, freeze?.cutoffs.isTo !== null ? (freeze.cutoffs.isTo as number) - 2 * HOUR : null);
    assert.equal(freeze?.cutoffs.oosEvaluationFrom, freeze?.cutoffs.oosFrom !== null ? (freeze.cutoffs.oosFrom as number) + HOUR : null);
    assert.equal(freeze?.freezeHash.length, 64);
    const changed = runWalkForward(input({ candidates: [candidate("a", 99), candidate("c", 103)] }));
    assert.notEqual(base.training?.candidatesHash, changed.training?.candidatesHash);
    assert.notEqual(base.training?.finalDecision.freezeHash, changed.training?.finalDecision.freezeHash);
  });

  it("evaluates a final holdout only after the final IS decision", () => {
    const holdout = candles(8, 110).map((candle) => ({ ...candle, time: START + 22 * DAY + (candle.time - START) }));
    const report = runWalkForward(input({ finalHoldout: { candles: holdout } }));
    assert.equal(report.training?.holdout?.selectedCandidateId, report.training?.finalDecision.selectedCandidateId);
    assert.equal(report.training?.holdout?.from, holdout[0].time);
    assert.equal(report.training?.holdout?.summary.from, holdout[0].time);
  });

  it("rejects delayed availability and invalid candidate search inputs", () => {
    const source = candles(21 * 24 + 1);
    const provenance = source.map((candle, index) => ({ eventTime: candle.time, availableAt: candle.time + (index === 3 ? HOUR : 0), computedAt: candle.time + HOUR }));
    assert.throws(() => runWalkForward(input({ candles: source, candleProvenance: provenance })), (error: unknown) => error instanceof WalkForwardTrainingError && error.code === "training:invalid-data");
    assert.throws(() => runWalkForward(input({ candidates: Array.from({ length: 65 }, (_, index) => candidate(`c${index}`, 99 + index)) })), (error: unknown) => error instanceof WalkForwardTrainingError && error.code === "training:invalid-candidates");
  });
});
