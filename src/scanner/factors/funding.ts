/**
 * **Faktor `funding` — Haltekosten bei Perpetuals.**
 *
 * Formel: `annualisiert = |fundingRate| × Intervalle pro Jahr`
 * (Intervalle = `8760 / fundingIntervalHours`, sonst
 * `defaultIntervalsPerYear` = 1095 ⇒ 8-Stunden-Takt).
 * `raw = fundingRate` (signiert, je Intervall).
 *
 * Normalisierung: invers linear — `0 → 1`, `maxAnnualized (0.5 = 50 % p. a.) → 0`.
 * Instrumente ohne Funding-Mechanik (Spot, Aktien, ETF) erhalten `spotValue`
 * (Default 1), weil dort schlicht keine Haltekosten anfallen.
 *
 * Datenbedarf: {@link DerivativeContext.fundingRate} für Perpetuals.
 *
 * Diagnose-Faktor: kein eigenes Score-Gewicht.
 */
import { inverseNorm } from "../math";
import type { Factor, FactorInput, FactorValue } from "../types";
import { factorValue, unavailable } from "./helpers";

/** Neutralwert, wenn ein Perpetual keine Funding-Daten liefert. */
export const FUNDING_NEUTRAL = 0.5;

/** Stunden pro Jahr (365 × 24). */
const HOURS_PER_YEAR = 8760;

/** Funding-Faktor (Diagnose, kein Score-Gewicht). */
export const fundingFactor: Factor = {
  id: "funding",
  label: "Funding-Kosten",
  neutral: FUNDING_NEUTRAL,
  compute(input: FactorInput): FactorValue {
    const cfg = input.config.factors.funding;
    const type = input.instrument.marketType;
    if (type !== "perpetual") {
      return factorValue("funding", {
        raw: 0,
        normalized: cfg.spotValue,
        reason: `Markttyp ${type} kennt kein Funding`,
        detail: { marketType: type },
      });
    }
    const rate = input.derivatives?.fundingRate ?? null;
    if (rate === null || !Number.isFinite(rate)) {
      return unavailable("funding", FUNDING_NEUTRAL, "keine Funding-Rate bekannt", { marketType: type });
    }
    const intervalHours = input.derivatives?.fundingIntervalHours ?? null;
    const intervals =
      intervalHours !== null && Number.isFinite(intervalHours) && intervalHours > 0
        ? HOURS_PER_YEAR / intervalHours
        : cfg.defaultIntervalsPerYear;
    const annualized = Math.abs(rate) * intervals;
    return factorValue("funding", {
      raw: rate,
      normalized: inverseNorm(annualized, 0, cfg.maxAnnualized),
      reason: `Funding ${(rate * 10_000).toFixed(2)} bp/Intervall ⇒ ${(annualized * 100).toFixed(1)} % p. a.`,
      detail: { annualized, intervalsPerYear: intervals, direction: rate > 0 ? "long zahlt" : rate < 0 ? "short zahlt" : "neutral" },
    });
  },
};
