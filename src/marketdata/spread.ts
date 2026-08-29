/**
 * Relative bid/ask spread used to enrich `MarketInstrument.spread`.
 *
 * Formula: `(ask − bid) / mid` with `mid = (ask + bid) / 2`.
 * `0.0004` = 4 bp. Missing or invalid book levels yield `null`
 * (unknown — never coerced to 0, which would look “tight”).
 *
 * Datenquelle: `GET /api/v1/futures/market/depth` (bestBid/bestAsk). Die
 * Ticker-API liefert **keinen** Spread — siehe `docs/BITUNIX.md` §1.2.
 */

/**
 * Compute the relative spread from best bid/ask.
 *
 * @returns `null` when either side is missing, non-finite, ≤ 0, or ask < bid.
 */
// Relativer Spread = (ask - bid) / mid-price. Liefert null bei
// fehlenden/ungültigen Orderbook-Daten. WICHTIG: null ist explizit
// unterscheidbar von 0 — ein Spread von 0 wäre fachlich verdächtig,
// null bedeutet „nicht geladen“.
export function calculateRelativeSpread(bid?: number, ask?: number): number | null {
  // Ein Guard für alle „kein Preis“-Fälle: `typeof`/`isFinite` verwerfen
  // `undefined`, `null` (JSON-seitig durchgereicht), Strings, `NaN` und
  // ±`Infinity`. Damit entsteht hier weder eine Exception noch ein `NaN`-Spread.
  if (typeof bid !== "number" || typeof ask !== "number") return null;
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) return null;
  if (bid <= 0 || ask <= 0) return null;
  // Invertiertes Buch (bid > ask) ist kein handelbarer Spread, sondern
  // fehlerhafte Daten — unbekannt, nicht negativ.
  if (ask < bid) return null;
  const mid = (bid + ask) / 2;
  if (!(mid > 0) || !Number.isFinite(mid)) return null;
  const spread = (ask - bid) / mid;
  if (!Number.isFinite(spread) || spread < 0) return null;
  return spread;
}
