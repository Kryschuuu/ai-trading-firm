/**
 * Mengen-/Preis-Arithmetik des Execution-Policy-Controllers (RMA-P4-02).
 *
 * Invarianten (werden in JEDEM Pfad erzwungen, nicht nur im Happy Path):
 *   1. Die kumulierte Fill-Menge überschreitet das Ziel NIE (Überfüllung ist
 *      ein harter Fehler, kein Clamp — ein Venue-Report über Ziel wird als
 *      `OVERFILL_DETECTED` terminal abgebrochen, nicht „korrigiert“).
 *   2. Die Fallback-Menge = Ziel − bestätigte Fills, ABGERUNDET auf den
 *      Venue-Mengen-Step, NIEMALS negativ. Eine Restmenge unter einem Step
 *      ist Staub (dust) — sie wird NICHT als Market nachgehandelt, sondern der
 *      Workflow schließt mit Reason `DUST_REMAINDER`.
 *   3. Venue-Minimum-/Tick-Regeln werden nie umgangen: Mengen unter
 *      `minQuantity` und Preise abseits des `priceStep` werden VOR dem Submit
 *      erkannt (fail-closed), nicht venue-seitig „geraten“.
 *   4. Gebühren: `feeQuoteTotal` ist NULL, sobald EIN Fill seine Gebühr nicht
 *      belegt (`feeQuote: null`). Unbekannt ≠ 0 — eine 0 würde PnL schönen.
 */

export interface FillFact {
  fillId: string;
  orderId: string;
  qty: number;
  price: number;
  /** Gebühr in Quote-Währung; null = unbekannt (nie still 0). */
  feeQuote: number | null;
}

export class ExecutionQuantityError extends Error {
  readonly code: string;
  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "ExecutionQuantityError";
    this.code = code;
  }
}

/** Zählt die Nachkommastellen eines Steps (1 → 0, 0.001 → 3). */
function stepDecimals(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0;
  const s = step.toPrecision(15).replace(/0+$/, "").replace(/\.$/, "");
  const dot = s.indexOf(".");
  if (dot < 0) return 0;
  // Exponent-Schreibweise (1e-7) defensiv auflösen.
  const e = s.indexOf("e");
  if (e >= 0) {
    const exp = Number(s.slice(e + 1));
    if (Number.isFinite(exp) && exp < 0) return Math.min(15, -exp + (s.slice(0, e).includes(".") ? s.slice(dot + 1, e).length : 0));
    return 0;
  }
  return Math.min(15, s.length - dot - 1);
}

/**
 * Rundet eine Menge AB auf den Venue-Step (floor). Nie auf — ein Aufrunden
 * könnte das Ziel überschreiten (Überfüllung) oder das Minimum vortäuschen.
 */
export function floorToStep(qty: number, step: number): number {
  if (!Number.isFinite(qty) || qty <= 0) return 0;
  if (!Number.isFinite(step) || step <= 0) {
    throw new ExecutionQuantityError("INVALID_QTY_STEP", `step muss endlich und > 0 sein (got ${String(step)})`);
  }
  const steps = Math.floor(qty / step + 1e-9);
  if (steps <= 0) return 0;
  const decimals = stepDecimals(step);
  const rounded = Number((steps * step).toFixed(decimals));
  return Number.isFinite(rounded) && rounded > 0 ? rounded : 0;
}

/** Rundet einen Preis auf den Venue-Tick (kaufmännisch, zur Tick-Mitte). */
export function roundToTick(price: number, tick: number): number {
  if (!Number.isFinite(price) || price <= 0) {
    throw new ExecutionQuantityError("INVALID_PRICE", `Preis muss endlich und > 0 sein (got ${String(price)})`);
  }
  if (!Number.isFinite(tick) || tick <= 0) {
    throw new ExecutionQuantityError("INVALID_PRICE_TICK", `tick muss endlich und > 0 sein (got ${String(tick)})`);
  }
  const decimals = stepDecimals(tick);
  // Epsilon-Korrektur: Binärbrüche wie 100.05/0.1 liegen knapp UNTER dem
  // mathematischen Halbtick; ohne Korrektur rundete Math.round falsch ab.
  // Die Verschiebung (1e-9 Ticks) ändert kein nicht-grenzwertiges Ergebnis.
  const rounded = Number((Math.round(price / tick + 1e-9) * tick).toFixed(decimals));
  if (!Number.isFinite(rounded) || rounded <= 0) {
    throw new ExecutionQuantityError("INVALID_PRICE", "Tick-Rundung ergab keinen positiven Preis");
  }
  return rounded;
}

/** Summe bestätigter Fills (fail-closed bei invaliden Fakten). */
export function sumFills(fills: readonly FillFact[]): number {
  let total = 0;
  for (const f of fills) {
    if (!Number.isFinite(f.qty) || f.qty <= 0) {
      throw new ExecutionQuantityError("INVALID_FILL_QTY", `Fill ${f.fillId} trägt keine positive Menge`);
    }
    if (!Number.isFinite(f.price) || f.price <= 0) {
      throw new ExecutionQuantityError("INVALID_FILL_PRICE", `Fill ${f.fillId} trägt keinen positiven Preis`);
    }
    total += f.qty;
  }
  return total;
}

/**
 * Gebühren-Summe in Quote-Währung. NULL, sobald ein Fill seine Gebühr nicht
 * belegt — der Aufrufer persistiert dann NULL (unbekannt), nie 0.
 */
export function sumFees(fills: readonly FillFact[]): number | null {
  let total = 0;
  for (const f of fills) {
    if (f.feeQuote === null || f.feeQuote === undefined) return null;
    if (!Number.isFinite(f.feeQuote) || f.feeQuote < 0) {
      throw new ExecutionQuantityError("INVALID_FILL_FEE", `Fill ${f.fillId} trägt keine gültige Gebühr`);
    }
    total += f.feeQuote;
  }
  return total;
}

export interface RemainderResult {
  /** Ziel − bestätigte Fills, auf Step abgerundet (0 bei Staub/negativ). */
  remainderQty: number;
  /** True, wenn eine positive Restmenge unter einem Step liegt (Staub). */
  isDust: boolean;
  /** Bestätigte Gesamtmenge (ungerundet). */
  filledQty: number;
}

/**
 * Berechnet die offene Restmenge. Wirft `OVERFILL_DETECTED`, wenn bestätigte
 * Fills das Ziel überschreiten (Toleranz 1e-9 gegen FP-Rauschen) — das ist ein
 * Venue-/Ledger-Widerspruch und wird terminal, nicht still geklemmt.
 */
export function computeRemainder(
  targetQty: number,
  fills: readonly FillFact[],
  qtyStep: number
): RemainderResult {
  if (!Number.isFinite(targetQty) || targetQty <= 0) {
    throw new ExecutionQuantityError("INVALID_TARGET_QTY", "Zielmenge muss endlich und > 0 sein");
  }
  const filledQty = sumFills(fills);
  const raw = targetQty - filledQty;
  if (raw < -1e-9) {
    throw new ExecutionQuantityError(
      "OVERFILL_DETECTED",
      `bestätigte Fills (${filledQty}) überschreiten das Ziel (${targetQty})`
    );
  }
  if (raw <= 1e-9) {
    return { remainderQty: 0, isDust: false, filledQty };
  }
  const floored = floorToStep(raw, qtyStep);
  if (floored <= 0) {
    return { remainderQty: 0, isDust: true, filledQty };
  }
  return { remainderQty: floored, isDust: false, filledQty };
}

/** Limit-Preis aus Mid ± Maker-Offset (LONG kauft unter Mid, SHORT verkauft über Mid). */
export function limitPriceFromMid(
  side: "LONG" | "SHORT",
  mid: number,
  offsetBps: number,
  priceTick: number
): number {
  if (!Number.isFinite(mid) || mid <= 0) {
    throw new ExecutionQuantityError("INVALID_MID", "Mid muss endlich und > 0 sein");
  }
  if (!Number.isFinite(offsetBps) || offsetBps < 0) {
    throw new ExecutionQuantityError("INVALID_OFFSET", "Offset muss endlich und ≥ 0 sein");
  }
  const factor = offsetBps / 10_000;
  const raw = side === "LONG" ? mid * (1 - factor) : mid * (1 + factor);
  return roundToTick(raw, priceTick);
}
