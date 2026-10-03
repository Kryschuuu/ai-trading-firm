/**
 * Pine-Primitiven (`src/signals/pine.ts`) — Tests.
 *
 * Deckung:
 *   1. SEMANTIK: Jeder Akkumulator wird gegen eine unabhängig im Test
 *      ausgeschriebene Referenzformel geprüft (SMA, EMA, RMA, σ, RSI, ATR,
 *      DMI/ADX) — nicht gegen sich selbst.
 *   2. `na`-VERHALTEN: Pine liefert `na`, solange ein Fenster unvollständig
 *      ist; der Port darf daraus nie eine stille 0 machen.
 *   3. SUPERTREND-AUFWÄRMPHASE: exakte Spur der ersten Bars — das ist die
 *      Stelle, an der sich ein Nachbau am leichtesten vom Original löst.
 *   4. FAIL-CLOSED: unsinnige Perioden werfen, statt sich zu korrigieren.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createAtr,
  createBollinger,
  createDmi,
  createEma,
  createHighest,
  createLowest,
  createMacd,
  createObv,
  createRma,
  createRsi,
  createSma,
  createStdev,
  createStoch,
  createSupertrend,
  createTrueRange,
  seriesOf,
  type PineBar,
  type PineValue,
} from "../src/signals/pine";
import { lcg } from "./cti.fixtures";

// ── Referenzimplementierungen (bewusst naiv, nicht geteilt mit dem Port) ────

function refSma(values: readonly number[], length: number): PineValue[] {
  return values.map((_, i) => {
    if (i + 1 < length) return null;
    let sum = 0;
    for (let k = i + 1 - length; k <= i; k += 1) sum += values[k] as number;
    return sum / length;
  });
}

function refEmaLike(values: readonly number[], length: number, alpha: number): PineValue[] {
  const out: PineValue[] = [];
  let prev: number | null = null;
  for (let i = 0; i < values.length; i += 1) {
    if (i + 1 < length) {
      out.push(null);
      continue;
    }
    if (prev === null) {
      let sum = 0;
      for (let k = i + 1 - length; k <= i; k += 1) sum += values[k] as number;
      prev = sum / length;
    } else {
      prev = alpha * (values[i] as number) + (1 - alpha) * prev;
    }
    out.push(prev);
  }
  return out;
}

function closeTo(actual: PineValue, expected: PineValue, eps = 1e-9): void {
  if (expected === null || actual === null) {
    assert.equal(actual, expected);
    return;
  }
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `erwartet ${expected}, bekommen ${actual} (Δ ${Math.abs(actual - expected)})`,
  );
}

function sampleCloses(count: number, seed = 11): number[] {
  const rnd = lcg(seed);
  const out: number[] = [];
  let price = 100;
  for (let i = 0; i < count; i += 1) {
    price = Math.max(1, price * (1 + (rnd() - 0.48) * 0.02));
    out.push(price);
  }
  return out;
}

function sampleBars(count: number, seed = 23): PineBar[] {
  const rnd = lcg(seed);
  const out: PineBar[] = [];
  let price = 100;
  for (let i = 0; i < count; i += 1) {
    const open = price;
    price = Math.max(1, price * (1 + (rnd() - 0.47) * 0.02));
    out.push({
      high: Math.max(open, price) * (1 + rnd() * 0.004),
      low: Math.min(open, price) * (1 - rnd() * 0.004),
      close: price,
      volume: 100 + rnd() * 50,
    });
  }
  return out;
}

describe("Pine-Primitiven: gleitende Mittel", () => {
  it("ta.sma entspricht dem arithmetischen Fenstermittel und ist vorher na", () => {
    const closes = sampleCloses(40);
    const actual = seriesOf(createSma(14), closes);
    const expected = refSma(closes, 14);
    assert.equal(actual.length, expected.length);
    for (let i = 0; i < closes.length; i += 1) closeTo(actual[i], expected[i], 1e-10);
    assert.equal(actual.slice(0, 13).every((v) => v === null), true);
  });

  it("ta.ema nutzt α = 2/(n+1) und startet auf dem SMA-Seed", () => {
    const closes = sampleCloses(60, 5);
    const actual = seriesOf(createEma(10), closes);
    const expected = refEmaLike(closes, 10, 2 / 11);
    for (let i = 0; i < closes.length; i += 1) closeTo(actual[i], expected[i], 1e-9);
  });

  it("ta.rma nutzt α = 1/n (Wilder) und startet ebenfalls auf dem SMA-Seed", () => {
    const closes = sampleCloses(60, 6);
    const actual = seriesOf(createRma(14), closes);
    const expected = refEmaLike(closes, 14, 1 / 14);
    for (let i = 0; i < closes.length; i += 1) closeTo(actual[i], expected[i], 1e-9);
  });

  it("ta.stdev ist die Populationsstandardabweichung und bei konstanter Reihe exakt 0", () => {
    const closes = sampleCloses(30, 9);
    const actual = seriesOf(createStdev(20), closes);
    for (let i = 19; i < closes.length; i += 1) {
      const window = closes.slice(i - 19, i + 1);
      const mean = window.reduce((a, b) => a + b, 0) / window.length;
      const variance = window.reduce((a, b) => a + (b - mean) ** 2, 0) / window.length;
      closeTo(actual[i], Math.sqrt(variance), 1e-9);
    }
    const flat = seriesOf(createStdev(20), new Array(25).fill(42));
    assert.equal(flat[24], 0);
  });

  it("highest/lowest liefern Fenster-Extrema, vorher na", () => {
    const values = [5, 3, 9, 1, 7, 4];
    assert.deepEqual(seriesOf(createHighest(3), values), [null, null, 9, 9, 9, 7]);
    assert.deepEqual(seriesOf(createLowest(3), values), [null, null, 3, 1, 1, 1]);
  });

  it("na im Fenster vergiftet den SMA und setzt EMA/RMA zurück", () => {
    const sma = createSma(3);
    assert.equal(sma.next(1), null);
    assert.equal(sma.next(null), null);
    assert.equal(sma.next(3), null, "Fenster enthält noch das na");
    assert.equal(sma.next(5), null, "Fenster enthält noch das na");
    closeTo(sma.next(7), 5, 1e-12);

    const ema = createEma(2);
    assert.equal(ema.next(10), null);
    closeTo(ema.next(20), 15, 1e-12);
    assert.equal(ema.next(null), null, "na unterbricht die Rekursion");
    assert.equal(ema.next(30), null, "danach wird neu aufgewärmt");
    closeTo(ema.next(40), 35, 1e-12);
  });
});

describe("Pine-Primitiven: Oszillatoren", () => {
  it("ta.rsi entspricht der Wilder-Referenz", () => {
    const closes = sampleCloses(80, 13);
    const actual = seriesOf(createRsi(14), closes);
    const changes: PineValue[] = closes.map((value, i) => (i === 0 ? null : value - (closes[i - 1] as number)));
    const ups = changes.map((change) => (change === null ? null : Math.max(change, 0)));
    const downs = changes.map((change) => (change === null ? null : -Math.min(change, 0)));
    const rmaUp = seriesOf(createRma(14), ups);
    const rmaDown = seriesOf(createRma(14), downs);
    for (let i = 0; i < closes.length; i += 1) {
      const up = rmaUp[i];
      const down = rmaDown[i];
      if (up === null || down === null) {
        assert.equal(actual[i], null);
        continue;
      }
      const expected = down === 0 ? 100 : up === 0 ? 0 : 100 - 100 / (1 + up / down);
      closeTo(actual[i], expected, 1e-9);
    }
  });

  it("ta.rsi ist 100 bei reiner Aufwärtsreihe und 0 bei reiner Abwärtsreihe", () => {
    const up = Array.from({ length: 30 }, (_, i) => 100 + i);
    const down = Array.from({ length: 30 }, (_, i) => 100 - i);
    assert.equal(seriesOf(createRsi(14), up).at(-1), 100);
    assert.equal(seriesOf(createRsi(14), down).at(-1), 0);
  });

  it("ta.stoch ist na, wenn Hoch und Tief im Fenster zusammenfallen", () => {
    const flat: PineBar[] = Array.from({ length: 25 }, () => ({
      high: 10,
      low: 10,
      close: 10,
      volume: 1,
    }));
    const stoch = createStoch(14, 3, 3);
    const values = flat.map((bar) => stoch.next(bar));
    assert.equal(values.at(-1)?.raw, null, "Division durch 0 ⇒ na, nicht 50");
    assert.equal(values.at(-1)?.k, null);
    assert.equal(values.at(-1)?.d, null);
  });

  it("%K ist der SMA des Rohwerts und %D der SMA von %K", () => {
    const bars = sampleBars(60, 31);
    const stoch = createStoch(14, 3, 3);
    const values = bars.map((bar) => stoch.next(bar));
    const raws = values.map((value) => value.raw);
    const ks = seriesOf(createSma(3), raws);
    const ds = seriesOf(createSma(3), ks);
    for (let i = 0; i < bars.length; i += 1) {
      closeTo(values[i].k, ks[i], 1e-12);
      closeTo(values[i].d, ds[i], 1e-12);
    }
    assert.equal(values[14].k, null, "%K braucht 14 + (3 − 1) Bars");
    assert.equal(values[15].k === null, false, "ab Bar 16 (Index 15) liegt %K vor");
    assert.equal(values[16].d, null, "%D braucht weitere (3 − 1) Bars");
    assert.equal(values[17].d === null, false, "ab Bar 18 (Index 17) liegt %D vor");
  });

  it("ta.macd = EMA(12) − EMA(26), Signal = EMA(macd, 9)", () => {
    const closes = sampleCloses(120, 17);
    const macd = createMacd(12, 26, 9);
    const values = closes.map((close) => macd.next(close));
    const fast = seriesOf(createEma(12), closes);
    const slow = seriesOf(createEma(26), closes);
    const line = fast.map((value, i) => (value === null || slow[i] === null ? null : value - (slow[i] as number)));
    const signal = seriesOf(createEma(9), line);
    for (let i = 0; i < closes.length; i += 1) {
      closeTo(values[i].macd, line[i], 1e-9);
      closeTo(values[i].signal, signal[i], 1e-9);
      if (values[i].macd !== null && values[i].signal !== null) {
        closeTo(values[i].histogram, (values[i].macd as number) - (values[i].signal as number), 1e-9);
      }
    }
    assert.equal(values[32].signal, null, "Signal erst ab Bar 34 (Index 33)");
    assert.equal(values[33].signal === null, false);
  });
});

describe("Pine-Primitiven: Volatilität, Volumen, Supertrend", () => {
  it("ta.tr(true) nimmt auf Bar 0 high − low, ta.tr(false) ist dort na", () => {
    const bars = sampleBars(5, 3);
    const withNa = createTrueRange(true);
    const withoutNa = createTrueRange(false);
    closeTo(withNa.next(bars[0]), bars[0].high - bars[0].low, 1e-12);
    assert.equal(withoutNa.next(bars[0]), null);
    for (let i = 1; i < bars.length; i += 1) {
      const prevClose = bars[i - 1].close;
      const expected = Math.max(
        bars[i].high - bars[i].low,
        Math.abs(bars[i].high - prevClose),
        Math.abs(bars[i].low - prevClose),
      );
      closeTo(withNa.next(bars[i]), expected, 1e-12);
      closeTo(withoutNa.next(bars[i]), expected, 1e-12);
    }
  });

  it("ta.atr ist das RMA der True Range", () => {
    const bars = sampleBars(60, 37);
    const atr = createAtr(14);
    const actual = bars.map((bar) => atr.next(bar));
    const tr = createTrueRange(true);
    const trs = bars.map((bar) => tr.next(bar));
    const expected = seriesOf(createRma(14), trs);
    for (let i = 0; i < bars.length; i += 1) closeTo(actual[i], expected[i], 1e-9);
  });

  it("ta.obv ist auf Bar 0 na und danach die vorzeichenbehaftete Volumensumme", () => {
    const bars: PineBar[] = [
      { high: 11, low: 9, close: 10, volume: 100 },
      { high: 12, low: 10, close: 11, volume: 50 },
      { high: 12, low: 10, close: 11, volume: 70 },
      { high: 11, low: 9, close: 10, volume: 30 },
    ];
    const obv = createObv();
    assert.equal(obv.next(bars[0]), null, "ohne Vorgängerkerze keine Richtung");
    assert.equal(obv.next(bars[1]), 50);
    assert.equal(obv.next(bars[2]), 50, "unveränderter Schluss ⇒ unverändertes OBV");
    assert.equal(obv.next(bars[3]), 20);
  });

  it("ta.obv liefert na statt eines veralteten Stands, wenn das Volumen fehlt", () => {
    const obv = createObv();
    obv.next({ high: 11, low: 9, close: 10, volume: 100 });
    assert.equal(obv.next({ high: 12, low: 10, close: 11, volume: 50 }), 50);
    assert.equal(obv.next({ high: 12, low: 10, close: 12, volume: Number.NaN }), null);
  });

  it("ta.dmi liefert +DI/−DI/ADX wie die Wilder-Referenz", () => {
    const bars = sampleBars(120, 41);
    const dmi = createDmi(14, 14);
    const actual = bars.map((bar) => dmi.next(bar));

    const plusDm: PineValue[] = [];
    const minusDm: PineValue[] = [];
    const trs: PineValue[] = [];
    const tr = createTrueRange(false);
    for (let i = 0; i < bars.length; i += 1) {
      trs.push(tr.next(bars[i]));
      if (i === 0) {
        plusDm.push(null);
        minusDm.push(null);
        continue;
      }
      const up = bars[i].high - bars[i - 1].high;
      const down = bars[i - 1].low - bars[i].low;
      plusDm.push(up > down && up > 0 ? up : 0);
      minusDm.push(down > up && down > 0 ? down : 0);
    }
    const rmaPlus = seriesOf(createRma(14), plusDm);
    const rmaMinus = seriesOf(createRma(14), minusDm);
    const rmaTr = seriesOf(createRma(14), trs);
    for (let i = 0; i < bars.length; i += 1) {
      const trueRange = rmaTr[i];
      if (trueRange === null || trueRange === 0 || rmaPlus[i] === null || rmaMinus[i] === null) continue;
      closeTo(actual[i].plus, (100 * (rmaPlus[i] as number)) / trueRange, 1e-9);
      closeTo(actual[i].minus, (100 * (rmaMinus[i] as number)) / trueRange, 1e-9);
    }
    const first = actual.findIndex((value) => value.adx !== null);
    assert.equal(first, 27, "ADX(14,14) liegt ab Bar 28 (Index 27) vor");
    for (const value of actual) {
      if (value.adx === null) continue;
      assert.ok(value.adx >= 0 && value.adx <= 100, `ADX außerhalb [0,100]: ${value.adx}`);
    }
  });

  it("Supertrend: dokumentierte Aufwärmspur bleibt erhalten", () => {
    const bars = sampleBars(20, 53);
    const supertrend = createSupertrend(3, 10);
    const values = bars.map((bar) => supertrend.next(bar));
    assert.equal(values[0].direction, 1, "Bar 0: Pine startet bärisch");
    assert.equal(values[0].line, 0, "Bar 0: beide Bänder sind 0 ⇒ Linie 0");
    for (let i = 1; i < 9; i += 1) {
      assert.equal(values[i].direction, 1, `Bar ${i} bleibt in der Aufwärmphase bärisch`);
    }
    assert.equal(values[9].line === null, false, "ab Bar 10 (Index 9) liegt das ATR vor");
    const later = values.slice(10);
    assert.ok(
      later.every((value) => value.line !== null),
      "nach der Aufwärmphase ist die Linie nie na",
    );
  });

  it("Supertrend dreht in einer klaren Rally auf bullisch (direction = −1)", () => {
    const rally: PineBar[] = Array.from({ length: 60 }, (_, i) => {
      const close = 100 + i * 2;
      return { high: close + 1, low: close - 1, close, volume: 10 };
    });
    const supertrend = createSupertrend(3, 10);
    const values = rally.map((bar) => supertrend.next(bar));
    assert.equal(values.at(-1)?.direction, -1);
    assert.ok((values.at(-1)?.line as number) < 100 + 59 * 2, "Linie liegt unter dem Kurs");
  });

  it("Bollinger: Basis = SMA, Bänder = Basis ± mult · σ", () => {
    const closes = sampleCloses(40, 59);
    const bollinger = createBollinger(20, 2);
    const values = closes.map((close) => bollinger.next(close));
    const basis = seriesOf(createSma(20), closes);
    const dev = seriesOf(createStdev(20), closes);
    for (let i = 0; i < closes.length; i += 1) {
      closeTo(values[i].basis, basis[i], 1e-12);
      if (basis[i] === null) {
        assert.equal(values[i].upper, null);
        continue;
      }
      closeTo(values[i].upper, (basis[i] as number) + 2 * (dev[i] as number), 1e-12);
      closeTo(values[i].lower, (basis[i] as number) - 2 * (dev[i] as number), 1e-12);
    }
  });
});

describe("Pine-Primitiven: fail-closed", () => {
  it("unsinnige Perioden werfen, statt sich still zu korrigieren", () => {
    assert.throws(() => createSma(0), RangeError);
    assert.throws(() => createEma(-5), RangeError);
    assert.throws(() => createRma(1.5), RangeError);
    assert.throws(() => createAtr(Number.NaN), RangeError);
    assert.throws(() => createSupertrend(3, 0), RangeError);
    assert.throws(() => createDmi(14, 0), RangeError);
  });

  it("nicht-endliche Eingaben werden zu na, nicht zu 0", () => {
    const sma = createSma(2);
    assert.equal(sma.next(10), null);
    assert.equal(sma.next(Number.POSITIVE_INFINITY), null);
    assert.equal(sma.next(Number.NaN), null);
    assert.equal(sma.next(20), null, "Fenster enthält noch das na");
    assert.equal(sma.next(30), 25);
  });
});
