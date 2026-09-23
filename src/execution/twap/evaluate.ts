/**
 * Ausführungskennzahlen eines TWAP-Parents (RMA-P4-03) gegen den P4.1-`cost()`.
 *
 *   completion = filledQty / targetQty
 *     Bekannte Mengen. 0 ist eine echte Null (keine Fills), nicht „unbekannt“.
 *   durationMs = letzte Fill-availableAt − startAt, sonst null (kein stilles 0).
 *   coverage   = vom Ankunftsbuch begehbare Menge / Ziel.
 *     null, wenn das Ankunftsbuch fehlt, stale oder in der Zukunft liegt.
 *   TWAP-VWAP  = Σ(fill.qty × fill.price) / Σ fill.qty, sonst null.
 *   Sofort-Baseline = Walk der Zielmenge durch das Ankunftsbuch (nicht ein
 *     späteres Buch). Deckt das Buch das Ziel nicht, wird die Deckung
 *     berichtet und der ungedeckte Rest nicht extrapoliert.
 *   Shortfall  = cost(Seite, VWAP, Menge, Ankunft). Positiv = schlechter als
 *     die Ankunft. null, wenn eine Seite fehlt — nie 0 als Ersatz.
 *   shortfallVsImmediateBps = TWAP-bp − Sofort-bp, nur wenn beide gemessen
 *     sind. Die Quotienten-Differenz wird nicht als Dollar-Vergleich
 *     ausgegeben, wenn die Mengen auseinanderfallen (`quantityMismatch`).
 *
 * Ankunfts-Mid ist der Mid zum Parent-Start, dessen availableAt und eventTime
 * ≤ startAt sind und dessen Alter ≤ maxBookAgeMs ist. Sonst null
 * (MISSING / STALE / FUTURE). Ein späteres Buch wird nicht rückdatiert.
 */
import { cost } from "../../executionQuality/model";
import type { DepthBook } from "./depth";
import { bookMid, sortLevels, walkBook } from "./depth";

export interface TwapFillFact {
  qty: number;
  price: number;
  eventTime: number;
  availableAt: number;
}

export interface TwapEvaluationDraft {
  completion: number;
  durationMs: number | null;
  coverage: number | null;
  twapVwap: number | null;
  immediateVwap: number | null;
  immediateQty: number | null;
  arrivalPrice: number | null;
  arrivalReason: "OK" | "MISSING" | "STALE" | "FUTURE" | "INVALID";
  twapShortfallBps: number | null;
  immediateShortfallBps: number | null;
  shortfallVsImmediateBps: number | null;
  quantityMismatch: boolean;
  reason: string;
}

export function arrivalUsable(
  arrival: { mid: number; eventTime: number; availableAt: number } | null,
  startAt: number,
  maxBookAgeMs: number,
): { price: number | null; reason: TwapEvaluationDraft["arrivalReason"] } {
  if (!arrival) return { price: null, reason: "MISSING" };
  if (!(arrival.mid > 0) || !Number.isFinite(arrival.mid)) return { price: null, reason: "INVALID" };
  if (arrival.availableAt > startAt || arrival.eventTime > startAt) return { price: null, reason: "FUTURE" };
  if (startAt - arrival.eventTime > maxBookAgeMs || startAt - arrival.availableAt > maxBookAgeMs) {
    return { price: null, reason: "STALE" };
  }
  return { price: arrival.mid, reason: "OK" };
}

export function evaluateTwap(input: {
  side: "LONG" | "SHORT";
  targetQty: number;
  filledQty: number;
  fills: readonly TwapFillFact[];
  startAt: number;
  now: number;
  maxBookAgeMs: number;
  arrival: { mid: number; eventTime: number; availableAt: number } | null;
  /** Buch, das zum Start verfügbar war. Ein späteres Buch darf hier nicht stehen. */
  arrivalBook: DepthBook | null;
  parentLimit: number | null;
}): TwapEvaluationDraft {
  const arrival = arrivalUsable(input.arrival, input.startAt, input.maxBookAgeMs);
  const side = input.side === "LONG" ? "buy" : "sell";
  const completion = input.targetQty > 0 ? input.filledQty / input.targetQty : 0;
  let twapVwap: number | null = null;
  let durationMs: number | null = null;
  if (input.fills.length > 0) {
    let qty = 0;
    let notional = 0;
    let lastAvail = input.startAt;
    for (const f of input.fills) {
      if (!(f.qty > 0) || !(f.price > 0)) continue;
      qty += f.qty;
      notional += f.qty * f.price;
      if (f.availableAt > lastAvail) lastAvail = f.availableAt;
    }
    twapVwap = qty > 0 ? notional / qty : null;
    durationMs = qty > 0 ? lastAvail - input.startAt : null;
  }
  let coverage: number | null = null;
  let immediateVwap: number | null = null;
  let immediateQty: number | null = null;
  const bookOk =
    input.arrivalBook !== null &&
    input.arrivalBook.availableAt <= input.startAt &&
    input.arrivalBook.eventTime <= input.startAt &&
    input.startAt - input.arrivalBook.eventTime <= input.maxBookAgeMs &&
    bookMid(input.arrivalBook) !== null;
  if (!input.arrivalBook) {
    coverage = null;
  } else if (!bookOk) {
    coverage = null;
  } else {
    const levels = input.side === "LONG" ? sortLevels(input.arrivalBook.asks, "ask") : sortLevels(input.arrivalBook.bids, "bid");
    const walk = walkBook({
      side: input.side,
      levels,
      qty: input.targetQty,
      limitPrice: input.parentLimit,
    });
    coverage = input.targetQty > 0 ? walk.filled / input.targetQty : null;
    immediateQty = walk.filled > 0 ? walk.filled : 0;
    immediateVwap = walk.vwap;
  }
  const twapCost =
    twapVwap !== null && arrival.price !== null && input.filledQty > 0
      ? cost(side, twapVwap, input.filledQty, { price: arrival.price, reason: null })
      : null;
  const immediateCost =
    immediateVwap !== null && arrival.price !== null && immediateQty !== null && immediateQty > 0
      ? cost(side, immediateVwap, immediateQty, { price: arrival.price, reason: null })
      : null;
  const twapBps = twapCost?.bps.value ?? null;
  const immediateBps = immediateCost?.bps.value ?? null;
  const quantityMismatch =
    twapBps !== null && immediateBps !== null && Math.abs(input.filledQty - (immediateQty ?? 0)) > input.targetQty * 1e-6;
  const shortfallVsImmediateBps = twapBps !== null && immediateBps !== null ? twapBps - immediateBps : null;
  const reason = arrival.reason === "OK" ? (bookOk ? "OK" : "BASELINE_BOOK_MISSING") : `ARRIVAL_${arrival.reason}`;
  return {
    completion,
    durationMs,
    coverage,
    twapVwap,
    immediateVwap,
    immediateQty,
    arrivalPrice: arrival.price,
    arrivalReason: arrival.reason,
    twapShortfallBps: twapBps,
    immediateShortfallBps: immediateBps,
    shortfallVsImmediateBps,
    quantityMismatch,
    reason,
  };
}
