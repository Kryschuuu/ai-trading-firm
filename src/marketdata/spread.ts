/**
 * Relative bid/ask spread used to enrich `MarketInstrument.spread`.
 *
 * Formula: `(ask − bid) / mid` with `mid = (ask + bid) / 2`.
 * `0.0004` = 4 bp. Missing or invalid book levels yield `null`
 * (unknown — never coerced to 0, which would look “tight”).
 */

/**
 * Compute the relative spread from best bid/ask.
 *
 * @returns `null` when either side is missing, non-finite, ≤ 0, or ask < bid.
 */
export function calculateRelativeSpread(bid?: number, ask?: number): number | null {
  if (bid === undefined || ask === undefined) return null;
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) return null;
  if (bid <= 0 || ask <= 0) return null;
  if (ask < bid) return null;
  const mid = (bid + ask) / 2;
  if (!(mid > 0) || !Number.isFinite(mid)) return null;
  const spread = (ask - bid) / mid;
  if (!Number.isFinite(spread) || spread < 0) return null;
  return spread;
}
