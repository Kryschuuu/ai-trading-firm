import { test } from "node:test";
import assert from "node:assert/strict";
import { adx, rsi, ema, macd, atrPct, bollingerBandWidthPct, returnStdDevPct, snapshot } from "../src/lib/indicators";
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

// ── ADX (Wilder) — GAP-06, Referenzwerte per Handrechnung ──────────────────

/** Kerze mit explizitem High/Low/Close (für die ADX-Handrechnung). */
function hlc(high: number, low: number, close: number, i: number): Candle {
  return { time: i, open: close, high, low, close, volume: 0 };
}

test("ADX: exakte Handrechnung (Periode 2, 5 Kerzen) → 190/3 ≈ 63.3333", () => {
  // Serie (H/L/C):
  //   c0: 10 / 9  / 9.5    c1: 11 / 10 / 10.5   c2: 11 / 10 / 10.2
  //   c3: 10 / 9  / 9.4    c4: 9.5 / 8.5 / 8.9
  //
  // Schritt 1 — Richtungsmaße + True Range je Bar (ab c1):
  //   i=1: upMove=11−10=1 > downMove=9−10=−1 → +DM=1, −DM=0
  //        TR = max(1, |11−9.5|, |10−9.5|) = 1.5
  //   i=2: upMove=0, downMove=0 → +DM=0, −DM=0;  TR = max(1, 0.5, 0.5) = 1
  //   i=3: downMove=10−9=1 > upMove=10−11=−1 → +DM=0, −DM=1
  //        TR = max(1, |10−10.2|, |9−10.2|) = 1.2
  //   i=4: downMove=9−8.5=0.5 > upMove=9.5−10=−0.5 → +DM=0, −DM=0.5
  //        TR = max(1, |9.5−9.4|, |8.5−9.4|) = 1
  //
  // Schritt 2 — Wilder-Summen (Periode 2, Start = Summe der ersten 2):
  //   TR₀=1.5+1=2.5,  +DM₀=1+0=1,  −DM₀=0
  //   → DX₀: +DI=100·1/2.5=40, −DI=0 ⇒ DX₀=100
  //   i=2: TR=2.5−1.25+1.2=2.45, +DM=1−0.5+0=0.5, −DM=0−0+1=1
  //        +DI=100·0.5/2.45, −DI=100·1/2.45 ⇒ DX₁=100·(1000/49)/(3000/49)=100/3
  //   i=3: TR=2.45−1.225+1=2.225, +DM=0.5−0.25+0=0.25, −DM=1−0.5+0.5=1
  //        +DI=100·(1/4)/(89/40)=1000/89, −DI=4000/89 ⇒ DX₂=100·3000/5000=60
  //
  // Schritt 3 — ADX: Start = Mittel(DX₀, DX₁) = (100+100/3)/2 = 200/3,
  //   dann Wilder: (200/3·1 + 60)/2 = 190/3 ≈ 63.3333
  const series = [
    hlc(10, 9, 9.5, 0),
    hlc(11, 10, 10.5, 1),
    hlc(11, 10, 10.2, 2),
    hlc(10, 9, 9.4, 3),
    hlc(9.5, 8.5, 8.9, 4),
  ];
  const value = adx(series, 2);
  assert.ok(value != null, "erwartet Zahl, war null");
  assert.ok(Math.abs(value - 190 / 3) < 1e-9, `erwartet 190/3 ≈ 63.3333, war ${value}`);
});

test("ADX: reiner Aufwärtstrend → 100 (nur +DM, DX stets 100)", () => {
  // Stufenleiter mit konstanter Schrittweite: jeder Bar hat upMove > 0 und
  // downMove ≤ 0 → −DM ≡ 0 → −DI ≡ 0 → DX ≡ 100 → ADX ≡ 100.
  const up = Array.from({ length: 40 }, (_, i) => {
    const close = 100 + i;
    return hlc(close + 0.4, close - 0.4, close, i);
  });
  const value = adx(up, 14);
  assert.ok(value != null);
  assert.ok(Math.abs(value - 100) < 1e-9, `erwartet 100, war ${value}`);
});

test("ADX: Trendstärke-Monotonie — Trendserie > Chop-Serie", () => {
  const trend = Array.from({ length: 60 }, (_, i) => {
    const close = 100 + i * 0.5;
    return hlc(close + 0.3, close - 0.3, close, i);
  });
  const chop = Array.from({ length: 60 }, (_, i) => {
    const close = 100 + (i % 2 === 0 ? 1 : -1);
    return hlc(close + 0.5, close - 0.5, close, i);
  });
  const trendAdx = adx(trend, 14)!;
  const chopAdx = adx(chop, 14)!;
  assert.ok(trendAdx > chopAdx, `Trend-ADX ${trendAdx} muss über Chop-ADX ${chopAdx} liegen`);
});

test("MACD: zu kurz oder ungültige Perioden → null", () => {
  assert.equal(macd(Array.from({ length: 34 }, (_, i) => 100 + i)), null);
  assert.equal(macd([], 12, 26, 9), null);
  assert.equal(macd(Array.from({ length: 80 }, () => 100), 26, 12, 9), null);
});

test("MACD: flach → 0, steigend → positiv, Linie = EMA(fast) − EMA(slow)", () => {
  const flat = Array.from({ length: 80 }, () => 100);
  const flatMacd = macd(flat);
  assert.ok(flatMacd);
  assert.ok(Math.abs(flatMacd.macd) < 1e-9);
  assert.ok(Math.abs(flatMacd.signal) < 1e-9);
  assert.ok(Math.abs(flatMacd.histogram) < 1e-9);

  const rising = Array.from({ length: 80 }, (_, i) => 100 + i * 0.5);
  const reading = macd(rising);
  assert.ok(reading);
  const line = ema(rising, 12).at(-1)! - ema(rising, 26).at(-1)!;
  assert.ok(Math.abs(reading.macd - line) < 1e-9);
  assert.ok(reading.macd > 0);
  assert.equal(reading.histogram, reading.macd - reading.signal);
});

test("ADX: zu wenige Kerzen (< 2·Periode+1) oder leere Eingabe → null", () => {
  const few = Array.from({ length: 4 }, (_, i) => hlc(101 + i, 99 + i, 100 + i, i));
  assert.equal(adx(few, 2), null, "4 Kerzen < 2·2+1");
  assert.equal(adx([], 14), null);
});
