/**
 * Claude Trading Indicator (CTI) — Indikator-Tests.
 *
 * Deckung (Definition of Done):
 *   1. KONSENS: Zwei-Stufen-Logik als Invariante über die gesamte Reihe —
 *      Dimension nur bei Einstimmigkeit, Verdikt nur bei Einstimmigkeit über
 *      alle EINGESCHALTETEN Dimensionen.
 *   2. FILTER: `persistBars` feuert genau einmal je Strecke (Pine prüft
 *      Gleichheit), `minBarsBetween` sperrt und holt NICHTS nach.
 *   3. KAUSALITÄT: Das Ergebnis der ersten k Kerzen ist unabhängig davon, ob
 *      man k oder n Kerzen auswertet (kein Look-ahead, kein Repainting).
 *   4. PARITÄT: Streaming (`CtiRuntime.push`) == Batch (`computeCtiSeries`)
 *      — es gibt nur EINE Implementierung, und dieser Test hält das fest.
 *   5. STOPS: ATR-Stop beim Signal eingefroren, Trefferprüfung gegen
 *      `low`/`high`.
 *   6. FAIL-CLOSED: unbrauchbare Kerzen und Zeitsprünge werfen.
 *   7. PARAMETER/AUSGABE: Klemmung sichtbar, Dashboard- und Alert-Wortlaut
 *      wie im Skript.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  CTI_COMPONENTS,
  CTI_DEFAULT_WARMUP_BARS,
  CTI_PARAM_BOUNDS,
  DEFAULT_CTI_PARAMS,
  ctiWarmupBars,
  resolveCtiParams,
} from "../src/signals/cti/params";
import { CtiRuntime, computeCtiSeries, ctiSignals } from "../src/signals/cti/runtime";
import { CtiInputError, type CtiBar, type CtiCandle } from "../src/signals/cti/types";
import {
  ctiAlertMessage,
  ctiDashboardRows,
  ctiVerdictLabel,
  ctiVoteLabel,
  renderCtiDashboard,
} from "../src/signals/cti/dashboard";
import { FIXTURE_START_MS, bullSeries, trendReversalSeries } from "./cti.fixtures";

const HOUR_MS = 3_600_000;
const SERIES = trendReversalSeries();
const BARS = computeCtiSeries(SERIES);

function candle(partial: Partial<CtiCandle> & { time: number }): CtiCandle {
  return { high: 101, low: 99, close: 100, volume: 10, ...partial };
}

describe("CTI — Zwei-Stufen-Konsens", () => {
  it("die Testreihe erzeugt überhaupt Signale in beide Richtungen", () => {
    const signals = ctiSignals(BARS);
    assert.ok(signals.length >= 8, `zu wenige Signale für einen Aussagetest: ${signals.length}`);
    assert.ok(signals.some((bar) => bar.signal === "BUY"), "kein BUY in der Testreihe");
    assert.ok(signals.some((bar) => bar.signal === "SELL"), "kein SELL in der Testreihe");
  });

  it("eine Dimension ist nur bei Einstimmigkeit ihrer Komponenten gerichtet", () => {
    for (const bar of BARS) {
      const trend = [bar.votes.ema, bar.votes.supertrend, bar.votes.bollinger];
      const momentum = [bar.votes.macd, bar.votes.rsi, bar.votes.stoch];
      for (const [name, components, dimension] of [
        ["trend", trend, bar.dimensions.trend],
        ["momentum", momentum, bar.dimensions.momentum],
      ] as const) {
        const allBull = components.every((vote) => vote === 1);
        const allBear = components.every((vote) => vote === -1);
        const expected = allBull ? 1 : allBear ? -1 : 0;
        assert.equal(dimension, expected, `${name} auf Bar ${bar.index}: ${components.join(",")}`);
      }
      assert.equal(bar.dimensions.volatility, bar.votes.dmi, "Volatilität = DMI-Votum");
      assert.equal(bar.dimensions.volume, bar.votes.obv, "Volumen = OBV-Votum");
    }
  });

  it("das Verdikt verlangt Einstimmigkeit über alle eingeschalteten Dimensionen", () => {
    for (const bar of BARS) {
      assert.equal(bar.enabledCount, 4, "Default: alle vier Dimensionen aktiv");
      const votes = [
        bar.dimensions.trend,
        bar.dimensions.momentum,
        bar.dimensions.volatility,
        bar.dimensions.volume,
      ];
      assert.equal(bar.bullCount, votes.filter((vote) => vote === 1).length);
      assert.equal(bar.bearCount, votes.filter((vote) => vote === -1).length);
      const expected = bar.bullCount === 4 ? "BULL" : bar.bearCount === 4 ? "BEAR" : "NONE";
      assert.equal(bar.verdict, expected, `Verdikt auf Bar ${bar.index}`);
    }
  });

  it("ein einziges neutrales Votum verhindert das Verdikt", () => {
    const blocked = BARS.filter(
      (bar) => bar.bullCount === 3 && bar.bearCount === 0 && bar.verdict === "NONE",
    );
    assert.ok(blocked.length > 0, "Testreihe enthält keinen 3:0-Fall — Test wäre wirkungslos");
  });

  it("Komponenten-Voten folgen exakt ihren Vergleichen", () => {
    for (const bar of BARS) {
      const { readings, votes } = bar;
      assert.equal(votes.ema, sign(bar.close, readings.ema), `EMA-Votum Bar ${bar.index}`);
      assert.equal(votes.bollinger, sign(bar.close, readings.bollingerBasis));
      assert.equal(votes.macd, sign(readings.macd, readings.macdSignal));
      assert.equal(votes.rsi, sign(readings.rsi, 50));
      assert.equal(votes.stoch, sign(readings.stochK, readings.stochD));
      assert.equal(votes.obv, sign(readings.obv, readings.obvMa));
      assert.equal(votes.supertrend, readings.supertrendDirection < 0 ? 1 : -1);
    }
  });

  it("die Volatilitäts-Dimension bleibt unter der ADX-Schwelle neutral", () => {
    let weak = 0;
    for (const bar of BARS) {
      const adx = bar.readings.adx;
      if (adx === null || adx < CTI_COMPONENTS.adxMinStrength) {
        assert.equal(bar.dimensions.volatility, 0, `Bar ${bar.index}: ADX ${String(adx)}`);
        weak += 1;
      } else {
        assert.equal(bar.dimensions.volatility, sign(bar.readings.diPlus, bar.readings.diMinus));
      }
    }
    assert.ok(weak > 0, "Testreihe enthält keine schwache Phase — Test wäre wirkungslos");
  });

  it("abgeschaltete Dimensionen zählen nicht mit", () => {
    const reduced = computeCtiSeries(SERIES, { useVolume: false, useVolatility: false });
    assert.ok(reduced.every((bar) => bar.enabledCount === 2));
    for (const bar of reduced) {
      const expected = bar.dimensions.trend === 1 && bar.dimensions.momentum === 1
        ? "BULL"
        : bar.dimensions.trend === -1 && bar.dimensions.momentum === -1
          ? "BEAR"
          : "NONE";
      assert.equal(bar.verdict, expected);
    }
    // Weniger Bedingungen können ein Verdikt nur ERMÖGLICHEN, nie verhindern:
    // Jeder BULL-Bar des vollen Laufs ist auch im reduzierten Lauf BULL.
    // (Bei den SIGNALEN gilt das nicht — die Sperrfrist verschiebt sich.)
    for (const bar of BARS) {
      if (bar.verdict === "NONE") continue;
      assert.equal(reduced[bar.index].verdict, bar.verdict, `Bar ${bar.index}`);
    }
    // Mit nur noch EINER Dimension wird die Hürde sichtbar niedriger.
    const single = computeCtiSeries(SERIES, {
      useTrend: false,
      useMomentum: false,
      useVolume: false,
    });
    assert.ok(
      single.filter((bar) => bar.verdict !== "NONE").length >
        BARS.filter((bar) => bar.verdict !== "NONE").length,
      "eine einzelne Dimension muss deutlich öfter ein Verdikt liefern",
    );
  });

  it("ohne eingeschaltete Dimension feuert der Indikator nie", () => {
    const none = computeCtiSeries(SERIES, {
      useTrend: false,
      useMomentum: false,
      useVolatility: false,
      useVolume: false,
    });
    assert.ok(none.every((bar) => bar.enabledCount === 0));
    assert.ok(none.every((bar) => bar.verdict === "NONE"));
    assert.equal(ctiSignals(none).length, 0);
  });
});

describe("CTI — Persistenz- und Sperrfrist-Filter", () => {
  it("ein Signal feuert nur auf dem Bar, auf dem die Strecke exakt persistBars erreicht", () => {
    for (const bar of ctiSignals(BARS)) {
      const streak = bar.signal === "BUY" ? bar.bullStreak : bar.bearStreak;
      assert.equal(streak, DEFAULT_CTI_PARAMS.persistBars, `Bar ${bar.index}`);
    }
  });

  it("eine längere Strecke erzeugt kein zweites Signal", () => {
    const params = { persistBars: 1, minBarsBetween: 0 };
    const bars = computeCtiSeries(SERIES, params);
    const streakStarts = bars.filter(
      (bar, index) => bar.verdict !== "NONE" && (index === 0 || bars[index - 1].verdict !== bar.verdict),
    ).length;
    assert.equal(ctiSignals(bars).length, streakStarts, "ein Signal je Strecke, nicht je Bar");
  });

  it("die Sperrfrist hält den Mindestabstand ein und meldet ihn transparent", () => {
    const signals = ctiSignals(BARS);
    for (let i = 1; i < signals.length; i += 1) {
      const gap = signals[i].index - signals[i - 1].index;
      assert.ok(
        gap >= DEFAULT_CTI_PARAMS.minBarsBetween,
        `Abstand ${gap} < ${DEFAULT_CTI_PARAMS.minBarsBetween} (Bar ${signals[i].index})`,
      );
      assert.equal(signals[i].barsSinceSignal, gap, "barsSinceSignal = Abstand zum Vorgänger");
    }
    assert.equal(signals[0].barsSinceSignal, null, "vor dem ersten Signal gibt es keinen Abstand");
  });

  it("ein in der Sperrfrist verlorenes Signal wird NICHT nachgeholt", () => {
    const strict = computeCtiSeries(SERIES, { minBarsBetween: 60 });
    const loose = computeCtiSeries(SERIES, { minBarsBetween: 0 });
    assert.ok(ctiSignals(strict).length < ctiSignals(loose).length);

    // Entscheidend: Nach Ablauf der Sperrfrist feuert der Indikator nicht
    // einfach auf dem nächsten Bar nach — eine neue Strecke muss entstehen.
    for (const bar of ctiSignals(strict)) {
      const streak = bar.signal === "BUY" ? bar.bullStreak : bar.bearStreak;
      assert.equal(streak, DEFAULT_CTI_PARAMS.persistBars, `Bar ${bar.index} ist kein Nachhol-Signal`);
    }
  });

  it("BUY und SELL schließen sich auf demselben Bar aus", () => {
    for (const bar of BARS) {
      assert.ok(!(bar.bullStreak > 0 && bar.bearStreak > 0), `Bar ${bar.index}`);
    }
  });

  it("persistBars > 1 ist strenger als persistBars = 1", () => {
    const fast = ctiSignals(computeCtiSeries(SERIES, { persistBars: 1, minBarsBetween: 0 }));
    const slow = ctiSignals(computeCtiSeries(SERIES, { persistBars: 4, minBarsBetween: 0 }));
    assert.ok(slow.length < fast.length);
  });
});

describe("CTI — Kausalität und Determinismus", () => {
  it("die ersten k Bars hängen nicht von späteren Kerzen ab (kein Look-ahead)", () => {
    for (const k of [50, 201, 260, 333, SERIES.length]) {
      const prefix = computeCtiSeries(SERIES.slice(0, k));
      assert.deepEqual(prefix, BARS.slice(0, k), `Präfix der Länge ${k} weicht ab`);
    }
  });

  it("Streaming und Batch liefern identische Bars", () => {
    const runtime = new CtiRuntime();
    const streamed = SERIES.map((bar) => runtime.push(bar));
    assert.deepEqual(streamed, BARS);
    assert.equal(runtime.bars, SERIES.length);
    assert.deepEqual(runtime.last, BARS[BARS.length - 1]);
  });

  it("zwei Läufe sind byte-identisch", () => {
    assert.equal(JSON.stringify(computeCtiSeries(SERIES)), JSON.stringify(BARS));
  });

  it("vor dem Aufwärmbedarf kann kein Signal entstehen", () => {
    const first = ctiSignals(BARS)[0];
    assert.ok(first.index + 1 >= CTI_DEFAULT_WARMUP_BARS, `erstes Signal auf Bar ${first.index + 1}`);
    assert.equal(CTI_DEFAULT_WARMUP_BARS, 201, "EMA 200 + 2 Persistenz-Bars − 1");
    const short = computeCtiSeries(SERIES.slice(0, CTI_DEFAULT_WARMUP_BARS - 1));
    assert.equal(ctiSignals(short).length, 0);
  });

  it("ein anderer Zeitraster ändert nichts an der Logik (nur Kerzenfolge zählt)", () => {
    const shifted = SERIES.map((bar, index) => ({ ...bar, time: bar.time + index * 60_000 }));
    const shiftedBars = computeCtiSeries(shifted);
    assert.deepEqual(
      shiftedBars.map((bar) => bar.signal),
      BARS.map((bar) => bar.signal),
    );
  });
});

describe("CTI — Stops", () => {
  it("der Stop ist ATR-basiert und beim Signal eingefroren", () => {
    const signals = ctiSignals(BARS);
    const buy = signals.find((bar) => bar.signal === "BUY") as CtiBar;
    const atr = buy.readings.atr as number;
    assert.ok(atr > 0);
    assert.equal(buy.longStop, buy.close - atr * DEFAULT_CTI_PARAMS.atrMultiplier);
    assert.equal(buy.activeLongStop, buy.longStop, "beim Signal wird der Stop übernommen");

    // Kein Nachziehen: Bis zum nächsten BUY bleibt der aktive Stop konstant.
    const nextBuy = signals.find((bar) => bar.signal === "BUY" && bar.index > buy.index) as CtiBar;
    for (const bar of BARS.slice(buy.index + 1, nextBuy.index)) {
      assert.equal(bar.activeLongStop, buy.activeLongStop, `Bar ${bar.index} hat den Stop verschoben`);
    }
  });

  it("der Multiplikator skaliert die Stop-Distanz linear", () => {
    const wide = computeCtiSeries(SERIES, { atrMultiplier: 6 });
    const bar = wide[300];
    const atr = bar.readings.atr as number;
    assert.equal(bar.longStop, bar.close - atr * 6);
    assert.equal(bar.shortStop, bar.close + atr * 6);
  });

  it("der Stop-Treffer beendet die Strecke und wird gemeldet", () => {
    const hits = BARS.filter((bar) => bar.stopHit !== null);
    assert.ok(hits.length > 0, "Testreihe trifft nie einen Stop — Test wäre wirkungslos");
    for (const hit of hits) {
      const candleAt = SERIES[hit.index];
      if (hit.stopHit === "LONG") {
        assert.ok(candleAt.low <= (hit.activeLongStop as number));
        assert.equal(hit.inLongTrade, false, "nach dem Treffer ist die Strecke zu");
      } else {
        assert.ok(candleAt.high >= (hit.activeShortStop as number));
        assert.equal(hit.inShortTrade, false);
      }
    }
  });

  it("ohne ATR (Aufwärmphase) gibt es keinen Stop — keine stille 0", () => {
    const early = BARS.slice(0, DEFAULT_CTI_PARAMS.atrLength - 1);
    assert.ok(early.every((bar) => bar.longStop === null && bar.shortStop === null));
  });
});

describe("CTI — Eingabeprüfung (fail-closed)", () => {
  it("rückwärts laufende Zeit wird abgewiesen", () => {
    const runtime = new CtiRuntime();
    runtime.push(candle({ time: FIXTURE_START_MS + HOUR_MS }));
    assert.throws(
      () => runtime.push(candle({ time: FIXTURE_START_MS })),
      (error: unknown) => error instanceof CtiInputError && error.code === "NON_MONOTONIC_TIME",
    );
  });

  it("derselbe Zeitstempel zweimal wird abgewiesen", () => {
    const runtime = new CtiRuntime();
    runtime.push(candle({ time: FIXTURE_START_MS }));
    assert.throws(
      () => runtime.push(candle({ time: FIXTURE_START_MS })),
      (error: unknown) => error instanceof CtiInputError && error.code === "DUPLICATE_BAR",
    );
  });

  it("unbrauchbare Kerzenwerte werden abgewiesen", () => {
    const cases: Partial<CtiCandle>[] = [
      { high: 99, low: 101 },
      { close: 0 },
      { close: -5 },
      { volume: -1 },
      { close: Number.NaN },
      { high: Number.POSITIVE_INFINITY },
      { time: Number.NaN },
    ];
    for (const broken of cases) {
      const runtime = new CtiRuntime();
      assert.throws(
        () => runtime.push(candle({ time: FIXTURE_START_MS, ...broken })),
        (error: unknown) => error instanceof CtiInputError && error.code === "INVALID_CANDLE",
        `akzeptiert ${JSON.stringify(broken)}`,
      );
    }
  });

  it("ein abgewiesener Bar verändert den Zustand nicht", () => {
    const runtime = new CtiRuntime();
    for (const bar of bullSeries().slice(0, 40)) runtime.push(bar);
    const before = runtime.state();
    assert.throws(() => runtime.push(candle({ time: before.lastTime as number })), CtiInputError);
    assert.deepEqual(runtime.state(), before);
  });
});

describe("CTI — Parameter", () => {
  it("die Voreinstellungen entsprechen dem Skript", () => {
    assert.deepEqual(DEFAULT_CTI_PARAMS, {
      useTrend: true,
      useMomentum: true,
      useVolatility: true,
      useVolume: true,
      atrLength: 14,
      atrMultiplier: 3,
      persistBars: 2,
      minBarsBetween: 10,
    });
    assert.equal(CTI_COMPONENTS.emaLength, 200);
    assert.equal(CTI_COMPONENTS.supertrendFactor, 3);
    assert.equal(CTI_COMPONENTS.supertrendAtrPeriod, 10);
    assert.equal(CTI_COMPONENTS.bollingerLength, 20);
    assert.equal(CTI_COMPONENTS.bollingerMult, 2);
    assert.equal(CTI_COMPONENTS.macdFast, 12);
    assert.equal(CTI_COMPONENTS.macdSlow, 26);
    assert.equal(CTI_COMPONENTS.macdSignal, 9);
    assert.equal(CTI_COMPONENTS.rsiLength, 14);
    assert.equal(CTI_COMPONENTS.stochLength, 14);
    assert.equal(CTI_COMPONENTS.stochSmooth, 3);
    assert.equal(CTI_COMPONENTS.stochD, 3);
    assert.equal(CTI_COMPONENTS.adxLength, 14);
    assert.equal(CTI_COMPONENTS.adxSmoothing, 14);
    assert.equal(CTI_COMPONENTS.adxMinStrength, 20);
    assert.equal(CTI_COMPONENTS.volumeSmoothLength, 10);
  });

  it("unsinnige Parameter werden geklemmt und die Korrektur gemeldet", () => {
    const resolved = resolveCtiParams({
      atrLength: 0,
      atrMultiplier: Number.NaN,
      persistBars: 7.6,
      minBarsBetween: -3,
    });
    assert.equal(resolved.params.atrLength, CTI_PARAM_BOUNDS.atrLength.min);
    assert.equal(resolved.params.atrMultiplier, DEFAULT_CTI_PARAMS.atrMultiplier);
    assert.equal(resolved.params.persistBars, 7, "ganze Bars, Nachkommastellen abgeschnitten");
    assert.equal(resolved.params.minBarsBetween, CTI_PARAM_BOUNDS.minBarsBetween.min);
    assert.deepEqual(
      [...resolved.clamped].sort(),
      ["atrLength", "atrMultiplier", "minBarsBetween", "persistBars"],
    );
  });

  it("gültige Parameter bleiben unverändert und melden nichts", () => {
    const resolved = resolveCtiParams({ atrLength: 21, atrMultiplier: 2.5, persistBars: 3 });
    assert.deepEqual(resolved.clamped, []);
    assert.equal(resolved.params.atrLength, 21);
    assert.equal(resolved.params.atrMultiplier, 2.5);
    assert.equal(resolved.params.persistBars, 3);
    assert.equal(resolved.params.minBarsBetween, DEFAULT_CTI_PARAMS.minBarsBetween);
  });

  it("der Aufwärmbedarf folgt der langsamsten aktiven Dimension", () => {
    assert.equal(ctiWarmupBars(DEFAULT_CTI_PARAMS), 201);
    assert.equal(ctiWarmupBars({ ...DEFAULT_CTI_PARAMS, useTrend: false }), 35);
    assert.equal(
      ctiWarmupBars({ ...DEFAULT_CTI_PARAMS, useTrend: false, useMomentum: false }),
      29,
      "DMI(14,14) = 28 Bars + 2 Persistenz-Bars − 1",
    );
    assert.equal(ctiWarmupBars({ ...DEFAULT_CTI_PARAMS, persistBars: 5 }), 204);
  });
});

describe("CTI — Dashboard und Alerts", () => {
  const bar = BARS[BARS.length - 1];

  it("Beschriftungen entsprechen dem Skript", () => {
    assert.equal(ctiVoteLabel(1), "Bullish");
    assert.equal(ctiVoteLabel(-1), "Bearish");
    assert.equal(ctiVoteLabel(0), "Neutral");
    assert.equal(ctiVerdictLabel({ ...bar, verdict: "BULL" }), "BUY ZONE");
    assert.equal(ctiVerdictLabel({ ...bar, verdict: "BEAR" }), "SELL ZONE");
    assert.equal(ctiVerdictLabel({ ...bar, verdict: "NONE" }), "No Consensus");
  });

  it("die Tabelle zeigt Kopf, vier Dimensionen und Verdikt", () => {
    const rows = ctiDashboardRows(bar, DEFAULT_CTI_PARAMS);
    assert.deepEqual(
      rows.map((row) => row.label),
      ["CLAUDE TRADING INDICATOR", "Trend", "Momentum", "Volatility", "Volume", "Verdict"],
    );
    assert.equal(rows[0].value, `${bar.bullCount}B / ${bar.bearCount}S / ${bar.enabledCount}`);
    const rendered = renderCtiDashboard(bar, DEFAULT_CTI_PARAMS);
    assert.ok(rendered.includes("CLAUDE TRADING INDICATOR"));
    assert.ok(rendered.includes("Verdict"));
  });

  it("abgeschaltete Dimensionen erscheinen als „Off“", () => {
    const rows = ctiDashboardRows(bar, { ...DEFAULT_CTI_PARAMS, useVolume: false });
    assert.equal(rows[4].value, "Off");
  });

  it("der Alert-Wortlaut ist identisch zum Skript", () => {
    const signal = ctiSignals(BARS)[0];
    assert.equal(
      ctiAlertMessage(signal, { ticker: "BTCUSDT", interval: "60" }),
      `Claude Trading Indicator: ${signal.signal} signal on BTCUSDT (60)`,
    );
    const quiet = BARS.find((item) => item.signal === null) as CtiBar;
    assert.equal(ctiAlertMessage(quiet, { ticker: "BTCUSDT", interval: "60" }), null);
  });
});

/** Vergleichsvotum wie im Indikator (na ⇒ neutral). */
function sign(a: number | null, b: number | null): -1 | 0 | 1 {
  if (a === null || b === null) return 0;
  return a > b ? 1 : a < b ? -1 : 0;
}
