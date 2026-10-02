/**
 * Tests für den deterministischen Cost- & Slippage-Stress-Runner
 * (`src/strategies/validator/stress.ts`, STX-06-03, Finding STX-11, Phase 6).
 *
 * Abgedeckte Verträge:
 *   1. Szenario-Katalog (`COST_STRESS_SCENARIOS`: `base` 1×/5bp, `double` 2×/10bp,
 *      `triple` 3×/20bp) & Architektur-Guards (kein drittes Kostenmodell,
 *      keine eigene Monte-Carlo-Implementierung).
 *   2. `runInEngineStress` mit injiziertem Runner-Stub:
 *      - Pro Szenario genau ein Lauf mit skaliertem `feeModel` und
 *        `slippageModel: "fixed"`, `fixedSlippageBps`.
 *      - `executionModel` bleibt der des Referenzlaufs (`"legacy" | "paper" | "event_replay"`).
 *   3. `base` ist byte-identisch zum Referenzlauf — sowohl mit Runner-Stub
 *      als auch gegen einen echten `runWalkForward`-Lauf.
 *   4. Fail-closed Validierung: `slippageModel: "none"` (sowie 0-bp-Slippage
 *      oder 0-bp-Gebühren) ⇒ `{ ok: false, errors }`, kein stilles Hochrechnen,
 *      0 Runner-Aufrufe.
 *   5. `summarizeStressSweep`:
 *      - `degradationRatio = OOS-Sharpe(triple) / OOS-Sharpe(base)`
 *      - `breakevenMultiplier` via linearer Interpolation zwischen Szenarien;
 *        `null`, wenn `triple` noch positiv ist („hält mindestens 3×").
 *      - Verdikt-Grenzen (`COST_ROBUST`, `COST_SENSITIVE`, `COST_DEPENDENT`),
 *        inklusive Pflichtbedingung `triple.netPnl > 0` für `COST_ROBUST` und
 *        konfigurierbarer Schwellen.
 *   6. Laufzeit-Bounds (`DEFAULT_MAX_STRESS_RUNS = 45` = 3 × 3 × 5, hartes
 *      `maxRuns`-Argument, CLI-Parser `parseMaxRunsFlag` für `--max-runs`).
 *   7. `runPostHocStress` reicht das Trade-Log dünn an `runMonteCarloSimulation`
 *      durch; In-Engine- und Post-Hoc-Ergebnis stehen im Report strikt getrennt.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  COST_STRESS_SCENARIOS,
  COST_STRESS_SCENARIO_IDS,
  COST_STRESS_VERSION,
  DEFAULT_MAX_STRESS_RUNS,
  DEFAULT_STRESS_VERDICT_THRESHOLDS,
  MAX_STRESS_CANDIDATES,
  MAX_STRESS_SCENARIOS,
  MAX_STRESS_WINDOWS,
  STRESS_VERDICTS,
  buildScenarioEngineConfig,
  buildStressReport,
  computeBreakevenMultiplier,
  parseMaxRunsFlag,
  runInEngineStress,
  runPostHocStress,
  summarizeStressSweep,
  toMonteCarloTrades,
  validateReferenceCostConfig,
  type InEngineStressRunnerContext,
  type StressScenarioSummaryRow,
} from "../src/strategies/validator/stress";
import { DEFAULT_BACKTEST_CONFIG } from "../src/backtest/engine";
import type {
  BacktestEngineConfig,
  BacktestTradeLog,
} from "../src/backtest/types";
import {
  runWalkForward,
  type RunWalkForwardInput,
  type WalkForwardTradeRecord,
} from "../src/backtest/walkforward";
import {
  MonteCarloError,
  runMonteCarloSimulation,
  type MonteCarloTradeInput,
} from "../src/backtest/montecarlo";
import { sanitizeRuleSpec, type CandleLike, type RuleSpec } from "../src/lib/ruleEngine";

// ─────────────────────────────────────────────────────────────────────────────
// Test-Hilfen & deterministische Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeReferenceConfig(
  overrides: Partial<BacktestEngineConfig> = {},
): BacktestEngineConfig {
  return {
    ...DEFAULT_BACKTEST_CONFIG,
    executionModel: "paper",
    slippageModel: "fixed",
    fixedSlippageBps: 5,
    feeModel: {
      makerFee: 0.0002,
      takerFee: 0.0006,
    },
    ...overrides,
  };
}

function makeStubRunnerOutput(params: {
  readonly sharpeRatio: number;
  readonly netPnl: number;
  readonly maxDrawdownPct?: number;
  readonly trades?: number;
  readonly configTag?: string;
}) {
  return {
    aggregateOos: {
      sharpeRatio: params.sharpeRatio,
      netPnl: params.netPnl,
      maxDrawdownPct: params.maxDrawdownPct ?? 6.5,
      trades: params.trades ?? 42,
    },
    ...(params.configTag ? { configTag: params.configTag } : {}),
  };
}

function makeMonteCarloTrades(count = 36): MonteCarloTradeInput[] {
  const startTs = Date.UTC(2026, 0, 1, 0, 0, 0);
  const hourMs = 3_600_000;
  const trades: MonteCarloTradeInput[] = [];

  for (let i = 0; i < count; i += 1) {
    const isWin = i % 3 !== 0;
    const notional = 1_000;
    const fees = 1.2;
    const slippage = 0.5;
    const gross = isWin ? 18 : -11;
    const pnlNet = Number((gross - fees - slippage).toFixed(4));
    trades.push({
      seq: i + 1,
      symbol: "BTCUSDT",
      strategyId: "ema-adx-trend",
      entryTs: startTs + i * 6 * hourMs,
      exitTs: startTs + (i * 6 + 3) * hourMs,
      pnlNet,
      fees,
      slippage,
      notional,
    });
  }
  return trades;
}

function makeSyntheticCandles(count = 720): CandleLike[] {
  const startTs = Date.UTC(2025, 0, 1, 0, 0, 0);
  const hourMs = 3_600_000;
  const candles: CandleLike[] = [];
  let price = 100;

  for (let i = 0; i < count; i += 1) {
    // Deterministischer Sägezahn-/Trend-Verlauf für reproduzierbare Walk-Forward-Trades
    const phase = i % 28;
    const delta = phase < 20 ? 0.55 : -0.75;
    const open = price;
    const close = Math.max(20, Number((open + delta).toFixed(4)));
    const high = Number((Math.max(open, close) + 0.35).toFixed(4));
    const low = Number((Math.min(open, close) - 0.35).toFixed(4));
    price = close;

    candles.push({
      time: startTs + i * hourMs,
      open,
      high,
      low,
      close,
      volume: 1_500 + (i % 11) * 100,
    });
  }
  return candles;
}

const SANITIZED_RULE = sanitizeRuleSpec({
  name: "Stress Test Rule",
  symbol: "BTCUSDT",
  condition: {
    logic: "all",
    conditions: [{ field: "rsi14", op: "gt", value: 45 }],
  },
  action: {
    side: "LONG",
    stopLossPct: 2.0,
    takeProfitRR: 1.5,
  },
  window: {
    timeframe: "1h",
  },
});
if (!SANITIZED_RULE.ok) {
  throw new Error(`Unexpected sanitizeRuleSpec failure: ${SANITIZED_RULE.errors.join(", ")}`);
}
const SIMPLE_RULE_SPEC: RuleSpec = SANITIZED_RULE.spec;

// ─────────────────────────────────────────────────────────────────────────────
// 1. Szenario-Katalog & statische Architektur-Guards
// ─────────────────────────────────────────────────────────────────────────────

describe("STX-06-03 Cost- & Slippage-Stress-Runner — Katalog & Architektur-Guards", () => {
  it("exportiert COST_STRESS_SCENARIOS exakt wie spezifiziert", () => {
    assert.equal(COST_STRESS_VERSION, "stx06-cost-stress-v1");
    assert.deepEqual(COST_STRESS_SCENARIO_IDS, ["base", "double", "triple"]);
    assert.deepEqual(COST_STRESS_SCENARIOS, [
      { id: "base",   feeMultiplier: 1, slippageBps: 5,  label: "Basis" },
      { id: "double", feeMultiplier: 2, slippageBps: 10, label: "2× Kosten" },
      { id: "triple", feeMultiplier: 3, slippageBps: 20, label: "3× Kosten" },
    ]);
    assert.deepEqual(STRESS_VERDICTS, [
      "COST_ROBUST",
      "COST_SENSITIVE",
      "COST_DEPENDENT",
    ]);
  });

  it("definiert die Default-Laufzeit-Bounds auf 3 × 3 × 5 = 45 Läufe", () => {
    assert.equal(MAX_STRESS_SCENARIOS, 3);
    assert.equal(MAX_STRESS_WINDOWS, 3);
    assert.equal(MAX_STRESS_CANDIDATES, 5);
    assert.equal(
      DEFAULT_MAX_STRESS_RUNS,
      MAX_STRESS_SCENARIOS * MAX_STRESS_WINDOWS * MAX_STRESS_CANDIDATES,
    );
    assert.equal(DEFAULT_MAX_STRESS_RUNS, 45);
  });

  it("verwendet in stress.ts ausschließlich bestehende Konfigurationsfelder und runMonteCarloSimulation", () => {
    const stressSource = readFileSync(
      path.resolve(process.cwd(), "src/strategies/validator/stress.ts"),
      "utf8",
    );
    assert.match(
      stressSource,
      /import\s*\{[^}]*runMonteCarloSimulation[^}]*\}\s*from\s*["']\.\.\/\.\.\/backtest\/montecarlo["']/,
    );
    // Keine eigene Zufallszahlengenerierung / kein eigenes Bootstrap in stress.ts
    assert.doesNotMatch(stressSource, /Math\.random\s*\(/);
    assert.doesNotMatch(stressSource, /mulberry32|xoshiro|splitmix/i);
    // Verweis auf 06-01 (Annahmen-Prüfung) ist im JSDoc dokumentiert
    assert.match(stressSource, /FEE_NONZERO/);
    assert.match(stressSource, /SLIPPAGE_NONZERO/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. In-Engine-Stress (`runInEngineStress`) mit injiziertem Runner-Stub
// ─────────────────────────────────────────────────────────────────────────────

describe("STX-06-03 runInEngineStress — Szenario-Skalierung & ExecutionModel", () => {
  it("führt pro Szenario genau einen Lauf mit skaliertem feeModel und fixedSlippageBps aus", async () => {
    const baseConfig = makeReferenceConfig({
      executionModel: "paper",
      slippageModel: "fixed",
      fixedSlippageBps: 5,
      feeModel: { makerFee: 0.0002, takerFee: 0.0006 },
    });

    const recordedContexts: InEngineStressRunnerContext[] = [];

    const sweep = await runInEngineStress({
      engineConfig: baseConfig,
      windowCount: 3,
      candidateCount: 2,
      runner: (ctx) => {
        recordedContexts.push(ctx);
        const mult = ctx.scenario.feeMultiplier;
        return makeStubRunnerOutput({
          sharpeRatio: Number((2.0 - (mult - 1) * 0.3).toFixed(4)),
          netPnl: 500 - (mult - 1) * 150,
          maxDrawdownPct: 5 + (mult - 1) * 1.5,
          trades: 48,
        });
      },
    });

    assert.equal(sweep.ok, true);
    if (!sweep.ok) return;

    assert.equal(recordedContexts.length, 3);
    assert.deepEqual(
      recordedContexts.map((c) => c.scenario.id),
      ["base", "double", "triple"],
    );

    // 1× Base
    assert.deepEqual(recordedContexts[0].engineConfig.feeModel, {
      makerFee: 0.0002,
      takerFee: 0.0006,
    });
    assert.equal(recordedContexts[0].engineConfig.slippageModel, "fixed");
    assert.equal(recordedContexts[0].engineConfig.fixedSlippageBps, 5);

    // 2× Double
    assert.deepEqual(recordedContexts[1].engineConfig.feeModel, {
      makerFee: 0.0004,
      takerFee: 0.0012,
    });
    assert.equal(recordedContexts[1].engineConfig.slippageModel, "fixed");
    assert.equal(recordedContexts[1].engineConfig.fixedSlippageBps, 10);

    // 3× Triple (ohne IEEE-754 0.0018000000000000002 Drift)
    assert.deepEqual(recordedContexts[2].engineConfig.feeModel, {
      makerFee: 0.0006,
      takerFee: 0.0018,
    });
    assert.equal(recordedContexts[2].engineConfig.slippageModel, "fixed");
    assert.equal(recordedContexts[2].engineConfig.fixedSlippageBps, 20);

    // Budget-Nachweis: 3 Szenarien × 3 Fenster × 2 Kandidaten = 18 <= 45
    assert.deepEqual(sweep.budget, {
      scenarioCount: 3,
      windowCount: 3,
      candidateCount: 2,
      plannedRuns: 18,
      executedRuns: 18,
      maxRuns: 45,
    });

    assert.equal(sweep.summary.verdict, "COST_ROBUST");
    assert.equal(sweep.summary.degradationRatio, 0.7); // 1.4 / 2.0
    assert.equal(sweep.summary.breakevenMultiplier, null);
  });

  it("behält executionModel des Referenzlaufs für legacy, paper und event_replay unverändert bei", async () => {
    const models: readonly BacktestEngineConfig["executionModel"][] = [
      "legacy",
      "paper",
      "event_replay",
    ];

    for (const executionModel of models) {
      const seenModels: BacktestEngineConfig["executionModel"][] = [];
      const refConfig = makeReferenceConfig({ executionModel });

      const sweep = await runInEngineStress({
        engineConfig: refConfig,
        runner: (ctx) => {
          seenModels.push(ctx.engineConfig.executionModel);
          return makeStubRunnerOutput({ sharpeRatio: 1.5, netPnl: 200 });
        },
      });

      assert.equal(sweep.ok, true);
      assert.deepEqual(seenModels, [
        executionModel,
        executionModel,
        executionModel,
      ]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Byte-Identität des `base`-Szenarios zum Referenzlauf
// ─────────────────────────────────────────────────────────────────────────────

describe("STX-06-03 Base-Szenario — Byte-Identität zum Referenzlauf", () => {
  it("liefert mit injiziertem Runner ein zum Referenzlauf byte-identisches Base-Ergebnis", async () => {
    const refConfig = makeReferenceConfig({
      executionModel: "event_replay",
      slippageModel: "fixed",
      fixedSlippageBps: 5,
      feeModel: { makerFee: 0.0002, takerFee: 0.0006 },
    });

    const deterministicRunner = (ctx: InEngineStressRunnerContext) => {
      const cfgJson = JSON.stringify(ctx.engineConfig);
      const mult = ctx.engineConfig.feeModel.takerFee / 0.0006;
      const slip = ctx.engineConfig.fixedSlippageBps;
      return makeStubRunnerOutput({
        sharpeRatio: Number((1.8 - (mult - 1) * 0.25 - (slip - 5) * 0.01).toFixed(4)),
        netPnl: Number((400 - (mult - 1) * 90 - (slip - 5) * 4).toFixed(4)),
        maxDrawdownPct: Number((6.0 + (mult - 1) * 0.8).toFixed(4)),
        trades: 35,
        configTag: cfgJson,
      });
    };

    // Direkter Referenzlauf mit unveränderter Referenzkonfiguration
    const referenceOutput = deterministicRunner({
      scenario: COST_STRESS_SCENARIOS[0],
      engineConfig: refConfig,
      config: refConfig,
    });

    const sweep = await runInEngineStress({
      engineConfig: refConfig,
      runner: deterministicRunner,
    });

    assert.equal(sweep.ok, true);
    if (!sweep.ok) return;

    const baseRun = sweep.runs[0];
    assert.equal(baseRun.scenario.id, "base");
    assert.equal(
      JSON.stringify(baseRun.engineConfig),
      JSON.stringify(refConfig),
      "Base-EngineConfig muss byte-identisch zur Referenzkonfiguration sein",
    );
    assert.equal(
      JSON.stringify(baseRun.report),
      JSON.stringify(referenceOutput),
      "Base-Report muss byte-identisch zum Referenzlauf sein",
    );
  });

  it("liefert auch gegen das echte runWalkForward einen byte-identischen Base-WalkForwardReport", async () => {
    const candles = makeSyntheticCandles(720); // 30 Tage 1h-Kerzen
    const fixedNowMs = Date.UTC(2026, 9, 2, 12, 0, 0);
    const refEngineConfig = makeReferenceConfig({
      executionModel: "paper",
      slippageModel: "fixed",
      fixedSlippageBps: 5,
      feeModel: { makerFee: 0.0002, takerFee: 0.0006 },
    });

    const referenceWfInput: RunWalkForwardInput = {
      instrumentId: "BTCUSDT",
      timeframe: "1h",
      candles,
      strategies: [{ type: "rule", spec: SIMPLE_RULE_SPEC }],
      ruleRef: {
        ruleId: "stress-test-rule",
        ruleKey: "stress-test-rule",
        name: SIMPLE_RULE_SPEC.name,
        signature: "sig-stress-test-v1",
        ruleSymbol: "BTCUSDT",
      },
      walkforward: {
        isDays: 10,
        oosDays: 5,
        maxSpanDays: 30,
      },
      engineConfig: refEngineConfig,
      nowMs: fixedNowMs,
    };

    const referenceReport = runWalkForward(referenceWfInput);
    const sweep = await runInEngineStress({
      walkForward: referenceWfInput,
    });

    assert.equal(sweep.ok, true);
    if (!sweep.ok) return;

    const baseReport = sweep.runs[0].report;
    assert.equal(
      JSON.stringify(baseReport),
      JSON.stringify(referenceReport),
      "Der echte WalkForwardReport des base-Szenarios muss byte-identisch zum Referenzlauf sein",
    );
    // Double und Triple haben abweichende Config-Hashes und höhere Gebühren
    assert.notEqual(
      sweep.runs[1].report.costProfile.takerFee,
      referenceReport.costProfile.takerFee,
    );
    assert.notEqual(
      sweep.runs[2].report.costProfile.takerFee,
      referenceReport.costProfile.takerFee,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Fail-Closed bei `slippageModel: "none"` & 0-Kosten
// ─────────────────────────────────────────────────────────────────────────────

describe("STX-06-03 Fail-Closed Validierung — kein stilles Hochrechnen", () => {
  it("lehnt slippageModel: 'none' im Referenzlauf mit { ok: false, errors } ohne Runner-Aufruf ab", async () => {
    let runnerCalls = 0;
    const noneSlippageConfig = makeReferenceConfig({
      slippageModel: "none",
    });

    const res = await runInEngineStress({
      engineConfig: noneSlippageConfig,
      runner: () => {
        runnerCalls += 1;
        return makeStubRunnerOutput({ sharpeRatio: 2.0, netPnl: 300 });
      },
    });

    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(runnerCalls, 0, "Runner darf bei slippageModel: 'none' nicht aufgerufen werden");
    assert.ok(res.errors.length >= 1);
    assert.match(res.errors[0], /stress:slippage-none/);
  });

  it("lehnt 0-bp fixedSlippageBps, 0-Factor spread_relative und 0-Gebühren fail-closed ab", async () => {
    let runnerCalls = 0;
    const stubRunner = () => {
      runnerCalls += 1;
      return makeStubRunnerOutput({ sharpeRatio: 1.5, netPnl: 100 });
    };

    const zeroFixedSlippage = await runInEngineStress({
      engineConfig: makeReferenceConfig({
        slippageModel: "fixed",
        fixedSlippageBps: 0,
      }),
      runner: stubRunner,
    });
    assert.equal(zeroFixedSlippage.ok, false);
    if (!zeroFixedSlippage.ok) {
      assert.match(zeroFixedSlippage.errors[0], /stress:slippage-zero/);
    }

    const zeroSpreadFactor = await runInEngineStress({
      engineConfig: makeReferenceConfig({
        slippageModel: "spread_relative",
        spreadSlippageFactor: 0,
      }),
      runner: stubRunner,
    });
    assert.equal(zeroSpreadFactor.ok, false);
    if (!zeroSpreadFactor.ok) {
      assert.match(zeroSpreadFactor.errors[0], /stress:slippage-zero/);
    }

    const zeroFees = await runInEngineStress({
      engineConfig: makeReferenceConfig({
        feeModel: { makerFee: 0, takerFee: 0 },
      }),
      runner: stubRunner,
    });
    assert.equal(zeroFees.ok, false);
    if (!zeroFees.ok) {
      assert.match(zeroFees.errors[0], /stress:fee-zero/);
    }

    const missingConfig = validateReferenceCostConfig(null);
    assert.equal(missingConfig.ok, false);

    assert.equal(runnerCalls, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. `summarizeStressSweep` — `degradationRatio`, `breakevenMultiplier`, Verdikte
// ─────────────────────────────────────────────────────────────────────────────

describe("STX-06-03 summarizeStressSweep — Interpolation & Verdikt-Grenzen", () => {
  it("vergibt COST_ROBUST bei degradationRatio >= 0.6 und positivem triple-NetPnl (breakevenMultiplier: null)", () => {
    const rows: readonly StressScenarioSummaryRow[] = [
      { id: "base",   sharpe: 2.0, netPnl: 600, maxDrawdownPct: 5.0, trades: 50 },
      { id: "double", sharpe: 1.6, netPnl: 400, maxDrawdownPct: 6.2, trades: 50 },
      { id: "triple", sharpe: 1.3, netPnl: 180, maxDrawdownPct: 7.5, trades: 50 },
    ];

    const summary = summarizeStressSweep(rows);
    assert.deepEqual(summary, {
      scenarios: rows,
      degradationRatio: 0.65, // 1.3 / 2.0 = 0.65 >= 0.6
      breakevenMultiplier: null, // triple noch positiv ⇒ „hält mindestens 3×"
      verdict: "COST_ROBUST",
    });
  });

  it("behandelt die Grenze degradationRatio === 0.6 exakt als COST_ROBUST", () => {
    const summary = summarizeStressSweep([
      { id: "base",   sharpe: 2.0, netPnl: 300, maxDrawdownPct: 4.0, trades: 30 },
      { id: "double", sharpe: 1.5, netPnl: 150, maxDrawdownPct: 5.0, trades: 30 },
      { id: "triple", sharpe: 1.2, netPnl: 25,  maxDrawdownPct: 6.0, trades: 30 },
    ]);

    assert.equal(summary.degradationRatio, 0.6);
    assert.equal(summary.breakevenMultiplier, null);
    assert.equal(summary.verdict, "COST_ROBUST");
  });

  it("stuft degradationRatio >= 0.6 auf COST_SENSITIVE herab, wenn triple nicht mehr profitabel ist (netPnl <= 0)", () => {
    const summary = summarizeStressSweep([
      { id: "base",   sharpe: 1.5, netPnl: 200,  maxDrawdownPct: 5.0, trades: 40 },
      { id: "double", sharpe: 1.2, netPnl: 80,   maxDrawdownPct: 6.0, trades: 40 },
      { id: "triple", sharpe: 1.05, netPnl: -20, maxDrawdownPct: 7.0, trades: 40 },
    ]);

    assert.equal(summary.degradationRatio, 0.7); // >= 0.6, aber triple.netPnl = -20 <= 0
    assert.equal(summary.verdict, "COST_SENSITIVE");
    // Interpolation zwischen double (2×, +80) und triple (3×, -20): 2 + 80 / 100 = 2.8
    assert.equal(summary.breakevenMultiplier, 2.8);
  });

  it("vergibt COST_SENSITIVE für degradationRatio in [0.3, 0.6) und interpoliert breakevenMultiplier", () => {
    const summary = summarizeStressSweep([
      { id: "base",   sharpe: 2.0, netPnl: 400,  maxDrawdownPct: 5.0, trades: 45 },
      { id: "double", sharpe: 1.3, netPnl: 100,  maxDrawdownPct: 7.0, trades: 45 },
      { id: "triple", sharpe: 0.9, netPnl: -100, maxDrawdownPct: 9.5, trades: 45 },
    ]);

    assert.equal(summary.degradationRatio, 0.45); // 0.9 / 2.0 ∈ [0.3, 0.6)
    assert.equal(summary.verdict, "COST_SENSITIVE");
    // Nullstelle zwischen 2× (+100) und 3× (-100) liegt exakt bei 2.5×
    assert.equal(summary.breakevenMultiplier, 2.5);

    // Exakte Untergrenze 0.30
    const boundary = summarizeStressSweep([
      { id: "base",   sharpe: 2.0, netPnl: 300, maxDrawdownPct: 5.0, trades: 45 },
      { id: "double", sharpe: 1.1, netPnl: 120, maxDrawdownPct: 7.0, trades: 45 },
      { id: "triple", sharpe: 0.6, netPnl: 10,  maxDrawdownPct: 9.0, trades: 45 },
    ]);
    assert.equal(boundary.degradationRatio, 0.3);
    assert.equal(boundary.verdict, "COST_SENSITIVE");
    assert.equal(boundary.breakevenMultiplier, null);
  });

  it("vergibt COST_DEPENDENT bei degradationRatio < 0.3 oder nicht-positivem Base-Sharpe", () => {
    // Fall A: positiver Base-Sharpe, starker Einbruch unter 3× Kosten
    const collapsed = summarizeStressSweep([
      { id: "base",   sharpe: 1.6,  netPnl: 150,  maxDrawdownPct: 6.0,  trades: 60 },
      { id: "double", sharpe: -0.2, netPnl: -50,  maxDrawdownPct: 11.0, trades: 60 },
      { id: "triple", sharpe: -1.1, netPnl: -250, maxDrawdownPct: 16.0, trades: 60 },
    ]);

    assert.equal(collapsed.degradationRatio, -0.6875);
    assert.equal(collapsed.verdict, "COST_DEPENDENT");
    // Nullstelle zwischen 1× (+150) und 2× (-50): 1 + 150 / 200 = 1.75
    assert.equal(collapsed.breakevenMultiplier, 1.75);

    // Fall B: schon Base-Sharpe <= 0 ⇒ degradationRatio = null, COST_DEPENDENT
    const negativeBase = summarizeStressSweep([
      { id: "base",   sharpe: -0.4, netPnl: -40,  maxDrawdownPct: 8.0,  trades: 30 },
      { id: "double", sharpe: -0.9, netPnl: -120, maxDrawdownPct: 12.0, trades: 30 },
      { id: "triple", sharpe: -1.5, netPnl: -220, maxDrawdownPct: 16.0, trades: 30 },
    ]);

    assert.equal(negativeBase.degradationRatio, null);
    assert.equal(negativeBase.verdict, "COST_DEPENDENT");
    assert.equal(negativeBase.breakevenMultiplier, 0);
  });

  it("interpoliert breakevenMultiplier über alle Randfälle deterministisch", () => {
    // Exakt 0 bei double (2×)
    assert.equal(
      computeBreakevenMultiplier([
        { id: "base",   sharpe: 1.2, netPnl: 100, maxDrawdownPct: 4, trades: 20 },
        { id: "double", sharpe: 0.0, netPnl: 0,   maxDrawdownPct: 6, trades: 20 },
        { id: "triple", sharpe: -0.8, netPnl: -90, maxDrawdownPct: 8, trades: 20 },
      ]),
      2,
    );

    // Exakt 0 bei triple (3×)
    assert.equal(
      computeBreakevenMultiplier([
        { id: "base",   sharpe: 1.5, netPnl: 200, maxDrawdownPct: 4, trades: 20 },
        { id: "double", sharpe: 0.8, netPnl: 90,  maxDrawdownPct: 5, trades: 20 },
        { id: "triple", sharpe: 0.0, netPnl: 0,   maxDrawdownPct: 6, trades: 20 },
      ]),
      3,
    );

    // Exakt 0 bei base (1×)
    assert.equal(
      computeBreakevenMultiplier([
        { id: "base",   sharpe: 0.0, netPnl: 0,    maxDrawdownPct: 4, trades: 20 },
        { id: "double", sharpe: -0.5, netPnl: -80, maxDrawdownPct: 6, trades: 20 },
        { id: "triple", sharpe: -1.0, netPnl: -160, maxDrawdownPct: 8, trades: 20 },
      ]),
      1,
    );
  });

  it("unterstützt konfigurierbare Verdikt-Schwellen", () => {
    assert.deepEqual(DEFAULT_STRESS_VERDICT_THRESHOLDS, {
      robustMinRatio: 0.6,
      sensitiveMinRatio: 0.3,
      minTripleNetPnl: 0,
    });

    const rows: readonly StressScenarioSummaryRow[] = [
      { id: "base",   sharpe: 2.0, netPnl: 500, maxDrawdownPct: 4, trades: 40 },
      { id: "double", sharpe: 1.6, netPnl: 300, maxDrawdownPct: 5, trades: 40 },
      { id: "triple", sharpe: 1.4, netPnl: 100, maxDrawdownPct: 6, trades: 40 },
    ];
    // Mit Standard-Schwellen (0.6) ist ratio = 0.7 ⇒ COST_ROBUST;
    // mit strengerer Schwelle robustMinRatio = 0.75 ⇒ COST_SENSITIVE
    const strictSummary = summarizeStressSweep(rows, {
      thresholds: { robustMinRatio: 0.75 },
    });
    assert.equal(strictSummary.degradationRatio, 0.7);
    assert.equal(strictSummary.verdict, "COST_SENSITIVE");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Laufzeit-Bounds (`maxRuns`, Default 45, CLI `--max-runs`)
// ─────────────────────────────────────────────────────────────────────────────

describe("STX-06-03 Laufzeit-Bounds — maxRuns & CLI --max-runs", () => {
  it("erlaubt exakt 45 Läufe (3 Szenarien × 3 Fenster × 5 Kandidaten) und bricht darüber vor dem ersten Lauf ab", async () => {
    let callsAt45 = 0;
    const atLimit = await runInEngineStress({
      engineConfig: makeReferenceConfig(),
      windowCount: 3,
      candidateCount: 5,
      runner: () => {
        callsAt45 += 1;
        return makeStubRunnerOutput({ sharpeRatio: 1.5, netPnl: 200 });
      },
    });
    assert.equal(atLimit.ok, true);
    assert.equal(callsAt45, 3);

    // 3 Szenarien × 3 Fenster × 6 Kandidaten = 54 > 45 ⇒ harter Abbruch
    let callsOverLimit = 0;
    const overCandidates = await runInEngineStress({
      engineConfig: makeReferenceConfig(),
      windowCount: 3,
      candidateCount: 6,
      runner: () => {
        callsOverLimit += 1;
        return makeStubRunnerOutput({ sharpeRatio: 1.5, netPnl: 200 });
      },
    });
    assert.equal(overCandidates.ok, false);
    assert.equal(callsOverLimit, 0);
    if (!overCandidates.ok) {
      assert.match(overCandidates.errors[0], /stress:max-runs-exceeded/);
      assert.match(overCandidates.errors[0], /54/);
      assert.match(overCandidates.errors[0], /45/);
    }

    // Explizites hartes maxRuns-Argument (z. B. maxRuns = 10 bei 3 × 2 × 2 = 12)
    let callsCustomCap = 0;
    const customCap = await runInEngineStress({
      engineConfig: makeReferenceConfig(),
      windowCount: 2,
      candidateCount: 2,
      maxRuns: 10,
      runner: () => {
        callsCustomCap += 1;
        return makeStubRunnerOutput({ sharpeRatio: 1.5, netPnl: 200 });
      },
    });
    assert.equal(customCap.ok, false);
    assert.equal(callsCustomCap, 0);
    if (!customCap.ok) {
      assert.match(customCap.errors[0], /stress:max-runs-exceeded/);
      assert.match(customCap.errors[0], /12/);
      assert.match(customCap.errors[0], /10/);
    }
  });

  it("parst das CLI-Flag --max-runs deterministisch mit Default 45", () => {
    assert.deepEqual(parseMaxRunsFlag([]), { ok: true, maxRuns: 45 });
    assert.deepEqual(parseMaxRunsFlag(["--template=ema-adx-trend"]), {
      ok: true,
      maxRuns: 45,
    });
    assert.deepEqual(parseMaxRunsFlag(["--max-runs=27"]), {
      ok: true,
      maxRuns: 27,
    });
    assert.deepEqual(parseMaxRunsFlag(["--max-runs", "18"]), {
      ok: true,
      maxRuns: 18,
    });

    const zeroRes = parseMaxRunsFlag(["--max-runs=0"]);
    assert.equal(zeroRes.ok, false);

    const negRes = parseMaxRunsFlag(["--max-runs", "-5"]);
    assert.equal(negRes.ok, false);

    const nanRes = parseMaxRunsFlag(["--max-runs=abc"]);
    assert.equal(nanRes.ok, false);

    const missingValRes = parseMaxRunsFlag(["--max-runs"]);
    assert.equal(missingValRes.ok, false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Post-Hoc-Stress (`runPostHocStress`) & strikte Report-Trennung
// ─────────────────────────────────────────────────────────────────────────────

describe("STX-06-03 runPostHocStress & Report-Trennung (inEngine vs. postHoc)", () => {
  it("reicht das Trade-Log dünn an runMonteCarloSimulation mit stress: { feeMultiplier, slippageMultiplier } durch", () => {
    const trades = makeMonteCarloTrades(36);

    const postHoc = runPostHocStress({
      sourceRunId: "wf-run-001",
      trades,
      stress: { feeMultiplier: 2, slippageMultiplier: 3 },
      method: "iid",
      runs: 250,
      seed: 42,
    });

    const directMc = runMonteCarloSimulation({
      sourceRunId: "wf-run-001",
      trades,
      config: {
        method: "iid",
        runs: 250,
        seed: 42,
        stress: { feeMultiplier: 2, slippageMultiplier: 3 },
      },
    });

    assert.deepEqual(postHoc, directMc);
    assert.deepEqual(postHoc.config.stress, {
      feeMultiplier: 2,
      slippageMultiplier: 3,
    });
    assert.ok(postHoc.summary.observedStressed !== null);
    assert.ok(
      postHoc.summary.observedStressed.endEquity < postHoc.summary.observed.endEquity,
      "Gestresste beobachtete End-Equity muss unter höheren Kosten kleiner als die Baseline sein",
    );
  });

  it("akzeptiert BacktestTradeLog[] und WalkForwardTradeRecord[] und delegiert Validierung an montecarlo.ts", () => {
    const mcTrades = makeMonteCarloTrades(32);
    const wfRecords: WalkForwardTradeRecord[] = mcTrades.map((t, idx) => {
      const log: BacktestTradeLog = {
        id: `trade-${idx + 1}`,
        strategyId: t.strategyId,
        symbol: t.symbol,
        side: "LONG",
        entryTime: t.entryTs,
        exitTime: t.exitTs,
        entryPrice: 100,
        exitPrice: t.pnlNet >= 0 ? 102 : 99,
        qty: 10,
        notional: t.notional,
        pnl: t.pnlNet,
        pnlPct: (t.pnlNet / t.notional) * 100,
        fees: t.fees,
        slippage: t.slippage,
        exitReason: "TAKE_PROFIT",
        durationBars: 3,
        durationMs: t.exitTs - t.entryTs,
      };
      return {
        windowIndex: 0,
        segment: "OOS",
        trade: log,
      };
    });

    const converted = toMonteCarloTrades(wfRecords, "OOS");
    assert.equal(converted.length, 32);

    const res = runPostHocStress(wfRecords, {
      sourceRunId: "wf-run-002",
      feeMultiplier: 3,
      slippageMultiplier: 3,
      runs: 200,
      seed: 7,
    });
    assert.equal(res.summary.stats.sampleTrades, 32);
    assert.deepEqual(res.config.stress, {
      feeMultiplier: 3,
      slippageMultiplier: 3,
    });

    // 1× / 1× wird sauber auf stress: null abgebildet
    const baseMc = runPostHocStress(mcTrades, {
      feeMultiplier: 1,
      slippageMultiplier: 1,
      runs: 200,
      seed: 7,
    });
    assert.equal(baseMc.config.stress, null);
    assert.equal(baseMc.summary.observedStressed, null);

    // Ungültiger Multiplikator (< 1) wirft den Original-MonteCarloError
    assert.throws(
      () =>
        runPostHocStress(mcTrades, {
          feeMultiplier: 0.5,
          slippageMultiplier: 2,
        }),
      (err: unknown) =>
        err instanceof MonteCarloError && err.code === "mc:invalid-config",
    );
  });

  it("hält In-Engine- und Post-Hoc-Ergebnis im Report strikt getrennt", async () => {
    const trades = makeMonteCarloTrades(36);
    const sweep = await runInEngineStress({
      engineConfig: makeReferenceConfig(),
      runner: (ctx) =>
        makeStubRunnerOutput({
          sharpeRatio: Number((1.8 - (ctx.scenario.feeMultiplier - 1) * 0.2).toFixed(4)),
          netPnl: 400 - (ctx.scenario.feeMultiplier - 1) * 80,
        }),
      postHoc: {
        sourceRunId: "wf-sep-test",
        trades,
        stress: { feeMultiplier: 3, slippageMultiplier: 4 },
        runs: 200,
        seed: 99,
      },
    });

    assert.equal(sweep.ok, true);
    if (!sweep.ok) return;

    assert.ok(sweep.postHoc !== null);
    assert.equal(sweep.inEngine.verdict, "COST_ROBUST");
    assert.equal(sweep.inEngine.degradationRatio, 0.7778);
    assert.equal(sweep.inEngine.breakevenMultiplier, null);

    const report = buildStressReport({
      inEngine: sweep.inEngine,
      postHoc: sweep.postHoc,
    });

    assert.equal(report.version, COST_STRESS_VERSION);
    assert.deepEqual(Object.keys(report), ["version", "inEngine", "postHoc"]);
    assert.deepEqual(report.inEngine, sweep.summary);
    assert.deepEqual(report.postHoc, sweep.postHoc);
    // In-Engine enthält keine MC-Felder; Post-Hoc enthält kein StressVerdict
    assert.equal("resampled" in report.inEngine, false);
    assert.equal("verdict" in (report.postHoc ?? {}), false);
  });

  it("buildScenarioEngineConfig verändert das Basisszenario nicht und skaliert Stress-Szenarien deterministisch", () => {
    const ref = makeReferenceConfig({
      executionModel: "paper",
      slippageModel: "fixed",
      fixedSlippageBps: 5,
      feeModel: { makerFee: 0.0002, takerFee: 0.0006 },
    });

    const baseCfg = buildScenarioEngineConfig(ref, COST_STRESS_SCENARIOS[0]);
    const doubleCfg = buildScenarioEngineConfig(ref, COST_STRESS_SCENARIOS[1]);
    const tripleCfg = buildScenarioEngineConfig(ref, COST_STRESS_SCENARIOS[2]);

    assert.deepEqual(baseCfg, ref);
    assert.notEqual(baseCfg, ref); // eigener Klon, keine Referenz-Aliasing-Mutation
    assert.notEqual(baseCfg.feeModel, ref.feeModel);

    assert.equal(doubleCfg.fixedSlippageBps, 10);
    assert.deepEqual(doubleCfg.feeModel, { makerFee: 0.0004, takerFee: 0.0012 });

    assert.equal(tripleCfg.fixedSlippageBps, 20);
    assert.deepEqual(tripleCfg.feeModel, { makerFee: 0.0006, takerFee: 0.0018 });
  });
});
