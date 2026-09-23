/**
 * Deterministischer TWAP-Planer (RMA-P4-03).
 *
 * Der Planer arbeitet in Venue-Steps (ganze Zahlen), nicht in Binärfloats.
 * Die Summe der Slice-Mengen ist exakt die Zielmenge. Der Rundungsrest liegt
 * auf dem letzten erlaubten Slice und wird, wenn der das Höchstslice sprengt,
 * rückwärts auf Slices mit Restkapazität verteilt. Ein Slice unter dem
 * Mindestslice oder über dem Höchstslice wird nicht emittiert — der Plan
 * schlägt fehl (fail-closed), statt eine illegale Order zu planen.
 *
 * Jitter kommt ausschließlich aus dem persistierten Seed (`unitSigned`).
 * Dieselbe Eingabe erzeugt denselben Plan. Jitter, der Grenzen verletzt,
 * wird geklemmt; der Rest bleibt auf dem letzten Slice. Schlägt die Reparatur
 * fehl, fällt der Plan auf die ungejitterte Menge zurück (Zeit-Jitter bleibt)
 * und meldet `JITTER_QTY_CLAMPED`.
 *
 * Zeit: Slice i startet bei `startAt + i * sliceIntervalMs` plus optionalem
 * Seed-Jitter, streng vor `deadlineAt`, monoton steigend. `startAt` ist die
 * bereits auf das Eltern-Raster gesnappten Startzeit — der Planer verschiebt
 * sie nicht noch einmal.
 *
 * Participation wird hier nur angewendet, wenn `observedVolume` eine Zahl ist
 * (auch 0). `null` ist unbekannt und wird NICHT als unbegrenztes oder leeres
 * Volumen gelesen. Der Submit-Pfad erzwingt die frische Participation noch
 * einmal; ein Plan ohne Volumen ist eine Zeit-/Mengenaufteilung unter
 * maxSlice, kein Freibrief.
 */
import { floorToStep } from "../quantities";
import { TwapError } from "./errors";
import { unitSigned } from "./keys";

export interface PlannedSlice {
  index: number;
  qty: number;
  scheduledAt: number;
}

export interface TwapPlan {
  slices: PlannedSlice[];
  /** Menge, die nicht termingerecht in erlaubte Slices passt. 0 ist eine echte Null. */
  unscheduledQty: number;
  jitter: "NONE" | "APPLIED" | "QTY_CLAMPED";
}

export interface PlanTwapInput {
  targetQty: number;
  quantityStep: number;
  minQuantity: number;
  startAt: number;
  deadlineAt: number;
  sliceIntervalMs: number;
  minSliceQty: number;
  maxSliceQty: number;
  minNotional: number;
  /** Preis für die Notional-Prüfung. Pflicht, wenn minNotional > 0. */
  referencePrice: number | null;
  maxParticipation: number;
  /** null = unbekannt (nicht 0, nicht unbegrenzt). */
  observedVolume: number | null;
  jitterFraction: number;
  jitterMs: number;
  /** Pflicht, sobald Jitter > 0. */
  seed: string | null;
}

function stepDecimals(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0;
  const s = step.toPrecision(15).replace(/0+$/, "").replace(/\.$/, "");
  const dot = s.indexOf(".");
  if (dot < 0) return 0;
  const e = s.indexOf("e");
  if (e >= 0) {
    const exp = Number(s.slice(e + 1));
    if (Number.isFinite(exp) && exp < 0) return Math.min(12, -exp);
    return 0;
  }
  return Math.min(12, s.length - dot - 1);
}

export function stepsToQty(steps: number, step: number): number {
  if (steps <= 0) return 0;
  return Number((steps * step).toFixed(stepDecimals(step)));
}

export function floorSteps(qty: number, step: number): number {
  if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(step) || step <= 0) return 0;
  return Math.floor(qty / step + 1e-9);
}

export function ceilSteps(qty: number, step: number): number {
  if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(step) || step <= 0) return 0;
  return Math.ceil(qty / step - 1e-9);
}

export function isStepAligned(qty: number, step: number): boolean {
  if (!(qty > 0) || !(step > 0)) return false;
  const floored = floorToStep(qty, step);
  return Math.abs(floored - qty) <= step * 1e-6;
}

/**
 * Nächster Rasterpunkt ≥ now auf dem Eltern-Raster `startAt + n * interval`.
 * Liegt `now` exakt auf einem Punkt, bleibt er. Sonst der nächste strikt
 * spätere Punkt. Deterministisch, kein Jitter.
 */
export function snapToGrid(parentStartAt: number, intervalMs: number, now: number): number {
  if (now <= parentStartAt) return parentStartAt;
  const elapsed = now - parentStartAt;
  const slots = Math.floor(elapsed / intervalMs);
  const onGrid = parentStartAt + slots * intervalMs;
  if (onGrid >= now) return onGrid;
  return onGrid + intervalMs;
}

function slotCount(startAt: number, deadlineAt: number, intervalMs: number): number {
  let n = 0;
  for (let i = 0; i < 100_000; i++) {
    const t = startAt + i * intervalMs;
    if (t >= deadlineAt) break;
    n++;
  }
  return n;
}

function repair(slices: number[], minSteps: number, maxSteps: number, totalSteps: number): boolean {
  let guard = 0;
  while (guard++ < slices.length * 8) {
    let changed = false;
    for (let i = 0; i < slices.length; i++) {
      if (slices[i]! > maxSteps) {
        const excess = slices[i]! - maxSteps;
        let moved = 0;
        for (let j = slices.length - 1; j >= 0 && moved < excess; j--) {
          if (j === i) continue;
          const room = maxSteps - slices[j]!;
          if (room <= 0) continue;
          const take = Math.min(room, excess - moved);
          slices[j] = slices[j]! + take;
          moved += take;
        }
        slices[i] = slices[i]! - moved;
        changed = true;
        if (moved < excess) return false;
      }
      if (slices[i]! < minSteps) {
        const need = minSteps - slices[i]!;
        let moved = 0;
        for (let j = slices.length - 1; j >= 0 && moved < need; j--) {
          if (j === i) continue;
          const spare = slices[j]! - minSteps;
          if (spare <= 0) continue;
          const take = Math.min(spare, need - moved);
          slices[j] = slices[j]! - take;
          moved += take;
        }
        slices[i] = slices[i]! + moved;
        changed = true;
        if (moved < need) return false;
      }
    }
    const sum = slices.reduce((s, n) => s + n, 0);
    if (sum !== totalSteps) return false;
    if (!changed && slices.every((n) => n >= minSteps && n <= maxSteps)) return true;
    if (!changed) return false;
  }
  return slices.every((n) => n >= minSteps && n <= maxSteps) && slices.reduce((s, n) => s + n, 0) === totalSteps;
}

function scheduleTimes(
  n: number,
  startAt: number,
  deadlineAt: number,
  intervalMs: number,
  jitterMs: number,
  seed: string | null,
): number[] {
  const times: number[] = [];
  let prev = startAt - 1;
  for (let i = 0; i < n; i++) {
    const jitter = jitterMs > 0 && seed ? Math.round(unitSigned(seed, "time", i) * jitterMs) : 0;
    let t = startAt + i * intervalMs + jitter;
    if (t < startAt) t = startAt;
    if (t <= prev) t = prev + 1;
    if (t >= deadlineAt) t = deadlineAt - 1;
    if (t <= prev || t >= deadlineAt) {
      throw new TwapError("WINDOW_TOO_SHORT", "Zeit-Jitter lässt sich nicht monoton vor die Deadline legen");
    }
    times.push(t);
    prev = t;
  }
  return times;
}

/**
 * Plant `targetQty` in erlaubte Slices. Wirft, wenn das Fenster oder die
 * Grenzen die Zielmenge nicht aufnehmen können. Eine Zielmenge unter dem
 * Mindestslice ist `UNSCHEDULABLE` (Aufrufer persistiert sie als unscheduled,
 * nicht als illegale Order).
 */
export function planTwap(input: PlanTwapInput): TwapPlan {
  const step = input.quantityStep;
  if (!Number.isFinite(step) || step <= 0) throw new TwapError("INVALID_STEP", "quantityStep muss > 0 sein", "quantityStep");
  if (!Number.isFinite(input.targetQty) || input.targetQty <= 0) {
    throw new TwapError("INVALID_TARGET_QTY", "targetQty muss > 0 sein", "targetQty");
  }
  if (!isStepAligned(input.targetQty, step)) {
    throw new TwapError("NOT_STEP_ALIGNED", `targetQty ${input.targetQty} verletzt den Step ${step}`, "targetQty");
  }
  if (!Number.isFinite(input.startAt) || !Number.isFinite(input.deadlineAt) || input.deadlineAt <= input.startAt) {
    throw new TwapError("INVALID_WINDOW", "deadlineAt muss nach startAt liegen", "deadlineAt");
  }
  if (!Number.isInteger(input.sliceIntervalMs) || input.sliceIntervalMs < 1_000) {
    throw new TwapError("SUBSECOND_INTERVAL", "sliceIntervalMs muss ganzzahlig und ≥ 1000 sein", "sliceIntervalMs");
  }
  if ((input.jitterFraction > 0 || input.jitterMs > 0) && (!input.seed || input.seed.length === 0)) {
    throw new TwapError("JITTER_SEED_REQUIRED", "Jitter ohne persistierten Seed ist verboten", "seed");
  }
  const totalSteps = Math.round(input.targetQty / step);
  let minSteps = Math.max(ceilSteps(input.minSliceQty, step), ceilSteps(input.minQuantity, step), 1);
  if (input.minNotional > 0) {
    if (input.referencePrice === null || !(input.referencePrice > 0)) {
      throw new TwapError("NOTIONAL_UNPRICED", "minNotional verlangt einen Referenzpreis", "referencePrice");
    }
    minSteps = Math.max(minSteps, ceilSteps(input.minNotional / input.referencePrice, step));
  }
  let maxSteps = floorSteps(input.maxSliceQty, step);
  if (input.observedVolume !== null) {
    if (!Number.isFinite(input.observedVolume) || input.observedVolume < 0) {
      throw new TwapError("INVALID_VOLUME", "observedVolume muss null oder ≥ 0 sein", "observedVolume");
    }
    const cap = floorSteps(input.maxParticipation * input.observedVolume, step);
    maxSteps = Math.min(maxSteps, cap);
  }
  if (totalSteps < minSteps) {
    return { slices: [], unscheduledQty: input.targetQty, jitter: "NONE" };
  }
  if (maxSteps < minSteps) {
    throw new TwapError("BOUNDS_INFEASIBLE", "Höchstslice liegt unter dem Mindestslice (Participation/Impact/Policy)", "maxSliceQty");
  }
  const nSlots = slotCount(input.startAt, input.deadlineAt, input.sliceIntervalMs);
  if (nSlots < 1) throw new TwapError("WINDOW_TOO_SHORT", "kein Slice-Start vor der Deadline", "deadlineAt");
  const maxSlicesByMin = Math.floor(totalSteps / minSteps);
  const minSlicesByMax = Math.ceil(totalSteps / maxSteps);
  if (minSlicesByMax > nSlots) {
    throw new TwapError("WINDOW_TOO_SHORT", "Fenster reicht nicht, um die Zielmenge unter dem Höchstslice zu verteilen", "deadlineAt");
  }
  const n = Math.min(nSlots, maxSlicesByMin);
  if (n < minSlicesByMax) {
    throw new TwapError("BOUNDS_INFEASIBLE", "Mindest- und Höchstslice widersprechen der Slot-Zahl", "minSliceQty");
  }
  const base = Math.floor(totalSteps / n);
  const residual = totalSteps - base * n;
  const raw = Array.from({ length: n }, () => base);
  raw[n - 1] = raw[n - 1]! + residual;
  if (!repair(raw, minSteps, maxSteps, totalSteps)) {
    throw new TwapError("PLAN_INFEASIBLE", "Rest ließ sich nicht in erlaubte Slices legen");
  }
  let jitter: TwapPlan["jitter"] = "NONE";
  const jittered = raw.slice();
  if (input.jitterFraction > 0 && input.seed && n > 1) {
    jitter = "APPLIED";
    for (let i = 0; i < n - 1; i++) {
      const delta = Math.round(unitSigned(input.seed, "qty", i) * input.jitterFraction * jittered[i]!);
      if (delta === 0) continue;
      jittered[i] = jittered[i]! + delta;
      jittered[n - 1] = jittered[n - 1]! - delta;
    }
    if (!repair(jittered, minSteps, maxSteps, totalSteps)) {
      jittered.splice(0, jittered.length, ...raw);
      jitter = "QTY_CLAMPED";
    }
  }
  const times = scheduleTimes(n, input.startAt, input.deadlineAt, input.sliceIntervalMs, input.jitterMs, input.seed);
  const slices = jittered.map((steps, index) => ({
    index,
    qty: stepsToQty(steps, step),
    scheduledAt: times[index]!,
  }));
  const sum = slices.reduce((s, sl) => s + sl.qty, 0);
  if (Math.abs(sum - input.targetQty) > step * 1e-6) {
    throw new TwapError("PLAN_SUM_MISMATCH", `Slice-Summe ${sum} ≠ Ziel ${input.targetQty}`);
  }
  return { slices, unscheduledQty: 0, jitter };
}
