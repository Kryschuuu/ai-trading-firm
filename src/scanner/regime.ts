/**
 * Volatilitäts-Regime (Task 04).
 *
 * Klassifiziert die **annualisierte realisierte Volatilität** (Faktor
 * `volatility`) in vier Stufen. Schwellen sind konfigurierbar
 * (`config.regime`), die Defaults sind dokumentiert:
 *
 * | Regime | Bedingung (annualisierte Volatilität) | Default |
 * | --- | --- | --- |
 * | `LOW` | `σ_a < low` | < 25 % |
 * | `NORMAL` | `low ≤ σ_a < normal` | 25 – 60 % |
 * | `HIGH` | `normal ≤ σ_a < high` | 60 – 120 % |
 * | `EXTREME` | `σ_a ≥ high` | ≥ 120 % |
 *
 * Die Grenzen gehören jeweils zur **oberen** Klasse (`σ_a = 0.25` ⇒ `NORMAL`).
 */

import type { RegimeConfig } from "./config";
import type { VolatilityRegime } from "./types";

/**
 * Klassifiziert eine annualisierte Volatilität.
 *
 * Ist der Wert unbekannt (`null`/`NaN`), wird `NORMAL` geliefert — die
 * Datenlage selbst wird bereits vom Filter `min-candles` abgefangen, damit
 * eine fehlende Reihe nicht als „ruhiger Markt“ durchgeht.
 */
export function classifyRegime(annualizedVolatility: number | null, config: RegimeConfig): VolatilityRegime {
  if (annualizedVolatility === null || !Number.isFinite(annualizedVolatility)) return "NORMAL";
  if (annualizedVolatility < config.low) return "LOW";
  if (annualizedVolatility < config.normal) return "NORMAL";
  if (annualizedVolatility < config.high) return "HIGH";
  return "EXTREME";
}

/** Menschenlesbare Beschreibung eines Regimes (Doku/UI/Begründungen). */
export function describeRegime(regime: VolatilityRegime, config: RegimeConfig): string {
  switch (regime) {
    case "LOW":
      return `ruhig (< ${(config.low * 100).toFixed(0)} % p. a.)`;
    case "NORMAL":
      return `normal (${(config.low * 100).toFixed(0)}–${(config.normal * 100).toFixed(0)} % p. a.)`;
    case "HIGH":
      return `erhöht (${(config.normal * 100).toFixed(0)}–${(config.high * 100).toFixed(0)} % p. a.)`;
    default:
      return `extrem (≥ ${(config.high * 100).toFixed(0)} % p. a.)`;
  }
}
