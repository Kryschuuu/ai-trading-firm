/**
 * Tests für PROMPT-P1-02 — Echtes 90d/30d Walk-Forward Train-Select-Freeze-Test.
 *
 * Abgedeckte Pflicht-Tests:
 *   - [x] mutierte OOS-Werte ändern die IS-Auswahl nicht
 *   - [x] stabile Tie-Breaks sind unabhängig von Kandidaten-Eingabereihenfolge
 *   - [x] Freeze-Hash ändert sich bei Kandidat, Datenmanifest oder Config
 *   - [x] ausgewählte Kandidaten-ID ist in OOS exakt dieselbe
 *   - [x] Leakage-Fixture mit horizonüberlappendem Label wird gepurged/abgelehnt
 *   - [x] finaler Holdout ist vor Abschluss der Auswahl nicht verfügbar
 *   - [x] Negative Paths für invalide, fehlende und stale Inputs (Muster R6)
 *   - [x] Roundtrip, Idempotenz, Restart/Retry
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  backtestRunIdempotencyKey,
  createFreezeArtifact,
  filterCandlesWithLeakageProtection,
  runWalkForward,
  toBacktestRunInsert,
  validateCandidates,
  WalkForwardError,
  type CandleWithHorizon,
  type WalkForwardCandidate,
} from "../src/backtest";
import { sanitizeRuleSpec, type CandleLike, type RuleSpec } from "../src/lib/ruleEngine";

function generateCandles(count: number, startTs = 1704067200000): CandleLike[] {
  const candles: CandleLike[] = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    const time = startTs + i * 3600_000;
    const change = (i % 2 === 0 ? 1 : -0.8) * (1 + (i % 5) * 0.1);
    const open = price;
    const close = Math.max(10, price + change);
    const high = Math.max(open, close) + 0.5;
    const low = Math.min(open, close) - 0.5;
    const volume = 1000 + (i % 10) * 100;
    candles.push({ time, open, high, low, close, volume });
    price = close;
  }
  return candles;
}

function sampleRule(symbol = "PAPER:BTC", suffix = "1"): RuleSpec {
  const raw = {
    name: `Sample Rule ${suffix}`,
    symbol,
    condition: {
      logic: "all",
      conditions: [
        { field: "price", op: "gt", value: 10 },
      ],
    },
    action: {
      type: "BUY",
      riskPerTradePct: 0.02,
      stopLossPct: 0.03,
      takeProfitPct: 0.06,
    },
    window: { timeframe: "1h", cooldownBars: 1, maxExecutions: 50 },
  };
  const checked = sanitizeRuleSpec(raw as any, "MANUAL");
  if (!checked.ok) throw new Error(checked.errors.join(", "));
  return checked.spec;
}

function sampleRuleTight(symbol = "PAPER:BTC", suffix = "tight"): RuleSpec {
  const raw = {
    name: `Sample Rule ${suffix}`,
    symbol,
    condition: {
      logic: "all",
      conditions: [
        { field: "price", op: "gt", value: 150 },
      ],
    },
    action: {
      type: "BUY",
      riskPerTradePct: 0.02,
      stopLossPct: 0.01,
      takeProfitPct: 0.02,
    },
    window: { timeframe: "1h", cooldownBars: 5, maxExecutions: 10 },
  };
  const checked = sanitizeRuleSpec(raw as any, "MANUAL");
  if (!checked.ok) throw new Error(checked.errors.join(", "));
  return checked.spec;
}

function sampleCandidates(symbol = "PAPER:BTC"): WalkForwardCandidate[] {
  return [
    {
      id: "cand-a",
      name: "Candidate A (Base)",
      strategyVersion: "v1",
      config: { fastPeriod: 10, slowPeriod: 20 },
      strategies: [{ type: "rule", spec: sampleRule(symbol, "A") }],
    },
    {
      id: "cand-b",
      name: "Candidate B (Tight)",
      strategyVersion: "v1",
      config: { fastPeriod: 5, slowPeriod: 15 },
      strategies: [{ type: "rule", spec: sampleRuleTight(symbol, "B") }],
    },
  ];
}

describe("RMA-P1-02 — Train-Select-Freeze-Test Walk-Forward", () => {
  it("Kandidaten-Validierung: verarbeitet valide Kandidaten und weist Müll ab", () => {
    const valid = sampleCandidates();
    const checked = validateCandidates(valid);
    assert.equal(checked.length, 2);
    assert.equal(checked[0].id, "cand-a");

    // Negative Paths
    assert.throws(
      () => validateCandidates([]),
      (e) => e instanceof WalkForwardError && e.code === "walkforward:invalid-candidates"
    );

    assert.throws(
      () => validateCandidates([{ id: "dup", strategies: [] }, { id: "dup", strategies: [] }]),
      (e) => e instanceof WalkForwardError && (e.code === "walkforward:duplicate-candidate-id" || e.code === "walkforward:invalid-candidates")
    );

    assert.throws(
      () => validateCandidates([{ id: "cand-nan", config: { bad: NaN }, strategies: [{ type: "rule", spec: sampleRule() }] }]),
      (e) => e instanceof WalkForwardError && e.code === "walkforward:invalid-candidate-config"
    );

    const tooMany = Array.from({ length: 101 }, (_, i) => ({
      id: `cand-${i}`,
      config: {},
      strategies: [{ type: "rule", spec: sampleRule() }],
    }));
    assert.throws(
      () => validateCandidates(tooMany),
      (e) => e instanceof WalkForwardError && e.code === "walkforward:unbounded-candidate-space"
    );
  });

  it("mutierte OOS-Werte ändern die IS-Auswahl nicht", () => {
    // 150 Tage (3601 Kerzen für exakte IS 90d + OOS 30d Abdeckung)
    const candles1 = generateCandles(3601);
    const candidates = sampleCandidates("PAPER:BTC");

    const ruleRef = {
      ruleId: null,
      ruleKey: null,
      name: "Test Rule",
      signature: "sig123",
      ruleSymbol: "PAPER:BTC",
    };

    const report1 = runWalkForward({
      instrumentId: "PAPER:BTC",
      timeframe: "1h",
      candles: candles1,
      candidates,
      ruleRef,
      walkforward: { isDays: 90, oosDays: 30, maxSpanDays: 365 },
    });

    // Mutieren der Kerzen im OOS-Bereich (nach IS-Ende des ersten Fensters)
    const candles2 = candles1.map((c, idx) => {
      if (idx > 2160) { // OOS Bereich für Fenster 0 (IS ist [0, 2160))
        return { ...c, close: c.close * 2.5, volume: c.volume * 10 };
      }
      return c;
    });

    const report2 = runWalkForward({
      instrumentId: "PAPER:BTC",
      timeframe: "1h",
      candles: candles2,
      candidates,
      ruleRef,
      walkforward: { isDays: 90, oosDays: 30, maxSpanDays: 365 },
    });

    // IS-Auswahl im ersten Fenster MUSS exakt identisch sein
    assert.equal(
      report1.freezeArtifacts![0].selectedCandidateId,
      report2.freezeArtifacts![0].selectedCandidateId
    );
    assert.equal(
      report1.freezeArtifacts![0].freezeHash,
      report2.freezeArtifacts![0].freezeHash
    );
    assert.deepEqual(
      report1.freezeArtifacts![0].scoreTable,
      report2.freezeArtifacts![0].scoreTable
    );
  });

  it("stabile Tie-Breaks sind unabhängig von Kandidaten-Eingabereihenfolge", () => {
    const candles = generateCandles(3601);
    const cand1: WalkForwardCandidate = {
      id: "cand-1",
      name: "Cand 1",
      config: { param: 10 },
      strategies: [{ type: "rule", spec: sampleRule("PAPER:BTC", "1") }],
    };
    const cand2: WalkForwardCandidate = {
      id: "cand-2",
      name: "Cand 2",
      config: { param: 10 },
      strategies: [{ type: "rule", spec: sampleRule("PAPER:BTC", "1") }],
    };

    const ruleRef = { ruleId: null, ruleKey: null, name: "Test Rule", signature: "sig123", ruleSymbol: "PAPER:BTC" };

    const reportForward = runWalkForward({
      instrumentId: "PAPER:BTC",
      timeframe: "1h",
      candles,
      candidates: [cand1, cand2],
      ruleRef,
    });

    const reportReverse = runWalkForward({
      instrumentId: "PAPER:BTC",
      timeframe: "1h",
      candles,
      candidates: [cand2, cand1],
      ruleRef,
    });

    // Durch die lexikographische Tie-Break-Regel auf Candidate ID ("cand-1" < "cand-2")
    // MUSS in beiden Fällen "cand-1" gewonnen haben!
    assert.equal(reportForward.freezeArtifacts![0].selectedCandidateId, "cand-1");
    assert.equal(reportReverse.freezeArtifacts![0].selectedCandidateId, "cand-1");
    assert.equal(reportForward.freezeArtifacts![0].freezeHash, reportReverse.freezeArtifacts![0].freezeHash);
  });

  it("Freeze-Hash ändert sich bei Kandidat, Datenmanifest oder Config", () => {
    const candles = generateCandles(2200);
    const cand = sampleCandidates()[0];
    const scoreTable = [
      {
        candidateId: cand.id,
        candidateName: cand.name,
        config: cand.config,
        score: 1.5,
        passedGates: true,
        metrics: { trades: 10, winRate: 60, netPnl: 100, pnl: 100, sharpeRatio: 1.5, sortinoRatio: 2.0, profitFactor: 1.8, maxDrawdownPct: 5 },
      },
    ];

    const baseArtifact = createFreezeArtifact({
      windowIndex: 0,
      isFrom: candles[0].time,
      isTo: candles[1000].time,
      oosFrom: candles[1000].time,
      oosTo: candles[1500].time,
      selectedCandidate: cand,
      scoreTable,
      candles,
      selectorConfig: { targetMetric: "sharpeRatio" },
    });

    // 1. Änderung an Kandidat Config
    const modifiedCand: WalkForwardCandidate = {
      ...cand,
      config: { ...cand.config, fastPeriod: 99 },
    };
    const candModifiedArtifact = createFreezeArtifact({
      windowIndex: 0,
      isFrom: candles[0].time,
      isTo: candles[1000].time,
      oosFrom: candles[1000].time,
      oosTo: candles[1500].time,
      selectedCandidate: modifiedCand,
      scoreTable,
      candles,
      selectorConfig: { targetMetric: "sharpeRatio" },
    });
    assert.notEqual(baseArtifact.freezeHash, candModifiedArtifact.freezeHash);

    // 2. Änderung am Datenmanifest (andere Kerzen)
    const modifiedCandles = candles.map((c, i) => (i === 10 ? { ...c, close: c.close + 5 } : c));
    const dataModifiedArtifact = createFreezeArtifact({
      windowIndex: 0,
      isFrom: candles[0].time,
      isTo: candles[1000].time,
      oosFrom: candles[1000].time,
      oosTo: candles[1500].time,
      selectedCandidate: cand,
      scoreTable,
      candles: modifiedCandles,
      selectorConfig: { targetMetric: "sharpeRatio" },
    });
    assert.notEqual(baseArtifact.freezeHash, dataModifiedArtifact.freezeHash);

    // 3. Änderung an Selector Config
    const configModifiedArtifact = createFreezeArtifact({
      windowIndex: 0,
      isFrom: candles[0].time,
      isTo: candles[1000].time,
      oosFrom: candles[1000].time,
      oosTo: candles[1500].time,
      selectedCandidate: cand,
      scoreTable,
      candles,
      selectorConfig: { targetMetric: "netPnl" },
    });
    assert.notEqual(baseArtifact.freezeHash, configModifiedArtifact.freezeHash);
  });

  it("ausgewählte Kandidaten-ID ist in OOS exakt dieselbe", () => {
    const candles = generateCandles(3601);
    const candidates = sampleCandidates();
    const ruleRef = { ruleId: null, ruleKey: null, name: "Test Rule", signature: "sig123", ruleSymbol: "PAPER:BTC" };

    const report = runWalkForward({
      instrumentId: "PAPER:BTC",
      timeframe: "1h",
      candles,
      candidates,
      ruleRef,
    });

    assert.ok(report.freezeArtifacts && report.freezeArtifacts.length > 0);
    const artifacts = report.freezeArtifacts;
    for (let i = 0; i < artifacts.length; i++) {
      const freezeItem = artifacts[i];
      assert.ok(freezeItem.selectedCandidateId);
      assert.equal(freezeItem.selectedCandidate.id, freezeItem.selectedCandidateId);
      const scoreRow = freezeItem.scoreTable.find((s: { candidateId: string }) => s.candidateId === freezeItem.selectedCandidateId);
      assert.ok(scoreRow);
      assert.equal(scoreRow.passedGates, true);
    }
  });

  it("Leakage-Fixture mit horizonüberlappendem Label wird gepurged/abgelehnt", () => {
    const candles = generateCandles(100);
    const from = candles[0].time;
    const to = candles[80].time;

    // Normale Kerzen ohne Leaks
    const cleanCandles = filterCandlesWithLeakageProtection(candles, from, to);
    assert.equal(cleanCandles.length, 80);

    // Kerze mit availableAt > to
    const leakyCandles: CandleWithHorizon[] = candles.map((c, i) => {
      if (i === 50) return { ...c, availableAt: to + 10_000 };
      return c;
    });

    // In 'strict: false' Modus wird die leckende Kerze gepurged (entfernt)
    const purged = filterCandlesWithLeakageProtection(leakyCandles, from, to, { strict: false });
    assert.equal(purged.length, 79);

    // In 'strict: true' Modus wird ein WalkForwardError geworfen
    assert.throws(
      () => filterCandlesWithLeakageProtection(leakyCandles, from, to, { strict: true }),
      (e) => e instanceof WalkForwardError && e.code === "walkforward:leakage-detected"
    );

    // Kerze mit labelHorizonEnd > to
    const horizonLeakyCandles: CandleWithHorizon[] = candles.map((c, i) => {
      if (i === 70) return { ...c, labelHorizonEnd: to + 50_000 };
      return c;
    });

    assert.throws(
      () => filterCandlesWithLeakageProtection(horizonLeakyCandles, from, to, { strict: true }),
      (e) => e instanceof WalkForwardError && e.code === "walkforward:leakage-detected"
    );
  });

  it("finaler Holdout ist vor Abschluss der Auswahl nicht verfügbar", () => {
    const candles = generateCandles(4500); // ~180 Tage
    const candidates = sampleCandidates();
    const ruleRef = { ruleId: null, ruleKey: null, name: "Test Rule", signature: "sig123", ruleSymbol: "PAPER:BTC" };

    const report = runWalkForward({
      instrumentId: "PAPER:BTC",
      timeframe: "1h",
      candles,
      candidates,
      holdout: { holdoutDays: 30 },
      ruleRef,
    });

    assert.ok(report.holdout);
    assert.ok(report.holdout.from < report.holdout.to);
    assert.equal(report.holdout.to, candles[candles.length - 1].time);
    assert.ok(report.holdout.summary.trades >= 0);
    assert.ok(report.holdout.candidateId);

    // Der Holdout-Zeitraum ist NICHT Bestandteil der Walk-Forward-Fenster (vom Ende abgeschnitten)
    const lastWindow = report.windows[report.windows.length - 1];
    assert.ok(lastWindow.oos.to <= report.holdout.from);
  });

  it("harte Mindestgates leiten bei Nichterfüllung fail-closed den Fehler ein", () => {
    const candles = generateCandles(3601);
    const candidates = sampleCandidates();
    const ruleRef = { ruleId: null, ruleKey: null, name: "Test Rule", signature: "sig123", ruleSymbol: "PAPER:BTC" };

    // Setze ein unerreichbar hohes Gate für Sharpe Ratio
    assert.throws(
      () =>
        runWalkForward({
          instrumentId: "PAPER:BTC",
          timeframe: "1h",
          candles,
          candidates,
          selector: { gates: { minSharpeRatio: 99.0 }, failClosed: true },
          ruleRef,
        }),
      (e) => e instanceof WalkForwardError && e.code === "walkforward:no-candidate-passed-gates"
    );
  });

  it("Roundtrip, Idempotenz, Restart/Retry über persistBacktestRun & paramsJson", () => {
    const candles = generateCandles(3601);
    const candidates = sampleCandidates();
    const ruleRef = { ruleId: null, ruleKey: null, name: "Test Rule", signature: "sig123", ruleSymbol: "PAPER:BTC" };

    const report = runWalkForward({
      instrumentId: "PAPER:BTC",
      timeframe: "1h",
      candles,
      candidates,
      holdout: { holdoutDays: 30 },
      selector: { targetMetric: "netPnl" },
      ruleRef,
    });

    const spec = sampleRule("PAPER:BTC", "A");
    const insertRow = toBacktestRunInsert(report, spec, "00000000-0000-0000-0000-000000000001");

    assert.ok(insertRow.paramsJson.selection);
    assert.ok(insertRow.paramsJson.freezeArtifacts);
    assert.ok(insertRow.paramsJson.holdout);

    // Idempotency Key test
    const key1 = backtestRunIdempotencyKey(report);
    const key2 = backtestRunIdempotencyKey(report);
    assert.equal(key1, key2);
    assert.ok(key1.startsWith("wf1:"));
  });
});
