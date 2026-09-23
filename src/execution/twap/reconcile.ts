/**
 * Parent-Status aus Slice- und Fill-Zeilen (RMA-P4-03).
 *
 * Invariante, solange der Parent nicht FAILED ist:
 *   filled + liveOutstanding + pending + unscheduled = target
 *
 *   filled            Summe der Slice-Fills (bekannte 0, wenn keine Fills)
 *   liveOutstanding   Ziel − Fill der Slices in SUBMITTED/PARTIAL
 *   pending           Ziel der PENDING-Slices
 *   unscheduled       explizit persistierter Rest (null = noch nicht geplant,
 *                     dann wird die Invariante nicht als 0 erzwungen)
 *
 * CANCELLED/SKIPPED-Slices tragen nur ihren Fill bei. Ihre ungefillte
 * Zielmenge muss im Rest oder in neuen PENDING-Slices liegen — sie bleibt
 * nicht als „noch offen“ hängen.
 *
 * Terminal:
 *   filled ≈ target und nichts Lebendiges ⇒ COMPLETED
 *   now ≥ deadline, nichts Lebendiges, Rest > Staub ⇒ EXPIRED
 *   filled > target ⇒ FAILED (OVERFILL), kein stilles Klemmen
 *   erzwungener Cancel bleibt CANCELLED
 *   Pause bleibt PAUSED, bis Resume oder ein terminaler Zwang
 */
export type TwapParentStatus = "PLANNED" | "RUNNING" | "PAUSED" | "COMPLETED" | "EXPIRED" | "CANCELLED" | "FAILED";
export type TwapSliceStatus = "PENDING" | "SUBMITTED" | "PARTIAL" | "DONE" | "SKIPPED" | "CANCELLED";

export interface ReconcileSlice {
  status: TwapSliceStatus;
  targetQty: number;
  filledQty: number;
}

export interface ReconcileResult {
  status: TwapParentStatus;
  reason: string;
  filledQty: number;
  liveOutstandingQty: number;
  pendingQty: number;
  unscheduledQty: number | null;
  invariantOk: boolean;
}

const TERMINAL: ReadonlySet<TwapParentStatus> = new Set(["COMPLETED", "EXPIRED", "CANCELLED", "FAILED"]);

export function isTerminalStatus(status: TwapParentStatus): boolean {
  return TERMINAL.has(status);
}

export function reconcileParent(input: {
  now: number;
  deadlineAt: number;
  targetQty: number;
  quantityStep: number;
  unscheduledQty: number | null;
  slices: readonly ReconcileSlice[];
  forced: TwapParentStatus | null;
  pauseReason: string | null;
}): ReconcileResult {
  const step = input.quantityStep;
  const dust = step * 1e-6;
  let filled = 0;
  let liveOutstanding = 0;
  let pending = 0;
  let live = false;
  for (const s of input.slices) {
    filled += s.filledQty;
    if (s.status === "SUBMITTED" || s.status === "PARTIAL") {
      live = true;
      liveOutstanding += Math.max(0, s.targetQty - s.filledQty);
    } else if (s.status === "PENDING") {
      pending += s.targetQty;
    }
  }
  const unscheduled = input.unscheduledQty;
  const accounted = filled + liveOutstanding + pending + (unscheduled ?? 0);
  const invariantOk = unscheduled === null ? true : Math.abs(accounted - input.targetQty) <= Math.max(dust, 1e-9);
  const overfill = filled > input.targetQty + Math.max(dust, 1e-9);
  if (overfill) {
    return {
      status: "FAILED",
      reason: "OVERFILL",
      filledQty: filled,
      liveOutstandingQty: liveOutstanding,
      pendingQty: pending,
      unscheduledQty: unscheduled,
      invariantOk: false,
    };
  }
  if (!invariantOk) {
    return {
      status: "FAILED",
      reason: "INVARIANT_BROKEN",
      filledQty: filled,
      liveOutstandingQty: liveOutstanding,
      pendingQty: pending,
      unscheduledQty: unscheduled,
      invariantOk: false,
    };
  }
  const complete = !live && pending <= dust && filled + dust >= input.targetQty;
  if (input.forced === "FAILED") {
    return base("FAILED", input.pauseReason ?? "FORCED_FAILED", filled, liveOutstanding, pending, unscheduled, true);
  }
  if (input.forced === "CANCELLED") {
    return base("CANCELLED", input.pauseReason ?? "CANCELLED", filled, liveOutstanding, pending, unscheduled, true);
  }
  if (complete) return base("COMPLETED", "FILLED", filled, liveOutstanding, pending, unscheduled, true);
  if (!live && input.now >= input.deadlineAt) {
    return base("EXPIRED", "DEADLINE", filled, liveOutstanding, pending, unscheduled, true);
  }
  if (input.forced === "PAUSED") {
    return base("PAUSED", input.pauseReason ?? "PAUSED", filled, liveOutstanding, pending, unscheduled, true);
  }
  if (input.slices.length === 0 && unscheduled === null) {
    return base("PLANNED", "AWAITING_PLAN", filled, liveOutstanding, pending, unscheduled, true);
  }
  return base("RUNNING", live ? "LIVE_CHILD" : "SCHEDULED", filled, liveOutstanding, pending, unscheduled, true);
}

function base(
  status: TwapParentStatus,
  reason: string,
  filledQty: number,
  liveOutstandingQty: number,
  pendingQty: number,
  unscheduledQty: number | null,
  invariantOk: boolean,
): ReconcileResult {
  return { status, reason, filledQty, liveOutstandingQty, pendingQty, unscheduledQty, invariantOk };
}
