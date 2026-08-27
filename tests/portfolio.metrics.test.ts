/**
 * Golden-Tests der Kennzahl-Bibliothek (Task 05).
 *
 * Alle Referenzwerte wurden **unabhängig in Python** nachgerechnet (eigene
 * Implementierung derselben Formeln, ohne Bibliotheken); die Rechnungen stehen
 * als Kommentar am jeweiligen Test. Toleranz: 1e-6 (teils 1e-12).
 *
 * Zusätzlich: Robustheit (NaN/±∞/Preise ≤ 0 ⇒ definierter Fehler) und
 * Determinismus (gleiche Eingabe ⇒ byte-identische Ausgabe).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  annualizedReturn,
  averageTrueRange,
  classifyVolatilityRegime,
  computeMetrics,
  equityCurveFromLogReturns,
  logReturnsFromPrices,
  logReturnsFromSimpleReturns,
  maxDrawdown,
  profitFactor,
  realizedVolatility,
  sharpeRatio,
  sortinoRatio,
  trueRangeSeries,
  validateLogReturns,
} from "../src/portfolio/metrics";
import { annualizationFor, describeRegime, roundTo } from "../src/portfolio/config";
import { PortfolioError } from "../src/portfolio/errors";
import { GOLDEN_CANDLES, GOLDEN_PRICES } from "./fixtures/portfolioFixtures";

const A = 252;

test("Golden: logarithmische Renditen aus Schlusskursen", () => {
  const r = logReturnsFromPrices(GOLDEN_PRICES);
  // Python: [ln(102/100), ln(101/102), …] =
  // [0.01980262729617973, -0.009852296443011594, 0.03883983331626396,
  //  -0.019231361927887644, 0.06575137756278043, -0.01834913866819654,
  //  0.03636764417087479, 0.02643325706815543, -0.017544309650909508]
  const expected = [
    0.01980262729617973, -0.009852296443011594, 0.03883983331626396, -0.019231361927887644,
    0.06575137756278043, -0.01834913866819654, 0.03636764417087479, 0.02643325706815543,
    -0.017544309650909508,
  ];
  assert.equal(r.length, 9);
  for (let i = 0; i < expected.length; i++) {
    assert.ok(Math.abs(r[i] - expected[i]) < 1e-15, `r[${i}] = ${r[i]} ≠ ${expected[i]}`);
  }
});

test("Golden: Umrechnung einfacher Renditen ln(1 + R)", () => {
  const r = logReturnsFromSimpleReturns([0.1, -0.1, 0]);
  // Referenz: ln(1.1) = 0.09531017980432486, ln(0.9) = −0.10536051565782628
  assert.ok(Math.abs(r[0] - 0.09531017980432486) < 1e-14, `r0 = ${r[0]}`);
  assert.ok(Math.abs(r[1] + 0.10536051565782628) < 1e-14, `r1 = ${r[1]}`);
  assert.equal(r[2], 0);
  // Log-Renditen sind zeitadditiv: ln(1.1) + ln(0.9) = ln(0.99).
  assert.ok(Math.abs(r[0] + r[1] - Math.log(0.99)) < 1e-15);
});

test("Golden: realisierte Volatilität σ_p·√A = 0.4923966299039518", () => {
  const r = logReturnsFromPrices(GOLDEN_PRICES);
  // Python: std(ddof=1) = 0.031018072122194436 → × √252 = 0.4923966299039518
  const vol = realizedVolatility(r, A);
  assert.ok(Math.abs(vol - 0.4923966299039518) < 1e-12, `vol = ${vol}`);
  // Populations-σ (ddof = 0) = 0.029244118849249455
  assert.ok(Math.abs(realizedVolatility(r, A, 0) - 0.029244118849249455 * Math.sqrt(A)) < 1e-12);
});

test("Golden: annualisierte Rendite exp(r̄·A) − 1", () => {
  // Python: mean = 0.013579736969361008 → expm1(mean·252) = 29.63348575247991
  const value = annualizedReturn(0.013579736969361008, A);
  assert.ok(Math.abs(value - 29.63348575247991) < 1e-9, `value = ${value}`);
  assert.equal(annualizedReturn(0, A), 0);
});

test("Golden: True Range und ATR(14) = 3.431122448979592", () => {
  const trs = trueRangeSeries(GOLDEN_CANDLES);
  // Python: 15 True Ranges, Mittel der ersten 14 = 3.4642857142857144
  assert.equal(trs.length, 15);
  // TR[0]: high−low = 3, |high−prevClose| = |102.5−100| = 2.5, |low−prevClose| = 0.5 ⇒ 3
  assert.ok(Math.abs(trs[0] - 3) < 1e-12, `TR[0] = ${trs[0]}`);
  const atr = averageTrueRange(GOLDEN_CANDLES, 14);
  // Python (Wilder-RMA, Seed = Mittel der ersten 14 TR, danach 1 weiterer TR):
  // ATR14 = 3.431122448979592, atrPct = 3.431122448979592 / 112 = 0.030635021865889213
  assert.ok(Math.abs(atr - 3.431122448979592) < 1e-12, `ATR = ${atr}`);
  const metrics = computeMetrics(
    { symbol: "T", prices: GOLDEN_CANDLES.map((c) => c.close), candles: GOLDEN_CANDLES },
    { annualization: A, atrPeriod: 14 }
  );
  assert.ok(Math.abs((metrics.atrPct ?? 0) - 0.030635021865889213) < 1e-12);
  assert.equal(metrics.atrPeriod, 14);
});

test("Golden: Sharpe = 6.949872335532632 (annualisiert)", () => {
  const r = logReturnsFromPrices(GOLDEN_PRICES);
  // Python: (mean − 0)/std(ddof=1) = 0.43780080579683306 → × √252 = 6.949872335532632
  const s = sharpeRatio(r, { annualization: A, riskFreeRate: 0 });
  assert.ok(Math.abs(s.perPeriod - 0.43780080579683306) < 1e-12, `SR_p = ${s.perPeriod}`);
  assert.ok(Math.abs(s.annualized - 6.949872335532632) < 1e-9, `SR_a = ${s.annualized}`);
  // Mit rf = 25.2 % p. a. (= 0.1 % pro Periode) sinkt der Zähler exakt um rf_p/σ.
  const withRf = sharpeRatio(r, { annualization: A, riskFreeRate: 0.252 });
  assert.ok(Math.abs(withRf.perPeriod - (0.013579736969361008 - 0.001) / 0.031018072122194436) < 1e-12);
});

test("Golden: Sortino = 19.39886739685327 (annualisiert)", () => {
  const r = logReturnsFromPrices(GOLDEN_PRICES);
  // Python: DD = √(Σ min(r,0)²/n) = 0.011112589046232843
  //         Sortino_p = mean/DD = 1.2220137821045876 → × √252 = 19.39886739685327
  const s = sortinoRatio(r, { annualization: A, riskFreeRate: 0 });
  assert.ok(Math.abs(s.downsideDeviation - 0.011112589046232843) < 1e-15, `DD = ${s.downsideDeviation}`);
  assert.ok(Math.abs(s.perPeriod - 1.2220137821045876) < 1e-12);
  assert.ok(Math.abs(s.annualized - 19.39886739685327) < 1e-9, `So_a = ${s.annualized}`);
});

test("Golden: Max Drawdown = 2/105 mit Dauer 2 und Erholung bei Index 5", () => {
  // Equity-Kurve aus Log-Renditen reproduziert exakt prices/100.
  const equity = equityCurveFromLogReturns(logReturnsFromPrices(GOLDEN_PRICES));
  for (let i = 0; i < GOLDEN_PRICES.length; i++) {
    assert.ok(Math.abs(equity[i] - GOLDEN_PRICES[i] / 100) < 1e-12, `equity[${i}] = ${equity[i]}`);
  }
  const mdd = maxDrawdown(equity);
  // Handrechnung: Hoch 1.05 (Index 3) → Tief 1.03 (Index 4) ⇒ (1.05−1.03)/1.05 = 2/105.
  assert.ok(Math.abs(mdd.value - 2 / 105) < 1e-15, `MDD = ${mdd.value}`);
  assert.equal(mdd.peakIndex, 3);
  assert.equal(mdd.troughIndex, 4);
  assert.equal(mdd.recoveryIndex, 5);
  assert.equal(mdd.peakToTroughPeriods, 1);
  assert.equal(mdd.durationPeriods, 2);
  assert.equal(mdd.recovered, true);
});

test("Max Drawdown: nie erholter Rückgang läuft bis zum Serienende", () => {
  const mdd = maxDrawdown([100, 120, 60, 70, 80]);
  assert.ok(Math.abs(mdd.value - 0.5) < 1e-15, `MDD = ${mdd.value}`);
  assert.equal(mdd.peakIndex, 1);
  assert.equal(mdd.troughIndex, 2);
  assert.equal(mdd.recoveryIndex, null);
  assert.equal(mdd.durationPeriods, 3);
  assert.equal(mdd.recovered, false);
});

test("Max Drawdown: monotone Serie hat keinen Drawdown", () => {
  const mdd = maxDrawdown([1, 2, 3, 4]);
  assert.equal(mdd.value, 0);
  assert.equal(mdd.durationPeriods, 0);
  assert.equal(mdd.recovered, true);
});

test("Golden: Profit Factor = 2.880933746516732", () => {
  const r = logReturnsFromPrices(GOLDEN_PRICES);
  // Python: Bruttogewinn 0.18719473941425435, Bruttoverlust 0.06497710669000528
  const pf = profitFactor(r);
  assert.ok(Math.abs(pf.grossProfit - 0.18719473941425435) < 1e-15);
  assert.ok(Math.abs(pf.grossLoss - 0.06497710669000528) < 1e-15);
  assert.ok(Math.abs((pf.value ?? 0) - 2.880933746516732) < 1e-12, `PF = ${pf.value}`);
});

test("Profit Factor: ohne Verluste ∞, ohne Bewegung null", () => {
  assert.equal(profitFactor([0.01, 0.02]).value, Infinity);
  assert.equal(profitFactor([0, 0]).value, null);
  assert.equal(profitFactor([0.01, -0.02]).value, 0.5);
  assert.equal(profitFactor([-0.01]).value, 0);
});

test("Volatilitäts-Regime: Schwellen gehören zur oberen Klasse", () => {
  assert.equal(classifyVolatilityRegime(0.1), "LOW");
  assert.equal(classifyVolatilityRegime(0.25), "NORMAL");
  assert.equal(classifyVolatilityRegime(0.59), "NORMAL");
  assert.equal(classifyVolatilityRegime(0.6), "HIGH");
  assert.equal(classifyVolatilityRegime(1.19), "HIGH");
  assert.equal(classifyVolatilityRegime(1.2), "EXTREME");
  assert.equal(classifyVolatilityRegime(5), "EXTREME");
  assert.match(describeRegime("EXTREME"), /extrem/);
  assert.match(describeRegime("LOW"), /ruhig/);
});

test("Regime-Schwellen sind konfigurierbar und validiert", () => {
  assert.equal(classifyVolatilityRegime(0.3, { low: 0.1, normal: 0.2, high: 0.4 }), "HIGH");
  assert.equal(classifyVolatilityRegime(0.5, { low: 0.1, normal: 0.2, high: 0.4 }), "EXTREME");
  assert.throws(() => classifyVolatilityRegime(0.3, { low: 0.5, normal: 0.2, high: 0.4 }), PortfolioError);
});

test("Annualisierungsfaktor je Asset-Klasse", () => {
  assert.equal(annualizationFor("crypto"), 365);
  assert.equal(annualizationFor("equity"), 252);
  assert.equal(annualizationFor("CRYPTO"), 365);
  assert.equal(annualizationFor("unbekannt"), 252);
  assert.equal(annualizationFor(undefined), 252);
});

test("computeMetrics liefert den vollständigen Satz (Golden-Sammlung)", () => {
  const m = computeMetrics({ symbol: "T", prices: GOLDEN_PRICES }, { annualization: A });
  assert.equal(m.symbol, "T");
  assert.equal(m.observations, 9);
  assert.equal(m.annualization, A);
  assert.ok(Math.abs(m.volatility - 0.4923966299039518) < 1e-9);
  assert.ok(Math.abs(m.sharpe - 6.949872335532632) < 1e-9);
  assert.ok(Math.abs(m.sortino - 19.39886739685327) < 1e-9);
  assert.ok(Math.abs(m.maxDrawdown.value - 2 / 105) < 1e-12);
  assert.ok(Math.abs((m.profitFactor ?? 0) - 2.880933746516732) < 1e-9);
  assert.equal(m.regime, "NORMAL"); // 49.24 % p. a. ∈ [25 %, 60 %)
  assert.equal(m.atr, null);
  // JSON darf kein NaN/Infinity enthalten.
  const json = JSON.stringify(m);
  assert.ok(!json.includes("NaN") && !json.includes("Infinity"), json);
});

test("computeMetrics: Krypto-Annualisierung (365) ändert die Volatilität", () => {
  const equity = computeMetrics({ symbol: "T", prices: GOLDEN_PRICES, assetClass: "equity" });
  const crypto = computeMetrics({ symbol: "T", prices: GOLDEN_PRICES, assetClass: "crypto" });
  assert.equal(equity.annualization, 252);
  assert.equal(crypto.annualization, 365);
  assert.ok(Math.abs(crypto.volatility / equity.volatility - Math.sqrt(365 / 252)) < 1e-9);
});

test("Robustheit: NaN, ±∞ und Preise ≤ 0 werfen definierte Fehler", () => {
  const cases: { prices: number[]; code: string }[] = [
    { prices: [100, NaN, 105], code: "INVALID_INPUT" },
    { prices: [100, Infinity, 105], code: "INVALID_INPUT" },
    { prices: [100, -Infinity, 105], code: "INVALID_INPUT" },
    { prices: [100, 0, 105], code: "NON_POSITIVE_PRICE" },
    { prices: [100, -5, 105], code: "NON_POSITIVE_PRICE" },
    { prices: [100], code: "INSUFFICIENT_DATA" },
    { prices: [], code: "INSUFFICIENT_DATA" },
  ];
  for (const c of cases) {
    assert.throws(
      () => logReturnsFromPrices(c.prices),
      (e: unknown) => e instanceof PortfolioError && e.code === c.code,
      `erwartet ${c.code} für ${JSON.stringify(c.prices)}`
    );
  }
  assert.throws(() => logReturnsFromSimpleReturns([NaN]), PortfolioError);
  assert.throws(() => logReturnsFromSimpleReturns([-1]), PortfolioError);
  assert.throws(() => logReturnsFromSimpleReturns([-2]), PortfolioError);
  assert.throws(() => validateLogReturns([]), PortfolioError);
  assert.throws(() => validateLogReturns([0, NaN]), PortfolioError);
  // Die erste Kerze liefert keine True Range — ihr high/low geht nicht ein.
  assert.throws(
    () => trueRangeSeries([{ high: 1, low: 1, close: 1 }, { high: NaN, low: 1, close: 1 }]),
    PortfolioError
  );
  assert.throws(() => trueRangeSeries([{ high: 1, low: 1, close: 1 }]), PortfolioError);
  assert.throws(() => averageTrueRange(GOLDEN_CANDLES.slice(0, 5), 14), PortfolioError);
  assert.throws(() => maxDrawdown([1]), PortfolioError);
  assert.throws(() => maxDrawdown([1, 0]), PortfolioError);
  assert.throws(() => profitFactor([]), PortfolioError);
  assert.throws(() => realizedVolatility([0.01, NaN], A), PortfolioError);
  assert.throws(() => realizedVolatility([0.01], A), PortfolioError);
});

test("Robustheit: Serienquelle ist eindeutig — zwei Quellen sind ein Fehler", () => {
  assert.throws(
    () => computeMetrics({ symbol: "T", prices: GOLDEN_PRICES, returns: [0.01] }),
    (e: unknown) => e instanceof PortfolioError && e.code === "INVALID_INPUT"
  );
  assert.throws(
    () => computeMetrics({ symbol: "T" }),
    (e: unknown) => e instanceof PortfolioError && e.code === "INVALID_INPUT"
  );
  assert.throws(
    () => computeMetrics({ symbol: "", prices: GOLDEN_PRICES }),
    (e: unknown) => e instanceof PortfolioError && e.code === "INVALID_SYMBOL"
  );
});

test("Determinismus: gleiche Eingabe ⇒ byte-identische Ausgabe", () => {
  const a = JSON.stringify(computeMetrics({ symbol: "T", prices: GOLDEN_PRICES, candles: GOLDEN_CANDLES }, { annualization: A }));
  const b = JSON.stringify(computeMetrics({ symbol: "T", prices: GOLDEN_PRICES, candles: GOLDEN_CANDLES }, { annualization: A }));
  assert.equal(a, b);
});

test("Konstante Serie: Volatilität 0, Sharpe 0, Drawdown 0", () => {
  const m = computeMetrics({ symbol: "FLAT", prices: [100, 100, 100, 100] }, { annualization: A });
  assert.equal(m.volatility, 0);
  assert.equal(m.sharpe, 0);
  assert.equal(m.sortinoPerPeriod, 0);
  assert.equal(m.maxDrawdown.value, 0);
  assert.equal(m.profitFactor, null);
  assert.equal(m.regime, "LOW");
});

test("roundTo ist symmetrisch und fängt Nicht-Endliches ab", () => {
  assert.equal(roundTo(0.1234567890123456, 12), 0.123456789012);
  assert.equal(roundTo(-0.1234567890125, 12), -0.123456789013);
  assert.equal(roundTo(NaN, 12), 0);
  assert.equal(roundTo(Infinity, 12), 0);
});
