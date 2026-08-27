/**
 * **Faktor `volatility` — annualisierte realisierte Volatilität.**
 *
 * Formel: `r_t = ln(c_t / c_{t−1})`,
 * `σ = std(r)` (Populations-Standardabweichung über die letzten `lookback`
 * Renditen), `raw = σ × √periodsPerYear` (Default 365 ⇒ Tageskerzen, 24/7).
 *
 * Normalisierung: Trapez — zu ruhig (`< floor`) bietet keine Chance, zu wild
 * (`> ceiling`) ist mit konstantem Risikobudget nicht handelbar.
 *
 * Datenbedarf: ≥ 3 Kerzen (2 Renditen); voller Aussagewert ab `lookback + 1`.
 *
 * Speist zugleich die Regime-Klassifikation (`LOW/NORMAL/HIGH/EXTREME`).
 */
import { annualize, bandNorm, closesOf, logReturns, stdDev, tail } from "../math";
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
    if (!closes) return unavailable("volatility", VOLATILITY_NEUTRAL, "unbrauchbare Kursreihe (NaN/≤ 0)");
    const window = tail(closes, cfg.lookback + 1);
    const returns = logReturns(window);
    if (!returns || returns.length < 2) {
      return unavailable("volatility", VOLATILITY_NEUTRAL, `zu wenig Kurse (${closes.length})`);
    }
    const sigma = stdDev(returns);
    if (sigma === null) return unavailable("volatility", VOLATILITY_NEUTRAL, "σ nicht berechenbar");
    const annualized = annualize(sigma, cfg.periodsPerYear);
    return factorValue("volatility", {
      raw: annualized,
      normalized: bandNorm(annualized, cfg.floor, cfg.idealLow, cfg.idealHigh, cfg.ceiling),
      reason: `annualisierte Volatilität ${(annualized * 100).toFixed(1)} %`,
      detail: {
        sigmaPerPeriod: sigma,
        periods: returns.length,
        periodsPerYear: cfg.periodsPerYear,
      },
    });
  },
};
