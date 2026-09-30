import { test } from "node:test";
import assert from "node:assert/strict";
import { adx, rsi, ema, macd, atrPct, bollingerBandWidthPct, bollingerBands, bollingerPosition, donchianBreakoutPct, donchianChannel, DONCHIAN_ENTRY_PERIOD, DONCHIAN_EXIT_PERIOD, returnStdDevPct, sessionVwap, utcDayAnchorMs, snapshot, BOLLINGER_PERIOD, BOLLINGER_MULT } from "../src/lib/indicators";
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

// ── Bollinger-Bänder und Donchian-Kanal (STX-02-01) ────────────────────────

test("Bollinger: bekannte Populations-σ, Kurslevel und Bruch-Einheit", () => {
  const closes = Array.from({ length: 20 }, (_, i) => i % 2 ? 120 : 80);
  assert.deepEqual(bollingerBands(closes), {
    upper: 140, middle: 100, lower: 60, width: 0.8, bandwidthPct: 0.8,
  });
  assert.equal(bollingerBands(Array(20).fill(100))?.width, 0, "flache gültige Serie: echte Null");
});

test("Bollinger: Bandbreite exakt identisch zur unveränderten BBW-Funktion (5 Fixtures)", () => {
  const fixtures = [
    Array(20).fill(100),
    Array.from({ length: 20 }, (_, i) => i % 2 ? 120 : 80),
    Array.from({ length: 29 }, (_, i) => 100 + i * 0.37),
    Array.from({ length: 35 }, (_, i) => 90 + Math.sin(i / 3) * 7),
    Array.from({ length: 20 }, (_, i) => 100 + (i === 19 ? 25 : 0)),
  ];
  for (const closes of fixtures) {
    const reading = bollingerBands(closes);
    assert.ok(reading);
    assert.equal(reading.bandwidthPct, bollingerBandWidthPct(closes));
    assert.equal(reading.width, reading.bandwidthPct);
  }
});

test("Bollinger: fehlende/ungültige Historie, nichtpositiver SMA und Parameter-Klemmung", () => {
  assert.equal(bollingerBands([]), null);
  assert.equal(bollingerBands(Array(19).fill(100)), null);
  assert.equal(bollingerBands(Array(20).fill(0)), null);
  assert.equal(bollingerBands(Array(20).fill(-1)), null);
  assert.equal(bollingerBands([...Array(19).fill(100), NaN]), null);
  assert.equal(bollingerBands(Array(20).fill(100), NaN), null);
  assert.equal(bollingerBands(Array(20).fill(100), 20, Infinity), null);
  const closes = Array.from({ length: 25 }, (_, i) => 90 + i);
  assert.deepEqual(bollingerBands(closes, 20, 0), bollingerBands(closes, 20, 1));
  assert.deepEqual(bollingerBands(closes, 20, 99), bollingerBands(closes, 20, 4));
  assert.deepEqual(bollingerBands(closes, -10), bollingerBands(closes, 5));
  assert.equal(bollingerBands(closes, 999), null, "auf 200 geklemmt, daher zu wenig Daten");
  assert.deepEqual(bollingerBands(Array(201).fill(100), 999), bollingerBands(Array(201).fill(100), 200));
});

test("Donchian: entry-High und exit-Low nutzen verschiedene Fenster, ohne aktuelle Kerze", () => {
  const candles = candlesFrom([10, 11, 12, 13, 14, 15, 16, 17, 18]);
  candles[3].high = 50; // im entry-, aber nicht im exit-Fenster
  candles[5].low = 2;   // im exit-Fenster
  candles[8].high = 1000; // aktueller High/Low darf nichts ändern
  candles[8].low = -1000;
  assert.deepEqual(donchianChannel(candles, 5, 3), { upper: 50, lower: 2, mid: 26 });
});

test("Donchian: streng steigende Serie bricht über den vorherigen Kanal aus (kein Lookahead)", () => {
  const candles = candlesFrom(Array.from({ length: 21 }, (_, i) => 100 + 2 * i));
  const lastClose = candles.at(-1)!.close;
  const reading = donchianChannel(candles);
  assert.ok(reading);
  assert.ok(reading.upper < lastClose, `upper ${reading.upper} muss unter ${lastClose} liegen`);
  assert.equal(reading.upper, candles.at(-2)!.high);
});

test("Donchian-Ausbruch (STX-02-03): Prozentformel, kein Look-ahead, null statt 0", () => {
  // Kanalhoch der VORIGEN 20 Kerzen (streng steigend = die Kerze davor).
  const candles = candlesFrom(Array.from({ length: 22 }, (_, i) => 100 + 2 * i));
  const reading = donchianChannel(candles, DONCHIAN_ENTRY_PERIOD, DONCHIAN_EXIT_PERIOD)!;
  const close = candles.at(-1)!.close;
  assert.equal(reading.upper, candles.at(-2)!.high);
  assert.equal(
    donchianBreakoutPct(close, reading.upper),
    (close / candles.at(-2)!.high - 1) * 100,
    "Formel (close / voriges Kanalhoch − 1) · 100",
  );

  // Zu wenig Historie: kein Kanal ⇒ null, ausdrücklich keine 0.
  const short = candles.slice(0, DONCHIAN_ENTRY_PERIOD);
  assert.equal(donchianChannel(short), null);
  assert.equal(donchianBreakoutPct(short.at(-1)!.close, donchianChannel(short)?.upper), null);
  assert.notEqual(donchianBreakoutPct(short.at(-1)!.close, donchianChannel(short)?.upper), 0);

  // Kein Bezugswert (upper <= 0) bzw. kein sinnvoller Kurs ⇒ null.
  assert.equal(donchianBreakoutPct(-5, -4), null);
  assert.equal(donchianBreakoutPct(-5, 0), null);
  assert.equal(donchianBreakoutPct(0, 100), null);
  assert.equal(donchianBreakoutPct(100, Number.NaN), null);

  // Echte 0 = Kurs exakt auf dem Kanalhoch (Messwert, kein Ausfall).
  assert.equal(donchianBreakoutPct(100, 100), 0);
  // Die kanonischen Fenster sind 20/10 — sie sind Snapshot-Definition und
  // kein Regelfeld (Template 03-08 parametrisiert den Kanal).
  assert.equal(DONCHIAN_ENTRY_PERIOD, 20);
  assert.equal(DONCHIAN_EXIT_PERIOD, 10);
});

test("Donchian: Mindesthistorie nach Klemmung, exitPeriod höchstens entryPeriod", () => {
  assert.equal(donchianChannel([]), null);
  assert.equal(donchianChannel(candlesFrom(Array(20).fill(100))), null);
  const candles = candlesFrom(Array.from({ length: 12 }, (_, i) => 100 + i));
  assert.deepEqual(donchianChannel(candles, -1, 500), donchianChannel(candles, 5, 5));
  assert.deepEqual(donchianChannel(candles, 5, -1), donchianChannel(candles, 5, 3));
  assert.equal(donchianChannel(candles, 999), null);
  const long = candlesFrom(Array.from({ length: 202 }, (_, i) => 100 + i));
  assert.deepEqual(donchianChannel(long, 999, 999), donchianChannel(long, 200, 100));
  assert.equal(donchianChannel(candles, NaN, 3), null);
  assert.equal(donchianChannel(candles, 5, Infinity), null);
  candles[9].high = NaN;
  assert.equal(donchianChannel(candles, 5, 3), null);
  candles[9].high = 110;
  candles[10].low = NaN;
  assert.equal(donchianChannel(candles, 5, 3), null);
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

// ── Session-VWAP (CYCLE-DAYTRADE-01) ─────────────────────────────────────────

const VWAP_DAY = Date.UTC(2026, 0, 5);

function vwapCandle(
  minute: number,
  high: number,
  low: number,
  close: number,
  volume: number
): Candle {
  return { time: VWAP_DAY + minute * 60_000, open: close, high, low, close, volume };
}

test("sessionVwap: exakte Handrechnung (HLC3, volumen-gewichtet)", () => {
  //   c0: H110 L100 C105, V10 → tp = (110+100+105)/3 = 105
  //   c1: H120 L110 C115, V30 → tp = (120+110+115)/3 = 115
  //   vwap = (105·10 + 115·30) / (10+30) = 4500/40 = 112.5
  const candles = [vwapCandle(0, 110, 100, 105, 10), vwapCandle(1, 120, 110, 115, 30)];
  const reading = sessionVwap(candles);
  assert.ok(reading);
  assert.ok(Math.abs(reading.vwap - 112.5) < 1e-9, `vwap=${reading.vwap}`);
  assert.ok(
    Math.abs(reading.priceVsVwapPct - ((115 - 112.5) / 112.5) * 100) < 1e-9,
    `priceVsVwapPct=${reading.priceVsVwapPct}`,
  );
  assert.equal(reading.samples, 2);
  assert.equal(reading.totalVolume, 40);
  assert.equal(reading.anchoredAt, VWAP_DAY);
});

test("sessionVwap: flache Serie ⇒ VWAP = Kurs, Abweichung 0", () => {
  const candles = Array.from({ length: 10 }, (_, i) => vwapCandle(i, 100, 100, 100, 5 + i));
  const reading = sessionVwap(candles)!;
  assert.ok(Math.abs(reading.vwap - 100) < 1e-9);
  assert.ok(Math.abs(reading.priceVsVwapPct) < 1e-9);
});

test("sessionVwap: Kerzen vor dem Tagesanker zählen nicht (Tagesreset)", () => {
  // Extreme Preise am Vortag: würden sie mitrechnen, wäre der VWAP ~953.
  const prevDay = [vwapCandle(-600, 1000, 900, 950, 100), vwapCandle(-540, 1010, 910, 960, 100)];
  const today = [vwapCandle(0, 110, 100, 105, 10), vwapCandle(1, 120, 110, 115, 30)];
  const reading = sessionVwap([...prevDay, ...today]);
  assert.ok(reading);
  assert.ok(Math.abs(reading.vwap - 112.5) < 1e-9, `Vortag leakt in die Session: ${reading.vwap}`);
  assert.equal(reading.samples, 2);
});

test("sessionVwap: null statt erfundener Werte (Volumen 0, 1 Kerze, NaN)", () => {
  assert.equal(sessionVwap([vwapCandle(0, 110, 100, 105, 0), vwapCandle(1, 120, 110, 115, 0)]), null);
  assert.equal(sessionVwap([vwapCandle(0, 110, 100, 105, 10)]), null, "eine Kerze ist keine Session");
  assert.equal(sessionVwap([]), null);
  assert.equal(sessionVwap([vwapCandle(0, Number.NaN, 100, 105, 10), vwapCandle(1, 120, 110, 115, 10)]), null);
});

test("sessionVwap: expliziter Anker überstimmt die UTC-Tagesscheibe", () => {
  const candles = [vwapCandle(0, 110, 100, 105, 10), vwapCandle(1, 120, 110, 115, 30)];
  // Anker auf Minute 1 ⇒ nur eine Kerze in der Session ⇒ kein VWAP (null).
  assert.equal(sessionVwap(candles, VWAP_DAY + 60_000), null);
  // Vollständiger Anker ⇒ beide Kerzen.
  assert.equal(sessionVwap(candles, VWAP_DAY)?.samples, 2);
});

test("utcDayAnchorMs: rundet auf UTC-Mitternacht (nicht auf Lokalzeit)", () => {
  assert.equal(utcDayAnchorMs(VWAP_DAY), VWAP_DAY);
  assert.equal(utcDayAnchorMs(VWAP_DAY + 23 * 3_600_000 + 59 * 60_000), VWAP_DAY);
  assert.equal(utcDayAnchorMs(VWAP_DAY + 24 * 3_600_000), VWAP_DAY + 86_400_000);
  assert.equal(utcDayAnchorMs(Number.NaN), 0);
});

// ── Bollinger-Position (STX-02-02) ───────────────────────────────────────────
//
// Reine Formel-Ebene der drei Regel-Felder `bbZScore`, `priceVsUpperBbPct` und
// `priceVsLowerBbPct`. Die Snapshot-/Cache-Parität prüfen `tests/ruleEngine.test.ts`
// und `tests/backtest.multiAsset.test.ts`.

/** Symmetrische Reihe um 100 mit ±10: Mittel 100, σ = 10 (Populationsform). */
const symmetricBand = Array.from({ length: 20 }, (_, i) => (i % 2 ? 110 : 90));

test("STX-02-02: bollingerPosition rechnet aus Bandgeometrie — Mitte 0, Kanten ±mult", () => {
  const reading = bollingerBands(symmetricBand)!;
  assert.equal(reading.middle, 100);
  assert.equal(reading.upper, 120);
  assert.equal(reading.lower, 80);

  assert.deepEqual(bollingerPosition(100, reading), {
    zScore: 0,
    priceVsUpperPct: -20,
    priceVsLowerPct: 20,
  });
  // Kurs exakt auf der oberen Kante: zScore = +mult (2), Abstand zur Kante 0.
  // Der Abstand zur jeweils anderen Kante ist Prozent des KURSES, nicht des Bandes.
  assert.deepEqual(bollingerPosition(120, reading), {
    zScore: 2,
    priceVsUpperPct: 0,
    priceVsLowerPct: (40 / 120) * 100,
  });
  assert.deepEqual(bollingerPosition(80, reading), {
    zScore: -2,
    priceVsUpperPct: (-40 / 80) * 100,
    priceVsLowerPct: 0,
  });
});

test("STX-02-02: σ wird aus der Bandgeometrie gelesen (keine zweite Varianzrechnung)", () => {
  const closes = Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i / 2) * 4);
  const reading = bollingerBands(closes)!;
  const position = bollingerPosition(closes.at(-1)!, reading)!;
  const sigma = (reading.upper - reading.middle) / BOLLINGER_MULT;
  assert.ok(Math.abs(position.zScore! - (closes.at(-1)! - reading.middle) / sigma) < 1e-12);
  // Identisch zum direkten Nachrechnen der Populations-σ über das Fenster.
  const window = closes.slice(-BOLLINGER_PERIOD);
  const mean = window.reduce((a, b) => a + b, 0) / BOLLINGER_PERIOD;
  const sd = Math.sqrt(window.reduce((a, b) => a + (b - mean) ** 2, 0) / BOLLINGER_PERIOD);
  assert.ok(Math.abs(sigma - sd) < 1e-9, `σ-Geometrie ${sigma} vs. Varianz ${sd}`);
});

test("STX-02-02: σ == 0 ⇒ zScore null, Prozentwerte bleiben 0 (Kurs liegt auf der Kante)", () => {
  const flat = Array(20).fill(100);
  const reading = bollingerBands(flat)!;
  assert.equal(reading.width, 0, "flaches Band: echte Breite 0 (bestehende Semantik)");
  assert.deepEqual(bollingerPosition(100, reading), {
    zScore: null,
    priceVsUpperPct: 0,
    priceVsLowerPct: 0,
  });
});

test("STX-02-02: unbrauchbares Reading oder Kurs ⇒ null statt erfundener Zahlen", () => {
  const reading = bollingerBands(symmetricBand)!;
  assert.equal(bollingerPosition(0, reading), null, "Kurs 0 ergibt keinen Prozentbezug");
  assert.equal(bollingerPosition(-5, reading), null);
  assert.equal(bollingerPosition(Number.NaN, reading), null);
  assert.equal(bollingerPosition(Number.POSITIVE_INFINITY, reading), null);
  // Zu wenig Historie: `bollingerBands` liefert null — die Position dazu gibt es nicht.
  assert.equal(bollingerBands(Array(19).fill(100)), null);
  assert.equal(bollingerPosition(100, { ...reading, middle: 0 }), null, "Mitte 0 ⇒ kein Bezug");
  assert.equal(bollingerPosition(100, { ...reading, middle: Number.NaN }), null);
});

test("STX-02-02: Kantenabstände sind Prozent des Kurses (marktneutral, kein absoluter Preis)", () => {
  // Dasselbe Muster auf zwei Kursniveaus: die Prozentwerte sind identisch.
  const at100 = bollingerPosition(105, bollingerBands(symmetricBand)!);
  const at30000 = bollingerPosition(105 * 300, bollingerBands(symmetricBand.map((c) => c * 300))!);
  assert.deepEqual(at100, at30000);
});
