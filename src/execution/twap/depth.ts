/**
 * Depth-, Participation- und Impact-Entscheid (RMA-P4-03).
 *
 * Formeln (Einheiten im Doc `docs/TWAP_EXECUTION.md`):
 *
 *   Mid            (bestBid + bestAsk) / 2, nur wenn beide > 0 und ask ≥ bid.
 *                  Sonst null — nie 0.
 *   Buchalter      now − availableAt. availableAt > now ⇒ FUTURE (nicht nutzen).
 *                  Alter > maxBookAgeMs ⇒ STALE. Fehlendes Buch ⇒ MISSING.
 *   Participation  floorToStep(maxParticipation × observedVolume).
 *                  observedVolume null ⇒ Cap null (unbekannt ≠ 0 ≠ unbegrenzt).
 *                  observedVolume 0 (frisch beobachtet) ⇒ Cap 0.
 *   Verfügbare Tiefe  Summe der Gegenseite innerhalb des Eltern-Limits.
 *   Impact (bp)    LONG: (VWAP − bester zulässiger Ask) / Ask × 10 000
 *                  SHORT: (bester zulässiger Bid − VWAP) / Bid × 10 000
 *                  null, wenn nicht gelaufen (kein stilles 0).
 *   Slice-Menge    min(Plan, maxSlice, Impact-Cap, Participation-Cap),
 *                  auf den Step abgerundet. Unter dem Mindestslice ⇒ Pause,
 *                  keine illegale Order.
 *
 * Der geschätzte Impact ist der Take-Walk des sichtbaren Buchs bis zum
 * Eltern-Limit — die Obergrenze, falls das Maker-Limit doch genommen würde.
 * Das Kinder-Limit selbst bleibt auf der Maker-Seite und nie jenseits des
 * Eltern-Limits (LONG: nicht teurer, SHORT: nicht billiger).
 *
 * Konservativer Fallback (nur bei expliziter Policy): feste
 * `conservativeSliceQty`, Kinder-Limit = Eltern-Limit. Ohne Eltern-Limit
 * wird nicht geraten. Impact bleibt null (nicht gemessen). Participation
 * wird weiter angewendet, wenn das Volumen frisch bekannt ist.
 */
import { floorToStep } from "../quantities";
import { floorSteps, stepsToQty } from "./plan";

export interface BookLevel {
  price: number;
  qty: number;
}

export interface DepthBook {
  bids: BookLevel[];
  asks: BookLevel[];
  eventTime: number;
  availableAt: number;
  /** Basiseinheiten im Slice-Intervall. null = unbekannt. */
  observedVolume: number | null;
  volumeEventTime: number | null;
  volumeAvailableAt: number | null;
}

export interface DepthDecision {
  action: "submit" | "pause";
  reason: string;
  qty: number | null;
  limitPrice: number | null;
  /** null = nicht gemessen. 0 = gemessen und gleich dem Touch. */
  impactBps: number | null;
  availableDepth: number | null;
  participationCap: number | null;
  vwap: number | null;
  mid: number | null;
  bookAgeMs: number | null;
  /** null = unbekannt, 0 = frisch beobachtet leer. */
  volume: number | null;
}

export interface DepthInput {
  side: "LONG" | "SHORT";
  now: number;
  book: DepthBook | null;
  plannedQty: number;
  quantityStep: number;
  priceStep: number;
  minQuantity: number;
  minSliceQty: number;
  maxSliceQty: number;
  minNotional: number;
  maxParticipation: number;
  maxImpactBps: number;
  maxBookAgeMs: number;
  parentLimit: number | null;
  offsetBps: number;
  staleAction: "pause" | "conservative";
  conservativeSliceQty: number | null;
  postOnly: boolean;
}

function decimals(step: number): number {
  const s = step.toPrecision(12).replace(/0+$/, "").replace(/\.$/, "");
  const dot = s.indexOf(".");
  if (dot < 0) return 0;
  const e = s.indexOf("e");
  if (e >= 0) {
    const exp = Number(s.slice(e + 1));
    return Number.isFinite(exp) && exp < 0 ? Math.min(8, -exp) : 0;
  }
  return Math.min(8, s.length - dot - 1);
}

export function floorToTick(price: number, tick: number): number {
  if (!(price > 0) || !(tick > 0)) return 0;
  const steps = Math.floor(price / tick + 1e-9);
  if (steps <= 0) return 0;
  return Number((steps * tick).toFixed(decimals(tick)));
}

export function ceilToTick(price: number, tick: number): number {
  if (!(price > 0) || !(tick > 0)) return 0;
  const steps = Math.ceil(price / tick - 1e-9);
  if (steps <= 0) return 0;
  return Number((steps * tick).toFixed(decimals(tick)));
}

export function sortLevels(levels: readonly BookLevel[], side: "bid" | "ask"): BookLevel[] {
  const clean = levels.filter(
    (l) => Number.isFinite(l.price) && l.price > 0 && Number.isFinite(l.qty) && l.qty > 0,
  );
  return clean.slice().sort((a, b) => (side === "ask" ? a.price - b.price : b.price - a.price));
}

export function bookMid(book: DepthBook): number | null {
  const bids = sortLevels(book.bids, "bid");
  const asks = sortLevels(book.asks, "ask");
  const bid = bids[0]?.price;
  const ask = asks[0]?.price;
  if (bid === undefined || ask === undefined || !(bid > 0) || ask < bid) return null;
  return (bid + ask) / 2;
}

/** Frisches Volumen oder null. Stale/fehlende Verfügbarkeit wird nicht als 0 gelesen. */
export function freshVolume(book: DepthBook | null, now: number, maxAgeMs: number): number | null {
  if (!book || book.observedVolume === null) return null;
  if (!Number.isFinite(book.observedVolume) || book.observedVolume < 0) return null;
  if (book.volumeAvailableAt === null || book.volumeEventTime === null) return null;
  if (book.volumeAvailableAt > now || book.volumeEventTime > now) return null;
  if (now - book.volumeAvailableAt > maxAgeMs) return null;
  return book.observedVolume;
}

export function participationCapQty(volume: number | null, maxParticipation: number, step: number): number | null {
  if (volume === null) return null;
  return floorToStep(maxParticipation * volume, step);
}

export interface WalkResult {
  filled: number;
  vwap: number | null;
  impactBps: number | null;
  available: number;
}

/** Walk der Gegenseite bis `qty`, nur Levels innerhalb des Eltern-Limits. */
export function walkBook(args: {
  side: "LONG" | "SHORT";
  levels: readonly BookLevel[];
  qty: number;
  limitPrice: number | null;
}): WalkResult {
  const eligible = args.levels.filter((l) => {
    if (args.limitPrice === null) return true;
    return args.side === "LONG" ? l.price <= args.limitPrice + 1e-9 : l.price >= args.limitPrice - 1e-9;
  });
  const available = eligible.reduce((s, l) => s + l.qty, 0);
  const best = eligible[0]?.price;
  if (best === undefined || !(args.qty > 0)) {
    return { filled: 0, vwap: null, impactBps: null, available };
  }
  let remain = args.qty;
  let filled = 0;
  let notional = 0;
  for (const level of eligible) {
    if (remain <= 1e-12) break;
    const take = Math.min(level.qty, remain);
    filled += take;
    notional += take * level.price;
    remain -= take;
  }
  if (filled <= 0) return { filled: 0, vwap: null, impactBps: null, available };
  const vwap = notional / filled;
  const impactBps = args.side === "LONG" ? ((vwap - best) / best) * 10_000 : ((best - vwap) / best) * 10_000;
  return { filled, vwap, impactBps, available };
}

export function maxQtyWithinImpact(args: {
  side: "LONG" | "SHORT";
  levels: readonly BookLevel[];
  step: number;
  maxImpactBps: number;
  limitPrice: number | null;
}): { qty: number; impactBps: number | null; vwap: number | null; available: number } {
  const probe = walkBook({ side: args.side, levels: args.levels, qty: Number.MAX_SAFE_INTEGER / 4, limitPrice: args.limitPrice });
  const availableSteps = floorSteps(probe.available, args.step);
  let bestQty = 0;
  let bestImpact: number | null = null;
  let bestVwap: number | null = null;
  let lo = 0;
  let hi = availableSteps;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (mid === 0) {
      lo = 1;
      continue;
    }
    const qty = stepsToQty(mid, args.step);
    const walk = walkBook({ side: args.side, levels: args.levels, qty, limitPrice: args.limitPrice });
    const ok =
      walk.filled + args.step * 1e-6 >= qty &&
      walk.impactBps !== null &&
      walk.impactBps <= args.maxImpactBps + 1e-6;
    if (ok) {
      bestQty = qty;
      bestImpact = walk.impactBps;
      bestVwap = walk.vwap;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return { qty: bestQty, impactBps: bestImpact, vwap: bestVwap, available: probe.available };
}

/**
 * Maker-Limit, nie jenseits des Eltern-Limits.
 * LONG: floor, ≤ parentLimit, post-only strikt unter dem Ask.
 * SHORT: ceil, ≥ parentLimit, post-only strikt über dem Bid.
 * null = nicht platzierbar, ohne den Markt zu jagen.
 */
export function makerLimitPrice(args: {
  side: "LONG" | "SHORT";
  bid: number;
  ask: number;
  parentLimit: number | null;
  offsetBps: number;
  priceStep: number;
  postOnly: boolean;
}): number | null {
  const { side, bid, ask, parentLimit, offsetBps, priceStep, postOnly } = args;
  if (!(bid > 0) || !(ask >= bid) || !(priceStep > 0)) return null;
  const factor = offsetBps / 10_000;
  if (side === "LONG") {
    const maker = bid * (1 - factor);
    const capped = parentLimit === null ? maker : Math.min(maker, parentLimit);
    let limit = floorToTick(capped, priceStep);
    if (!(limit > 0)) return null;
    if (parentLimit !== null && limit > parentLimit + priceStep * 1e-6) return null;
    if (postOnly && limit >= ask) {
      limit = floorToTick(ask - priceStep, priceStep);
      if (!(limit > 0) || limit >= ask) return null;
      if (parentLimit !== null && limit > parentLimit + priceStep * 1e-6) return null;
    }
    return limit;
  }
  const maker = ask * (1 + factor);
  const raised = parentLimit === null ? maker : Math.max(maker, parentLimit);
  let limit = ceilToTick(raised, priceStep);
  if (!(limit > 0)) return null;
  if (parentLimit !== null && limit + priceStep * 1e-6 < parentLimit) return null;
  if (postOnly && limit <= bid) {
    limit = ceilToTick(bid + priceStep, priceStep);
    if (!(limit > bid)) return null;
    if (parentLimit !== null && limit + priceStep * 1e-6 < parentLimit) return null;
  }
  return limit;
}

function decision(partial: Partial<DepthDecision> & Pick<DepthDecision, "action" | "reason">): DepthDecision {
  return {
    action: partial.action,
    reason: partial.reason,
    qty: partial.qty ?? null,
    limitPrice: partial.limitPrice ?? null,
    impactBps: partial.impactBps ?? null,
    availableDepth: partial.availableDepth ?? null,
    participationCap: partial.participationCap ?? null,
    vwap: partial.vwap ?? null,
    mid: partial.mid ?? null,
    bookAgeMs: partial.bookAgeMs ?? null,
    volume: partial.volume === undefined ? null : partial.volume,
  };
}

function minRequiredSteps(input: DepthInput, referencePrice: number | null): number {
  let minSteps = Math.max(floorSteps(input.minSliceQty, input.quantityStep) === 0 ? 1 : 0, 1);
  const fromPolicy = Math.ceil(input.minSliceQty / input.quantityStep - 1e-9);
  const fromVenue = Math.ceil(input.minQuantity / input.quantityStep - 1e-9);
  minSteps = Math.max(fromPolicy, fromVenue, 1);
  if (input.minNotional > 0) {
    if (referencePrice === null || !(referencePrice > 0)) return Number.POSITIVE_INFINITY;
    minSteps = Math.max(minSteps, Math.ceil(input.minNotional / referencePrice / input.quantityStep - 1e-9));
  }
  return minSteps;
}

function bookProblem(book: DepthBook | null, now: number, maxAgeMs: number, side: "LONG" | "SHORT"): string | null {
  if (!book) return "DEPTH_MISSING";
  if (book.availableAt > now || book.eventTime > now) return "DEPTH_FUTURE";
  if (now - book.availableAt > maxAgeMs) return "DEPTH_STALE";
  const bids = sortLevels(book.bids, "bid");
  const asks = sortLevels(book.asks, "ask");
  if (side === "LONG" && asks.length === 0) return "DEPTH_INVALID";
  if (side === "SHORT" && bids.length === 0) return "DEPTH_INVALID";
  if (bids.length === 0 || asks.length === 0 || asks[0]!.price < bids[0]!.price) return "DEPTH_INVALID";
  return null;
}

function belowMinReason(input: DepthInput, impactQty: number, participation: number | null): string {
  const step = input.quantityStep;
  const minQty = stepsToQty(minRequiredSteps(input, input.parentLimit), step);
  if (participation !== null && participation + step * 1e-6 < Math.max(input.minSliceQty, input.minQuantity)) {
    return "PARTICIPATION_BELOW_MIN";
  }
  if (impactQty + step * 1e-6 < Math.max(input.minSliceQty, input.minQuantity)) return "IMPACT_BELOW_MIN";
  if (minQty === 0) return "DEPTH_BELOW_MIN";
  return "DEPTH_BELOW_MIN";
}

/**
 * Entscheidet Submit oder Pause. `skip` gibt es nicht: eine zu kleine
 * Klippe pausiert deterministisch, statt eine Order unter Mindestlot zu senden
 * oder die Menge still auf 0 zu setzen.
 */
export function assessDepth(input: DepthInput): DepthDecision {
  const volume = freshVolume(input.book, input.now, input.maxBookAgeMs);
  const cap = participationCapQty(volume, input.maxParticipation, input.quantityStep);
  const age = input.book ? input.now - input.book.availableAt : null;
  const problem = bookProblem(input.book, input.now, input.maxBookAgeMs, input.side);
  if (problem) {
    if (input.staleAction === "pause") {
      return decision({ action: "pause", reason: problem, participationCap: cap, bookAgeMs: age, volume });
    }
    return conservative(input, cap, age, volume);
  }
  if (volume === null) {
    if (input.staleAction === "pause") {
      return decision({
        action: "pause",
        reason: "VOLUME_UNKNOWN",
        participationCap: null,
        bookAgeMs: age,
        volume: null,
        mid: input.book ? bookMid(input.book) : null,
      });
    }
    return conservative(input, null, age, null);
  }
  const book = input.book!;
  const bids = sortLevels(book.bids, "bid");
  const asks = sortLevels(book.asks, "ask");
  const bid = bids[0]!.price;
  const ask = asks[0]!.price;
  const mid = (bid + ask) / 2;
  const levels = input.side === "LONG" ? asks : bids;
  const impact = maxQtyWithinImpact({
    side: input.side,
    levels,
    step: input.quantityStep,
    maxImpactBps: input.maxImpactBps,
    limitPrice: input.parentLimit,
  });
  const planned = floorToStep(Math.min(input.plannedQty, input.maxSliceQty), input.quantityStep);
  let qty = planned;
  qty = Math.min(qty, impact.qty);
  if (cap !== null) qty = Math.min(qty, cap);
  qty = floorToStep(qty, input.quantityStep);
  const reference = input.parentLimit ?? mid;
  const minSteps = minRequiredSteps(input, reference);
  if (!Number.isFinite(minSteps)) {
    return decision({
      action: "pause",
      reason: "NOTIONAL_UNPRICED",
      participationCap: cap,
      availableDepth: impact.available,
      mid,
      bookAgeMs: age,
      volume,
    });
  }
  if (floorSteps(qty, input.quantityStep) < minSteps) {
    return decision({
      action: "pause",
      reason: belowMinReason(input, impact.qty, cap),
      qty: null,
      impactBps: impact.impactBps,
      availableDepth: impact.available,
      participationCap: cap,
      vwap: impact.vwap,
      mid,
      bookAgeMs: age,
      volume,
    });
  }
  const limit = makerLimitPrice({
    side: input.side,
    bid,
    ask,
    parentLimit: input.parentLimit,
    offsetBps: input.offsetBps,
    priceStep: input.priceStep,
    postOnly: input.postOnly,
  });
  if (limit === null) {
    return decision({
      action: "pause",
      reason: "LIMIT_UNPRICEABLE",
      availableDepth: impact.available,
      participationCap: cap,
      impactBps: impact.impactBps,
      mid,
      bookAgeMs: age,
      volume,
    });
  }
  if (input.minNotional > 0 && qty * limit + 1e-9 < input.minNotional) {
    return decision({
      action: "pause",
      reason: "NOTIONAL_BELOW_MIN",
      participationCap: cap,
      availableDepth: impact.available,
      mid,
      bookAgeMs: age,
      volume,
    });
  }
  return decision({
    action: "submit",
    reason: "OK",
    qty,
    limitPrice: limit,
    impactBps: impact.impactBps,
    availableDepth: impact.available,
    participationCap: cap,
    vwap: impact.vwap,
    mid,
    bookAgeMs: age,
    volume,
  });
}

function conservative(
  input: DepthInput,
  cap: number | null,
  age: number | null,
  volume: number | null,
): DepthDecision {
  if (input.conservativeSliceQty === null || !(input.conservativeSliceQty > 0)) {
    return decision({ action: "pause", reason: "CONSERVATIVE_INVALID", participationCap: cap, bookAgeMs: age, volume });
  }
  if (input.parentLimit === null || !(input.parentLimit > 0)) {
    return decision({ action: "pause", reason: "LIMIT_UNPRICEABLE", participationCap: cap, bookAgeMs: age, volume });
  }
  let qty = floorToStep(Math.min(input.plannedQty, input.conservativeSliceQty, input.maxSliceQty), input.quantityStep);
  if (cap !== null) qty = floorToStep(Math.min(qty, cap), input.quantityStep);
  const limit = input.side === "LONG" ? floorToTick(input.parentLimit, input.priceStep) : ceilToTick(input.parentLimit, input.priceStep);
  if (!(limit > 0)) {
    return decision({ action: "pause", reason: "LIMIT_UNPRICEABLE", participationCap: cap, bookAgeMs: age, volume });
  }
  if (input.side === "LONG" && limit > input.parentLimit + input.priceStep * 1e-6) {
    return decision({ action: "pause", reason: "LIMIT_UNPRICEABLE", participationCap: cap, bookAgeMs: age, volume });
  }
  if (input.side === "SHORT" && limit + input.priceStep * 1e-6 < input.parentLimit) {
    return decision({ action: "pause", reason: "LIMIT_UNPRICEABLE", participationCap: cap, bookAgeMs: age, volume });
  }
  const minSteps = minRequiredSteps(input, limit);
  if (!Number.isFinite(minSteps) || floorSteps(qty, input.quantityStep) < minSteps) {
    return decision({ action: "pause", reason: "CONSERVATIVE_BELOW_MIN", participationCap: cap, bookAgeMs: age, volume });
  }
  if (input.minNotional > 0 && qty * limit + 1e-9 < input.minNotional) {
    return decision({ action: "pause", reason: "NOTIONAL_BELOW_MIN", participationCap: cap, bookAgeMs: age, volume });
  }
  return decision({
    action: "submit",
    reason: "CONSERVATIVE",
    qty,
    limitPrice: limit,
    impactBps: null,
    availableDepth: null,
    participationCap: cap,
    vwap: null,
    mid: null,
    bookAgeMs: age,
    volume,
  });
}
