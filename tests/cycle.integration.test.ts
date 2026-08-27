/**
 * Integrationstest: Vollzyklus im Zeitraffer (Task 06).
 *
 * Simuliert einen kompletten Tag und eine Woche in wenigen Sekunden:
 *   - 00:00–06:00 Market Scanner
 *   - 06:00 Macro Analyst
 *   - 07:00 Market Selection
 *   - 08:00 Technical Analyst (NUR Top-40)
 *   - 09:00 News Analyst (NUR Top-40 + systemische News)
 *   - 10:00 Risk Manager
 *   - danach Research
 *   - danach Backtest-Verifikation
 *   - Sonntag: Weekly Universe Review
 *   - Artefakte, Index & API-Zugriff
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SimulatedClock } from "../src/cycle/clock";
import { createTestPorts } from "../src/cycle/ports";
import { CycleScheduler } from "../src/cycle/scheduler";
import { createDailySteps } from "../src/cycle/daily";
import { createWeeklySteps } from "../src/cycle/weekly";
import { saveDailyCycleArtifacts, saveWeeklyCycleArtifacts, getArtifactIndex } from "../src/cycle/artifacts";
import { GET as getDailyLatest } from "../src/app/api/analysis/daily/latest/route";
import { GET as getWeeklyLatest } from "../src/app/api/analysis/weekly/latest/route";
import { GET as getRuns } from "../src/app/api/analysis/runs/route";
import { resetCycleServiceForTests, CycleService } from "../src/cycle/service";

test("Integration: Vollzyklus im Zeitraffer (24h in Sekunden) inkl. Artefakte & API", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "cycle-integration-"));
  const prevEnv = process.env.CYCLE_ARTIFACTS_DIR;
  process.env.CYCLE_ARTIFACTS_DIR = tmpDir;

  const clock = new SimulatedClock("2026-08-27T00:00:00.000Z"); // Start um Mitternacht
  const testPorts = createTestPorts();

  // Antworten für die Agenten vorkonfigurieren
  testPorts.agent.setResponseForRole("MACRO_ANALYST", {
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
    thesis: "Starkes Risk-On Umfeld",
    confidence: 0.85,
  });

  testPorts.agent.setResponseForRole("MARKET_SELECTION", {
    candidates: [
      { instrumentId: "BINANCE:BTCUSDT", rank: 1, score: 92, assetClass: "crypto", selectionRationale: "Top Asset" },
      { instrumentId: "BINANCE:ETHUSDT", rank: 2, score: 87, assetClass: "crypto", selectionRationale: "Second Asset" },
    ],
    selectedCount: 2,
    asOf: clock.toISOString(),
  });

  testPorts.agent.setResponseForRole("TECHNICAL_ANALYST", {
    analyses: [
      {
        instrumentId: "BINANCE:BTCUSDT",
        bias: "BULLISH",
        technicalScore: 88,
        trend: "uptrend",
        keyLevels: { support: 63000, resistance: 69000 },
        thesis: "Bullischer Trendkanal",
      },
      {
        instrumentId: "BINANCE:ETHUSDT",
        bias: "BULLISH",
        technicalScore: 82,
        trend: "uptrend",
        keyLevels: { support: 3400, resistance: 3700 },
        thesis: "Unterstützung hält",
      },
    ],
    analyzedCount: 2,
  });

  testPorts.agent.setResponseForRole("NEWS_ANALYST", {
    analyses: [
      { instrumentId: "BINANCE:BTCUSDT", sentiment: "BULLISH", impactScore: 80, riskFlags: [], summary: "ETF Inflows" },
      { instrumentId: "BINANCE:ETHUSDT", sentiment: "NEUTRAL", impactScore: 50, riskFlags: [], summary: "Ruhig" },
    ],
    systemicRisk: { level: "LOW", headline: "Keine systemischen Risiken", affectedSectors: [] },
  });

  testPorts.agent.setResponseForRole("RISK_MANAGER", {
    approvedCandidates: ["BINANCE:BTCUSDT", "BINANCE:ETHUSDT"],
    rejectedCandidates: [],
    correlationWarnings: [],
    maxPositionPct: 0.1,
    riskBudgetPerTrade: 0.01,
    rationale: "Diversifiziert, Risiko im Rahmen",
  });

  testPorts.agent.setResponseForRole("RESEARCH", {
    setups: [
      {
        instrumentId: "BINANCE:BTCUSDT",
        side: "LONG",
        entryPrice: 65000,
        stopLoss: 63000,
        takeProfit: 71000,
        riskScore: 0.4,
        timeframe: "4h",
        thesis: "Long Ausbruch",
        isProposal: true,
      },
    ],
    totalSetups: 1,
    disclaimer: "PROPOSAL_ONLY_NO_ORDERS_PLACED",
  });

  testPorts.agent.setResponseForRole("WEEKLY_REVIEW", {
    executiveSummary: "Erfolgreiche Handelswoche, CORE stabil.",
    macroRegime: "NORMAL",
    weeklyThemes: ["Liquidität stabil", "Keine Delistings"],
  });

  try {
    const scheduler = new CycleScheduler({
      clock,
      ports: testPorts,
      dailyStepsFactory: createDailySteps,
      weeklyStepsFactory: createWeeklySteps,
    });

    // 1. TAGESLAUF IM ZEITRAFFER
    const dailyRecord = await scheduler.runDaily();
    assert.equal(dailyRecord.status, "COMPLETED");
    assert.equal(dailyRecord.steps.length, 8);

    // Alle 8 Schritte müssen COMPLETED sein
    const expectedSteps = [
      "01-market-scanner",
      "02-macro-analyst",
      "03-market-selection",
      "04-technical-analyst",
      "05-news-analyst",
      "06-risk-manager",
      "07-research",
      "08-backtest-verification",
    ];
    for (let i = 0; i < expectedSteps.length; i++) {
      assert.equal(dailyRecord.steps[i].stepId, expectedSteps[i]);
      assert.equal(dailyRecord.steps[i].status, "COMPLETED");
    }

    // Artefakte abspeichern
    const stepOutputs: Record<string, unknown> = {
      "01-market-scanner": { scanned: 100 },
      "02-macro-analyst": { regime: "RISK_ON" },
      "03-market-selection": { selectedCount: 2 },
      "04-technical-analyst": { analyzedCount: 2 },
      "05-news-analyst": { analyses: [] },
      "06-risk-manager": { approvedCandidates: ["BINANCE:BTCUSDT"] },
      "07-research": { totalSetups: 1 },
      "08-backtest-verification": { summary: { total: 1, passed: 1, failed: 0 } },
    };
    saveDailyCycleArtifacts(dailyRecord, stepOutputs, tmpDir);

    // Dateistruktur prüfen: artifacts/2026-08-27/daily/*.json
    const dailyDir = path.join(tmpDir, "2026-08-27", "daily");
    assert.ok(existsSync(dailyDir));
    assert.ok(existsSync(path.join(dailyDir, "01-market-scanner.json")));
    assert.ok(existsSync(path.join(dailyDir, "02-macro-analyst.json")));
    assert.ok(existsSync(path.join(dailyDir, "03-market-selection.json")));
    assert.ok(existsSync(path.join(dailyDir, "04-technical-analyst.json")));
    assert.ok(existsSync(path.join(dailyDir, "05-news-analyst.json")));
    assert.ok(existsSync(path.join(dailyDir, "06-risk-manager.json")));
    assert.ok(existsSync(path.join(dailyDir, "07-research.json")));
    assert.ok(existsSync(path.join(dailyDir, "08-backtest-verification.json")));
    assert.ok(existsSync(path.join(dailyDir, "daily-summary.json")));

    // 2. ZEITRAFFER: WECHSEL ZU SONNTAG FÜR WEEKLY REVIEW
    clock.setTime("2026-08-30T00:00:00.000Z");
    const weeklyRecord = await scheduler.runWeekly();
    assert.equal(weeklyRecord.status, "COMPLETED");
    assert.equal(weeklyRecord.steps.length, 1);
    assert.equal(weeklyRecord.steps[0].stepId, "01-weekly-review");

    // Weekly Artefakte abspeichern
    const sampleWeeklyReview = {
      schemaVersion: 1,
      configVersion: 1,
      asOf: clock.toISOString(),
      entries: [{ instrumentId: "BINANCE:BTCUSDT", class: "CORE" as const, reasons: ["pers-1"], score: 88, asOf: clock.toISOString() }],
      summary: { CORE: 1, ROTATION: 0, DISCOVERY: 0, EXCLUDED: 0 },
      changes: { newListings: [], delistings: [], liquidityDrops: [], feeIncreases: [], brokerUnavailable: [], regimeShifts: [], correlationClusters: [] },
      context: { regimeByInstrument: {}, volume24hByInstrument: {}, takerFeeByInstrument: {}, paperAvailableByInstrument: {}, persistence: {} },
    };
    saveWeeklyCycleArtifacts(weeklyRecord, { review: sampleWeeklyReview }, tmpDir);

    const weeklyDir = path.join(tmpDir, "2026-W35", "weekly");
    assert.ok(existsSync(weeklyDir));
    assert.ok(existsSync(path.join(weeklyDir, "weekly-review.json")));
    assert.ok(existsSync(path.join(weeklyDir, "universe-classification.json")));

    // 3. INDEX PRÜFEN
    const index = getArtifactIndex(tmpDir);
    assert.equal(index.dailyRuns.length, 1);
    assert.equal(index.weeklyRuns.length, 1);

    // 4. API-TESTS AUF ERZEUGTE ARTEFAKTE
    const service = new CycleService({ ports: testPorts, clock });
    resetCycleServiceForTests(service);

    const dailyLatestRes = await getDailyLatest();
    assert.equal(dailyLatestRes.status, 200);
    const dailyLatestData = await dailyLatestRes.json();
    assert.equal(dailyLatestData.ok, true);
    assert.equal(dailyLatestData.cycleId, dailyRecord.id);

    const weeklyLatestRes = await getWeeklyLatest();
    assert.equal(weeklyLatestRes.status, 200);
    const weeklyLatestData = await weeklyLatestRes.json();
    assert.equal(weeklyLatestData.ok, true);
    assert.equal(weeklyLatestData.review.summary.CORE, 1);

    const runsRes = await getRuns(new Request("http://localhost/api/analysis/runs"));
    assert.equal(runsRes.status, 200);
    const runsData = await runsRes.json();
    assert.equal(runsData.total, 2); // 1 Daily + 1 Weekly
  } finally {
    process.env.CYCLE_ARTIFACTS_DIR = prevEnv;
    resetCycleServiceForTests();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
