/**
 * CTI × Multi-Asset-Backtest-Engine — Integrationstests.
 *
 * Deckung (Definition of Done):
 *   1. KEIN LOOK-AHEAD: Spätere Kerzen ändern keinen Trade bis t; die
 *      Strategie sieht pro Bar genau eine geschlossene Kerze und nichts
 *      sonst (Vertragstest auf `BacktestSignalBar`).
 *   2. SIGNAL ⇒ TRADE: Einstiegszeit/-richtung stimmen mit dem Indikator
 *      überein, der Stop ist der ATR-Stop des Signalbars.
 *   3. AUSSTIEGE: Stop-Treffer (`STOP_LOSS`) und Umkehrsignal
 *      (`SIGNAL_EXIT`); kein Trade läuft ohne Grund weiter.
 *   4. GUARDRAILS: Ohne Short-Freigabe wird aus dem Verkaufssignal ein
 *      Glattstellen — nie ein stiller Short, nie eine offene Gegenposition.
 *   5. DETERMINISMUS: Zwei Läufe ⇒ identische Trades (auch über den
 *      Paper-Pfad).
 *   6. KOSTEN: Gebühren/Slippage senken das Ergebnis — der Lauf rechnet
 *      nicht kostenlos.
 *   7. FAIL-CLOSED: `event_replay` + Signalstrategie wird abgelehnt.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { runMultiAssetBacktest, type BacktestEngineOptions } from "../src/backtest";
import {
  createCtiSignalStrategy,
  ctiStrategyItem,
  runCtiBacktest,
} from "../src/signals/cti/backtest";
import { computeCtiSeries, ctiSignals } from "../src/signals/cti/runtime";
import { CTI_DEFAULT_WARMUP_BARS } from "../src/signals/cti/params";
import type { BacktestSignalBar } from "../src/backtest/types";
import { oscillatingSeries, toEngineCandles } from "./cti.fixtures";

const SYMBOL = "BTCUSDT";
const SERIES = oscillatingSeries();
const CANDLES = toEngineCandles(SERIES);
const CTI_BARS = computeCtiSeries(SERIES);
const SIGNALS = ctiSignals(CTI_BARS);

/** Kostenfreier, deterministischer Lauf — Preise bleiben vergleichbar. */
const FRICTIONLESS: BacktestEngineOptions = {
  initialCapital: 100_000,
  executionModel: "legacy",
  slippageModel: "none",
  fixedSlippageBps: 0,
  feeModel: { makerFee: 0, takerFee: 0 },
  enableShorts: true,
  warmupBars: CTI_DEFAULT_WARMUP_BARS,
  maxOpenPositions: 5,
};

function run(config: Partial<BacktestEngineOptions> = {}, options = {}) {
  return runMultiAssetBacktest({
    candlesBySymbol: { [SYMBOL]: CANDLES },
    strategies: [ctiStrategyItem(SYMBOL, options)],
    config: { ...FRICTIONLESS, ...config },
  });
}

describe("CTI-Backtest — Kausalität", () => {
  it("die Strategie sieht pro Bar genau eine geschlossene Kerze", () => {
    const seen: BacktestSignalBar[] = [];
    const result = runMultiAssetBacktest({
      candlesBySymbol: { [SYMBOL]: CANDLES },
      strategies: [
        {
          type: "signal",
          signal: {
            id: "probe",
            symbol: SYMBOL,
            onBar(bar) {
              seen.push(bar);
              return null;
            },
          },
        },
      ],
      config: FRICTIONLESS,
    });

    assert.equal(result.barsProcessed, CANDLES.length);
    assert.equal(seen.length, CANDLES.length, "jede Kerze genau einmal");
    for (let i = 0; i < seen.length; i += 1) {
      assert.deepEqual(seen[i].candle, CANDLES[i], `Bar ${i} ist die Kerze dieses Schritts`);
      assert.equal(seen[i].index, i);
      assert.equal(seen[i].barStep, i + 1, "barStep ist 1-basiert wie in der Engine");
      assert.equal(seen[i].time, CANDLES[i].time);
      assert.equal(seen[i].warmup, i + 1 < CTI_DEFAULT_WARMUP_BARS);
      assert.equal(
        Object.prototype.hasOwnProperty.call(seen[i], "series"),
        false,
        "die Strategie bekommt KEINE Kerzenreihe — Zukunft ist strukturell unerreichbar",
      );
    }
  });

  it("spätere Kerzen ändern keinen Trade bis t", () => {
    const full = run();
    const cut = CANDLES.length - 60;
    const truncated = runMultiAssetBacktest({
      candlesBySymbol: { [SYMBOL]: CANDLES.slice(0, cut) },
      strategies: [ctiStrategyItem(SYMBOL)],
      config: FRICTIONLESS,
    });
    const limit = CANDLES[cut - 1].time;
    const key = (trade: { entryTime: number; exitTime: number; entryPrice: number; side: string }) =>
      `${trade.side}|${trade.entryTime}|${trade.entryPrice.toFixed(8)}|${trade.exitTime}`;

    const fullClosed = full.trades.filter((trade) => trade.exitTime <= limit).map(key);
    const cutClosed = truncated.trades
      .filter((trade) => trade.exitReason !== "END_OF_DATA" && trade.exitTime <= limit)
      .map(key);
    assert.deepEqual(cutClosed, fullClosed, "abgeschlossene Trades bis t müssen identisch sein");
  });

  it("zwei Läufe sind identisch (Determinismus) — auch über den Paper-Pfad", () => {
    const a = run();
    const b = run();
    assert.deepEqual(a.trades, b.trades);
    assert.deepEqual(a.metrics, b.metrics);

    const paperA = run({ executionModel: "paper", slippageModel: "fixed", fixedSlippageBps: 5 });
    const paperB = run({ executionModel: "paper", slippageModel: "fixed", fixedSlippageBps: 5 });
    assert.deepEqual(paperA.trades, paperB.trades);
  });
});

describe("CTI-Backtest — Signale werden zu Trades", () => {
  it("jeder Einstieg liegt auf einem Signalbar und übernimmt dessen Richtung", () => {
    const result = run();
    assert.ok(result.trades.length > 0, "kein einziger Trade — Test wäre wirkungslos");
    const byTime = new Map(SIGNALS.map((bar) => [bar.time, bar]));
    for (const trade of result.trades) {
      const signal = byTime.get(trade.entryTime);
      assert.ok(signal, `Einstieg ${trade.entryTime} ohne zugehöriges Signal`);
      assert.equal(trade.side, signal.signal === "BUY" ? "LONG" : "SHORT");
      // Die Engine rundet den Fill-Preis auf 6 Nachkommastellen.
      assert.ok(
        Math.abs(trade.entryPrice - signal.close) < 1e-5,
        `Einstieg ${trade.entryPrice} ≠ Schlusskurs ${signal.close} des Signalbars`,
      );
    }
  });

  it("Warmup-Signale werden nicht gehandelt", () => {
    const result = run();
    const firstTradableTime = CANDLES[CTI_DEFAULT_WARMUP_BARS - 1].time;
    for (const trade of result.trades) {
      assert.ok(trade.entryTime >= firstTradableTime, `Trade im Warmup: ${trade.entryTime}`);
    }
  });

  it("der Stop stammt aus dem ATR des Signalbars und beendet den Trade", () => {
    const result = run();
    const byTime = new Map(CTI_BARS.map((bar) => [bar.time, bar]));
    const signalByTime = new Map(SIGNALS.map((bar) => [bar.time, bar]));

    // Einstieg: Der Stop ist exakt der eingefrorene ATR-Stop des Signalbars.
    for (const trade of result.trades) {
      const signal = signalByTime.get(trade.entryTime);
      assert.ok(signal);
      const stop = trade.side === "LONG" ? signal.activeLongStop : signal.activeShortStop;
      assert.ok(stop !== null && stop > 0, "Signalbar ohne ATR-Stop");
      const distance = Math.abs(signal.close - (stop as number));
      assert.ok(
        Math.abs(distance - (signal.readings.atr as number) * 3) < 1e-9,
        "Stop-Distanz ist nicht ATR × Multiplikator",
      );
    }

    // Ausstieg: Der Stop gilt in der Fassung, die zum Ausstiegszeitpunkt
    // aktiv ist (ein erneutes Signal derselben Richtung schärft ihn nach).
    const stopped = result.trades.filter((trade) => trade.exitReason === "STOP_LOSS");
    assert.ok(stopped.length > 0, "kein Stop-Ausstieg in der Testreihe");
    for (const trade of stopped) {
      const bar = byTime.get(trade.exitTime);
      assert.ok(bar);
      const stop = (trade.side === "LONG" ? bar.activeLongStop : bar.activeShortStop) as number;
      // Ausstieg zum Stop (kostenfreier Lauf ⇒ bis auf die Rundung exakt)
      // oder schlechter durch eine Kurslücke — nie zufällig daneben.
      const gapped = trade.side === "LONG" ? trade.exitPrice < stop : trade.exitPrice > stop;
      assert.ok(
        Math.abs(trade.exitPrice - stop) < 1e-4 || gapped,
        `Ausstieg ${trade.exitPrice} passt nicht zum Stop ${String(stop)}`,
      );
    }
  });

  it("ein erneutes Signal derselben Richtung schärft den Stop nach, ohne aufzustocken", () => {
    const result = run();
    const entries = result.trades.map((trade) => trade.entryTime);
    assert.equal(new Set(entries).size, entries.length, "doppelter Einstieg auf derselben Kerze");

    // Zu jedem Trade gibt es mindestens ein weiteres gleichgerichtetes Signal
    // innerhalb der Haltedauer — sonst würde der Nachschärf-Pfad nie laufen.
    const rearmed = result.trades.filter((trade) =>
      SIGNALS.some(
        (bar) =>
          bar.time > trade.entryTime &&
          bar.time <= trade.exitTime &&
          (bar.signal === "BUY") === (trade.side === "LONG"),
      ),
    );
    assert.ok(rearmed.length > 0, "keine Nachschärfung in der Testreihe — Test wäre wirkungslos");
  });

  it("ein Umkehrsignal dreht die Position (SIGNAL_EXIT, kein Doppelbestand)", () => {
    const result = run();
    const flips = result.trades.filter((trade) => trade.exitReason === "SIGNAL_EXIT");
    assert.ok(flips.length > 0, "keine Umkehr in der Testreihe");
    for (const flip of flips) {
      const next = result.trades.find(
        (trade) => trade.symbol === flip.symbol && trade.entryTime === flip.exitTime,
      );
      assert.ok(next, "nach dem Umkehr-Ausstieg fehlt der Gegeneinstieg");
      assert.notEqual(next.side, flip.side);
    }
    // Zu keinem Zeitpunkt zwei gleichzeitig offene Trades desselben Symbols.
    const sorted = [...result.trades].sort((a, b) => a.entryTime - b.entryTime);
    for (let i = 1; i < sorted.length; i += 1) {
      assert.ok(
        sorted[i].entryTime >= sorted[i - 1].exitTime,
        `Überlappung zwischen ${sorted[i - 1].entryTime} und ${sorted[i].entryTime}`,
      );
    }
  });
});

describe("CTI-Backtest — Guardrails", () => {
  it("ohne Short-Freigabe entsteht kein Short, aber die Long-Position wird geschlossen", () => {
    const result = run({ enableShorts: false });
    assert.ok(result.trades.length > 0);
    assert.ok(
      result.trades.every((trade) => trade.side === "LONG"),
      "Short trotz enableShorts = false",
    );
    const sellTimes = new Set(SIGNALS.filter((bar) => bar.signal === "SELL").map((bar) => bar.time));
    for (const trade of result.trades) {
      if (trade.exitReason !== "SIGNAL_EXIT") continue;
      assert.ok(sellTimes.has(trade.exitTime), "SIGNAL_EXIT ohne Verkaufssignal");
    }
  });

  it("tradeShorts = false verhält sich wie ein Long-only-Lauf", () => {
    const longOnly = run({ enableShorts: true }, { tradeShorts: false });
    assert.ok(longOnly.trades.every((trade) => trade.side === "LONG"));
    assert.deepEqual(
      longOnly.trades.map((trade) => trade.entryTime),
      run({ enableShorts: false }).trades.map((trade) => trade.entryTime),
    );
  });

  it("closeOpposite = false lässt die bestehende Position bis zum Stop laufen", () => {
    const base = run();
    assert.ok(
      base.trades.some((trade) => trade.exitReason === "SIGNAL_EXIT"),
      "Vergleichslauf dreht nicht — Test wäre wirkungslos",
    );
    const result = run({}, { closeOpposite: false });
    assert.equal(
      result.trades.filter((trade) => trade.exitReason === "SIGNAL_EXIT").length,
      0,
      "trotz closeOpposite = false wurde gedreht",
    );
    assert.ok(
      result.trades.every((trade) => trade.exitReason === "STOP_LOSS" || trade.exitReason === "END_OF_DATA"),
      "ohne Drehung bleiben nur Stop und Laufzeitende als Ausstieg",
    );
  });

  it("maxOpenPositions begrenzt parallele Symbole", () => {
    const second = CANDLES.map((candle) => ({ ...candle }));
    const result = runMultiAssetBacktest({
      candlesBySymbol: { [SYMBOL]: CANDLES, ETHUSDT: second },
      strategies: [ctiStrategyItem(SYMBOL), ctiStrategyItem("ETHUSDT")],
      config: { ...FRICTIONLESS, maxOpenPositions: 1 },
    });
    const open: { start: number; end: number }[] = result.trades.map((trade) => ({
      start: trade.entryTime,
      end: trade.exitTime,
    }));
    for (let i = 0; i < open.length; i += 1) {
      for (let k = i + 1; k < open.length; k += 1) {
        const overlap = open[i].start < open[k].end && open[k].start < open[i].end;
        assert.equal(overlap, false, "mehr als eine Position gleichzeitig offen");
      }
    }
  });

  it("die Equity-Kurve stimmt mit der Summe der Trade-PnL überein (auch short)", () => {
    const result = run();
    assert.ok(
      result.trades.some((trade) => trade.side === "SHORT"),
      "kein Short im Lauf — Test wäre wirkungslos",
    );
    const sum = result.trades.reduce((total, trade) => total + trade.pnl, 0);
    const delta = result.metrics.endingEquity - result.metrics.startingEquity;
    assert.ok(
      Math.abs(delta - sum) < 0.01,
      `Equity-Delta ${delta.toFixed(4)} ≠ Σ Trade-PnL ${sum.toFixed(4)}`,
    );
    const last = result.equityCurve[result.equityCurve.length - 1];
    assert.ok(Math.abs(last.equity - result.metrics.endingEquity) < 0.01);
  });

  it("Kosten verschlechtern das Ergebnis messbar", () => {
    const free = run();
    const costly = run({
      slippageModel: "fixed",
      fixedSlippageBps: 25,
      feeModel: { makerFee: 0.0004, takerFee: 0.0012 },
    });
    assert.ok(costly.metrics.totalFeesPaid > 0);
    assert.ok(costly.metrics.totalSlippagePaid > 0);
    assert.ok(
      costly.metrics.endingEquity < free.metrics.endingEquity,
      "Kosten ohne Wirkung auf die Equity",
    );
  });

  it("event_replay + Signalstrategie wird abgelehnt (fail-closed)", () => {
    assert.throws(
      () =>
        runMultiAssetBacktest({
          candlesBySymbol: { [SYMBOL]: CANDLES.slice(0, 250) },
          strategies: [ctiStrategyItem(SYMBOL)],
          config: { ...FRICTIONLESS, executionModel: "event_replay" },
        }),
      /event_replay/i,
    );
  });
});

describe("CTI-Backtest — runCtiBacktest", () => {
  it("setzt den Warmup mindestens auf den Bedarf des Indikators", () => {
    const outcome = runCtiBacktest({
      candlesBySymbol: { [SYMBOL]: CANDLES },
      config: { ...FRICTIONLESS, warmupBars: 10 },
    });
    assert.equal(outcome.warmupBars, CTI_DEFAULT_WARMUP_BARS);
    assert.equal(outcome.result.config.warmupBars, CTI_DEFAULT_WARMUP_BARS);
  });

  it("meldet Indikator-Signale getrennt von den ausgeführten Trades", () => {
    const outcome = runCtiBacktest({
      candlesBySymbol: { [SYMBOL]: CANDLES },
      config: FRICTIONLESS,
    });
    const stats = outcome.signals[SYMBOL];
    const tradable = SIGNALS.filter((bar) => bar.index + 1 >= CTI_DEFAULT_WARMUP_BARS);
    assert.equal(stats.buy + stats.sell, tradable.length);
    assert.equal(stats.lastSignalAt, tradable[tradable.length - 1].time);
    assert.equal(stats.lastBar?.index, CANDLES.length - 1);
    assert.ok(outcome.result.trades.length <= stats.buy + stats.sell);
  });

  it("gibt die geklemmten Parameter zurück, statt sie zu verschlucken", () => {
    const outcome = runCtiBacktest({
      candlesBySymbol: { [SYMBOL]: CANDLES.slice(0, 220) },
      options: { params: { atrMultiplier: -1 } },
      config: FRICTIONLESS,
    });
    assert.deepEqual(outcome.clamped, ["atrMultiplier"]);
    assert.equal(outcome.params.atrMultiplier, 0.1);
  });

  it("jede Strategie hält ihren eigenen Automaten", () => {
    const a = createCtiSignalStrategy("AAA");
    const b = createCtiSignalStrategy("BBB");
    assert.notEqual(a.runtime, b.runtime);
    assert.equal(a.id, "cti:AAA");
    assert.equal(b.id, "cti:BBB");
  });
});
