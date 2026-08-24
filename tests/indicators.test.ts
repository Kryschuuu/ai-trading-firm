import { test } from "node:test";
import assert from "node:assert/strict";
import { rsi, ema, atrPct, snapshot } from "../src/lib/indicators";
import type { Candle } from "../src/lib/marketData";

test("RSI: stetiger Aufwärtslauf → überkauft (>70)", () => {
  const up = Array.from({ length: 30 }, (_, i) => 100 + i);
  assert.ok(rsi(up) > 70, `RSI=${rsi(up)}`);
});

test("RSI: stetiger Abwärtslauf → überverkauft (<30)", () => {
  const down = Array.from({ length: 30 }, (_, i) => 100 - i * 0.5);
  assert.ok(rsi(down) < 30, `RSI=${rsi(down)}`);
});

test("RSI: völlig flache Serie → neutral (50), kein Div-by-zero", () => {
  const flat = Array.from({ length: 40 }, () => 100);
  assert.equal(rsi(flat), 50);
});

test("EMA konvergiert gegen letzten Wert und folgt Trendwechsel", () => {
  const rising = Array.from({ length: 50 }, (_, i) => i);
  const e = ema(rising, 9);
  assert.ok(e[49] > e[25], "EMA steigt mit der Serie");
  assert.ok(Math.abs(e[49] - 49) < 5, `EMA nahe am letzten Wert, war ${e[49]}`);
});

function candlesFrom(closes: number[]): Candle[] {
  return closes.map((c, i) => ({
    time: i,
    open: c,
    high: c + 1,
    low: c - 1,
    close: c,
    volume: 0,
  }));
}

test("ATR% liegt bei synthetischen Kerzen plausibel", () => {
  const candles = candlesFrom(Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i / 3)));
  const atr = atrPct(candles, 14);
  assert.ok(atr != null && atr > 0 && atr < 0.05, `atrPct=${atr}`);
});

test("snapshot braucht Mindesthistorie und liefert Trend", () => {
  assert.equal(snapshot("BTC", []), null);
  const up = candlesFrom(Array.from({ length: 60 }, (_, i) => 100 + i)).map((c) => ({ ...c }));
  const snap = snapshot("BTC", up as any);
  assert.equal(snap?.trend, "UP");
});
