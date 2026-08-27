/**
 * Unit-Tests der 14 Faktor-Module (Task 04).
 *
 * Jeder Faktor wird mit einer **kurzen, hand-verifizierten Zeitreihe** gegen
 * einen Golden-Wert geprüft; anschließend die Edge Cases leere Serie,
 * konstante Preise, NaN und Einzelwert.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_SCANNER_CONFIG, resolveScannerConfig } from "../src/scanner/config";
import {
  FACTORS,
  FACTOR_LIST,
  alignByTime,
  computeAllFactors,
  computeRsi,
  pearson,
  ranks,
  spearman,
} from "../src/scanner/factors";
import { FACTOR_IDS, type FactorInput } from "../src/scanner/types";
import { bandNorm, closesOf, ema, logReturns, roundTo, stdDev, wilderSmooth } from "../src/scanner/math";
import { AS_OF_MS, candlesFromCloses, growthSeries, instrument } from "./fixtures/scannerFixtures";
import type { MarketInstrument } from "../src/universe/types";
import type { MarketCandle } from "../src/lib/marketdata/types";

const config = DEFAULT_SCANNER_CONFIG;

function input(overrides: Partial<FactorInput> = {}): FactorInput {
  return {
    instrument: instrument(),
    candles: [],
    benchmarkCandles: null,
    derivatives: null,
    news: null,
    asOf: AS_OF_MS,
    config,
    ...overrides,
  };
}

// ── 0: Modul-Inventar ────────────────────────────────────────────────────────

test("Faktoren: genau 14 Module, IDs eindeutig und vollständig", () => {
  assert.equal(FACTOR_IDS.length, 14);
  assert.equal(FACTOR_LIST.length, 14);
  assert.equal(new Set(FACTOR_LIST.map((f) => f.id)).size, 14);
  for (const id of FACTOR_IDS) {
    assert.equal(FACTORS[id].id, id, `Faktor ${id} muss seine eigene ID tragen`);
    assert.ok(FACTORS[id].label.length > 3);
  }
});

// ── 1: Liquidity ─────────────────────────────────────────────────────────────

test("liquidity: 1 Mio. Quote-Volumen ⇒ log-normiert 0.2 (Golden)", () => {
  const v = FACTORS.liquidity.compute(input({ instrument: instrument({ volume24h: 1_000_000 }) }));
  assert.equal(v.raw, 1_000_000);
  assert.equal(v.normalized, 0.2); // (log10(1e6)-log10(1e5)) / (log10(1e10)-log10(1e5)) = 1/5
  assert.equal(v.available, true);
  assert.equal(v.detail.source, "registry");
});

test("liquidity: ohne Registry-Volumen greift das Quote-Volumen der letzten Kerze", () => {
  const candles = candlesFromCloses([100, 100], { volume: 10_000 }); // 10.000 × 100 = 1e6
  const v = FACTORS.liquidity.compute(input({ instrument: instrument({ volume24h: null }), candles }));
  assert.equal(v.raw, 1_000_000);
  assert.equal(v.detail.source, "candle");
});

test("liquidity: kein Volumen ⇒ unavailable mit Neutralwert 0", () => {
  const v = FACTORS.liquidity.compute(input({ instrument: instrument({ volume24h: null }) }));
  assert.equal(v.available, false);
  assert.equal(v.raw, null);
  assert.equal(v.normalized, 0);
});

// ── 2: Spread ────────────────────────────────────────────────────────────────

test("spread: 10 bp ⇒ 0.8163265306 (Golden, invers linear)", () => {
  const v = FACTORS.spread.compute(input({ instrument: instrument({ spread: 0.001 }) }));
  assert.equal(v.raw, 0.001);
  assert.equal(v.normalized, 0.8163265306);
});

test("spread: Grenzen — bestSpread ⇒ 1, worstSpread ⇒ 0, unbekannt ⇒ unavailable", () => {
  assert.equal(FACTORS.spread.compute(input({ instrument: instrument({ spread: 0.0001 }) })).normalized, 1);
  assert.equal(FACTORS.spread.compute(input({ instrument: instrument({ spread: 0.005 }) })).normalized, 0);
  const unknown = FACTORS.spread.compute(input({ instrument: instrument({ spread: null }) }));
  assert.equal(unknown.available, false);
  assert.equal(unknown.normalized, 0);
});

// ── 3: ATR ───────────────────────────────────────────────────────────────────

test("atr: konstante True Range 2 bei Kurs 119 ⇒ 1.68 % (Golden), im Sweet Spot ⇒ 1", () => {
  const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
  const candles: MarketCandle[] = closes.map((close, i) => ({
    time: AS_OF_MS - (closes.length - 1 - i) * 86_400_000,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 1000,
  }));
  const v = FACTORS.atr.compute(input({ candles }));
  assert.equal(v.raw, 0.0168067227); // 2 / 119
  assert.equal(v.normalized, 1); // 1.68 % liegt zwischen idealLowPct (1 %) und idealHighPct (4 %)
  assert.equal(v.detail.atrAbsolute, 2);
});

test("atr: zu wenig Kerzen ⇒ unavailable", () => {
  const v = FACTORS.atr.compute(input({ candles: candlesFromCloses([100, 101, 102]) }));
  assert.equal(v.available, false);
  assert.equal(v.normalized, 0);
});

// ── 4: Realized Volatility ───────────────────────────────────────────────────

test("volatility: alternierende Kurse 100/110 ⇒ σ 0.09531018, annualisiert 1.8208984284 (Golden)", () => {
  const closes = Array.from({ length: 11 }, (_, i) => (i % 2 === 0 ? 100 : 110));
  const v = FACTORS.volatility.compute(input({ candles: candlesFromCloses(closes) }));
  assert.equal(v.detail.sigmaPerPeriod, 0.0953101798);
  assert.equal(v.raw, 1.8208984284); // σ × √365
  assert.equal(v.normalized, 0.3994715127); // fallende Trapez-Flanke zwischen 0.8 und 2.5
});

test("volatility: konstante Kurse ⇒ σ = 0 ⇒ normalisiert 0 (unterhalb floor)", () => {
  const v = FACTORS.volatility.compute(input({ candles: candlesFromCloses(new Array(40).fill(100)) }));
  assert.equal(v.raw, 0);
  assert.equal(v.normalized, 0);
});

test("volatility: leere Serie und Einzelwert ⇒ unavailable", () => {
  assert.equal(FACTORS.volatility.compute(input({ candles: [] })).available, false);
  assert.equal(FACTORS.volatility.compute(input({ candles: candlesFromCloses([100]) })).available, false);
});

test("volatility: NaN in der Serie ⇒ unavailable (nie interpolieren)", () => {
  const candles = candlesFromCloses([100, 101, 102, 103]);
  candles[2] = { ...candles[2], close: Number.NaN };
  const v = FACTORS.volatility.compute(input({ candles }));
  assert.equal(v.available, false);
  assert.equal(v.raw, null);
});

// ── 5: Momentum ──────────────────────────────────────────────────────────────

test("momentum: 0,1 % Tageswachstum über 61 Kerzen ⇒ 0.037961702 (Golden)", () => {
  const v = FACTORS.momentum.compute(input({ candles: candlesFromCloses(growthSeries(100, 1.001, 61)) }));
  assert.equal(v.raw, 0.037961702);
  assert.equal(v.normalized, 0.1265390068);
  assert.equal(v.detail.direction, "up");
  assert.equal(v.detail.windowsUsed, 3);
});

test("momentum: Abwärtsbewegung zählt im Default-Modus absolut, directional dagegen 0", () => {
  const candles = candlesFromCloses(growthSeries(100, 0.999, 61));
  const absolute = FACTORS.momentum.compute(input({ candles }));
  assert.ok(absolute.raw !== null && absolute.raw < 0);
  assert.ok(absolute.normalized > 0);
  const directionalConfig = resolveScannerConfig({ factors: { momentum: { mode: "directional" } } });
  const directional = FACTORS.momentum.compute(input({ candles, config: directionalConfig }));
  assert.equal(directional.normalized, 0);
});

test("momentum: zu kurze Serie ⇒ unavailable", () => {
  assert.equal(FACTORS.momentum.compute(input({ candles: candlesFromCloses([100, 101]) })).available, false);
});

// ── 6: Trend ─────────────────────────────────────────────────────────────────

test("trend: konstante Kurse ⇒ raw 0, keine Struktur ⇒ 0 (Golden)", () => {
  const v = FACTORS.trend.compute(input({ candles: candlesFromCloses(new Array(60).fill(100)) }));
  assert.equal(v.raw, 0);
  assert.equal(v.normalized, 0);
  assert.equal(v.detail.aligned, false);
});

test("trend: sauberer Aufwärtstrend ⇒ aligned und > 0.5", () => {
  const v = FACTORS.trend.compute(input({ candles: candlesFromCloses(growthSeries(100, 1.01, 80)) }));
  assert.equal(v.detail.aligned, true);
  assert.ok(v.normalized > 0.5, `erwartet > 0.5, war ${v.normalized}`);
  assert.ok((v.raw ?? 0) > 0);
});

test("trend: EMA-Struktur wird gegen eine unabhängige Referenzrechnung geprüft", () => {
  const closes = growthSeries(100, 1.005, 60);
  const candles = candlesFromCloses(closes);
  const fast = ema(closes, 9)!.at(-1)!;
  const slow = ema(closes, 50)!.at(-1)!;
  const expected = roundTo((fast - slow) / slow);
  assert.equal(FACTORS.trend.compute(input({ candles })).raw, expected);
});

// ── 7: Volume Ratio ──────────────────────────────────────────────────────────

test("volumeRatio: 5×200 gegen 20er-Schnitt 125 ⇒ 1.6 / 0.7333333333 (Golden)", () => {
  const volumes = [...new Array(15).fill(100), ...new Array(5).fill(200)];
  const v = FACTORS.volumeRatio.compute(input({ candles: candlesFromCloses(new Array(20).fill(100), { volume: volumes }) }));
  assert.equal(v.raw, 1.6);
  assert.equal(v.normalized, 0.7333333333);
});

test("volumeRatio: Nullvolumen ⇒ unavailable, negatives Volumen ⇒ unavailable", () => {
  const zero = FACTORS.volumeRatio.compute(input({ candles: candlesFromCloses(new Array(20).fill(100), { volume: 0 }) }));
  assert.equal(zero.available, false);
  const negative = candlesFromCloses(new Array(20).fill(100), { volume: 100 });
  negative[3] = { ...negative[3], volume: -1 };
  assert.equal(FACTORS.volumeRatio.compute(input({ candles: negative })).available, false);
});

// ── 8: RSI ───────────────────────────────────────────────────────────────────

test("rsi: reiner Aufwärtslauf ⇒ 100 ⇒ Überhitzungsfilter 0 (Golden)", () => {
  const v = FACTORS.rsi.compute(input({ candles: candlesFromCloses(growthSeries(100, 1.01, 30)) }));
  assert.equal(v.raw, 100);
  assert.equal(v.normalized, 0);
});

test("rsi: konstante Kurse ⇒ 50 ⇒ 1 (voll im neutralen Band)", () => {
  const v = FACTORS.rsi.compute(input({ candles: candlesFromCloses(new Array(30).fill(100)) }));
  assert.equal(v.raw, 50);
  assert.equal(v.normalized, 1);
});

test("rsi: Wilder-Referenz — ±1 im Wechsel, letzter Schritt aufwärts ⇒ 50.664722", () => {
  // 20 Schritte ±1: Seed-Fenster hat 7 Gewinne / 7 Verluste, die Wilder-Glättung
  // gewichtet die jüngsten Schritte stärker — der letzte Schritt ist ein Plus,
  // also liegt der RSI knapp über 50 (hand-nachgerechnet, Golden-Wert).
  const closes: number[] = [100];
  for (let i = 1; i <= 20; i++) closes.push(closes[i - 1] + (i % 2 === 0 ? 1 : -1));
  assert.equal(roundTo(computeRsi(closes, 14) ?? -1, 6), 50.664722);
  // Gegenprobe: endet die Serie mit einem Minus, spiegelt sich der Wert unter 50.
  const mirrored: number[] = [100];
  for (let i = 1; i <= 20; i++) mirrored.push(mirrored[i - 1] + (i % 2 === 0 ? -1 : 1));
  assert.ok((computeRsi(mirrored, 14) ?? 100) < 50);
});

// ── 9: Drawdown ──────────────────────────────────────────────────────────────

test("drawdown: 120 → 60 ⇒ 50 % ⇒ normalisiert 0 (Golden)", () => {
  const v = FACTORS.drawdown.compute(input({ candles: candlesFromCloses([100, 120, 60, 80]) }));
  assert.equal(v.raw, 0.5);
  assert.equal(v.normalized, 0);
});

test("drawdown: monoton steigende Kurse ⇒ 0 ⇒ normalisiert 1", () => {
  const v = FACTORS.drawdown.compute(input({ candles: candlesFromCloses([100, 110, 120, 130]) }));
  assert.equal(v.raw, 0);
  assert.equal(v.normalized, 1);
});

test("drawdown: Einzelwert ⇒ unavailable", () => {
  assert.equal(FACTORS.drawdown.compute(input({ candles: candlesFromCloses([100]) })).available, false);
});

// ── 10: Korrelation ──────────────────────────────────────────────────────────

test("correlation: Pearson und Spearman gegen hand-gerechnete Werte", () => {
  assert.equal(pearson([1, 2, 3], [2, 4, 6]), 1);
  assert.equal(pearson([1, 2, 3], [3, 2, 1]), -1);
  assert.equal(pearson([1, 1, 1], [1, 2, 3]), null); // σ = 0 ⇒ undefiniert
  assert.deepEqual(ranks([10, 20, 20, 30]), [1, 2.5, 2.5, 4]);
  assert.equal(spearman([1, 2, 3, 4], [1, 4, 9, 16]), 1); // monoton, aber nicht linear
});

test("correlation: identische Serien ⇒ r = 1 ⇒ Diversifikationsnutzen 0 (Golden)", () => {
  const candles = candlesFromCloses(growthSeries(100, 1.01, 40));
  const v = FACTORS.correlation.compute(input({ candles, benchmarkCandles: candles }));
  assert.equal(v.raw, 1);
  assert.equal(v.normalized, 0);
});

test("correlation: gegenläufige Serien ⇒ r = −1 ⇒ Nutzen 0 (Betrag zählt)", () => {
  const closes = [100, 110, 100, 110, 100, 110, 100];
  const inverse = closes.map((c) => 10_000 / c);
  const v = FACTORS.correlation.compute(
    input({ candles: candlesFromCloses(closes), benchmarkCandles: candlesFromCloses(inverse) })
  );
  assert.equal(v.raw, -1);
  assert.equal(v.normalized, 0);
});

test("correlation: ohne Benchmark ⇒ unavailable mit Neutralwert 0.5", () => {
  const v = FACTORS.correlation.compute(input({ candles: candlesFromCloses(growthSeries(100, 1.01, 40)) }));
  assert.equal(v.available, false);
  assert.equal(v.normalized, 0.5);
});

test("correlation: nur gemeinsame Zeitstempel werden verglichen", () => {
  const a = candlesFromCloses([100, 101, 102, 103, 104]);
  const b = candlesFromCloses([50, 51, 52], { endTime: a[4].time });
  const { left, right } = alignByTime(a, b);
  assert.deepEqual(left, [102, 103, 104]);
  assert.deepEqual(right, [50, 51, 52]);
});

// ── 11: News-Risiko ──────────────────────────────────────────────────────────

test("news: 2 Meldungen + 5/7d + 1 High-Impact + Termin ⇒ Risiko 0.76 (Golden)", () => {
  const v = FACTORS.news.compute(
    input({ news: { events24h: 2, events7d: 5, highImpact24h: 1, scheduledEventInHours: 12 } })
  );
  assert.equal(v.raw, 0.76); // 2×0.08 + 5×0.02 + 1×0.2 + 0.3
  assert.equal(v.normalized, 0.24);
  assert.equal(v.detail.scheduled, true);
});

test("news: ohne Kontext ⇒ konservativer Neutralwert 0.75", () => {
  const v = FACTORS.news.compute(input());
  assert.equal(v.available, false);
  assert.equal(v.normalized, 0.75);
});

test("news: veraltete Registry-Daten erhöhen das Risiko deterministisch", () => {
  const stale = instrument({ lastSeen: new Date(AS_OF_MS - 10 * 86_400_000).toISOString() });
  const v = FACTORS.news.compute(
    input({ instrument: stale, news: { events24h: 0, events7d: 0, highImpact24h: 0, scheduledEventInHours: null } })
  );
  assert.equal(v.raw, 0.2); // nur der Staleness-Beitrag
  assert.equal(v.detail.stale, true);
});

// ── 12: Funding ──────────────────────────────────────────────────────────────

test("funding: 1 bp je 8 h ⇒ 10.95 % p. a. ⇒ 0.781 (Golden)", () => {
  const v = FACTORS.funding.compute(
    input({
      instrument: instrument({ marketType: "perpetual" }),
      derivatives: { fundingRate: 0.0001, fundingIntervalHours: 8, openInterest: null, openInterestChange24h: null },
    })
  );
  assert.equal(v.raw, 0.0001);
  assert.equal(v.detail.annualized, 0.1095);
  assert.equal(v.normalized, 0.781);
});

test("funding: Spot kennt kein Funding ⇒ spotValue 1", () => {
  const v = FACTORS.funding.compute(input());
  assert.equal(v.normalized, 1);
  assert.equal(v.raw, 0);
});

test("funding: Perpetual ohne Rate ⇒ unavailable mit 0.5", () => {
  const v = FACTORS.funding.compute(input({ instrument: instrument({ marketType: "perpetual" }) }));
  assert.equal(v.available, false);
  assert.equal(v.normalized, 0.5);
});

// ── 13: Open Interest ────────────────────────────────────────────────────────

test("openInterest: 100 Mio. ⇒ 0.6384377847 (Golden, log-normiert)", () => {
  const v = FACTORS.openInterest.compute(
    input({
      instrument: instrument({ marketType: "perpetual" }),
      derivatives: { fundingRate: null, fundingIntervalHours: null, openInterest: 100_000_000, openInterestChange24h: 0.05 },
    })
  );
  assert.equal(v.raw, 100_000_000);
  assert.equal(v.normalized, 0.6384377847);
  assert.equal(v.detail.change24h, 0.05);
});

test("openInterest: Spot ⇒ Neutralwert 0.5 ohne Rohwert", () => {
  const v = FACTORS.openInterest.compute(input());
  assert.equal(v.raw, null);
  assert.equal(v.normalized, 0.5);
  assert.equal(v.available, true);
});

// ── 14: Handelskosten ────────────────────────────────────────────────────────

test("executionCost: 2×4 bp Taker + 2 bp Spread ⇒ 10 bp ⇒ 0.8888888889 (Golden)", () => {
  const v = FACTORS.executionCost.compute(input({ instrument: instrument({ takerFee: 0.0004, spread: 0.0002 }) }));
  assert.equal(v.raw, 0.001);
  assert.equal(v.normalized, 0.8888888889);
  assert.equal(v.detail.fees, 0.0008);
});

test("executionCost: feeMode maker/blend rechnen mit den Registry-Gebühren", () => {
  const inst = instrument({ makerFee: 0.0001, takerFee: 0.0005, spread: 0 });
  const maker = resolveScannerConfig({ factors: { execution: { feeMode: "maker" } } });
  const blend = resolveScannerConfig({ factors: { execution: { feeMode: "blend" } } });
  assert.equal(FACTORS.executionCost.compute(input({ instrument: inst, config: maker })).raw, 0.0002);
  assert.equal(FACTORS.executionCost.compute(input({ instrument: inst, config: blend })).raw, 0.0006);
});

test("executionCost: unbekannter Spread ⇒ unavailable (Kosten nie unterschätzen)", () => {
  const v = FACTORS.executionCost.compute(input({ instrument: instrument({ spread: null }) }));
  assert.equal(v.available, false);
  assert.equal(v.normalized, 0);
});

// ── Edge Cases quer über alle Faktoren ───────────────────────────────────────

test("Edge Cases: leere Serie liefert für jeden Faktor einen endlichen Wert in [0,1]", () => {
  const values = computeAllFactors(input({ candles: [] }));
  for (const id of FACTOR_IDS) {
    const v = values[id];
    assert.ok(Number.isFinite(v.normalized), `${id}: normalized muss endlich sein`);
    assert.ok(v.normalized >= 0 && v.normalized <= 1, `${id}: normalized außerhalb [0,1]`);
    assert.ok(v.raw === null || Number.isFinite(v.raw), `${id}: raw muss null oder endlich sein`);
    assert.ok(v.reason.length > 0, `${id}: Begründung fehlt`);
  }
});

test("Edge Cases: NaN-Preise werfen nie und führen nie zu NaN-Ausgaben", () => {
  const candles = candlesFromCloses([100, 101, 102, 103, 104, 105]);
  candles[1] = { ...candles[1], close: Number.NaN, high: Number.NaN, low: Number.NaN };
  const values = computeAllFactors(input({ candles }));
  for (const id of FACTOR_IDS) {
    assert.ok(Number.isFinite(values[id].normalized), `${id}: NaN durchgereicht`);
  }
});

test("Edge Cases: negative/0-Preise gelten als unbrauchbar", () => {
  assert.equal(closesOf(candlesFromCloses([100, 0, 102])), null);
  assert.equal(logReturns([100, -5]), null);
  assert.equal(stdDev([1]), null);
  assert.equal(wilderSmooth([1, 2], 5), null);
  assert.equal(ema([], 5), null);
});

test("Math: bandNorm-Flanken sind an den Stützstellen exakt", () => {
  assert.equal(bandNorm(0.05, 0.05, 0.2, 0.8, 2.5), 0);
  assert.equal(bandNorm(0.2, 0.05, 0.2, 0.8, 2.5), 1);
  assert.equal(bandNorm(0.8, 0.05, 0.2, 0.8, 2.5), 1);
  assert.equal(bandNorm(2.5, 0.05, 0.2, 0.8, 2.5), 0);
  assert.equal(roundTo(bandNorm(0.125, 0.05, 0.2, 0.8, 2.5)), 0.5);
});

test("Determinismus: zwei Berechnungen derselben Eingabe sind identisch", () => {
  const candles = candlesFromCloses(growthSeries(100, 1.003, 90), { wickPct: 0.01 });
  const inst: MarketInstrument = instrument();
  const a = computeAllFactors(input({ instrument: inst, candles }));
  const b = computeAllFactors(input({ instrument: inst, candles }));
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});
