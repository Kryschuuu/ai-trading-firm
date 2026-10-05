/** Risk Manager boundary, point-in-time Risk-Parity, and fail-closed allocation tests. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SimulatedClock } from "../src/cycle/clock";
import { createTestPorts } from "../src/cycle/ports";
import { riskStep, type RiskStepInput } from "../src/cycle/steps/riskStep";
import type { StepExecutionContext } from "../src/cycle/types";

const AS_OF = new Date("2026-10-05T12:00:00.000Z");

function context(
  input: RiskStepInput,
  ports = createTestPorts(),
  previousStepOutputs: Record<string, unknown> = {},
): StepExecutionContext<RiskStepInput> {
  const clock = new SimulatedClock(AS_OF);
  return {
    cycleId: "risk-step-test",
    date: "2026-10-05",
    asOf: AS_OF,
    clock,
    input,
    previousStepOutputs,
    ports,
    emitEscalation: () => undefined,
    log: () => undefined,
  };
}

function response(approvedCandidates: string[], rejectedCandidates: Array<{ instrumentId: string; reason: string }> = []) {
  return {
    approvedCandidates,
    rejectedCandidates,
    correlationWarnings: [],
    maxPositionPct: 0.1,
    riskBudgetPerTrade: 0.01,
    rationale: "Testentscheidung",
  };
}

test("LLM kann deterministisch abgelehnte oder unbekannte Kandidaten nicht wieder freigeben", async () => {
  const ports = createTestPorts();
  ports.agent.setResponseForRole("RISK_MANAGER", {
    ...response([
      "BINANCE:BTCUSDT",
      "BINANCE:DANGERUSDT",
      "BINANCE:EXTREMEUSDT",
      "BINANCE:UNKNOWNUSDT",
    ]),
    // The allocation is server-owned, never trusted from model JSON.
    portfolioAllocation: {
      method: "RISK_PARITY",
      weights: [{ instrumentId: "BINANCE:UNKNOWNUSDT", weight: 100 }],
    },
  });
  ports.analytics.computeCorrelationAndRisk = async (symbols) => ({
    correlations: Object.fromEntries(symbols.map((symbol) => [symbol, {}])),
    clusters: [],
    regimes: {
      "BINANCE:BTCUSDT": "NORMAL",
      "BINANCE:DANGERUSDT": "NORMAL",
      "BINANCE:EXTREMEUSDT": "EXTREME",
    },
    exposureWarnings: [],
  });

  const result = await riskStep.execute(context(
    { symbols: ["BINANCE:BTCUSDT", "BINANCE:DANGERUSDT", "BINANCE:EXTREMEUSDT"] },
    ports,
    {
      "05-news-analyst": {
        analyses: [
          { instrumentId: "BINANCE:DANGERUSDT", impactScore: 10, riskFlags: ["HALT"] },
        ],
      },
    },
  ));

  assert.deepEqual(result.approvedCandidates, ["BINANCE:BTCUSDT"]);
  assert.equal(result.rejectedCandidates.length, 2);
  assert.match(result.rejectedCandidates.find((item) => item.instrumentId === "BINANCE:DANGERUSDT")?.reason ?? "", /Kritisches News/);
  assert.match(result.rejectedCandidates.find((item) => item.instrumentId === "BINANCE:EXTREMEUSDT")?.reason ?? "", /Extremes Volatilitätsregime/);
  assert.equal(result.portfolioAllocation?.method, "EQUAL_WEIGHT_FALLBACK");
  assert.equal(result.portfolioAllocation?.weights[0]?.weight, 1);
});

test("RiskStep nutzt den guarded Risk-Parity-Optimizer für aligned Preise bis asOf", async () => {
  const ports = createTestPorts();
  ports.agent.setResponseForRole("RISK_MANAGER", response(["BINANCE:BTCUSDT", "BINANCE:ETHUSDT"]));
  const timestamps = Array.from({ length: 13 }, (_, index) => AS_OF.getTime() - (11 - index) * 3_600_000);
  const prices = {
    "BINANCE:BTCUSDT": [100, 102, 101, 104, 103, 106, 105, 108, 107, 110, 108, 112, 10_000],
    "BINANCE:ETHUSDT": [50, 49, 51, 50, 53, 52, 54, 53, 56, 55, 57, 59, 5_000],
  };
  ports.analytics.computeCorrelationAndRisk = async (symbols) => ({
    correlations: Object.fromEntries(symbols.map((symbol) => [symbol, {}])),
    clusters: [],
    regimes: Object.fromEntries(symbols.map((symbol) => [symbol, "NORMAL"])),
    exposureWarnings: [],
    portfolioSeriesBySymbol: Object.fromEntries(
      symbols.map((symbol) => [symbol, { timestamps, prices: prices[symbol as keyof typeof prices] }]),
    ),
  });

  const result = await riskStep.execute(context({ symbols: ["BINANCE:BTCUSDT", "BINANCE:ETHUSDT"] }, ports));
  const allocation = result.portfolioAllocation;
  assert.equal(allocation?.method, "RISK_PARITY");
  assert.equal(allocation?.weights.length, 2);
  const total = allocation?.weights.reduce((sum, item) => sum + item.weight, 0) ?? 0;
  assert.ok(Math.abs(total - 1) < 1e-6);
  assert.ok(allocation?.weights.every((item) => item.weight >= 0 && Number.isFinite(item.weight)));
});

test("fehlende oder nicht gemeinsam ausrichtbare Historie ist sichtbar als Equal-Weight-Fallback", async () => {
  const ports = createTestPorts();
  ports.agent.setResponseForRole("RISK_MANAGER", response(["BINANCE:BTCUSDT", "BINANCE:ETHUSDT"]));
  const base = AS_OF.getTime() - 10 * 3_600_000;
  const timestampsA = Array.from({ length: 5 }, (_, i) => base + i * 3_600_000);
  const timestampsB = Array.from({ length: 5 }, (_, i) => base + (i + 10) * 3_600_000);
  ports.analytics.computeCorrelationAndRisk = async () => ({
    correlations: {},
    clusters: [],
    regimes: { "BINANCE:BTCUSDT": "NORMAL", "BINANCE:ETHUSDT": "NORMAL" },
    exposureWarnings: [],
    portfolioSeriesBySymbol: {
      "BINANCE:BTCUSDT": { timestamps: timestampsA, prices: [100, 101, 102, 103, 104] },
      "BINANCE:ETHUSDT": { timestamps: timestampsB, prices: [50, 51, 52, 53, 54] },
    },
  });

  const result = await riskStep.execute(context({ symbols: ["BINANCE:BTCUSDT", "BINANCE:ETHUSDT"] }, ports));
  assert.equal(result.portfolioAllocation?.method, "EQUAL_WEIGHT_FALLBACK");
  assert.match(result.portfolioAllocation?.reason ?? "", /ALIGNED_POINT_IN_TIME_HISTORY/);
  assert.deepEqual(result.portfolioAllocation?.weights.map((item) => item.weight), [0.5, 0.5]);
});

test("gleichzeitige Modellfreigabe und -ablehnung wird konservativ als Ablehnung behandelt", async () => {
  const ports = createTestPorts();
  ports.agent.setResponseForRole("RISK_MANAGER", response(
    ["BINANCE:BTCUSDT"],
    [{ instrumentId: "BINANCE:BTCUSDT", reason: "Modell erkennt Klumpenrisiko" }],
  ));
  const result = await riskStep.execute(context({ symbols: ["BINANCE:BTCUSDT"] }, ports));
  assert.deepEqual(result.approvedCandidates, []);
  assert.equal(result.rejectedCandidates[0]?.reason, "Modell erkennt Klumpenrisiko");
  assert.equal(result.portfolioAllocation?.method, "NONE");
  assert.deepEqual(result.portfolioAllocation?.weights, []);
});
