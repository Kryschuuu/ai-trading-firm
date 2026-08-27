/**
 * Unit-Tests für die Schritte der Tagespipeline (Task 06).
 *
 * Prüft Input-Validierung, Schema-Prüfung und Verwerfen nichtkonformer Outputs je Step.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { SimulatedClock } from "../src/cycle/clock";
import { createTestPorts } from "../src/cycle/ports";
import { scannerStep } from "../src/cycle/steps/scannerStep";
import { macroStep, MACRO_REQUIRED_ASSETS } from "../src/cycle/steps/macroStep";
import { selectionStep } from "../src/cycle/steps/selectionStep";
import { technicalStep } from "../src/cycle/steps/technicalStep";
import { newsStep } from "../src/cycle/steps/newsStep";
import { riskStep } from "../src/cycle/steps/riskStep";
import { researchStep } from "../src/cycle/steps/researchStep";
import { backtestStep } from "../src/cycle/steps/backtestStep";
import type { StepExecutionContext } from "../src/cycle/types";

function mockContext<T>(input: T, ports = createTestPorts(), previousOutputs = {}): StepExecutionContext<T> {
  const clock = new SimulatedClock();
  return {
    cycleId: "test-cycle",
    date: "2026-08-27",
    asOf: clock.now(),
    clock,
    input,
    previousStepOutputs: previousOutputs,
    ports,
    emitEscalation: () => {},
    log: () => {},
  };
}

test("Step 1 (Market Scanner): führt deterministischen Scan ohne LLM aus", async () => {
  const ports = createTestPorts();
  const ctx = mockContext({}, ports);
  const result = await scannerStep.execute(ctx);

  assert.equal(scannerStep.llmAllowed, false);
  assert.equal(result.schemaVersion, 1);
  assert.ok(result.funnel.scanned > 0);
  assert.ok(Array.isArray(result.levels.daily));
});

test("Step 2 (Macro Analyst): deckt alle 7 geforderten Assets ab und validiert Schema", async () => {
  const ports = createTestPorts();
  ports.agent.setResponseForRole("MACRO_ANALYST", {
    view: "BULLISH",
    regime: "RISK_ON",
    volatilityRegime: "NORMAL",
    assets: {
      btc: { price: 65000, trend: "UP" },
      eth: { price: 3500, trend: "UP" },
      dxy: { price: 101, trend: "DOWN" },
      spx: { price: 5500, trend: "UP" },
      nasdaq: { price: 19500, trend: "UP" },
      gold: { price: 2500, trend: "UP" },
      bonds: { price: 98, trend: "SIDEWAYS" },
    },
    thesis: "Risk-On-Umfeld über alle Assetklassen",
    confidence: 0.85,
  });

  const ctx = mockContext({}, ports);
  const result = await macroStep.execute(ctx);

  assert.equal(result.view, "BULLISH");
  assert.equal(result.regime, "RISK_ON");
  assert.equal(result.volatilityRegime, "NORMAL");
  assert.equal(result.confidence, 0.85);

  for (const asset of MACRO_REQUIRED_ASSETS) {
    assert.ok(result.assets[asset.toLowerCase()], `Asset ${asset} nicht im Makro-Output`);
  }
});

test("Step 2 (Macro Analyst): ungültige Antwort führt zu sicherem Fallback", async () => {
  const ports = createTestPorts();
  // Völlig unstrukturiertes / kaputtes Modell-Ergebnis
  ports.agent.setResponseForRole("MACRO_ANALYST", "Ich bin ein kaputtes LLM ohne JSON");

  const ctx = mockContext({}, ports);
  const result = await macroStep.execute(ctx);

  assert.equal(result.view, "NEUTRAL");
  assert.equal(result.regime, "MIXED");
  assert.equal(result.volatilityRegime, "NORMAL");
  assert.ok(result.thesis.includes("Deterministischer Fallback"));
});

test("Step 3 (Market Selection): erzeugt Daily Candidate List und deckelt auf max 40", async () => {
  const ports = createTestPorts();
  const mockScannerArtifact = await ports.scanner.runScan(new Date());

  ports.agent.setResponseForRole("MARKET_SELECTION", {
    candidates: [
      { instrumentId: "BINANCE:BTCUSDT", rank: 1, score: 90, assetClass: "crypto", selectionRationale: "Top Liquidity" },
      { instrumentId: "BINANCE:ETHUSDT", rank: 2, score: 85, assetClass: "crypto", selectionRationale: "Strong Trend" },
    ],
    selectedCount: 2,
    asOf: "2026-08-27T07:00:00.000Z",
  });

  const ctx = mockContext({}, ports, { "01-market-scanner": mockScannerArtifact });
  const result = await selectionStep.execute(ctx);

  assert.equal(result.candidates.length, 2);
  assert.equal(result.candidates[0].instrumentId, "BINANCE:BTCUSDT");
  assert.ok(result.candidates.length <= 40);
});

test("Step 4 (Technical Analyst): analysiert Kandidaten und validiert Output-Schema", async () => {
  const ports = createTestPorts();
  ports.agent.setResponseForRole("TECHNICAL_ANALYST", {
    analyses: [
      {
        instrumentId: "BINANCE:BTCUSDT",
        bias: "BULLISH",
        technicalScore: 82,
        rsi: 62.5,
        atr: 1200,
        trend: "uptrend",
        keyLevels: { support: 62000, resistance: 68000 },
        thesis: "Bullischer Ausbruch aus Konsolidierung",
      },
    ],
    analyzedCount: 1,
  });

  const selection = {
    candidates: [{ instrumentId: "BINANCE:BTCUSDT", rank: 1, score: 90, assetClass: "crypto", selectionRationale: "Top" }],
    selectedCount: 1,
    asOf: "2026-08-27T07:00:00.000Z",
  };

  const ctx = mockContext({}, ports, { "03-market-selection": selection });
  const result = await technicalStep.execute(ctx);

  assert.equal(result.analyzedCount, 1);
  assert.equal(result.analyses[0].instrumentId, "BINANCE:BTCUSDT");
  assert.equal(result.analyses[0].bias, "BULLISH");
  assert.equal(result.analyses[0].technicalScore, 82);
});

test("Step 5 (News Analyst): analysiert Top-40 und trennt externe Daten strikt", async () => {
  const ports = createTestPorts();
  ports.agent.setResponseForRole("NEWS_ANALYST", {
    analyses: [
      {
        instrumentId: "BINANCE:BTCUSDT",
        sentiment: "BULLISH",
        impactScore: 75,
        riskFlags: [],
        summary: "Positive ETF Zuflüsse",
      },
    ],
    systemicRisk: {
      level: "LOW",
      headline: "Keine systemischen Risiken",
      affectedSectors: [],
    },
  });

  const ctx = mockContext(
    {
      symbols: ["BINANCE:BTCUSDT"],
      externalNews: [{ headline: "Positive Inflows reported", source: "CoinDesk" }],
    },
    ports
  );

  const result = await newsStep.execute(ctx);
  assert.equal(result.analyses.length, 1);
  assert.equal(result.analyses[0].sentiment, "BULLISH");
  assert.equal(result.systemicRisk.level, "LOW");
});

test("Step 6 (Risk Manager): berechnet Korrelationen und filtert Klumpenrisiken", async () => {
  const ports = createTestPorts();
  ports.agent.setResponseForRole("RISK_MANAGER", {
    approvedCandidates: ["BINANCE:BTCUSDT"],
    rejectedCandidates: [{ instrumentId: "BINANCE:ETHUSDT", reason: "Hohe Korrelation zu BTC" }],
    correlationWarnings: ["Korrelation ≥ 0.75"],
    maxPositionPct: 0.1,
    riskBudgetPerTrade: 0.01,
    rationale: "Freigabe nur für BTC",
  });

  const ctx = mockContext(
    { symbols: ["BINANCE:BTCUSDT", "BINANCE:ETHUSDT"] },
    ports
  );

  const result = await riskStep.execute(ctx);
  assert.deepEqual(result.approvedCandidates, ["BINANCE:BTCUSDT"]);
  assert.equal(result.rejectedCandidates.length, 1);
  assert.ok(result.maxPositionPct <= 0.25);
  assert.ok(result.riskBudgetPerTrade <= 0.02);
});

test("Step 7 (Research): erzeugt Setups mit expliziter Proposal-Markierung (keine Orders)", async () => {
  const ports = createTestPorts();
  ports.agent.setResponseForRole("RESEARCH", {
    setups: [
      {
        instrumentId: "BINANCE:BTCUSDT",
        side: "LONG",
        entryPrice: 65000,
        stopLoss: 63000,
        takeProfit: 71000,
        riskScore: 0.4,
        timeframe: "4h",
        thesis: "Long Setup am Support",
        isProposal: true,
      },
    ],
    totalSetups: 1,
    disclaimer: "PROPOSAL_ONLY_NO_ORDERS_PLACED",
  });

  const ctx = mockContext({ approvedCandidates: ["BINANCE:BTCUSDT"] }, ports);
  const result = await researchStep.execute(ctx);

  assert.equal(result.totalSetups, 1);
  assert.equal(result.disclaimer, "PROPOSAL_ONLY_NO_ORDERS_PLACED");
  assert.equal(result.setups[0].isProposal, true);
  assert.ok(result.setups[0].stopLoss < result.setups[0].entryPrice);
});

test("Step 8 (Backtest-Verifikation): prüft Setups deterministisch (MaxDD, Sharpe, Sortino, Robustness)", async () => {
  const ports = createTestPorts();
  const setups = [
    {
      instrumentId: "BINANCE:BTCUSDT",
      side: "LONG" as const,
      entryPrice: 65000,
      stopLoss: 63000,
      takeProfit: 71000,
      riskScore: 0.4,
      timeframe: "4h",
      thesis: "Long Setup",
      isProposal: true as const,
    },
  ];

  const ctx = mockContext({ setups }, ports);
  const result = await backtestStep.execute(ctx);

  assert.equal(backtestStep.llmAllowed, false);
  assert.equal(result.summary.total, 1);
  assert.ok(["PASSED", "FAILED"].includes(result.verifiedSetups[0].verdict));

  const metrics = result.verifiedSetups[0].metrics;
  assert.ok(typeof metrics.maxDrawdownPct === "number");
  assert.ok(typeof metrics.profitFactor === "number");
  assert.ok(typeof metrics.sharpeRatio === "number");
  assert.ok(typeof metrics.sortinoRatio === "number");
  assert.ok(typeof metrics.regimeRobustness === "number");
});
