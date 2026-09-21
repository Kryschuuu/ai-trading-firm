/**
 * Event-Replay mit realistischen Friktionen — Tests (RMA-P1-01, v1.58.0).
 *
 * Deckung (Definition of Done des Prompts):
 *   1. GOLDEN: Bar + Latenz + zwei Partial Fills + Fee + Funding liefert
 *      exakte Cash-/PnL-Werte (unabhängig nachgerechnet, keine Zirkularität).
 *   2. DETERMINISMUS: gleiche Inputs/Seed ⇒ identischer Event-, Trade- und
 *      Metrik-Hash (zweifacher Lauf, byte-identisch).
 *   3. FAIL-CLOSED-LIQUIDITÄT: fehlende/stale Depth nutzt den dokumentierten
 *      konservativen Kerzenvolumen-Fallback; ohne Volumen KEIN Fill.
 *   4. MENGEN-GUARDS: Fillmenge überschreitet weder Depth noch offene
 *      Orderrestmenge; Exit füllt nie mehr als die Positions-Restmenge.
 *   5. FUNDING-FENSTER: Funding vor Entry/nach Exit wird nicht gebucht;
 *      `availableAt` verhindert Look-ahead (Buchung erst wenn bekannt).
 *   6. NEGATIVE PATHS: invalide Events/Config werden abgewiesen
 *      (`replay:invalid-event`/`replay:invalid-config`), nie still geraten.
 *   7. KOMPATIBILITÄT: Legacy-Default bleibt `legacy`; Paper-Läufe sind
 *      byte-identisch zu vorher; Walk-Forward-Replay-Runs tragen
 *      Modellversion + Evidenz und reconcilen im Trade-Ledger.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  BacktestPortfolio,
  createEventReplayRuntime,
  DEFAULT_BACKTEST_CONFIG,
  EventReplayError,
  hashTrades,
  mapReportTrades,
  perpFundingRowsToReplayEvents,
  reconcileTradeLedger,
  resolveEventReplayConfig,
  runMultiAssetBacktest,
  runWalkForward,
  sortReplayEvents,
  validateReplayInputEvent,
  backtestRunIdempotencyKey,
} from "../src/backtest";
import type {
  BacktestEngineConfig,
  BacktestStrategyItem,
  MarketDepthEvent,
  MarketQuoteEvent,
  FundingDueEvent,
  ReplayInputEvent,
} from "../src/backtest";
import { fallbackInstrument } from "../src/lib/marketdata/snapshot";
import { stableStringify, type CandleLike, type RuleSpec } from "../src/lib/ruleEngine";
import type { PerpFundingRow } from "../src/perpdata/index";

const H = 3_600_000;
const T0 = Date.UTC(2024, 0, 1);

// ── Fixtures ─────────────────────────────────────────────────────────────────

function bar(time: number, close: number, opts: Partial<CandleLike> = {}): CandleLike {
  return {
    time,
    open: opts.open ?? close,
    high: opts.high ?? close * 1.001,
    low: opts.low ?? close * 0.999,
    close,
    volume: opts.volume ?? 1_000,
  };
}

function engineConfig(overrides: Partial<BacktestEngineConfig> = {}): BacktestEngineConfig {
  return {
    ...DEFAULT_BACKTEST_CONFIG,
    initialCapital: 10_000,
    warmupBars: 30,
    executionModel: "event_replay",
    ...overrides,
  };
}

function depth(symbol: string, time: number, askQty: number, bidQty = askQty): MarketDepthEvent {
  return { type: "MARKET_DEPTH", symbol, eventTime: time, availableAt: time, askQty, bidQty };
}

function quote(symbol: string, time: number, bid: number, ask: number): MarketQuoteEvent {
  return { type: "MARKET_QUOTE", symbol, eventTime: time, availableAt: time, bid, ask };
}

function fundingDue(
  symbol: string,
  eventTime: number,
  ratePer8h: number,
  availableAt = eventTime
): FundingDueEvent {
  return { type: "FUNDING_DUE", symbol, venue: "SIM", eventTime, availableAt, ratePer8h, intervalHours: 8 };
}

function perpInstrument(symbol: string) {
  const native = symbol.includes(":") ? symbol.split(":")[1] : symbol;
  return fallbackInstrument("SIM", native, {
    id: symbol,
    marketType: "perpetual",
    makerFee: 0.0005,
    takerFee: 0.001,
  });
}

function risingCloses(count: number, start = 100, stepPct = 0.004): number[] {
  const out: number[] = [];
  let p = start;
  for (let i = 0; i < count; i++) {
    out.push(Number(p.toFixed(4)));
    p *= 1 + stepPct;
  }
  return out;
}

function waveCloses(count: number, mid = 100, amplitudePct = 0.08, periodBars = 40): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    out.push(Number((mid * (1 + amplitudePct * Math.sin((2 * Math.PI * i) / periodBars))).toFixed(4)));
  }
  return out;
}

function candlesFromCloses(startTs: number, closes: number[]): CandleLike[] {
  return closes.map((close, i) => {
    const open = i === 0 ? close : closes[i - 1];
    return {
      time: startTs + i * H,
      open: Number(open.toFixed(4)),
      high: Number((Math.max(open, close) * 1.002).toFixed(4)),
      low: Number((Math.min(open, close) * 0.998).toFixed(4)),
      close: Number(close.toFixed(4)),
      volume: 1000 + (i % 7) * 100,
    };
  });
}

function priceRule(symbol: string, threshold: number): RuleSpec {
  return {
    name: `Preis über ${threshold}`,
    symbol,
    missionId: null,
    rationale: "Replay-Test-Regel",
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

// ── 1) GOLDEN REPLAY ─────────────────────────────────────────────────────────

describe("Golden Replay: Latenz + zwei Partial Fills + Fee + Funding", () => {
  const SYM = "SIM:GOLD";
  const takerFee = 0.001;
  const spreadBps = 20; // 0.002 relativ ⇒ Half-Spread 0.001
  const impactPer = 100; // 100 bp bei 100 % Partizipation

  function runGolden() {
    const candles = new Map<string, CandleLike[]>([
      [
        SYM,
        [
          bar(T0, 100, { high: 100.1, low: 99.9, volume: 0 }),
          bar(T0 + H, 101, { high: 101.1, low: 100.9, volume: 0 }),
          bar(T0 + 2 * H, 102, { high: 102.1, low: 101.9, volume: 0 }),
          bar(T0 + 3 * H, 103.9, { high: 104, low: 103, volume: 0 }),
          bar(T0 + 4 * H, 103.8, { high: 103.9, low: 103.5, volume: 0 }),
        ],
      ],
    ]);
    const runtime = createEventReplayRuntime({
      options: {
        seed: 7,
        latency: { decisionToSubmitMs: 0, submitToArrivalMs: H },
        impactBpsPerParticipation: impactPer,
        spreadBpsFallback: spreadBps,
        takerFee,
        instruments: { [SYM]: perpInstrument(SYM) },
        events: [
          // Funding VOR Entry (availableAt = T0+H, Position existiert noch nicht).
          fundingDue(SYM, T0 + 30 * 60_000, 0.0001, T0 + H),
          depth(SYM, T0 + H, 6), // Partial: 6 von 10
          // Funding WÄHREND der Haltedauer (gebucht bei beginBar(T0+2H) auf qty 6).
          fundingDue(SYM, T0 + H + 30 * 60_000, 0.0001, T0 + 2 * H),
          depth(SYM, T0 + 2 * H, 40), // Rest: 4 von 40
          depth(SYM, T0 + 4 * H, 100), // Exit-Liquidität
        ],
      },
      engineFeeModel: { makerFee: 0.0002, takerFee },
      barMs: H,
      candlesBySymbol: candles,
    });
    const portfolio = new BacktestPortfolio(engineConfig());
    const prices = new Map<string, number>();
    const times = [T0, T0 + H, T0 + 2 * H, T0 + 3 * H, T0 + 4 * H];
    const series = candles.get(SYM) as CandleLike[];

    for (let i = 0; i < times.length; i++) {
      const t = times[i];
      const c = series[i];
      prices.set(SYM, c.close);
      const bars = new Map([[SYM, { candle: c, index: i }]]);
      runtime.beginBar(t, i + 1, bars, prices, portfolio);
      if (i === 0) {
        // Entscheidung auf der T0-Kerze: 10 Einheiten (Notional 1000 @ 100).
        runtime.submitEntry({
          strategyId: "R-GOLD",
          symbol: SYM,
          side: "LONG",
          notional: 1000,
          candle: c,
          now: t,
          barStep: i + 1,
          stopLoss: 90,
          takeProfit: 103.8,
          portfolio,
        });
      }
    }
    runtime.finish(times[times.length - 1], times.length, prices, portfolio);
    return { runtime, portfolio };
  }

  it("liefert exakte Cash-/PnL-Werte (unabhängige Nachrechnung)", () => {
    const { runtime, portfolio } = runGolden();

    // Unabhängige Nachrechnung (Formel aus replayExecution.ts-Kopf):
    const half = spreadBps / 10_000 / 2; // 0.001
    // Fill 1 @ T0+H: base = Close 101 (Latenz ⇒ nicht mehr Entscheidungskurs),
    // Partizipation 6/6 = 1 ⇒ Impact 100 bp.
    const price1 = 101 * (1 + half) * (1 + impactPer / 10_000);
    const fees1 = price1 * 6 * takerFee;
    // Funding @ beginBar(T0+2H): qty 6, Mark = Close 102, LONG zahlt.
    const funding = -(0.0001 * 1 * Math.abs(6 * 102));
    // Fill 2 @ T0+2H: base = Close 102, Partizipation 4/40 ⇒ Impact 10 bp.
    const price2 = 102 * (1 + half) * (1 + (impactPer * (4 / 40)) / 10_000);
    const fees2 = price2 * 4 * takerFee;
    // TP-Trigger @ T0+3H (High 104 ≥ 103.8), Arrival T0+4H ⇒ base = Close 103.8,
    // SELL: Touch 103.8×(1−half), Partizipation 10/100 ⇒ Impact 10 bp.
    const priceX = 103.8 * (1 - half) * (1 - (impactPer * (10 / 100)) / 10_000);
    const feesX = priceX * 10 * takerFee;
    const gross = 6 * (priceX - price1) + 4 * (priceX - price2);
    const expectedPnl = gross - (fees1 + fees2 + feesX) + funding;
    const expectedCash = 10_000 + expectedPnl;

    assert.equal(portfolio.trades.length, 1, "genau EIN Trade");
    const trade = portfolio.trades[0];
    assert.equal(trade.exitReason, "TAKE_PROFIT");
    assert.equal(trade.qty, 10);
    assert.equal(trade.pnl, Number(expectedPnl.toFixed(4)));
    assert.equal(trade.fees, Number((fees1 + fees2 + feesX).toFixed(4)));
    assert.equal(trade.funding, Number(funding.toFixed(8)));
    // Entry-Preis = mengengewichtetes Mittel, Exit = Fill-VWAP.
    assert.ok(Math.abs(trade.entryPrice - (price1 * 6 + price2 * 4) / 10) < 1e-9);
    assert.ok(Math.abs(trade.exitPrice - priceX) < 1e-9);
    // Cash-Identität: Endkasse = Startkapital + Netto-PnL (exakt, ohne Rundung).
    assert.ok(
      Math.abs(portfolio.currentCash - expectedCash) < 1e-8,
      `Cash ${portfolio.currentCash} ≠ erwartet ${expectedCash}`
    );

    // Lifecycle-Evidenz: SUBMITTED → ACK → PARTIAL(6) → FILL(4) → SUBMITTED → ACK → FILL(10).
    const summary = runtime.summary();
    const kinds = summary.orderEvents.map((e) => e.type);
    assert.deepEqual(kinds, [
      "ORDER_SUBMITTED",
      "ORDER_ACK",
      "ORDER_PARTIAL_FILL",
      "ORDER_FILL",
      "ORDER_SUBMITTED",
      "ORDER_ACK",
      "ORDER_FILL",
    ]);
    const partial = summary.orderEvents[2];
    assert.equal(partial.type, "ORDER_PARTIAL_FILL");
    if (partial.type === "ORDER_PARTIAL_FILL") {
      assert.equal(partial.qty, 6);
      assert.equal(partial.remainingQty, 4);
      assert.equal(partial.liquiditySource, "DEPTH");
    }
    // Fill-Details am Trade: 2 Entry-Fills + 1 Exit-Fill, Zeiten getrennt.
    const detail = summary.tradeDetails[trade.id];
    assert.ok(detail, "Trade-Detailblock vorhanden");
    assert.equal(detail.fills.length, 3);
    assert.equal(detail.fills[0].decisionTime, T0);
    assert.equal(detail.fills[0].submitTime, T0);
    assert.equal(detail.fills[0].arrivalTime, T0 + H);
    assert.equal(detail.fills[0].fillTime, T0 + H);
    assert.equal(detail.fills[1].fillTime, T0 + 2 * H);
    assert.equal(detail.fills[2].fillTime, T0 + 4 * H);
    // Funding-Detail: genau EIN gebuchtes Ereignis (das Vor-Entry-Ereignis nicht).
    assert.equal(detail.funding.length, 1);
    assert.equal(detail.funding[0].funding, Number(funding.toFixed(8)));
    assert.equal(summary.coverage.fundingApplied, 1);
    assert.equal(summary.coverage.fundingSkipped, 1);
    // Reconciliation Trade ↔ Detail: Σ Fill-Fees = Trade-Fees, Σ Funding = Trade-Funding.
    const feeSum = detail.fills.reduce((a, f) => a + f.fees, 0);
    assert.equal(Number(feeSum.toFixed(4)), trade.fees);
    const fundingSum = detail.funding.reduce((a, f) => a + f.funding, 0);
    assert.equal(Number(fundingSum.toFixed(8)), trade.funding);
  });

  it("gleiche Inputs/Seed liefern identischen Event-, Trade- und Metrik-Hash", () => {
    const a = runGolden();
    const b = runGolden();
    assert.equal(
      hashTrades(a.portfolio.trades),
      hashTrades(b.portfolio.trades)
    );
    assert.equal(
      stableStringify(a.runtime.summary().orderEvents),
      stableStringify(b.runtime.summary().orderEvents)
    );
    assert.equal(stableStringify(a.runtime.summary()), stableStringify(b.runtime.summary()));
    assert.equal(a.portfolio.currentCash, b.portfolio.currentCash);
  });
});

// ── 2) ENGINE-INTEGRATION + DETERMINISMUS ────────────────────────────────────

describe("Engine-Integration (executionModel: event_replay)", () => {
  const SYM = "SIM:ENGINE";

  function runEngine(events: ReplayInputEvent[], closes = risingCloses(100)) {
    const candles = candlesFromCloses(T0, closes);
    const strategies: BacktestStrategyItem[] = [{ type: "rule", spec: priceRule(SYM, 100), id: "R-REPLAY" }];
    return runMultiAssetBacktest({
      candlesBySymbol: new Map([[SYM, candles]]),
      strategies,
      config: {
        initialCapital: 10_000,
        warmupBars: 30,
        executionModel: "event_replay",
        replay: {
          seed: 11,
          instruments: { [SYM]: perpInstrument(SYM) },
          events,
        },
      },
    });
  }

  it("Ende-zu-Ende: Rule-Signal → Order-Lifecycle → Trades + Replay-Evidenz", () => {
    const events: ReplayInputEvent[] = [];
    for (let i = 0; i < 100; i++) events.push(depth(SYM, T0 + i * H, 1_000_000));
    const result = runEngine(events);
    assert.ok(result.trades.length > 0, "Fixture muss Trades erzeugen");
    assert.ok(result.replay, "Replay-Evidenz vorhanden");
    const replay = result.replay;
    assert.equal(replay.config.frictionModelVersion, "er1");
    assert.equal(replay.config.seed, 11);
    assert.equal(replay.manifest.candleCount, 100);
    assert.equal(replay.coverage.bars, 100);
    assert.ok(replay.coverage.ordersSubmitted > 0);
    assert.ok(replay.coverage.fillsFromDepth > 0);
    assert.equal(replay.manifest.symbols.length, 1);
    // Jeder Trade hat einen Detailblock, dessen Fill-Summe die Trade-Menge ist.
    for (const trade of result.trades) {
      const detail = replay.tradeDetails[trade.id];
      assert.ok(detail, `Detail für ${trade.id}`);
      const exitQty = detail.fills.filter((f) => f.purpose === "EXIT").reduce((a, f) => a + f.qty, 0);
      assert.ok(Math.abs(exitQty - trade.qty) < 1e-9);
    }
  });

  it("zweifacher Lauf ist byte-identisch (Trade-/Metrik-/Event-Hash)", () => {
    const events: ReplayInputEvent[] = [];
    for (let i = 0; i < 100; i++) {
      events.push(depth(SYM, T0 + i * H, 500));
      events.push(quote(SYM, T0 + i * H, risingCloses(100)[i] * 0.999, risingCloses(100)[i] * 1.001));
    }
    const a = runEngine(events);
    const b = runEngine(events);
    assert.equal(hashTrades(a.trades), hashTrades(b.trades));
    assert.equal(stableStringify(a.metrics), stableStringify(b.metrics));
    assert.equal(stableStringify(a.replay), stableStringify(b.replay));
    assert.deepEqual(a.equityCurve, b.equityCurve);
  });

  it("Legacy-Default bleibt unverändert (kein stiller Pfadwechsel)", () => {
    assert.equal(DEFAULT_BACKTEST_CONFIG.executionModel, "legacy");
    const candles = candlesFromCloses(T0, risingCloses(80));
    const result = runMultiAssetBacktest({
      candlesBySymbol: new Map([[SYM, candles]]),
      strategies: [{ type: "rule", spec: priceRule(SYM, 100), id: "R-LEGACY" }],
    });
    assert.equal(result.config.executionModel, "legacy");
    assert.equal(result.replay, undefined, "Legacy-Läufe tragen keine Replay-Evidenz");
  });
});

// ── 3) FAIL-CLOSED-LIQUIDITÄT ────────────────────────────────────────────────

describe("Depth-Fallback (konservativ, fail-closed)", () => {
  const SYM = "SIM:LIQ";

  it("fehlende Depth ⇒ Kerzenvolumen-Fallback, sichtbar degradiert", () => {
    const candles = candlesFromCloses(T0, risingCloses(60));
    const result = runMultiAssetBacktest({
      candlesBySymbol: new Map([[SYM, candles]]),
      strategies: [{ type: "rule", spec: priceRule(SYM, 100), id: "R-NODEPTH" }],
      config: {
        initialCapital: 10_000,
        warmupBars: 30,
        executionModel: "event_replay",
        replay: { seed: 1, instruments: { [SYM]: perpInstrument(SYM) }, events: [] },
      },
    });
    assert.ok(result.replay);
    assert.ok(result.replay.coverage.fillsFromBarVolumeFallback > 0);
    assert.equal(result.replay.coverage.fillsFromDepth, 0);
    assert.ok(result.replay.degradedReasons.includes("DEPTH_MISSING_BAR_VOLUME_FALLBACK"));
  });

  it("stale Depth ⇒ Fallback (Alter > maxDepthAgeMs), frische Depth gewinnt", () => {
    const candles = candlesFromCloses(T0, risingCloses(60));
    // Depth NUR bei T0 — ab Bar 30 (Signalphase) ist sie Stunden alt.
    const result = runMultiAssetBacktest({
      candlesBySymbol: new Map([[SYM, candles]]),
      strategies: [{ type: "rule", spec: priceRule(SYM, 100), id: "R-STALE" }],
      config: {
        initialCapital: 10_000,
        warmupBars: 30,
        executionModel: "event_replay",
        replay: {
          seed: 1,
          instruments: { [SYM]: perpInstrument(SYM) },
          events: [depth(SYM, T0, 1_000_000)],
          maxDepthAgeMs: H, // 1 Kerze
        },
      },
    });
    assert.ok(result.replay);
    assert.ok(result.replay.degradedReasons.includes("DEPTH_STALE_BAR_VOLUME_FALLBACK"));
    assert.equal(result.replay.coverage.fillsFromDepth, 0);
  });

  it("keine Depth UND kein Kerzenvolumen ⇒ KEIN Fill (nie erfundene Liquidität)", () => {
    const closes = risingCloses(60);
    const candles = candlesFromCloses(T0, closes).map((c) => ({ ...c, volume: 0 }));
    const result = runMultiAssetBacktest({
      candlesBySymbol: new Map([[SYM, candles]]),
      strategies: [{ type: "rule", spec: priceRule(SYM, 100), id: "R-NOVOL" }],
      config: {
        initialCapital: 10_000,
        warmupBars: 30,
        executionModel: "event_replay",
        replay: { seed: 1, instruments: { [SYM]: perpInstrument(SYM) }, events: [] },
      },
    });
    assert.ok(result.replay);
    assert.equal(result.trades.length, 0, "ohne Liquiditätsdaten kein einziger Fill");
    assert.equal(result.replay.coverage.ordersFilled, 0);
    assert.ok(result.replay.degradedReasons.includes("NO_LIQUIDITY_DATA_NO_FILL"));
    assert.ok(result.replay.degradedReasons.includes("ORDER_TTL_CANCELLED"));
    assert.ok(result.replay.coverage.ordersCancelled > 0);
  });
});

// ── 4) MENGEN-GUARDS ─────────────────────────────────────────────────────────

describe("Fillmengen-Guards (Depth- und Restmengen-Deckel)", () => {
  const SYM = "SIM:QTY";

  it("kein Fill überschreitet Depth oder Orderrestmenge", () => {
    const candles = new Map<string, CandleLike[]>([
      [SYM, [bar(T0, 100, { volume: 0 }), bar(T0 + H, 100, { volume: 0 }), bar(T0 + 2 * H, 100, { volume: 0 }), bar(T0 + 3 * H, 100, { volume: 0 })]],
    ]);
    const runtime = createEventReplayRuntime({
      options: {
        seed: 3,
        orderTtlBars: 10,
        instruments: { [SYM]: perpInstrument(SYM) },
        events: [depth(SYM, T0, 4), depth(SYM, T0 + H, 3), depth(SYM, T0 + 2 * H, 100)],
      },
      engineFeeModel: { makerFee: 0.0002, takerFee: 0.001 },
      barMs: H,
      candlesBySymbol: candles,
    });
    const portfolio = new BacktestPortfolio(engineConfig());
    const prices = new Map([[SYM, 100]]);
    const series = candles.get(SYM) as CandleLike[];
    for (let i = 0; i < series.length; i++) {
      const t = T0 + i * H;
      const bars = new Map([[SYM, { candle: series[i], index: i }]]);
      runtime.beginBar(t, i + 1, bars, prices, portfolio);
      if (i === 0) {
        runtime.submitEntry({
          strategyId: "R-QTY",
          symbol: SYM,
          side: "LONG",
          notional: 1000, // 10 Einheiten @ 100
          candle: series[i],
          now: t,
          barStep: i + 1,
          stopLoss: null,
          takeProfit: null,
          portfolio,
        });
      }
    }
    const summary = runtime.summary();
    const fills = summary.orderEvents.filter(
      (e) => e.type === "ORDER_PARTIAL_FILL" || e.type === "ORDER_FILL"
    );
    // Kerze 1: Depth 4 ⇒ Fill 4; Kerze 2: Depth 3 ⇒ Fill 3; Kerze 3: Rest 3 ≤ 100.
    assert.equal(fills.length, 3);
    const qtys = fills.map((f) => (f.type === "ORDER_PARTIAL_FILL" || f.type === "ORDER_FILL" ? f.qty : 0));
    assert.deepEqual(qtys, [4, 3, 3]);
    let remaining = 10;
    for (const f of fills) {
      if (f.type !== "ORDER_PARTIAL_FILL" && f.type !== "ORDER_FILL") continue;
      assert.ok(f.qty <= remaining + 1e-9, "Fill ≤ Restmenge");
      remaining -= f.qty;
      assert.ok(Math.abs(f.remainingQty - Math.max(0, remaining)) < 1e-9);
    }
    const pos = portfolio.getOpenPosition(SYM);
    assert.ok(pos);
    assert.ok(Math.abs(pos.qty - 10) < 1e-9, "Position = Summe der Fills, nie mehr");
  });

  it("Exit füllt nie mehr als die offene Positions-Restmenge", () => {
    const portfolio = new BacktestPortfolio(engineConfig());
    portfolio.openPosition(
      "S",
      SYM,
      "LONG",
      { fillPrice: 100, qty: 5, fees: 0, slippage: 0 },
      bar(T0, 100),
      1,
      null,
      null
    );
    // Versuch, 7 zu schließen (mehr als offen): abgewiesen, nichts gebucht.
    assert.equal(portfolio.applyPartialExit(SYM, { qty: 7, price: 101, fees: 0.1, slippage: 0 }), false);
    assert.equal(portfolio.getOpenPosition(SYM)?.qty, 5);
    // Exakte Restmenge geht.
    assert.equal(portfolio.applyPartialExit(SYM, { qty: 5, price: 101, fees: 0.1, slippage: 0 }), true);
    assert.equal(portfolio.getOpenPosition(SYM)?.qty, 0);
    const trade = portfolio.finalizeReplayPosition(SYM, T0 + H, 2, "SIGNAL_EXIT");
    assert.ok(trade);
    assert.equal(trade.qty, 5);
  });

  it("finalizeReplayPosition verweigert bei offener Restmenge (kein halber Trade)", () => {
    const portfolio = new BacktestPortfolio(engineConfig());
    portfolio.openPosition("S", SYM, "LONG", { fillPrice: 100, qty: 5, fees: 0, slippage: 0 }, bar(T0, 100), 1, null, null);
    portfolio.applyPartialExit(SYM, { qty: 2, price: 101, fees: 0, slippage: 0 });
    assert.equal(portfolio.finalizeReplayPosition(SYM, T0 + H, 2, "SIGNAL_EXIT"), null);
    assert.ok(portfolio.getOpenPosition(SYM), "Position bleibt offen");
    assert.equal(portfolio.trades.length, 0);
  });
});

// ── 5) FUNDING-FENSTER ───────────────────────────────────────────────────────

describe("Funding: nur offene Perp-Positionen im Ereignisfenster", () => {
  const SYM = "SIM:FUND";

  function runFunding(events: ReplayInputEvent[]) {
    const candles = new Map<string, CandleLike[]>([
      [SYM, [0, 1, 2, 3, 4].map((i) => bar(T0 + i * H, 100, { volume: 0 }))],
    ]);
    const runtime = createEventReplayRuntime({
      options: {
        seed: 5,
        instruments: { [SYM]: perpInstrument(SYM) },
        events: [...events, depth(SYM, T0, 1_000), depth(SYM, T0 + 2 * H, 1_000)],
      },
      engineFeeModel: { makerFee: 0.0002, takerFee: 0.001 },
      barMs: H,
      candlesBySymbol: candles,
    });
    const portfolio = new BacktestPortfolio(engineConfig());
    const prices = new Map([[SYM, 100]]);
    const series = candles.get(SYM) as CandleLike[];
    for (let i = 0; i < series.length; i++) {
      const t = T0 + i * H;
      const bars = new Map([[SYM, { candle: series[i], index: i }]]);
      runtime.beginBar(t, i + 1, bars, prices, portfolio);
      if (i === 0) {
        // Entry sofort (Latenz 0) @ T0.
        runtime.submitEntry({
          strategyId: "R-FUND", symbol: SYM, side: "LONG", notional: 1000,
          candle: series[i], now: t, barStep: i + 1, stopLoss: null, takeProfit: 150, portfolio,
        });
      }
      if (i === 2) {
        // Voller Exit @ T0+2H (TP via manueller Partial-Exit-Simulation nicht
        // nötig — direkter Portfolio-Zugriff hält den Test fokussiert).
        const pos = portfolio.getOpenPosition(SYM);
        if (pos) {
          portfolio.applyPartialExit(SYM, { qty: pos.qty, price: 100, fees: 0, slippage: 0 });
          portfolio.finalizeReplayPosition(SYM, t, i + 1, "SIGNAL_EXIT");
        }
      }
    }
    runtime.finish(T0 + 4 * H, 5, prices, portfolio);
    return { runtime, portfolio };
  }

  it("Funding vor Entry wird nicht gebucht (Ereigniszeit ≤ Entry)", () => {
    // eventTime exakt = Entry-Zeit T0 ⇒ Position galt zum Settlement nicht als offen.
    const { runtime, portfolio } = runFunding([fundingDue(SYM, T0, 0.0005, T0 + H)]);
    assert.equal(runtime.summary().coverage.fundingApplied, 0);
    assert.equal(runtime.summary().coverage.fundingSkipped, 1);
    assert.equal(portfolio.trades[0]?.funding, 0);
  });

  it("Funding nach Exit wird nicht gebucht", () => {
    // eventTime T0+2.5H (nach dem Exit bei T0+2H), verfügbar ab T0+3H.
    const { runtime, portfolio } = runFunding([fundingDue(SYM, T0 + 2 * H + 30 * 60_000, 0.0005, T0 + 3 * H)]);
    assert.equal(runtime.summary().coverage.fundingApplied, 0);
    assert.equal(portfolio.trades[0]?.funding, 0);
  });

  it("Funding während der Haltedauer wird exakt einmal gebucht", () => {
    const { runtime, portfolio } = runFunding([fundingDue(SYM, T0 + 90 * 60_000, 0.0005, T0 + 2 * H)]);
    // Verfügbar ab T0+2H ⇒ gebucht in beginBar(T0+2H) VOR dem Exit desselben Schritts.
    assert.equal(runtime.summary().coverage.fundingApplied, 1);
    const expected = -(0.0005 * 1 * 10 * 100); // LONG zahlt: 10 Einheiten @ Mark 100
    assert.equal(portfolio.trades[0]?.funding, Number(expected.toFixed(8)));
  });

  it("availableAt nach Simulationsende ⇒ Ereignis bleibt unsichtbar (kein Look-ahead)", () => {
    const { runtime, portfolio } = runFunding([fundingDue(SYM, T0 + H, 0.0005, T0 + 10 * H)]);
    assert.equal(runtime.summary().coverage.fundingApplied, 0);
    assert.equal(runtime.summary().coverage.fundingSkipped, 0, "nie verarbeitet, nicht einmal übersprungen");
    assert.equal(portfolio.trades[0]?.funding, 0);
  });

  it("Spot-Instrument zahlt nie Funding (fail-safe)", () => {
    const candles = new Map<string, CandleLike[]>([[SYM, [bar(T0, 100), bar(T0 + H, 100)]]]);
    const runtime = createEventReplayRuntime({
      options: {
        seed: 5,
        instruments: {
          [SYM]: fallbackInstrument("SIM", "FUND", { id: SYM, marketType: "spot", makerFee: 0.0002, takerFee: 0.001 }),
        },
        events: [depth(SYM, T0, 1_000), fundingDue(SYM, T0 + 30 * 60_000, 0.0005, T0 + H)],
      },
      engineFeeModel: { makerFee: 0.0002, takerFee: 0.001 },
      barMs: H,
      candlesBySymbol: candles,
    });
    const portfolio = new BacktestPortfolio(engineConfig());
    const prices = new Map([[SYM, 100]]);
    const series = candles.get(SYM) as CandleLike[];
    for (let i = 0; i < 2; i++) {
      const bars = new Map([[SYM, { candle: series[i], index: i }]]);
      runtime.beginBar(T0 + i * H, i + 1, bars, prices, portfolio);
      if (i === 0) {
        runtime.submitEntry({
          strategyId: "S", symbol: SYM, side: "LONG", notional: 1000,
          candle: series[i], now: T0, barStep: 1, stopLoss: null, takeProfit: null, portfolio,
        });
      }
    }
    assert.equal(runtime.summary().coverage.fundingApplied, 0);
    assert.equal(runtime.summary().coverage.fundingSkipped, 1);
  });
});

// ── 6) NEGATIVE PATHS (Events + Config) ──────────────────────────────────────

describe("Fail-closed-Validierung", () => {
  const SYM = "SIM:BAD";

  it("availableAt < eventTime wird abgewiesen (rückwärts laufende Zeit)", () => {
    assert.throws(
      () => validateReplayInputEvent({ ...depth(SYM, T0 + H, 5), availableAt: T0 }, 0),
      (e: unknown) => e instanceof EventReplayError && e.code === "replay:invalid-event"
    );
  });

  it("invalide Quotes/Bars/Depth/Funding werden abgewiesen", () => {
    const cases: ReplayInputEvent[] = [
      { ...quote(SYM, T0, 101, 100) }, // bid > ask
      { type: "MARKET_BAR", symbol: SYM, eventTime: T0, availableAt: T0, open: 100, high: 101, low: -1, close: 100, volume: 10 },
      { ...depth(SYM, T0, -5) },
      { ...fundingDue(SYM, T0, 0.5) }, // 50 %/8h — außerhalb der Bounds
      { ...fundingDue(SYM, T0, 0.0001), intervalHours: 48 },
      { ...depth(SYM, T0, 5), symbol: "" },
      { ...depth(SYM, Number.NaN, 5) },
    ];
    for (const [i, event] of cases.entries()) {
      assert.throws(
        () => validateReplayInputEvent(event, i),
        (e: unknown) => e instanceof EventReplayError && e.code === "replay:invalid-event",
        `Case ${i} muss abgewiesen werden`
      );
    }
  });

  it("negative Latenz/ungültige Config wird abgewiesen (kein stiller Default)", () => {
    assert.throws(
      () => resolveEventReplayConfig({ latency: { submitToArrivalMs: -1 } }, H),
      (e: unknown) => e instanceof EventReplayError && e.code === "replay:invalid-config"
    );
    assert.throws(
      () => resolveEventReplayConfig({ maxBarVolumeParticipation: 0 }, H),
      (e: unknown) => e instanceof EventReplayError && e.code === "replay:invalid-config"
    );
    assert.throws(
      () => resolveEventReplayConfig({ orderTtlBars: 0.5 }, H),
      (e: unknown) => e instanceof EventReplayError && e.code === "replay:invalid-config"
    );
    assert.throws(
      () => resolveEventReplayConfig({}, 0),
      (e: unknown) => e instanceof EventReplayError && e.code === "replay:invalid-config"
    );
  });

  it("ein invalides Ereignis bricht den ganzen Engine-Lauf ab (kein Teil-Lauf)", () => {
    const candles = candlesFromCloses(T0, risingCloses(40));
    assert.throws(
      () =>
        runMultiAssetBacktest({
          candlesBySymbol: new Map([[SYM, candles]]),
          strategies: [{ type: "rule", spec: priceRule(SYM, 100), id: "R-BAD" }],
          config: {
            executionModel: "event_replay",
            replay: { events: [{ ...depth(SYM, T0 + H, 5), availableAt: T0 }] },
          },
        }),
      (e: unknown) => e instanceof EventReplayError && e.code === "replay:invalid-event"
    );
  });

  it("kanonische Sortierung: Zeit ↑, Typ-Priorität, Symbol, Einfüge-Reihenfolge", () => {
    const events: ReplayInputEvent[] = [
      fundingDue("B", T0, 0.0001),
      quote("A", T0, 99, 101),
      depth("A", T0, 5),
      depth("A", T0 - H, 5),
      depth("B", T0, 7),
      depth("A", T0, 6),
    ];
    const sorted = sortReplayEvents(events);
    assert.deepEqual(
      sorted.map((e) => `${e.eventTime === T0 - H ? "t-1" : "t0"}:${e.type}:${e.symbol}${e.type === "MARKET_DEPTH" ? `:${e.askQty}` : ""}`),
      [
        "t-1:MARKET_DEPTH:A:5",
        "t0:MARKET_DEPTH:A:5", // Einfüge-Reihenfolge als letzter Tie-Break
        "t0:MARKET_DEPTH:A:6",
        "t0:MARKET_DEPTH:B:7",
        "t0:MARKET_QUOTE:A",
        "t0:FUNDING_DUE:B",
      ]
    );
    // Stabilität: Sortierung mutiert die Eingabe nicht.
    assert.equal(events[0].type, "FUNDING_DUE");
  });
});

// ── 7) PERP-HISTORIE → FUNDING_DUE ───────────────────────────────────────────

describe("perpFundingRowsToReplayEvents (kanonische Historie → Ereignisse)", () => {
  function fundingRow(overrides: Partial<PerpFundingRow>): PerpFundingRow {
    return {
      kind: "funding",
      venue: "SIM",
      instrumentId: "SIM:XUSDT",
      symbol: "XUSDT",
      sourceId: "sim:funding_history",
      schemaVersion: 1,
      eventTime: new Date(T0),
      availableAt: new Date(T0),
      fetchedAt: new Date(T0),
      fundingRate: 0.0001,
      intervalHours: 8,
      nextFundingTime: null,
      markPrice: null,
      unit: "fraction_per_interval",
      qualityStatus: "OK",
      missingReason: null,
      contentHash: "pv1:test",
      ...overrides,
    };
  }

  it("übersetzt Rate je Intervall in Rate je 8h und übernimmt availableAt", () => {
    const { events, skipped } = perpFundingRowsToReplayEvents({
      engineSymbol: "SIM:XUSDT",
      venue: "SIM",
      rows: [
        fundingRow({ fundingRate: 0.0001, intervalHours: 8 }),
        fundingRow({ fundingRate: 0.00005, intervalHours: 4, eventTime: new Date(T0 + H), availableAt: new Date(T0 + 2 * H) }),
      ],
      defaultIntervalHours: 8,
    });
    assert.equal(skipped, 0);
    assert.equal(events.length, 2);
    assert.equal(events[0].ratePer8h, 0.0001);
    assert.equal(events[0].intervalHours, 8);
    // 4h-Intervall: Rate ×2 auf 8h-Basis, Intervall bleibt 4h.
    assert.equal(events[1].ratePer8h, 0.0001);
    assert.equal(events[1].intervalHours, 4);
    assert.equal(events[1].eventTime, T0 + H);
    assert.equal(events[1].availableAt, T0 + 2 * H);
  });

  it("Zeilen ohne Rate/mit kaputten Zeiten werden gezählt übersprungen (nie 0 erfunden)", () => {
    const { events, skipped } = perpFundingRowsToReplayEvents({
      engineSymbol: "SIM:XUSDT",
      venue: "SIM",
      rows: [
        fundingRow({ fundingRate: null }),
        fundingRow({ fundingRate: 0.5 }), // außerhalb der Bounds
        fundingRow({ availableAt: new Date(T0 - H) }), // availableAt < eventTime
        fundingRow({}),
      ],
      defaultIntervalHours: 8,
    });
    assert.equal(events.length, 1);
    assert.equal(skipped, 3);
  });
});

// ── 8) WALK-FORWARD + TRADE-LEDGER ───────────────────────────────────────────

describe("Walk-Forward mit event_replay (Persistenz-Verdrahtung)", () => {
  const SYM = "SIM:WF";

  function runWf(executionModel: "paper" | "event_replay") {
    const candles = candlesFromCloses(T0, waveCloses(750));
    const events: ReplayInputEvent[] = [];
    for (let i = 0; i < 750; i += 4) events.push(depth(SYM, T0 + i * H, 100_000));
    return runWalkForward({
      instrumentId: SYM,
      timeframe: "1h",
      candles,
      strategies: [{ type: "rule", spec: priceRule(SYM, 100), id: "R-WF" }],
      ruleRef: { ruleId: null, ruleKey: null, name: "WF-Replay", signature: "sig-wf", ruleSymbol: SYM },
      engineConfig:
        executionModel === "event_replay"
          ? {
              initialCapital: 10_000,
              warmupBars: 30,
              executionModel: "event_replay",
              replay: { seed: 9, instruments: { [SYM]: perpInstrument(SYM) }, events },
            }
          : {
              initialCapital: 10_000,
              warmupBars: 30,
              executionModel: "paper",
              paper: {
                simulator: {
                  makerFeeFallback: 0.0002, takerFeeFallback: 0.0006, latencyMs: 0,
                  slippageBpsBase: 1, slippageBpsPerParticipation: 0, slippageJitterBps: 0,
                  partialFillEnabled: false, partialFillMaxFraction: 1, seed: 42,
                  volume24hFallback: 10_000_000, syntheticSpreadBps: 4,
                },
              },
            },
      walkforward: { isDays: 14, oosDays: 7 },
      nowMs: T0,
    });
  }

  it("Report trägt executionModel, Modellversion und Replay-Evidenz", () => {
    const report = runWf("event_replay");
    assert.equal(report.costProfile.executionModel, "event_replay");
    assert.equal(report.costProfile.frictionModelVersion, "er1");
    assert.equal(report.costProfile.simulatorSeed, 9);
    assert.ok(report.replayEvidence, "Replay-Evidenz vorhanden");
    assert.equal(report.replayEvidence.config.seed, 9);
    assert.ok(report.replayEvidence.coverage.bars > 0);
    assert.ok(report.trades.length > 0, "Fixture muss Trades erzeugen");
    // Paper-Report bleibt unverändert (kein Modellversions-Leak).
    const paperReport = runWf("paper");
    assert.equal(paperReport.costProfile.executionModel, "paper");
    assert.equal(paperReport.costProfile.frictionModelVersion, null);
    assert.equal(paperReport.replayEvidence, undefined);
  });

  it("Trade-Ledger: Zeilen tragen Replay-Provenance und reconcilen exakt", () => {
    const report = runWf("event_replay");
    const runId = "11111111-2222-3333-4444-555555555555";
    const rows = mapReportTrades(report, runId);
    assert.equal(rows.length, report.trades.length);
    for (const row of rows) {
      assert.equal(row.provenanceJson.executionModel, "event_replay");
      assert.ok(row.provenanceJson.replay, `Zeile seq ${row.seq}: Replay-Detail fehlt`);
      assert.equal(row.provenanceJson.replay.frictionModelVersion, "er1");
      assert.ok(row.provenanceJson.replay.fills.length > 0);
    }
    const reconciliation = reconcileTradeLedger(report, rows);
    assert.equal(reconciliation.status, "RECONCILED");
    assert.equal(reconciliation.tradeCount, rows.length);
  });

  it("Idempotency-Key unterscheidet Replay- und Paper-Läufe (Modell im Key)", () => {
    const replayKey = backtestRunIdempotencyKey(runWf("event_replay"));
    const paperKey = backtestRunIdempotencyKey(runWf("paper"));
    assert.notEqual(replayKey, paperKey);
    // Derselbe Replay-Lauf ⇒ derselbe Key (Retry = Replay, kein Duplikat).
    assert.equal(replayKey, backtestRunIdempotencyKey(runWf("event_replay")));
  });

  it("Determinismus: zweifacher Walk-Forward-Replay-Lauf ist byte-identisch", () => {
    const a = runWf("event_replay");
    const b = runWf("event_replay");
    assert.equal(stableStringify(a.windows), stableStringify(b.windows));
    assert.equal(stableStringify(a.trades), stableStringify(b.trades));
    assert.equal(stableStringify(a.replayEvidence), stableStringify(b.replayEvidence));
  });
});

// ── 9) PERFORMANCE (bounded, realistisches Fixture) ──────────────────────────

describe("Performance-Deckel", () => {
  it("2 Jahre Stundenkerzen + Events replayen in unter 10 s", () => {
    const SYM = "SIM:PERF";
    const bars = 17_520; // 2 Jahre à 8760 h
    const closes = waveCloses(bars, 100, 0.1, 60);
    const candles = candlesFromCloses(T0, closes);
    const events: ReplayInputEvent[] = [];
    for (let i = 0; i < bars; i += 8) events.push(depth(SYM, T0 + i * H, 50_000));
    const started = performance.now();
    const result = runMultiAssetBacktest({
      candlesBySymbol: new Map([[SYM, candles]]),
      strategies: [{ type: "rule", spec: priceRule(SYM, 100), id: "R-PERF" }],
      config: {
        initialCapital: 10_000,
        warmupBars: 30,
        executionModel: "event_replay",
        replay: { seed: 2, instruments: { [SYM]: perpInstrument(SYM) }, events },
      },
    });
    const elapsed = performance.now() - started;
    assert.ok(result.trades.length > 0, "Fixture muss Trades erzeugen");
    assert.ok(elapsed < 10_000, `Replay dauerte ${Math.round(elapsed)} ms (> 10 s)`);
  });
});
