/**
 * CTI-Trading-Engine (`src/signals/cti/engine.ts`) — Tests.
 *
 * Deckung (Definition of Done):
 *   1. ABSICHTEN: Einstieg, Umkehr, Stop-Ausstieg und Stop-Nachschärfung
 *      entstehen in der richtigen Reihenfolge (Schutz vor Signal).
 *   2. KEIN STOP AUF DER EINSTIEGSKERZE: Die Position existiert erst ab
 *      deren Schluss — ein vorher gelaufenes Tief darf sie nicht treffen.
 *   3. AUSFÜHRUNGS-PORT: Ohne Freigabe kein Zustandswechsel; wirft der Port,
 *      bleibt die Engine bei ihrer Sicht (fail-closed).
 *   4. PARITÄT: Dieselben Ein-/Ausstiegszeitpunkte wie im Backtest — Live
 *      und Simulation teilen sich denselben Automaten.
 *   5. IO-FREIHEIT: `src/signals/**` importiert weder DB, Broker noch LLM.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import {
  CtiTradingEngine,
  type CtiExecutionPort,
  type CtiIntent,
} from "../src/signals/cti/engine";
import { computeCtiSeries, ctiSignals } from "../src/signals/cti/runtime";
import { CTI_DEFAULT_WARMUP_BARS } from "../src/signals/cti/params";
import type { CtiCandle } from "../src/signals/cti/types";
import { runMultiAssetBacktest, type BacktestEngineOptions } from "../src/backtest";
import { ctiStrategyItem } from "../src/signals/cti/backtest";
import { oscillatingSeries, toEngineCandles } from "./cti.fixtures";

const SYMBOL = "BTCUSDT";
const SERIES = oscillatingSeries();
const BARS = computeCtiSeries(SERIES);
const SIGNALS = ctiSignals(BARS);

/** Port, der alles annimmt und protokolliert. */
function recordingPort(log: CtiIntent[]): CtiExecutionPort {
  return {
    name: "recorder",
    apply(intent) {
      log.push(intent);
      return { ok: true };
    },
  };
}

async function feed(engine: CtiTradingEngine, candles: readonly CtiCandle[]): Promise<CtiIntent[]> {
  const intents: CtiIntent[] = [];
  for (const candle of candles) {
    const step = await engine.onClosedCandle(SYMBOL, candle);
    intents.push(...step.applied);
  }
  return intents;
}

describe("CTI-Trading-Engine — Absichten", () => {
  it("ein Kaufsignal eröffnet long mit dem eingefrorenen ATR-Stop", async () => {
    const engine = new CtiTradingEngine();
    const intents = await feed(engine, SERIES.slice(0, 400));
    const firstBuy = SIGNALS.find((bar) => bar.signal === "BUY" && bar.index < 400);
    assert.ok(firstBuy);
    const entry = intents.find((intent) => intent.kind === "ENTER" && intent.side === "LONG");
    assert.ok(entry, "kein Einstieg trotz Kaufsignal");
    assert.equal(entry.time, firstBuy.time);
    assert.equal(entry.price, firstBuy.close);
    assert.equal(entry.stopLoss, firstBuy.activeLongStop);
    assert.equal(entry.reason, "SIGNAL");
  });

  it("ein Umkehrsignal schließt zuerst und eröffnet danach", async () => {
    const engine = new CtiTradingEngine();
    const log: CtiIntent[] = [];
    const recorder = new CtiTradingEngine({ port: recordingPort(log) });
    for (const candle of SERIES) {
      await engine.onClosedCandle(SYMBOL, candle);
      await recorder.onClosedCandle(SYMBOL, candle);
    }
    const flips: { exit: CtiIntent; enter: CtiIntent }[] = [];
    for (let i = 1; i < log.length; i += 1) {
      if (log[i - 1].kind === "EXIT" && log[i - 1].reason === "OPPOSITE_SIGNAL" && log[i].kind === "ENTER") {
        flips.push({ exit: log[i - 1], enter: log[i] });
      }
    }
    assert.ok(flips.length > 0, "keine Umkehr in der Testreihe");
    for (const flip of flips) {
      assert.equal(flip.exit.time, flip.enter.time, "Umkehr passiert auf einer Kerze");
      assert.notEqual(flip.exit.side, flip.enter.side);
      assert.equal(flip.exit.price, flip.enter.price, "beide zum Schlusskurs dieser Kerze");
    }
  });

  it("der Stop wird vor dem Signal geprüft und zum Stop-Preis ausgeführt", async () => {
    const log: CtiIntent[] = [];
    const engine = new CtiTradingEngine({ port: recordingPort(log) });
    await feed(engine, SERIES);
    const stops = log.filter((intent) => intent.reason === "STOP_LOSS");
    assert.ok(stops.length > 0, "kein Stop-Ausstieg in der Testreihe");
    for (const stop of stops) {
      assert.equal(stop.kind, "EXIT");
      assert.equal(stop.price, stop.stopLoss, "Ausstieg zum Stop-Preis, nicht zum Schluss");
      const candle = SERIES.find((item) => item.time === stop.time) as CtiCandle;
      if (stop.side === "LONG") assert.ok(candle.low <= (stop.stopLoss as number));
      else assert.ok(candle.high >= (stop.stopLoss as number));
    }
  });

  it("die Einstiegskerze selbst löst den Stop nicht aus", async () => {
    const engine = new CtiTradingEngine();
    const steps: { time: number; intents: CtiIntent[] }[] = [];
    for (const candle of SERIES) {
      const step = await engine.onClosedCandle(SYMBOL, candle);
      steps.push({ time: candle.time, intents: step.intents });
    }
    for (const step of steps) {
      const hasEnter = step.intents.some((intent) => intent.kind === "ENTER");
      const hasStop = step.intents.some((intent) => intent.reason === "STOP_LOSS");
      assert.ok(
        !(hasEnter && hasStop && step.intents.findIndex((intent) => intent.kind === "ENTER") <
          step.intents.findIndex((intent) => intent.reason === "STOP_LOSS")),
        `Stop nach Einstieg auf derselben Kerze (${step.time})`,
      );
    }
  });

  it("ein Signal in bereits offener Richtung stockt nicht auf, sondern schärft den Stop nach", async () => {
    const log: CtiIntent[] = [];
    const engine = new CtiTradingEngine({ port: recordingPort(log), params: { atrMultiplier: 100 } });
    await feed(engine, SERIES);
    const enters = log.filter((intent) => intent.kind === "ENTER");
    const rearms = log.filter((intent) => intent.kind === "ADJUST_STOP");
    assert.ok(rearms.length > 0, "keine Stop-Nachschärfung — Test wäre wirkungslos");
    for (const rearm of rearms) assert.equal(rearm.reason, "REARM_STOP");
    // Kein doppelter Einstieg in dieselbe Richtung ohne Ausstieg dazwischen.
    let open: string | null = null;
    for (const intent of log) {
      if (intent.kind === "ENTER") {
        assert.equal(open, null, `Nachkauf auf ${intent.time}`);
        open = intent.side;
      } else if (intent.kind === "EXIT") {
        open = null;
      }
    }
    assert.ok(enters.length > 0);
  });

  it("Long-only: das Verkaufssignal schließt, eröffnet aber nichts", async () => {
    const log: CtiIntent[] = [];
    const engine = new CtiTradingEngine({ port: recordingPort(log), tradeShorts: false });
    await feed(engine, SERIES);
    assert.ok(log.length > 0);
    assert.ok(
      log.filter((intent) => intent.kind === "ENTER").every((intent) => intent.side === "LONG"),
      "Short trotz tradeShorts = false",
    );
    const sellTimes = new Set(SIGNALS.filter((bar) => bar.signal === "SELL").map((bar) => bar.time));
    const oppositeExits = log.filter((intent) => intent.reason === "OPPOSITE_SIGNAL");
    assert.ok(oppositeExits.length > 0, "Verkaufssignal hat die Long-Position nicht geschlossen");
    for (const exit of oppositeExits) {
      assert.equal(exit.side, "LONG");
      assert.ok(sellTimes.has(exit.time));
    }
  });
});

describe("CTI-Trading-Engine — Ausführungs-Port", () => {
  it("ohne Freigabe ändert sich der Zustand nicht", async () => {
    const engine = new CtiTradingEngine({
      port: { name: "veto", apply: () => ({ ok: false, reason: "KILL_SWITCH_ARMED" }) },
    });
    let rejected = 0;
    for (const candle of SERIES.slice(0, 400)) {
      const step = await engine.onClosedCandle(SYMBOL, candle);
      rejected += step.rejected.length;
      assert.equal(step.position, null, "Position trotz abgelehnter Order");
      assert.deepEqual(step.applied, []);
    }
    assert.ok(rejected > 0, "Port wurde nie gefragt — Test wäre wirkungslos");
    assert.equal(engine.positionOf(SYMBOL), null);
    assert.equal(engine.status().symbols[0].rejected, rejected);
  });

  it("ein werfender Port wird als Ablehnung gewertet (fail-closed)", async () => {
    const engine = new CtiTradingEngine({
      port: {
        name: "broken",
        apply: () => {
          throw new TypeError("Netzwerk weg");
        },
      },
    });
    const reasons: string[] = [];
    for (const candle of SERIES.slice(0, 400)) {
      const step = await engine.onClosedCandle(SYMBOL, candle);
      for (const item of step.rejected) reasons.push(item.reason);
    }
    assert.ok(reasons.length > 0);
    assert.ok(reasons.every((reason) => reason === "PORT_ERROR:TypeError"));
    assert.equal(engine.positionOf(SYMBOL), null);
  });

  it("der Port darf einen abweichenden Ausführungskurs melden", async () => {
    const engine = new CtiTradingEngine({
      port: { name: "slippy", apply: (intent) => ({ ok: true, fillPrice: intent.price * 1.01 }) },
    });
    const firstBuy = SIGNALS.find((bar) => bar.signal === "BUY");
    assert.ok(firstBuy);
    for (const candle of SERIES.slice(0, firstBuy.index + 1)) {
      await engine.onClosedCandle(SYMBOL, candle);
    }
    const position = engine.positionOf(SYMBOL);
    assert.ok(position);
    assert.equal(position.entryPrice, firstBuy.close * 1.01);
    assert.equal(position.stopLoss, firstBuy.activeLongStop, "der Stop bleibt der des Signals");
  });

  it("evaluate() verändert die Positionssicht nicht", async () => {
    const engine = new CtiTradingEngine();
    const firstBuy = SIGNALS.find((bar) => bar.signal === "BUY");
    assert.ok(firstBuy);
    for (const candle of SERIES.slice(0, firstBuy.index)) engine.evaluate(SYMBOL, candle);
    const evaluation = engine.evaluate(SYMBOL, SERIES[firstBuy.index]);
    assert.equal(evaluation.intents.length, 1);
    assert.equal(engine.positionOf(SYMBOL), null, "evaluate() hat eine Position angelegt");
    engine.commit(evaluation.intents[0]);
    assert.equal(engine.positionOf(SYMBOL)?.side, "LONG");
  });

  it("register() wärmt auf, ohne Absichten zu erzeugen", async () => {
    const engine = new CtiTradingEngine();
    engine.register(SYMBOL, SERIES.slice(0, 400));
    const status = engine.status().symbols[0];
    assert.equal(status.bars, 400);
    assert.equal(status.warm, true);
    assert.equal(status.position, null, "Seeding darf keine Position erzeugen");
    assert.equal(status.intents, 0);
    assert.equal(engine.lastBarOf(SYMBOL)?.index, 399);
  });

  it("adoptPosition() übernimmt eine bestehende Position zur Abstimmung mit dem Broker", async () => {
    const engine = new CtiTradingEngine();
    engine.register(SYMBOL, SERIES.slice(0, 400));
    engine.adoptPosition({
      symbol: SYMBOL,
      side: "LONG",
      entryPrice: SERIES[399].close,
      stopLoss: SERIES[399].close * 0.999,
      entryTime: SERIES[399].time,
      entryBarIndex: 399,
    });
    const step = await engine.onClosedCandle(SYMBOL, SERIES[400]);
    const exits = step.intents.filter((intent) => intent.kind === "EXIT");
    assert.equal(exits.length, 1, "der übernommene Stop wird ab der Folgekerze geprüft");
    assert.equal(exits[0].reason, "STOP_LOSS");
    assert.equal(engine.positionOf(SYMBOL), null);
  });

  it("der Status meldet Aufwärmstand, Streak und Verdikt", () => {
    const engine = new CtiTradingEngine();
    engine.register(SYMBOL, SERIES.slice(0, 50));
    const cold = engine.status();
    assert.equal(cold.symbols[0].warm, false);
    assert.equal(cold.symbols[0].warmupBars, CTI_DEFAULT_WARMUP_BARS);
    assert.equal(cold.port, null);
    assert.equal(cold.tradeShorts, true);
    assert.deepEqual(cold.clamped, []);

    engine.register(SYMBOL, SERIES.slice(50, 400));
    const warm = engine.status().symbols[0];
    assert.equal(warm.warm, true);
    assert.equal(warm.verdict, BARS[399].verdict);
    assert.equal(warm.bullStreak, BARS[399].bullStreak);
    assert.equal(warm.bearStreak, BARS[399].bearStreak);
  });

  it("geklemmte Parameter sind am Status ablesbar", () => {
    const engine = new CtiTradingEngine({ params: { persistBars: 0 } });
    assert.deepEqual(engine.clamped, ["persistBars"]);
    assert.equal(engine.params.persistBars, 1);
  });
});

describe("CTI-Trading-Engine — Parität zum Backtest", () => {
  it("Live-Engine und Backtest handeln dieselben Zeitpunkte", async () => {
    const config: BacktestEngineOptions = {
      initialCapital: 100_000,
      executionModel: "legacy",
      slippageModel: "none",
      fixedSlippageBps: 0,
      feeModel: { makerFee: 0, takerFee: 0 },
      enableShorts: true,
      warmupBars: CTI_DEFAULT_WARMUP_BARS,
      maxOpenPositions: 5,
    };
    const backtest = runMultiAssetBacktest({
      candlesBySymbol: { [SYMBOL]: toEngineCandles(SERIES) },
      strategies: [ctiStrategyItem(SYMBOL)],
      config,
    });

    const log: CtiIntent[] = [];
    const engine = new CtiTradingEngine({ port: recordingPort(log) });
    await feed(engine, SERIES);

    // Einstiege der Live-Engine ab dem Warmup — der Backtest handelt vorher
    // bewusst nicht.
    const firstTradable = SERIES[CTI_DEFAULT_WARMUP_BARS - 1].time;
    const liveEntries = log
      .filter((intent) => intent.kind === "ENTER" && intent.time >= firstTradable)
      .map((intent) => `${intent.side}@${intent.time}`);
    const backtestEntries = backtest.trades.map((trade) => `${trade.side}@${trade.entryTime}`);
    assert.deepEqual(liveEntries, backtestEntries);

    const liveExits = log
      .filter((intent) => intent.kind === "EXIT" && intent.time >= firstTradable)
      .map((intent) => intent.time);
    const backtestExits = backtest.trades
      .filter((trade) => trade.exitReason !== "END_OF_DATA")
      .map((trade) => trade.exitTime);
    assert.deepEqual(liveExits, backtestExits);
  });
});

describe("CTI — Architektur", () => {
  it("src/signals/** ist frei von IO (keine DB-, Broker- oder LLM-Importe)", () => {
    const root = path.join(process.cwd(), "src", "signals");
    const forbidden = [
      /from\s+["'][^"']*\/db["']/,
      /from\s+["'][^"']*\/db\//,
      /from\s+["'][^"']*broker/i,
      /from\s+["'][^"']*\/llm/i,
      /from\s+["']next\//,
      /from\s+["']drizzle-orm/,
    ];
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return walk(full);
        return entry.name.endsWith(".ts") ? [full] : [];
      });
    const files = walk(root);
    assert.ok(files.length >= 6, "Signal-Modul unerwartet leer");
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const pattern of forbidden) {
        assert.equal(pattern.test(source), false, `${path.relative(root, file)} verletzt ${pattern}`);
      }
    }
  });

  it("der Indikator bringt keine Laufzeit-Abhängigkeit mit", () => {
    const pkg = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    for (const name of Object.keys(pkg.dependencies)) {
      assert.equal(/technicalindicators|tulind|talib|pinets/i.test(name), false, `TA-Bibliothek ${name}`);
    }
  });
});
