/**
 * Step 8 (Backtest-Verifikation): kein synthetischer Fallback mehr
 * (GAP-01 D4, v1.51.0 — fail-closed statt erfundener Performance).
 *
 * RED/GREEN-Dokumentation: Vor diesem PR bewertete der Step bei < 5 Kerzen
 * mit ERFUNDENEN Kennzahlen (profitFactor aus RRR, sharpeRatio 1.0,
 * sortinoRatio 1.2, maxDrawdownPct 5.0, regimeRobustness 0.6 — davor sogar
 * eine „repräsentative Serie aus 20 Trades mit 55 % Winrate“, Audit
 * 2026-09-18, GAP-01) und meldete `verified=true`. Jeder dieser Tests wäre
 * gegen das alte Verhalten ROT (falsche Kennzahlen, falsches verified,
 * fehlender Status, fehlendes Audit). Jetzt gilt: < 5 Kerzen ⇒
 * verified=false + DATA_UNAVAILABLE + neutrale Null-Kennzahlen +
 * maschinenlesbarer Grund + Audit + Log — und NIEMALS synthetische Werte.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { SimulatedClock } from "../src/cycle/clock";
import { createTestPorts } from "../src/cycle/ports";
import { backtestStep } from "../src/cycle/steps/backtestStep";
import type { StepExecutionContext } from "../src/cycle/types";
import type { TradeSetupProposal } from "../src/cycle/schemas";
import { HistoricalStore } from "../src/lib/marketdata/historicalStore";

const INSTRUMENT = "NOSYNTH:BTC";
const H = 3_600_000;
const T0 = Date.UTC(2024, 5, 1);

function setup(instrumentId = INSTRUMENT): TradeSetupProposal {
  return {
    instrumentId,
    side: "LONG",
    entryPrice: 100,
    stopLoss: 95,
    takeProfit: 110,
    riskScore: 0.4,
    timeframe: "1h",
    thesis: "Nosynthetic-Test-Setup",
    isProposal: true,
  };
}

function risingCandles(count: number, start = 90, step = 0.6) {
  const out = [];
  let p = start;
  for (let i = 0; i < count; i++) {
    out.push({
      time: T0 + i * H,
      open: p,
      high: p * 1.001,
      low: p * 0.999,
      close: Number((p + step).toFixed(4)),
      volume: 1000,
    });
    p += step;
  }
  return out;
}

function mockContext(
  setups: TradeSetupProposal[],
  ports = createTestPorts(),
  logs: Array<{ message: string; level?: string }> = []
): { ctx: StepExecutionContext<{ setups: TradeSetupProposal[] }>; ports: typeof ports; logs: typeof logs } {
  const clock = new SimulatedClock(T0);
  const ctx: StepExecutionContext<{ setups: TradeSetupProposal[] }> = {
    cycleId: "test-cycle-nosynth",
    date: "2024-05-01",
    asOf: clock.now(),
    clock,
    input: { setups },
    previousStepOutputs: {},
    ports,
    emitEscalation: () => {},
    log: (message: string, level?: "INFO" | "WARN" | "CRITICAL") => {
      logs.push({ message, level });
    },
  };
  return { ctx, ports, logs };
}

/** Isolierter HistoricalStore pro Test (PAPER_HISTORY_DIR → Temp-Verz). */
async function withIsolatedStore<T>(candles: number, fn: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nosynth-store-"));
  const prev = process.env.PAPER_HISTORY_DIR;
  process.env.PAPER_HISTORY_DIR = dir;
  try {
    if (candles > 0) {
      const store = new HistoricalStore(dir);
      store.append(risingCandles(candles), INSTRUMENT, { venue: "NOSYNTH", feed: "test" }, "1h", new Date(T0));
    }
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.PAPER_HISTORY_DIR;
    else process.env.PAPER_HISTORY_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("Step 8: < 5 Kerzen ⇒ verified=false + DATA_UNAVAILABLE (statt erfundener Kennzahlen)", async () => {
  for (const n of [0, 1, 4]) {
    await withIsolatedStore(n, async () => {
      const { ctx, ports, logs } = mockContext([setup()]);
      const result = await backtestStep.execute(ctx);

      assert.equal(backtestStep.llmAllowed, false);
      const v = result.verifiedSetups[0];
      // Fail-closed: KEIN verified, KEIN PASSED, KEINE erfundenen Werte.
      assert.equal(v.verified, false);
      assert.equal(v.verdict, "FAILED");
      assert.equal(v.status, "DATA_UNAVAILABLE");
      assert.deepEqual(v.metrics, {
        maxDrawdownPct: 0,
        profitFactor: 0,
        sharpeRatio: 0,
        sortinoRatio: 0,
        regimeRobustness: 0,
      });
      assert.deepEqual(v.failureReasons, [`data:insufficient-candles:${n}-of-5-minimum`]);
      assert.equal(result.summary.unavailable, 1);
      assert.equal(result.summary.failed, 1);
      assert.equal(result.summary.passed, 0);

      // Sichtbarkeit: WARN-Log + revisionssicheres Audit-Event (R6-Muster).
      assert.ok(logs.some((l) => l.level === "WARN" && l.message.includes("DATA_UNAVAILABLE")));
      const events = await ports.audit.getEvents("test-cycle-nosynth");
      const skipped = events.filter((e) => e.event === "CYCLE_STEP_SKIPPED");
      assert.equal(skipped.length, 1);
      assert.equal(skipped[0].stepId, "08-backtest-verification");
      assert.deepEqual(skipped[0].detail.reason, `data:insufficient-candles:${n}-of-5-minimum`);
    });
  }
});

test("Step 8: exakt 5 Kerzen ⇒ echte Messung (Status OK, kein DATA_UNAVAILABLE)", async () => {
  await withIsolatedStore(5, async () => {
    const { ctx, ports } = mockContext([setup()]);
    const result = await backtestStep.execute(ctx);
    const v = result.verifiedSetups[0];
    assert.equal(v.status, "OK");
    assert.equal(result.summary.unavailable, 0);
    assert.ok(!String(v.failureReasons ?? []).includes("data:insufficient-candles"));
    const events = await ports.audit.getEvents("test-cycle-nosynth");
    assert.equal(events.filter((e) => e.event === "CYCLE_STEP_SKIPPED").length, 0);
  });
});

test("Step 8: gemischte Setups ⇒ unavailable zählt nur die datenlosen (Konservativ-Summe)", async () => {
  await withIsolatedStore(60, async () => {
    const { ctx } = mockContext([setup(INSTRUMENT), setup("NOSYNTH:OHNE-KERZEN")]);
    const result = await backtestStep.execute(ctx);
    assert.equal(result.summary.total, 2);
    assert.equal(result.summary.unavailable, 1);
    const [withData, withoutData] = result.verifiedSetups;
    assert.equal(withData.status, "OK");
    assert.equal(withoutData.status, "DATA_UNAVAILABLE");
    assert.equal(withoutData.verified, false);
  });
});

test("Step 8: gemessene Kennzahlen sind echte Engine-Werte (keine synthetischen Konstanten)", async () => {
  await withIsolatedStore(60, async () => {
    const { ctx } = mockContext([setup()]);
    const result = await backtestStep.execute(ctx);
    const v = result.verifiedSetups[0];
    assert.equal(v.status, "OK");
    // Die alten synthetischen Konstanten (sharpe 1.0, sortino 1.2, DD 5.0,
    // Robustness 0.6) dürfen als Kombination nie wieder auftauchen.
    const m = v.metrics;
    const looksSynthetic =
      m.sharpeRatio === 1.0 && m.sortinoRatio === 1.2 && m.maxDrawdownPct === 5.0 && m.regimeRobustness === 0.6;
    assert.equal(looksSynthetic, false);
  });
});
