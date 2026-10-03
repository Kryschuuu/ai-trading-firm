/**
 * Gemeinsame Fixtures für die CTI-Tests (Indikator, Backtest, Trading-Engine).
 *
 * Alles hier ist deterministisch: Der Zufall kommt aus einem linearen
 * Kongruenzgenerator mit festem Seed, nie aus `Math.random()`. Zwei Läufe
 * derselben Parameter liefern byte-identische Kerzen — sonst wären
 * Determinismus-Tests wertlos.
 */

import type { CtiCandle } from "../src/signals/cti/types";

const HOUR_MS = 3_600_000;
/** Fester Startzeitpunkt (2023-11-14T22:13:20Z) — keine `Date.now()`-Abhängigkeit. */
export const FIXTURE_START_MS = 1_700_000_000_000;

/** Linearer Kongruenzgenerator (Numerical Recipes) — reproduzierbar. */
export function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export interface SeriesSpec {
  bars: number;
  start: number;
  /** Relative Drift je Bar (z. B. 0.006 = +0,6 %). */
  drift: (index: number) => number;
  /** Spannweite des multiplikativen Rauschens. */
  noise: number;
  seed: number;
  startMs?: number;
}

/** Baut eine synthetische Kerzenreihe (konsistente OHLC-Beziehungen). */
export function makeSeries(spec: SeriesSpec): CtiCandle[] {
  const rnd = lcg(spec.seed);
  const startMs = spec.startMs ?? FIXTURE_START_MS;
  const out: CtiCandle[] = [];
  let price = spec.start;
  for (let i = 0; i < spec.bars; i += 1) {
    const step = spec.drift(i) + (rnd() - 0.5) * spec.noise;
    const open = price;
    price = Math.max(1, price * (1 + step));
    out.push({
      time: startMs + i * HOUR_MS,
      high: Math.max(open, price) * (1 + rnd() * 0.002),
      low: Math.min(open, price) * (1 - rnd() * 0.002),
      close: price,
      volume: 1000 + rnd() * 500 + (step > 0 ? 400 : 0),
    });
  }
  return out;
}

/**
 * Standardreihe der CTI-Tests: 240 Bars Abwärtsdrift, danach 180 Bars
 * Rally. Ergibt mit den Default-Parametern sowohl SELL- als auch
 * BUY-Signale (beide Richtungen werden also wirklich getestet).
 */
export function trendReversalSeries(seed = 42): CtiCandle[] {
  return makeSeries({
    bars: 420,
    start: 100,
    drift: (i) => (i < 240 ? -0.0015 : 0.006),
    noise: 0.006,
    seed,
  });
}

/** Reine Aufwärtsreihe ohne Umkehr (nur BUY-Signale). */
export function bullSeries(seed = 7, bars = 360): CtiCandle[] {
  return makeSeries({ bars, start: 50, drift: () => 0.004, noise: 0.005, seed });
}

/** Kerzen in das `CandleLike`-Format der Backtest-Engine (mit `open`). */
export function toEngineCandles(
  candles: readonly CtiCandle[],
): { time: number; open: number; high: number; low: number; close: number; volume: number }[] {
  return candles.map((candle, index) => ({
    time: candle.time,
    open: index === 0 ? candle.close : (candles[index - 1] as CtiCandle).close,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
  }));
}

/**
 * Schwingende Reihe (Sinus + Rauschen): erzeugt abwechselnd BUY- und
 * SELL-Signale und damit echte Positionswechsel — die Grundlage der
 * Backtest-/Engine-Integrationstests.
 */
export function oscillatingSeries(seed = 99, bars = 1200, period = 120, amplitude = 0.35): CtiCandle[] {
  const rnd = lcg(seed);
  const out: CtiCandle[] = [];
  let previous = 100;
  for (let i = 0; i < bars; i += 1) {
    const base = 100 * (1 + amplitude * Math.sin((2 * Math.PI * i) / period));
    const close = Math.max(1, base * (1 + (rnd() - 0.5) * 0.01));
    out.push({
      time: FIXTURE_START_MS + i * HOUR_MS,
      high: Math.max(previous, close) * (1 + rnd() * 0.002),
      low: Math.min(previous, close) * (1 - rnd() * 0.002),
      close,
      volume: 1000 + rnd() * 500 + (close > previous ? 400 : 0),
    });
    previous = close;
  }
  return out;
}
