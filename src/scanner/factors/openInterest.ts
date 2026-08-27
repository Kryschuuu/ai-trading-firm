/**
 * **Faktor `openInterest` — offenes Interesse (Derivate).**
 *
 * Formel: `raw = openInterest` in Quote-Währung.
 * Normalisierung: logarithmisch wie bei der Liquidität —
 * `minOpenInterest → 0`, `maxOpenInterest → 1`.
 *
 * Instrumente ohne OI-Begriff (Spot, Aktien, ETF, FX) erhalten den
 * dokumentierten `neutralValue` (Default 0.5) — der Faktor darf Spot-Märkte
 * weder belohnen noch bestrafen.
 *
 * Datenbedarf: {@link DerivativeContext.openInterest} für Perpetual/Future.
 *
 * Diagnose-Faktor: kein eigenes Score-Gewicht.
 */
import { logNorm } from "../math";
import type { Factor, FactorInput, FactorValue } from "../types";
import { factorValue, unavailable } from "./helpers";

/** Neutralwert für fehlende OI-Daten bei Derivaten. */
export const OPEN_INTEREST_NEUTRAL = 0.5;

/** Open-Interest-Faktor (Diagnose, kein Score-Gewicht). */
export const openInterestFactor: Factor = {
  id: "openInterest",
  label: "Open Interest",
  neutral: OPEN_INTEREST_NEUTRAL,
  compute(input: FactorInput): FactorValue {
    const cfg = input.config.factors.openInterest;
    const type = input.instrument.marketType;
    const isDerivative = type === "perpetual" || type === "future" || type === "option";
    if (!isDerivative) {
      return factorValue("openInterest", {
        raw: null,
        normalized: cfg.neutralValue,
        reason: `Markttyp ${type} kennt kein Open Interest`,
        detail: { marketType: type },
      });
    }
    const oi = input.derivatives?.openInterest ?? null;
    if (oi === null || !Number.isFinite(oi) || oi <= 0) {
      return unavailable("openInterest", OPEN_INTEREST_NEUTRAL, "kein Open Interest bekannt", { marketType: type });
    }
    const change = input.derivatives?.openInterestChange24h ?? null;
    return factorValue("openInterest", {
      raw: oi,
      normalized: logNorm(oi, cfg.minOpenInterest, cfg.maxOpenInterest),
      reason: `Open Interest ${oi.toFixed(0)}`,
      detail: { change24h: change !== null && Number.isFinite(change) ? change : null, marketType: type },
    });
  },
};
