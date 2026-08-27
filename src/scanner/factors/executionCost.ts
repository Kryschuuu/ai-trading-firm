/**
 * **Faktor `executionCost` — Handelskosten (Execution).**
 *
 * Formel (Roundturn, also Ein- **und** Ausstieg):
 *
 * ```text
 * feeMode = "taker" ⇒ 2 × takerFee      (Default, konservativ)
 * feeMode = "maker" ⇒ 2 × makerFee
 * feeMode = "blend" ⇒ makerFee + takerFee
 * raw = Gebühren + (includeSpread ? spread : 0)
 * ```
 *
 * Gebühren stammen aus der Instrument-Registry (`makerFee`/`takerFee`,
 * Task 01), der Spread aus `MarketInstrument.spread`.
 *
 * Normalisierung: invers linear — `bestCost (5 bp) → 1`, `worstCost (50 bp) → 0`.
 *
 * Datenbedarf: Registry-Gebühren; bei `includeSpread` zusätzlich ein bekannter
 * Spread (unbekannt ⇒ `available: false`, damit Kosten nie unterschätzt werden).
 */
import { inverseNorm } from "../math";
import type { Factor, FactorInput, FactorValue } from "../types";
import { factorValue, unavailable } from "./helpers";

/** Neutralwert ohne Datenlage: 0 — unbekannte Kosten gelten als teuer. */
export const EXECUTION_NEUTRAL = 0;

/** Handelskosten-Faktor (Score-Gewicht 5 %, „Execution“). */
export const executionCostFactor: Factor = {
  id: "executionCost",
  label: "Handelskosten (Roundturn)",
  neutral: EXECUTION_NEUTRAL,
  compute(input: FactorInput): FactorValue {
    const cfg = input.config.factors.execution;
    const { makerFee, takerFee, spread } = input.instrument;
    if (!Number.isFinite(makerFee) || !Number.isFinite(takerFee)) {
      return unavailable("executionCost", EXECUTION_NEUTRAL, "Gebühren unbekannt");
    }
    const fees =
      cfg.feeMode === "maker" ? 2 * makerFee : cfg.feeMode === "blend" ? makerFee + takerFee : 2 * takerFee;
    let spreadCost = 0;
    if (cfg.includeSpread) {
      if (spread === null || !Number.isFinite(spread) || spread < 0) {
        return unavailable("executionCost", EXECUTION_NEUTRAL, "Spread unbekannt — Kosten nicht bezifferbar", {
          fees,
        });
      }
      spreadCost = spread;
    }
    const cost = fees + spreadCost;
    return factorValue("executionCost", {
      raw: cost,
      normalized: inverseNorm(cost, cfg.bestCost, cfg.worstCost),
      reason: `Roundturn-Kosten ${(cost * 10_000).toFixed(2)} bp (${cfg.feeMode})`,
      detail: { fees, spreadCost, feeMode: cfg.feeMode, makerFee, takerFee },
    });
  },
};
