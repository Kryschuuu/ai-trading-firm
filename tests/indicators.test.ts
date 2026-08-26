import { test } from "node:test";
import assert from "node:assert/strict";
import { rsi, ema, atrPct, bollingerBandWidthPct, returnStdDevPct, snapshot } from "../src/lib/indicators";
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

// ── Bollinger Band Width (BBW) ───────────────────────────────────────────────

test("BBW: völlig flache Serie → Bandbreite 0", () => {
  const flat = Array.from({ length: 30 }, () => 100);
  const bbw = bollingerBandWidthPct(flat, 20, 2);
  assert.ok(bbw != null, "muss einen Wert liefern");
  assert.equal(bbw, 0, "keine Streuung → Breite 0");
});

test("BBW: bekannte Streuung liefert exakte Bandbreite (2·mult·σ/SMA)", () => {
  // 20 Werte: 10×80 + 10×120 → SMA=100, Populations-σ=20 → Breite=2·2·20/100=0.8
  const alt = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 80 : 120));
  const bbw = bollingerBandWidthPct(alt, 20, 2);
  assert.ok(bbw != null);
  assert.ok(Math.abs(bbw - 0.8) < 1e-12, `erwartet 0.8, war ${bbw}`);
});

test("BBW: mehr Streuung → größere Bandbreite (Monotonie)", () => {
  const calm = Array.from({ length: 20 }, (_, i) => 100 + (i % 2) * 0.5);
  const wild = Array.from({ length: 20 }, (_, i) => 100 + (i % 2) * 10);
  const calmW = bollingerBandWidthPct(calm, 20, 2)!;
  const wildW = bollingerBandWidthPct(wild, 20, 2)!;
  assert.ok(wildW > calmW, "wildere Serie muss breitere Bänder haben");
});

test("BBW: zu wenig Daten → null (keine Division durch NULL/NaN)", () => {
  assert.equal(bollingerBandWidthPct([100, 101, 102], 20, 2), null);
  assert.equal(bollingerBandWidthPct([], 20, 2), null);
});

test("BBW: nicht-sinnvoller Mittelkurs (≤0) → null statt NaN", () => {
  assert.equal(bollingerBandWidthPct(Array(20).fill(0), 20, 2), null);
});

// ── Return-Standardabweichung ────────────────────────────────────────────────

test("Return-StdDev: flache Serie → 0", () => {
  const flat = Array.from({ length: 25 }, () => 100);
  const sd = returnStdDevPct(flat, 20);
  assert.ok(sd != null);
  assert.equal(sd, 0);
});

test("Return-StdDev: bekannte Einzel-Ausreißer liefern exakten Wert", () => {
  // 21 Kurse: 20×100, dann 101 → 20 Returns: 19×0 und 1×0.01.
  // Populations-Varianz = (19·0.0005² + 0.0095²)/20 = 4.75e-6 → σ ≈ 0.0021794
  const closes = [...Array(20).fill(100), 101];
  const sd = returnStdDevPct(closes, 20);
  assert.ok(sd != null, `erwartet Zahl, war ${sd}`);
  assert.ok(Math.abs(sd - Math.sqrt(4.75e-6)) < 1e-9, `erwartet ${Math.sqrt(4.75e-6)}, war ${sd}`);
});

test("Return-StdDev: stärkere Schwankungen → höhere StdDev (Monotonie)", () => {
  const calm = Array.from({ length: 25 }, (_, i) => 100 + Math.sin(i) * 0.2);
  const wild = Array.from({ length: 25 }, (_, i) => 100 + Math.sin(i) * 5);
  assert.ok(returnStdDevPct(wild, 20)! > returnStdDevPct(calm, 20)!, "wild > ruhig");
});

test("Return-StdDev: zu wenig Historie → null", () => {
  assert.equal(returnStdDevPct([100, 101, 102, 103], 20), null);
  assert.equal(returnStdDevPct([], 20), null);
});

test("Return-StdDev: nicht-sinnvoller Vorgängerkurs (≤0) → null statt NaN", () => {
  assert.equal(returnStdDevPct([0, 100, 101, 102], 3), null);
});

// ── ATR (Bestand) — zusätzliche Edge Cases fürs adaptive System ─────────────

test("ATR: zu wenige Kerzen → null", () => {
  const few = candlesFrom([100, 101, 102]);
  assert.equal(atrPct(few, 14), null);
});
