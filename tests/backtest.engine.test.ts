/**
 * Walk-Forward-Backtesting-Engine — Tests (GAP-01, v1.51.0).
 *
 * Deckung (Definition of Done):
 *   1. LOOKAHEAD: Später eintreffende Kerzen ändern keine Entscheidung bis t
 *      (Trade-Hash der Trades bis t identisch); umgekehrte Eingabereihenfolge
 *      als Mutationstest (Engine sortiert nach Zeit).
 *   2. IS/OOS: exakte Fenstergrenzen (OOS lückenlos/überlappungsfrei),
 *      Kennzahlen je Fenster getrennt, Determinismus (zwei Läufe ⇒
 *      byte-identischer Report).
 *   3. KOSTENMODELL: Fees/Slippage/Funding fließen in die Kennzahlen ein
 *      (Run mit vs. ohne Kosten); derselbe Simulator wie Paper
 *      (FillSimulator-Identität + Funding-Formel-Identität, kein Duplikat).
 *   4. PERSISTENZ: Run-Mapping + DB-Roundtrip (DB-gegated, Repo-Konvention:
 *      ping → skip) + Read-API (Auth: ohne firm.read abgewiesen).
 *   5. ARCHITEKTUR: kein LLM-Import in src/backtest/**; Kennzahlen aus
 *      src/portfolio (Import-Nachweis, keine Duplikate).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";

import {
  DEFAULT_BACKTEST_CONFIG,
  aggregateWindowEvals,
  computeWalkForwardWindows,
  createPaperExecutionRuntime,
  detectExitTrigger,
  defaultBacktestInstrument,
  effectiveSpreadDecimal,
  getBacktestRun,
  hashTrades,
  insertBacktestRun,
  listBacktestRuns,
  loadWalkForwardConfig,
  runMultiAssetBacktest,
  runWalkForward,
  toBacktestRunInsert,
  validateRunId,
  validateRunsLimit,
  WalkForwardError,
  WF_BOUNDS,
  WF_DEFAULTS,
  WF_ENV,
  computeFunding as paperComputeFunding,
} from "../src/backtest";
import type { BacktestStrategyItem, MultiAssetBacktestResult } from "../src/backtest";
import { FillSimulator } from "../src/lib/marketdata/simulator";
import type { FillSimulatorConfig } from "../src/lib/marketdata/config";
import { computeFunding as libComputeFunding } from "../src/lib/funding";
import { fallbackInstrument } from "../src/lib/marketdata/snapshot";
import { ruleSignature, type CandleLike, type RuleSpec } from "../src/lib/ruleEngine";
import { db } from "../src/db";
import { backtestRuns } from "../src/db/schema";

// ── Fixtures (deterministisch, keine Zufallsquelle) ─────────────────────────

const H = 3_600_000;
const DAY = 24 * H;
const T0 = Date.UTC(2024, 0, 1);

function candlesFromCloses(startTs: number, closes: number[], stepMs = H): CandleLike[] {
  return closes.map((close, i) => {
    const open = i === 0 ? close : closes[i - 1];
    // Kleine, deterministische Intrabar-Range um Open/Close.
    const high = Math.max(open, close) * 1.002;
    const low = Math.min(open, close) * 0.998;
    return {
      time: startTs + i * stepMs,
      open: Number(open.toFixed(4)),
      high: Number(high.toFixed(4)),
      low: Number(low.toFixed(4)),
      close: Number(close.toFixed(4)),
      volume: 1000 + (i % 7) * 100,
    };
  });
}

/** Monoton steigend: löst Schwellen-Regeln aus, TPs werden erreicht. */
function risingCloses(count: number, start = 100, stepPct = 0.004): number[] {
  const out: number[] = [];
  let p = start;
  for (let i = 0; i < count; i++) {
    out.push(Number(p.toFixed(4)));
    p *= 1 + stepPct;
  }
  return out;
}

/** Steigend, dann scharf fallend (Lookahead-Mutation: kehrt den Trend um). */
function reversalCloses(upCount: number, downCount: number): number[] {
  const up = risingCloses(upCount, 100, 0.004);
  const out = [...up];
  let p = up[up.length - 1];
  for (let i = 0; i < downCount; i++) {
    p *= 0.985;
    out.push(Number(p.toFixed(4)));
  }
  return out;
}

/** Sinusschwingung um eine Schwelle (wiederholte Ein-/Ausstiege). */
function waveCloses(count: number, mid = 100, amplitudePct = 0.08, periodBars = 40): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    out.push(Number((mid * (1 + amplitudePct * Math.sin((2 * Math.PI * i) / periodBars))).toFixed(4)));
  }
  return out;
}

function priceRule(symbol: string, threshold: number): RuleSpec {
  return {
    name: `Preis über ${threshold}`,
    symbol,
    missionId: null,
    rationale: "Test-Regel",
    sourceRole: "MANUAL",
    riskScore: 0.3,
    condition: { logic: "all", conditions: [{ field: "price", op: "gt", value: threshold }] },
    action: {
      side: "LONG",
      stopLossPct: 5,
      takeProfitRR: 2,
      riskBudgetPct: 0.02,
      maxPositionPct: 0.25,
      positionSizeMode: "risk",
    },
    window: {
      timeframe: "1h",
      validFrom: null,
      validUntil: null,
      maxExecutionsPerDay: 5,
      cooldownMinutes: 0,
      volumeWindow: 20,
    },
  };
}

/** Explizite Simulator-Konfiguration (deterministisch: Seed fix, Jitter 0). */
function testSimulatorConfig(overrides: Partial<FillSimulatorConfig> = {}): FillSimulatorConfig {
  return {
    makerFeeFallback: 0.0002,
    takerFeeFallback: 0.0006,
    latencyMs: 0,
    slippageBpsBase: 1,
    slippageBpsPerParticipation: 0,
    slippageJitterBps: 0,
    partialFillEnabled: false,
    partialFillMaxFraction: 1,
    seed: 42,
    volume24hFallback: 10_000_000,
    syntheticSpreadBps: 4,
    ...overrides,
  };
}

function runPaper(candles: CandleLike[], symbol: string, threshold: number, paperOverrides = {}) {
  const strategies: BacktestStrategyItem[] = [
    { type: "rule", spec: priceRule(symbol, threshold), id: "R-TEST" },
  ];
  return runMultiAssetBacktest({
    candlesBySymbol: new Map([[symbol, candles]]),
    strategies,
    config: {
      initialCapital: 10_000,
      warmupBars: 30,
      enableShorts: false,
      executionModel: "paper",
      paper: { simulator: testSimulatorConfig(), ...paperOverrides },
    },
  });
}

// ── 1) LOOKAHEAD (kritischster Test) ────────────────────────────────────────

describe("Lookahead-Garantie", () => {
  it("später eintreffende Kerzen ändern keine Entscheidung bis t (Hash bis t identisch)", () => {
    const symbol = "WFTEST";
    // Lauf A: 100 Kerzen. Lauf B: identisches Präfix + 40 Umkehr-Kerzen, die
    // JEDE Full-Series-Kennzahl (EMA/RSI über alles) verschieben würden.
    const prefix = candlesFromCloses(T0, risingCloses(100));
    const extended = candlesFromCloses(T0, reversalCloses(100, 40));

    const runA = runPaper(prefix, symbol, 100);
    const runB = runPaper(extended, symbol, 100);
    assert.ok(runA.trades.length > 0, "Fixture muss Trades erzeugen");

    const t = prefix[prefix.length - 1].time;
    // Einstiege sind reine Entscheidungen ≤ t ⇒ exakt identisch …
    const entriesA = runA.trades.filter((tr) => tr.entryTime <= t).map((tr) => ({
      entryTime: tr.entryTime, entryPrice: tr.entryPrice, qty: tr.qty, side: tr.side,
    }));
    const entriesB = runB.trades.filter((tr) => tr.entryTime <= t).map((tr) => ({
      entryTime: tr.entryTime, entryPrice: tr.entryPrice, qty: tr.qty, side: tr.side,
    }));
    assert.deepEqual(entriesB, entriesA);

    // … und bis t abgeschlossene Trades (inkl. Kennzahlen-relevanter Felder).
    // END_OF_DATA ist ausgenommen: Lauf A schließt seine Restposition an
    // seinem (früheren) Datenserien-Ende — ein Artefakt des Serienendes,
    // keine Entscheidung (Lauf B hält sie zu Recht länger).
    const doneA = runA.trades.filter((tr) => tr.exitTime <= t && tr.exitReason !== "END_OF_DATA");
    const doneB = runB.trades.filter((tr) => tr.exitTime <= t && tr.exitReason !== "END_OF_DATA");
    assert.deepEqual(doneB, doneA);
    assert.equal(
      hashTrades(doneB as unknown as Record<string, unknown>[]),
      hashTrades(doneA as unknown as Record<string, unknown>[])
    );
  });

  it("umgekehrte Eingabereihenfolge liefert identisches Ergebnis (Mutationstest)", () => {
    const symbol = "WFTEST";
    const ordered = candlesFromCloses(T0, waveCloses(120));
    const reversed = [...ordered].reverse();

    const runOrdered = runPaper(ordered, symbol, 100);
    const runReversed = runPaper(reversed, symbol, 100);

    // Entscheidungen hängen an der Zeit, nicht an der Eingabereihenfolge.
    assert.deepEqual(runReversed.trades, runOrdered.trades);
    assert.deepEqual(runReversed.metrics, runOrdered.metrics);
    assert.deepEqual(runReversed.equityCurve, runOrdered.equityCurve);
  });

  it("OOS-Fensterläufe sehen keine IS-fremden Kerzen (Fenster-Zeitmaske)", () => {
    const symbol = "WFTEST";
    const all = candlesFromCloses(T0, waveCloses(750));
    const report = runWalkForward({
      instrumentId: symbol,
      timeframe: "1h",
      candles: all,
      strategies: [{ type: "rule", spec: priceRule(symbol, 100), id: "R-TEST" }],
      ruleRef: { ruleId: null, ruleKey: null, name: "Test", signature: "test", ruleSymbol: "WFTEST" },
      engineConfig: {
        initialCapital: 10_000, warmupBars: 30, executionModel: "paper",
        paper: { simulator: testSimulatorConfig() },
      },
      walkforward: { isDays: 14, oosDays: 7 },
      nowMs: T0,
    });
    assert.ok(report.windows.length >= 2);
    for (const w of report.windows) {
      // OOS-Kennzahlen stammen aus einem Lauf, dessen Engine-Clip exakt das
      // OOS-Intervall war — IS-Kerzen sind strukturell unerreichbar.
      assert.ok(w.oos.from < w.oos.to);
      assert.equal(w.oos.from, w.is.to);
      assert.equal(w.oos.tradeHash.length, 64);
    }
    // OOS-Segmente kacheln lückenlos und überlappungsfrei.
    for (let i = 1; i < report.windows.length; i++) {
      assert.equal(report.windows[i].oos.from, report.windows[i - 1].oos.to);
    }
  });
});

// ── 2) IS/OOS-FENSTER + DETERMINISMUS ───────────────────────────────────────

describe("Walk-Forward-Fenster", () => {
  it("legt exakte Grenzen (IS/OOS), verwirft angebrochene Restfenster", () => {
    const layout = computeWalkForwardWindows(0, 200 * DAY, { isDays: 90, oosDays: 30, maxSpanDays: 730 });
    assert.equal(layout.truncated, false);
    assert.deepEqual(layout.windows, [
      { index: 0, isFrom: 0, isTo: 90 * DAY, oosFrom: 90 * DAY, oosTo: 120 * DAY },
      { index: 1, isFrom: 30 * DAY, isTo: 120 * DAY, oosFrom: 120 * DAY, oosTo: 150 * DAY },
      { index: 2, isFrom: 60 * DAY, isTo: 150 * DAY, oosFrom: 150 * DAY, oosTo: 180 * DAY },
    ]);
  });

  it("kappt den Zeitraum am maxSpanDays-Deckel (jüngste Daten gewinnen)", () => {
    const to = 800 * DAY;
    const layout = computeWalkForwardWindows(0, to, { isDays: 90, oosDays: 30, maxSpanDays: 730 });
    assert.equal(layout.truncated, true);
    assert.equal(layout.effectiveFrom, to - 730 * DAY);
    assert.equal(layout.effectiveTo, to);
    assert.ok(layout.windows.length > 0);
    assert.ok(layout.windows[0].isFrom >= layout.effectiveFrom);
  });

  it("trägt kein vollständiges Fenster ⇒ leeres Layout, Runner wirft walkforward:insufficient-span", () => {
    const layout = computeWalkForwardWindows(0, 10 * DAY, { isDays: 90, oosDays: 30, maxSpanDays: 730 });
    assert.deepEqual(layout.windows, []);
    const candles = candlesFromCloses(T0, risingCloses(60));
    assert.throws(
      () =>
        runWalkForward({
          instrumentId: "WFTEST",
          timeframe: "1h",
          candles,
          strategies: [{ type: "rule", spec: priceRule("WFTEST", 100), id: "R" }],
          ruleRef: { ruleId: null, ruleKey: null, name: "T", signature: "s", ruleSymbol: "WFTEST" },
          engineConfig: { executionModel: "paper", paper: { simulator: testSimulatorConfig() } },
          walkforward: { isDays: 90, oosDays: 30 },
          nowMs: T0,
        }),
      (e: unknown) => e instanceof WalkForwardError && e.code === "walkforward:insufficient-span"
    );
  });

  it("ohne Kerzen ⇒ walkforward:no-candles (fail-closed, kein erfundener Lauf)", () => {
    assert.throws(
      () =>
        runWalkForward({
          instrumentId: "WFTEST",
          timeframe: "1h",
          candles: [],
          strategies: [{ type: "rule", spec: priceRule("WFTEST", 100), id: "R" }],
          ruleRef: { ruleId: null, ruleKey: null, name: "T", signature: "s", ruleSymbol: "WFTEST" },
          nowMs: T0,
        }),
      (e: unknown) => e instanceof WalkForwardError && e.code === "walkforward:no-candles"
    );
  });

  it("zwei Läufe ⇒ byte-identischer Report (Determinismus, inkl. metricsJson)", () => {
    const input = {
      instrumentId: "WFTEST",
      timeframe: "1h" as const,
      candles: candlesFromCloses(T0, waveCloses(750)),
      strategies: [{ type: "rule", spec: priceRule("WFTEST", 100), id: "R-TEST" }] as BacktestStrategyItem[],
      ruleRef: { ruleId: null, ruleKey: null, name: "Test", signature: "sig", ruleSymbol: "WFTEST" },
      engineConfig: {
        initialCapital: 10_000, warmupBars: 30, executionModel: "paper" as const,
        paper: { simulator: testSimulatorConfig() },
      },
      walkforward: { isDays: 14, oosDays: 7 },
      nowMs: T0,
    };
    const run1 = runWalkForward(input);
    const run2 = runWalkForward(input);
    assert.equal(JSON.stringify(run2), JSON.stringify(run1));
    assert.ok(run1.aggregateOos.trades > 0, "Fixture muss OOS-Trades erzeugen");
    // Aggregate sind aus Summen neu berechnet (kein Mittel über Raten).
    const oosWins = run1.windows.reduce((s, w) => s + w.oos.wins, 0);
    assert.equal(run1.aggregateOos.wins, oosWins);
  });

  it("Aggregate über leere Fensterliste sind neutral-null (kein NaN)", () => {
    const agg = aggregateWindowEvals([]);
    assert.equal(agg.windows, 0);
    assert.equal(agg.trades, 0);
    assert.equal(agg.winRate, 0);
    assert.equal(agg.profitFactor, null);
    assert.equal(agg.sharpeRatio, 0);
  });

  it("WF-Flags: Defaults, Bounds und Env-Ladung (Muster loadFundingConfig)", () => {
    assert.deepEqual(WF_DEFAULTS, { isDays: 90, oosDays: 30, maxSpanDays: 730 });
    assert.deepEqual(WF_BOUNDS.isDays, { min: 14, max: 720 });
    assert.deepEqual(WF_BOUNDS.oosDays, { min: 7, max: 180 });
    assert.deepEqual(WF_ENV, {
      IS_WINDOW_DAYS: "WF_IS_WINDOW_DAYS",
      OOS_WINDOW_DAYS: "WF_OOS_WINDOW_DAYS",
      MAX_SPAN_DAYS: "WF_MAX_SPAN_DAYS",
    });
    const cfg = loadWalkForwardConfig({});
    assert.equal(cfg.isDays, 90);
    assert.equal(cfg.oosDays, 30);
    assert.equal(cfg.maxSpanDays, 730);
    const clamped = loadWalkForwardConfig({ WF_IS_WINDOW_DAYS: "5", WF_OOS_WINDOW_DAYS: "9999" });
    assert.equal(clamped.isDays, 14);
    assert.equal(clamped.oosDays, 180);
  });
});

// ── 3) KOSTENMODELL = PAPER-SIMULATOR ───────────────────────────────────────

describe("Kostenmodell (Paper-Simulator)", () => {
  it("Run ohne Kosten vs. mit Kosten ⇒ erwartete Differenz in den Kennzahlen", () => {
    const symbol = "WFTEST";
    const candles = candlesFromCloses(T0, waveCloses(200));
    // Null-Kosten: Instrument-Gebühren 0 (gehen VOR Simulator-Fallbacks —
    // dieselbe Präzedenz wie im Paper-Betrieb, `effectiveFees`) + kein
    // Spread/Slippage.
    const free = runPaper(candles, symbol, 100, {
      simulator: testSimulatorConfig({
        makerFeeFallback: 0, takerFeeFallback: 0, slippageBpsBase: 0, syntheticSpreadBps: 0,
      }),
      makerFee: 0,
      takerFee: 0,
      spreadBpsFallback: 0,
    });
    const paid = runPaper(candles, symbol, 100);
    assert.ok(paid.trades.length > 0 && free.trades.length > 0);
    assert.equal(free.metrics.totalFeesPaid, 0);
    assert.equal(free.metrics.totalSlippagePaid, 0);
    assert.ok(paid.metrics.totalFeesPaid > 0);
    assert.ok(paid.metrics.totalSlippagePaid > 0);
    assert.ok(paid.metrics.totalReturn < free.metrics.totalReturn);
  });

  it("Einstiegs-Fill = direkter FillSimulator-Aufruf (kein duplizierter Code)", () => {
    const cfg = testSimulatorConfig();
    const runtime = createPaperExecutionRuntime({ simulator: cfg });
    const refPrice = 100;
    const ts = T0;
    const snap = runtime.snapshotOf("WFTEST", refPrice, ts);
    assert.ok(snap);
    const instrument = runtime.instrumentOf("WFTEST");
    const qty = 1000 / snap.ask;
    // Referenz: DIESELBE Klasse, VON HAND aufgerufen (wie createPaperExecution).
    const direct = new FillSimulator(cfg).simulate(
      { symbol: snap.symbol, side: "LONG", qty }, snap, instrument
    );
    const via = runtime.fillEntry("WFTEST", "LONG", 1000, refPrice, ts);
    assert.ok(via);
    assert.equal(via.fillPrice, direct.fillPrice);
    assert.equal(via.filledQty, direct.filledQty);
    assert.equal(via.fees, direct.fees);
    assert.equal(via.slippageBps, direct.slippageBps);
    assert.equal(via.status, direct.status);
  });

  it("Funding-Formel ist DIESELBE Funktion wie im Paper-Betrieb (Referenz-Identität)", () => {
    assert.equal(paperComputeFunding, libComputeFunding);
  });

  it("Funding fließt in Kennzahlen ein (LONG zahlt bei positiver Rate)", () => {
    const symbol = "WFTEST";
    // Ein Trade: Aufstieg über die Schwelle, TP, danach unter der Schwelle.
    const closes = [
      ...risingCloses(30, 90, 0.003), // Bars 0–29 (unter 100, Warmup)
      ...risingCloses(12, 100.5, 0.008), // Bars 30–41 (Einstieg + TP bei +10 %)
      ...Array.from({ length: 18 }, (_, i) => 99 - i * 0.2), // Bars 42–59 (kein Re-Entry)
    ];
    const candles = candlesFromCloses(T0, closes);
    const perpetual = fallbackInstrument("PAPER", symbol, { marketType: "perpetual" });
    const base = {
      simulator: testSimulatorConfig(),
      instruments: { [symbol]: perpetual },
    };
    const without = runPaper(candles, symbol, 100, { ...base, fundingRatePctPer8h: 0 });
    const withFunding = runPaper(candles, symbol, 100, { ...base, fundingRatePctPer8h: 0.01 });
    assert.equal(without.trades.length, 1);
    assert.equal(withFunding.trades.length, 1);
    assert.equal(without.metrics.totalFundingPaid, 0);
    assert.ok(withFunding.metrics.totalFundingPaid < 0, "LONG zahlt Funding (Kontosicht negativ)");
    assert.equal(withFunding.trades[0].funding, withFunding.metrics.totalFundingPaid);
    // Gleicher Trade, exakt um das Funding schlechter (Rundung ≤ 1 ct).
    const delta = without.metrics.totalReturn - withFunding.metrics.totalReturn;
    assert.ok(Math.abs(delta + withFunding.metrics.totalFundingPaid) < 0.01);
  });

  it("Default-Instrument ist Spot ⇒ kein Funding ohne Registry-Perpetual (fail-safe)", () => {
    const inst = defaultBacktestInstrument("WFTEST", { makerFee: 0.0002, takerFee: 0.0006 });
    assert.equal(inst.marketType, "spot");
    const run = runPaper(candlesFromCloses(T0, waveCloses(120)), "WFTEST", 100, {
      simulator: testSimulatorConfig(), fundingRatePctPer8h: 0.5,
    });
    assert.ok(run.trades.length > 0);
    assert.equal(run.metrics.totalFundingPaid, 0);
  });

  it("Spread-Quelle gestuft: Registry-Spread vor Fallback, defektes Buch ⇒ Fallback", () => {
    const reg = fallbackInstrument("PAPER", "X", { spread: 0.001 });
    assert.equal(effectiveSpreadDecimal(reg, 4), 0.001);
    const missing = fallbackInstrument("PAPER", "X", { spread: null });
    assert.equal(effectiveSpreadDecimal(missing, 4), 0.0004);
    const broken = fallbackInstrument("PAPER", "X", { spread: 0.9 });
    assert.equal(effectiveSpreadDecimal(broken, 4), 0.0004);
  });

  it("Stop-Vorrang bei Kerzen-Kollision gilt auch im Paper-Pfad", () => {
    const pos = { side: "LONG" as const, stopLoss: 95, takeProfit: 110 };
    const collision: CandleLike = { time: T0, open: 100, high: 115, low: 90, close: 102, volume: 5 };
    const trigger = detectExitTrigger(pos, collision);
    assert.ok(trigger);
    assert.equal(trigger.reason, "STOP_LOSS");
    assert.equal(trigger.price, 95);
    const tpOnly: CandleLike = { time: T0, open: 101, high: 112, low: 99, close: 108, volume: 2 };
    assert.deepEqual(detectExitTrigger(pos, tpOnly), { price: 110, reason: "TAKE_PROFIT" });
    const none: CandleLike = { time: T0, open: 100, high: 102, low: 98, close: 101, volume: 1 };
    assert.equal(detectExitTrigger(pos, none), null);
  });

  it("Legacy-Default bleibt: executionModel=legacy, kein Funding, keine Verhaltensänderung", () => {
    assert.equal(DEFAULT_BACKTEST_CONFIG.executionModel, "legacy");
    const strategies: BacktestStrategyItem[] = [
      { type: "rule", spec: priceRule("WFTEST", 100), id: "R" },
    ];
    const result = runMultiAssetBacktest({
      candlesBySymbol: new Map([["WFTEST", candlesFromCloses(T0, waveCloses(120))]]),
      strategies,
      config: { initialCapital: 10_000, warmupBars: 30 },
    });
    assert.equal(result.config.executionModel, "legacy");
    assert.equal(result.metrics.totalFundingPaid, 0);
    for (const tr of result.trades) assert.equal(tr.funding, 0);
  });
});

// ── 4) PERSISTENZ + READ-API ────────────────────────────────────────────────

async function backtestRunsReachable(): Promise<boolean> {
  try {
    await db.execute(sql`SELECT 1 FROM backtest_runs LIMIT 1`);
    return true;
  } catch {
    return false;
  }
}

function sampleReport(): Parameters<typeof toBacktestRunInsert>[0] {
  const candles = candlesFromCloses(T0, waveCloses(750));
  return runWalkForward({
    instrumentId: "WFTEST",
    timeframe: "1h",
    candles,
    strategies: [{ type: "rule", spec: priceRule("WFTEST", 100), id: "R" }],
    ruleRef: { ruleId: null, ruleKey: null, name: "Persistenz-Test", signature: ruleSignature(priceRule("WFTEST", 100)), ruleSymbol: "WFTEST" },
    engineConfig: {
      initialCapital: 10_000, warmupBars: 30, executionModel: "paper",
      paper: { simulator: testSimulatorConfig() },
    },
    walkforward: { isDays: 14, oosDays: 7 },
    nowMs: T0,
  });
}

describe("Run-Persistenz (backtest_runs)", () => {
  it("toBacktestRunInsert bildet den Report rein ab (ohne DB testbar)", () => {
    const report = sampleReport();
    const spec = priceRule("WFTEST", 100);
    const id = randomUUID();
    const row = toBacktestRunInsert(report, spec, id);
    assert.equal(row.id, id);
    assert.equal(row.instrumentId, "WFTEST");
    assert.equal(row.timeframe, "1h");
    assert.deepEqual(row.fromTs, new Date(report.from));
    assert.deepEqual(row.toTs, new Date(report.to));
    assert.ok(typeof row.codeVersion === "string" && row.codeVersion.length > 0);
    const params = row.paramsJson as Record<string, unknown>;
    assert.deepEqual(params.ruleSpec, JSON.parse(JSON.stringify(spec)));
    assert.ok(params.costProfile);
    assert.ok((row.metricsJson as Record<string, unknown>).aggregateOos);
    assert.ok(Array.isArray((row.windowsJson as Record<string, unknown>).windows));
  });

  it("Validatoren: Limit 1..100 und UUID-Format (handgeschrieben, kein Zod)", () => {
    assert.deepEqual(validateRunsLimit(undefined), { ok: true, limit: 20 });
    assert.deepEqual(validateRunsLimit("5"), { ok: true, limit: 5 });
    assert.equal(validateRunsLimit("0").ok, false);
    assert.equal(validateRunsLimit("101").ok, false);
    assert.equal(validateRunsLimit("abc").ok, false);
    const id = randomUUID();
    assert.deepEqual(validateRunId(id), { ok: true, id: id.toLowerCase() });
    assert.equal(validateRunId("keine-uuid").ok, false);
    assert.equal(validateRunId("").ok, false);
    assert.equal(validateRunId(undefined).ok, false);
  });

  it("DB-Roundtrip: Insert → Get → List (ping → skip ohne DB)", async (t) => {
    if (!(await backtestRunsReachable())) {
      t.skip("Keine PostgreSQL erreichbar (backtest_runs) — DB-Test übersprungen (Repo-Konvention)");
      return;
    }
    const report = sampleReport();
    const id = randomUUID();
    const inserted = await insertBacktestRun(toBacktestRunInsert(report, priceRule("WFTEST", 100), id));
    assert.equal(inserted.id, id);
    try {
      const loaded = await getBacktestRun(id);
      assert.ok(loaded);
      assert.equal(loaded.instrumentId, "WFTEST");
      assert.deepEqual(
        (loaded.metricsJson as { aggregateOos: unknown }).aggregateOos,
        JSON.parse(JSON.stringify(report.aggregateOos))
      );
      const listed = await listBacktestRuns(50);
      assert.ok(listed.some((r) => r.id === id));
      assert.equal(await getBacktestRun(randomUUID()), null);
    } finally {
      await db.delete(backtestRuns).where(sql`${backtestRuns.id} = ${id}`);
    }
  });
});

describe("Read-API /api/firm/backtests (firm.read)", () => {
  const AUTH_KEYS = ["FIRM_ADMIN_TOKEN", "FIRM_API_TOKEN", "FIRM_VIEWER_TOKEN", "FIRM_SESSION_SECRET", "AUTH_MODE"] as const;
  const saved = new Map<string, string | undefined>();

  function tokenMode(): void {
    for (const key of AUTH_KEYS) {
      if (!saved.has(key)) saved.set(key, process.env[key]);
      delete process.env[key];
    }
    process.env.FIRM_API_TOKEN = "backtest-api-token-0123456789abcdef";
  }

  function localOpen(): void {
    for (const key of AUTH_KEYS) {
      if (!saved.has(key)) saved.set(key, process.env[key]);
      delete process.env[key];
    }
  }

  function restore(): void {
    for (const key of AUTH_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    saved.clear();
  }

  it("GET ohne Credential weist im Token-Betrieb ab (401, vor jedem DB-Zugriff)", async () => {
    tokenMode();
    try {
      const { GET } = await import("../src/app/api/firm/backtests/route");
      const res = await GET(new Request("https://trading.example.test/api/firm/backtests"));
      assert.equal(res.status, 401);
      const body = (await res.json()) as { ok?: unknown; error?: unknown };
      assert.equal(body.ok, false);
      assert.equal(body.error, "UNAUTHORIZED");
    } finally {
      restore();
    }
  });

  it("GET [id] ohne Credential weist im Token-Betrieb ab (401)", async () => {
    tokenMode();
    try {
      const { GET } = await import("../src/app/api/firm/backtests/[id]/route");
      const res = await GET(new Request(`https://trading.example.test/api/firm/backtests/${randomUUID()}`), {
        params: Promise.resolve({ id: randomUUID() }),
      });
      assert.equal(res.status, 401);
      const body = (await res.json()) as { ok?: unknown; error?: unknown };
      assert.equal(body.error, "UNAUTHORIZED");
    } finally {
      restore();
    }
  });

  it("ungültiges Limit ⇒ 400 vor DB-Zugriff (local-open, ohne DB grün)", async () => {
    localOpen();
    try {
      const { GET } = await import("../src/app/api/firm/backtests/route");
      const res = await GET(new Request("https://trading.example.test/api/firm/backtests?limit=999"));
      assert.equal(res.status, 400);
      const body = (await res.json()) as { error?: unknown };
      assert.match(String(body.error), /^INVALID_LIMIT/);
    } finally {
      restore();
    }
  });

  it("ungültige Run-ID ⇒ 400 vor DB-Zugriff (local-open, ohne DB grün)", async () => {
    localOpen();
    try {
      const { GET } = await import("../src/app/api/firm/backtests/[id]/route");
      const res = await GET(new Request("https://trading.example.test/api/firm/backtests/keine-uuid"), {
        params: Promise.resolve({ id: "keine-uuid" }),
      });
      assert.equal(res.status, 400);
      const body = (await res.json()) as { error?: unknown };
      assert.match(String(body.error), /^INVALID_RUN_ID/);
    } finally {
      restore();
    }
  });

  it("GET liefert Runs im local-open-Betrieb (DB-gegated)", async (t) => {
    if (!(await backtestRunsReachable())) {
      t.skip("Keine PostgreSQL erreichbar (backtest_runs) — DB-Test übersprungen (Repo-Konvention)");
      return;
    }
    localOpen();
    try {
      const report = sampleReport();
      const id = randomUUID();
      await insertBacktestRun(toBacktestRunInsert(report, priceRule("WFTEST", 100), id));
      try {
        const { GET } = await import("../src/app/api/firm/backtests/route");
        const res = await GET(new Request("https://trading.example.test/api/firm/backtests?limit=50"));
        assert.equal(res.status, 200);
        const body = (await res.json()) as { ok?: unknown; runs?: Array<{ id: string }> };
        assert.equal(body.ok, true);
        assert.ok(body.runs?.some((r) => r.id === id));

        const detail = await import("../src/app/api/firm/backtests/[id]/route");
        const resDetail = await detail.GET(
          new Request(`https://trading.example.test/api/firm/backtests/${id}`),
          { params: Promise.resolve({ id }) }
        );
        assert.equal(resDetail.status, 200);
        const bodyDetail = (await resDetail.json()) as { ok?: unknown; run?: { id: string } };
        assert.equal(bodyDetail.ok, true);
        assert.equal(bodyDetail.run?.id, id);

        const resMissing = await detail.GET(
          new Request(`https://trading.example.test/api/firm/backtests/${randomUUID()}`),
          { params: Promise.resolve({ id: randomUUID() }) }
        );
        assert.equal(resMissing.status, 404);
      } finally {
        await db.delete(backtestRuns).where(sql`${backtestRuns.id} = ${id}`);
      }
    } finally {
      restore();
    }
  });
});

// ── 5) ARCHITEKTUR ──────────────────────────────────────────────────────────

function importsOf(source: string): string[] {
  const specifiers: string[] = [];
  const re = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) specifiers.push(match[1]);
  const dynamic = /import\s*\(\s*["']([^"']+)["']\s*\)/g;
  while ((match = dynamic.exec(source)) !== null) specifiers.push(match[1]);
  return specifiers;
}

describe("Architektur", () => {
  const BACKTEST_DIR = path.join(process.cwd(), "src/backtest");
  const FORBIDDEN_LLM_IMPORTS = /(ollama|llmProvider|openai|anthropic|claude|gemini|analysts|langchain|prompt)/i;

  it("src/backtest/** importiert kein LLM-Modul (reine Arithmetik, D1)", () => {
    const files = readdirSync(BACKTEST_DIR).filter((f) => f.endsWith(".ts"));
    assert.ok(files.length >= 5);
    for (const file of files) {
      const source = readFileSync(path.join(BACKTEST_DIR, file), "utf8");
      for (const specifier of importsOf(source)) {
        assert.ok(
          !FORBIDDEN_LLM_IMPORTS.test(specifier),
          `src/backtest/${file} importiert verbotenes LLM-Modul: "${specifier}"`
        );
      }
    }
  });

  it("Kennzahlen kommen aus src/portfolio (Import-Nachweis, keine Duplikate)", () => {
    for (const file of ["metrics.ts", "walkforward.ts"]) {
      const source = readFileSync(path.join(BACKTEST_DIR, file), "utf8");
      assert.ok(
        source.includes('from "../portfolio/metrics"'),
        `${file} muss aus ../portfolio/metrics importieren`
      );
      for (const fn of ["maxDrawdown", "profitFactor", "sharpeRatio", "sortinoRatio"]) {
        assert.ok(source.includes(fn), `${file} muss ${fn} aus src/portfolio nutzen`);
      }
    }
  });

  it("Paper-Ausführung nutzt FillSimulator + Funding aus dem Paper-Pfad (Import-Nachweis)", () => {
    const source = readFileSync(path.join(BACKTEST_DIR, "paperExecution.ts"), "utf8");
    assert.ok(source.includes('"../lib/marketdata/simulator"'), "FillSimulator-Import fehlt");
    assert.ok(source.includes('"../lib/marketdata/snapshot"'), "Snapshot-Builder-Import fehlt");
    assert.ok(source.includes('"../lib/funding"'), "Funding-Import fehlt");
  });
});
