/**
 * Gemeinsame Hilfen der Faktor-Module.
 *
 * Jeder Faktor liefert exakt ein {@link FactorValue}; diese Fabrik erzwingt
 * dabei die Invarianten: `normalized ∈ [0,1]`, keine `NaN`, gerundete Ausgabe
 * (Byte-Identität) und eine gefrorene `detail`-Struktur.
 */

import { clamp01, roundTo } from "../math";
import type { FactorId, FactorValue } from "../types";

/** Baut einen berechneten Faktorwert. */
export function factorValue(
  factorId: FactorId,
  args: {
    raw: number | null;
    normalized: number;
    reason: string;
    detail?: Record<string, number | string | boolean | null>;
  }
): FactorValue {
  const detail: Record<string, number | string | boolean | null> = {};
  for (const [k, v] of Object.entries(args.detail ?? {})) {
    detail[k] = typeof v === "number" ? roundTo(v) : v;
  }
  return Object.freeze({
    factorId,
    raw: args.raw === null || !Number.isFinite(args.raw) ? null : roundTo(args.raw),
    normalized: roundTo(clamp01(args.normalized)),
    available: true,
    reason: args.reason,
    detail: Object.freeze(detail),
  });
}

/**
 * Baut einen **nicht berechenbaren** Faktorwert: `raw = null`, `normalized`
 * ist der dokumentierte Neutralwert des Faktors, `available = false`.
 */
export function unavailable(
  factorId: FactorId,
  neutral: number,
  reason: string,
  detail?: Record<string, number | string | boolean | null>
): FactorValue {
  return Object.freeze({
    factorId,
    raw: null,
    normalized: roundTo(clamp01(neutral)),
    available: false,
    reason,
    detail: Object.freeze({ ...(detail ?? {}) }),
  });
}
