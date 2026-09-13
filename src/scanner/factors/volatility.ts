/**
 * **Faktor `volatility` — annualisierte realisierte Volatilität.**
 *
 * Formel: `r_t = ln(c_t / c_{t−1})`,
 * `σ = std(r)` (Populations-Standardabweichung über die letzten `lookback`
 * Renditen), `raw = σ × √periodsPerYear`.
 *
 * **Perioden pro Jahr (v1.37.0):** Der Wert wird standardmäßig aus dem
 * *tatsächlichen, gleichmäßigen Kerzenabstand* der gewerteten Reihe
 * abgeleitet ({@link inferPeriodsPerYear}, Median der Zeitdifferenzen):
 *
 *   - 1h-Kerzen (Scanner-Default über die Timeframe-Präferenz) ⇒ 8.760
 *   - Tageskerzen ⇒ 365
 *   - 5m-Kerzen ⇒ 105.120
 *
 * Zuvor war hier hart `365` vorkonfiguriert („Tageskerzen, 24/7“), während
 * der Sync den Scanner auf 1h-Kerzen betreibt — das rechnete die
 * annualisierte Volatilität um den Faktor √(8760/365) ≈ 4,9 zu klein und
 * schob damit den 15-%-Scoreblock UND die LOW/NORMAL/HIGH/EXTREME-Regime
 * massiv in Richtung LOW (kaum ein Markt erreichte die „interessant“-
 * Schwelle). Bei `inferPeriodsPerYear: false` gilt wieder der konfigurierte
 * `periodsPerYear`-Wert; er dient zugleich als Fallback bei zu kurzen oder
 * ungleichmäßigen Reihen.
 *
 * Normalisierung: Trapez — zu ruhig (`< floor`) bietet keine Chance, zu wild
 * (`> ceiling`) ist mit konstantem Risikobudget nicht handelbar.
 *
 * Datenbedarf: ≥ 3 Kerzen (2 Renditen); voller Aussagewert ab `lookback + 1`.
 *
 * Speist zugleich die Regime-Klassifikation (`LOW/NORMAL/HIGH/EXTREME`).
 */
import {
  annualize,
  bandNorm,
  closesOf,
  inferPeriodsPerYear,
  logReturns,
  roundTo,
  stdDev,
  tail,
} from "../math";
import type { Factor, FactorInput, FactorValue } from "../types";
import { factorValue, unavailable } from "./helpers";

/** Neutralwert ohne Datenlage: 0. */
export const VOLATILITY_NEUTRAL = 0;

/** Volatilitäts-Faktor (Score-Gewicht 15 %). */
export const volatilityFactor: Factor = {
  id: "volatility",
  label: "Realisierte Volatilität (annualisiert)",
  neutral: VOLATILITY_NEUTRAL,
  compute(input: FactorInput): FactorValue {
    const cfg = input.config.factors.volatility;
    const closes = closesOf(input.candles);
    if (!closes)
      return unavailable(
        "volatility",
        VOLATILITY_NEUTRAL,
        "unbrauchbare Kursreihe (NaN/≤ 0)",
      );
    const window = tail(closes, cfg.lookback + 1);
    const returns = logReturns(window);
    if (!returns || returns.length < 2) {
      return unavailable(
        "volatility",
        VOLATILITY_NEUTRAL,
        `zu wenig Kurse (${closes.length})`,
      );
    }
    const sigma = stdDev(returns);
    if (sigma === null)
      return unavailable(
        "volatility",
        VOLATILITY_NEUTRAL,
        "σ nicht berechenbar",
      );
    // Die Annualisierung MUSS zur Periodizität der gewerteten Reihe passen.
    // Default: aus den Zeitstempeln DESSELBEN Fensters ableiten (robust via
    // Median); der Config-Wert ist das Fallback bei nicht ableitbarem Abstand.
    const timestamps = tail(
      input.candles.map((c) => c.time),
      cfg.lookback + 1,
    );
    const periodsPerYear = cfg.inferPeriodsPerYear
      ? inferPeriodsPerYear(timestamps, cfg.periodsPerYear)
      : cfg.periodsPerYear;
    const annualized = annualize(sigma, periodsPerYear);
    return factorValue("volatility", {
      raw: annualized,
      normalized: bandNorm(
        annualized,
        cfg.floor,
        cfg.idealLow,
        cfg.idealHigh,
        cfg.ceiling,
      ),
      reason: `annualisierte Volatilität ${(annualized * 100).toFixed(1)} %`,
      detail: {
        sigmaPerPeriod: sigma,
        periods: returns.length,
        periodsPerYear: roundTo(periodsPerYear, 6),
        inferred: cfg.inferPeriodsPerYear,
      },
    });
  },
};
