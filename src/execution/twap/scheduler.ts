/**
 * Restartbarer TWAP-Scheduler (RMA-P4-03).
 *
 * Ein Tick, ein Lease, höchstens ein neues Kind. Kinder laufen über den
 * injizierten Executor (Produktion: P4.2-Controller, kein Market-Fallback).
 * Die Slice-Identität ist der Kind-Key; die Menge wird vor `start` eingefroren,
 * damit ein Restart denselben Workflow-Key trifft und keine zweite Order legt.
 *
 * Kill-Switch und Deadline canceln lebende Kinder und markieren den Parent
 * erst dann terminal, wenn der Cancel bestätigt ist. Ein unbestätigter Cancel
 * pausiert (`*_UNCONFIRMED`) — die Order gilt nicht als weg. Disconnect
 * pausiert ohne Cancel-Versuch. Fehlende Tiefe pausiert; `null` wird nie als
 * 0 oder als unbegrenzte Participation gelesen.
 */
import { randomUUID } from "node:crypto";
import type { BrokerVenueId, ExecutionMode } from "../../contracts/broker";
import type { ExternalCancelReason } from "../controller";
import { auditTwap, countTwapTick } from "./audit";
import type { ChildExecutor, ChildView } from "./child";
import { assessDepth, bookMid, type DepthBook } from "./depth";
import { TwapError } from "./errors";
import { evaluateTwap, type TwapFillFact } from "./evaluate";
import { buildChildKey, buildEvalKey, buildEventId, buildParentKey, childWorkflowSeed } from "./keys";
import { childExecutionPolicy, parseTwapPolicy, type TwapPolicy } from "./policy";
import { floorSteps, isStepAligned, planTwap, snapToGrid, stepsToQty } from "./plan";
import { isTerminalStatus, reconcileParent, type TwapSliceStatus } from "./reconcile";
import type { SlicePatch, TwapParentRecord, TwapSliceRecord, TwapStore } from "./store";

const WORKER_RE = /^[A-Za-z0-9_.:-]{1,40}$/;
const CHILD_TERMINAL = new Set(["DONE", "FAILED", "REJECTED"]);

export interface TwapSchedulerDeps {
  store: TwapStore;
  executor: ChildExecutor;
  getBook: (venue: BrokerVenueId, symbol: string) => Promise<DepthBook | null>;
  now?: () => number;
  leaseMs?: number;
  isKilled?: () => boolean;
  /** null = unbekannt → Pause, kein Submit. */
  isMarketOpen?: () => boolean | null;
  /** null/false = nicht verbunden → Pause ohne Cancel. */
  isVenueConnected?: () => boolean | null;
}

export interface StartTwapInput {
  venue: BrokerVenueId;
  mode: ExecutionMode;
  symbol: string;
  side: "LONG" | "SHORT";
  targetQty: number;
  startAt: number;
  deadlineAt: number;
  seed: string;
  policy?: unknown;
  limitPrice?: number | null;
  hasStopLoss?: boolean;
  scope?: string;
  quoteCurrency?: string;
  quantityStep: number;
  priceStep: number;
  minQuantity: number;
}

export interface TwapTickResult {
  parent: TwapParentRecord;
  submitted: boolean;
  reason: string;
}

function canonicalQty(qty: number): string {
  return qty.toFixed(8);
}

function close(a: number, b: number, step: number): boolean {
  return Math.abs(a - b) <= Math.max(step * 1e-6, 1e-9);
}

function childTerminal(state: string): boolean {
  return CHILD_TERMINAL.has(state);
}

function sliceStatusOf(view: ChildView): TwapSliceStatus {
  if (view.state === "DONE") return "DONE";
  if (view.state === "FAILED" || view.state === "REJECTED") return "CANCELLED";
  if (view.filledQty > 0) return "PARTIAL";
  return "SUBMITTED";
}

function sumFilled(slices: readonly TwapSliceRecord[]): number {
  return slices.reduce((s, sl) => s + sl.filledQty, 0);
}

function liveOutstanding(slices: readonly TwapSliceRecord[]): number {
  let n = 0;
  for (const s of slices) {
    if (s.status === "SUBMITTED" || s.status === "PARTIAL" || (s.status === "PENDING" && s.qtyFrozen)) {
      n += Math.max(0, s.targetQty - s.filledQty);
    }
  }
  return n;
}

export class TwapScheduler {
  private readonly store: TwapStore;
  private readonly executor: ChildExecutor;
  private readonly getBook: TwapSchedulerDeps["getBook"];
  private readonly now: () => number;
  private readonly leaseMs: number;
  private readonly isKilled: () => boolean;
  private readonly isMarketOpen: () => boolean | null;
  private readonly isVenueConnected: () => boolean | null;
  private nonce = 0;

  constructor(deps: TwapSchedulerDeps) {
    this.store = deps.store;
    this.executor = deps.executor;
    this.getBook = deps.getBook;
    this.now = deps.now ?? (() => Date.now());
    this.leaseMs = deps.leaseMs ?? 30_000;
    this.isKilled = deps.isKilled ?? (() => false);
    this.isMarketOpen = deps.isMarketOpen ?? (() => true);
    this.isVenueConnected = deps.isVenueConnected ?? (() => true);
  }

  async start(input: StartTwapInput): Promise<TwapParentRecord> {
    const symbol = input.symbol.trim().toUpperCase();
    if (!symbol || symbol.length > 32) throw new TwapError("INVALID_INPUT", "symbol fehlt", "symbol");
    if (input.side !== "LONG" && input.side !== "SHORT") throw new TwapError("INVALID_INPUT", "side muss LONG oder SHORT sein", "side");
    if (!input.seed || input.seed.length > 128) throw new TwapError("INVALID_INPUT", "seed muss 1..128 Zeichen sein", "seed");
    if (!isStepAligned(input.targetQty, input.quantityStep)) {
      throw new TwapError("NOT_STEP_ALIGNED", "targetQty verletzt den Venue-Step", "targetQty");
    }
    const policy = parseTwapPolicy(input.policy);
    const limitPrice = input.limitPrice ?? null;
    if (limitPrice !== null && !(limitPrice > 0)) throw new TwapError("INVALID_INPUT", "limitPrice muss > 0 sein", "limitPrice");
    const parentKey = buildParentKey({
      venue: input.venue,
      mode: input.mode,
      symbol,
      side: input.side,
      targetQty: canonicalQty(input.targetQty),
      startAt: input.startAt,
      deadlineAt: input.deadlineAt,
      seed: input.seed,
      policyVersion: policy.policyVersion,
    });
    const now = this.now();
    const { record, created } = await this.store.createParent({
      parentKey,
      venue: input.venue,
      mode: input.mode,
      symbol,
      side: input.side,
      targetQty: input.targetQty,
      startAt: input.startAt,
      deadlineAt: input.deadlineAt,
      sliceIntervalMs: policy.sliceIntervalMs,
      policyVersion: policy.policyVersion,
      policy,
      jitterSeed: policy.jitterFraction > 0 || policy.jitterMs > 0 ? input.seed : input.seed,
      limitPrice,
      hasStopLoss: input.hasStopLoss ?? false,
      scope: input.scope ?? "twap",
      quoteCurrency: input.quoteCurrency ?? "USD",
      quantityStep: input.quantityStep,
      priceStep: input.priceStep,
      minQuantity: input.minQuantity,
      now,
    });
    const slices = await this.store.listSlices(record.id);
    if (!created && slices.length > 0) return record;
    return this.ensurePlan(record, policy, input.seed);
  }

  async tick(parentId: string, workerId: string): Promise<TwapTickResult> {
    this.assertWorker(workerId);
    const loaded = await this.store.loadParent(parentId);
    if (!loaded) throw new TwapError("PARENT_NOT_FOUND", parentId);
    if (isTerminalStatus(loaded.status)) return { parent: loaded, submitted: false, reason: "TERMINAL" };
    const now = this.now();
    const token = randomUUID();
    const leased = await this.store.acquireLease(loaded.id, loaded.version, workerId, token, now, now + this.leaseMs);
    if (!leased) return { parent: loaded, submitted: false, reason: "LEASE_HELD" };
    try {
      return await this.tickLeased(leased, workerId, now);
    } catch (e) {
      if (e instanceof TwapError && e.code === "STORE_CONFLICT") {
        const parent = (await this.store.loadParent(parentId)) ?? leased;
        countTwapTick("lost", "LEASE_LOST");
        return { parent, submitted: false, reason: "LEASE_LOST" };
      }
      throw e;
    } finally {
      await this.store.releaseLease(leased.id, workerId, token);
    }
  }

  async cancel(parentId: string, workerId: string): Promise<TwapParentRecord> {
    this.assertWorker(workerId);
    const parent = await this.store.loadParent(parentId);
    if (!parent) throw new TwapError("PARENT_NOT_FOUND", parentId);
    if (isTerminalStatus(parent.status)) return parent;
    const now = this.now();
    const token = randomUUID();
    const leased = await this.store.acquireLease(parent.id, parent.version, workerId, token, now, now + this.leaseMs);
    if (!leased) return parent;
    try {
      const ended = await this.cancelParent(leased, "OPERATOR_CANCEL", "CANCELLED", now, true);
      return ended.parent;
    } finally {
      await this.store.releaseLease(leased.id, workerId, token);
    }
  }

  async resume(parentId: string, workerId: string): Promise<TwapParentRecord> {
    this.assertWorker(workerId);
    const parent = await this.store.loadParent(parentId);
    if (!parent) throw new TwapError("PARENT_NOT_FOUND", parentId);
    if (parent.status !== "PAUSED") return parent;
    const now = this.now();
    const token = randomUUID();
    const leased = await this.store.acquireLease(parent.id, parent.version, workerId, token, now, now + this.leaseMs);
    if (!leased) return parent;
    try {
      const next = await this.store.updateParent(leased.id, leased.version, { status: "RUNNING", reason: "RESUMED" }, now);
      await this.event(next, "RESUME", "RESUMED", "PAUSED", "RUNNING", now);
      return next;
    } finally {
      await this.store.releaseLease(leased.id, workerId, token);
    }
  }

  async recover(workerId: string, limit = 50): Promise<{ results: TwapTickResult[]; errors: Array<{ id: string; code: string }> }> {
    const open = await this.store.listActionable(limit);
    const results: TwapTickResult[] = [];
    const errors: Array<{ id: string; code: string }> = [];
    for (const parent of open) {
      try {
        results.push(await this.tick(parent.id, workerId));
      } catch (e) {
        errors.push({ id: parent.id, code: e instanceof TwapError ? e.code : "RECOVER_ERROR" });
      }
    }
    return { results, errors };
  }

  async report(parentId: string): Promise<{ parent: TwapParentRecord; slices: TwapSliceRecord[]; evaluation: ReturnType<typeof evaluateTwap> }> {
    const parent = await this.store.loadParent(parentId);
    if (!parent) throw new TwapError("PARENT_NOT_FOUND", parentId);
    const slices = await this.store.listSlices(parentId);
    const fills = await this.collectFills(slices);
    const evaluation = evaluateTwap({
      side: parent.side,
      targetQty: parent.targetQty,
      filledQty: sumFilled(slices),
      fills,
      startAt: parent.startAt,
      now: this.now(),
      maxBookAgeMs: parent.policy.maxBookAgeMs,
      arrival: parent.arrivalMid === null ? null : { mid: parent.arrivalMid, eventTime: parent.arrivalEventTime ?? parent.startAt, availableAt: parent.arrivalAvailableAt ?? parent.startAt },
      arrivalBook: null,
      parentLimit: parent.limitPrice,
    });
    return { parent, slices, evaluation };
  }

  private async tickLeased(parent: TwapParentRecord, workerId: string, now: number): Promise<TwapTickResult> {
    let current = parent;
    if (current.status === "PLANNED") {
      const slices = await this.store.listSlices(current.id);
      if (slices.length === 0) current = await this.ensurePlan(current, { ...current.policy, policyVersion: current.policyVersion }, current.jitterSeed);
      current = await this.store.updateParent(current.id, current.version, { status: "RUNNING", reason: "STARTED" }, now);
    }
    const safety = this.safetyOf();
    if (safety.kind === "stop") {
      const ended = await this.cancelParent(current, safety.reason, safety.status, now, safety.cancelLive);
      countTwapTick("stop", safety.reason);
      return { parent: ended.parent, submitted: false, reason: safety.reason };
    }
    if (now >= current.deadlineAt) {
      const ended = await this.cancelParent(current, "DEADLINE", "EXPIRED", now, true);
      countTwapTick("deadline", ended.parent.status);
      return { parent: ended.parent, submitted: false, reason: ended.parent.reason ?? "DEADLINE" };
    }
    if (current.status === "PAUSED" && this.holdPause(current.reason)) {
      const ended = await this.cancelParent(current, "DEADLINE", current.reason === "DEADLINE_UNCONFIRMED" ? "EXPIRED" : "CANCELLED", now, true);
      return { parent: ended.parent, submitted: false, reason: ended.parent.reason ?? "PAUSED" };
    }
    if (current.status === "PAUSED") {
      current = await this.store.updateParent(current.id, current.version, { status: "RUNNING", reason: "RETRY" }, now);
    }
    current = await this.reconcileLive(current, now);
    if (isTerminalStatus(current.status)) return { parent: current, submitted: false, reason: current.reason ?? current.status };
    const boundary = await this.cancelExpiredSlice(current, now);
    current = boundary.parent;
    if (!boundary.confirmed) {
      current = await this.pause(current, "CANCEL_UNCONFIRMED", now);
      return { parent: current, submitted: false, reason: "CANCEL_UNCONFIRMED" };
    }
    const book = await this.getBook(current.venue, current.symbol);
    current = await this.captureArrival(current, book, now);
    current = await this.replan(current, now);
    if (isTerminalStatus(current.status) || current.status === "PAUSED") {
      return { parent: current, submitted: false, reason: current.reason ?? current.status };
    }
    const slices = await this.store.listSlices(current.id);
    const live = slices.some((s) => s.status === "SUBMITTED" || s.status === "PARTIAL");
    let submitted = false;
    if (!live) {
      const due = this.pickDue(slices, now);
      if (due) {
        const sent = await this.submitOne(current, due, workerId, now, book);
        current = sent.parent;
        submitted = sent.submitted;
        if (submitted) current = await this.replan(current, now);
      }
    }
    current = await this.persistReconcile(current, now);
    await this.persistEvaluation(current, now);
    countTwapTick(submitted ? "submit" : "idle", current.reason ?? current.status);
    return { parent: current, submitted, reason: current.reason ?? current.status };
  }

  private safetyOf(): { kind: "run" } | { kind: "stop"; reason: string; status: "CANCELLED" | "PAUSED" | "EXPIRED"; cancelLive: boolean } {
    if (this.isKilled()) return { kind: "stop", reason: "KILL_SWITCH", status: "CANCELLED", cancelLive: true };
    const connected = this.isVenueConnected();
    if (connected === false || connected === null) return { kind: "stop", reason: "VENUE_DISCONNECT", status: "PAUSED", cancelLive: false };
    const open = this.isMarketOpen();
    if (open === false) return { kind: "stop", reason: "MARKET_CLOSED", status: "PAUSED", cancelLive: true };
    if (open === null) return { kind: "stop", reason: "MARKET_UNKNOWN", status: "PAUSED", cancelLive: false };
    return { kind: "run" };
  }

  private async cancelParent(
    parent: TwapParentRecord,
    reason: string,
    want: "CANCELLED" | "PAUSED" | "EXPIRED",
    now: number,
    cancelLive: boolean,
  ): Promise<{ parent: TwapParentRecord }> {
    let current = parent;
    let confirmed = true;
    if (cancelLive) {
      const cancelled = await this.cancelLive(current, this.cancelReason(reason), now, reason);
      current = cancelled.parent;
      confirmed = cancelled.confirmed;
    }
    if (!confirmed) {
      return { parent: await this.pause(current, `${reason}_UNCONFIRMED`.slice(0, 64), now) };
    }
    current = await this.dropPending(current, reason, now);
    const slices = await this.store.listSlices(current.id);
    const filled = sumFilled(slices);
    const outstanding = liveOutstanding(slices);
    const unscheduled = Math.max(0, current.targetQty - filled - outstanding);
    const status = want === "EXPIRED" && filled + current.quantityStep * 1e-6 >= current.targetQty ? "COMPLETED" : want;
    current = await this.store.updateParent(current.id, current.version, { status, reason, filledQty: filled, unscheduledQty: unscheduled }, now);
    await this.event(current, "CANCEL", reason, parent.status, status, now);
    return { parent: current };
  }

  private cancelReason(reason: string): ExternalCancelReason {
    if (reason === "KILL_SWITCH") return "KILL_SWITCH";
    if (reason === "DEADLINE") return "DEADLINE";
    return "PARENT_CANCEL";
  }

  private async cancelLive(
    parent: TwapParentRecord,
    venueReason: ExternalCancelReason,
    now: number,
    auditReason: string,
  ): Promise<{ parent: TwapParentRecord; confirmed: boolean }> {
    let current = parent;
    let confirmed = true;
    const slices = await this.store.listSlices(parent.id);
    for (const slice of slices) {
      if (slice.status !== "SUBMITTED" && slice.status !== "PARTIAL") continue;
      if (!slice.workflowId) {
        confirmed = false;
        continue;
      }
      try {
        const view = await this.executor.cancel(slice.workflowId, venueReason);
        current = await this.applyView(current, slice, view, now, auditReason);
        if (!childTerminal(view.state)) confirmed = false;
      } catch {
        confirmed = false;
        await this.event(current, "CANCEL", "CANCEL_UNCONFIRMED", slice.status, slice.status, now, slice.id);
      }
    }
    return { parent: current, confirmed };
  }

  private async dropPending(parent: TwapParentRecord, reason: string, now: number): Promise<TwapParentRecord> {
    const slices = await this.store.listSlices(parent.id);
    for (const slice of slices) {
      if (slice.status !== "PENDING") continue;
      await this.store.updateSlice(slice.id, slice.version, { status: "CANCELLED", skipReason: reason, completedAt: now });
    }
    return (await this.store.loadParent(parent.id)) ?? parent;
  }

  private async reconcileLive(parent: TwapParentRecord, now: number): Promise<TwapParentRecord> {
    let current = parent;
    const slices = await this.store.listSlices(parent.id);
    for (const slice of slices) {
      if ((slice.status !== "SUBMITTED" && slice.status !== "PARTIAL") || !slice.workflowId) continue;
      const view = await this.executor.poll(slice.workflowId);
      current = await this.applyView(current, slice, view, now, view.reason ?? "RECONCILE");
      if (isTerminalStatus(current.status)) return current;
    }
    return current;
  }

  private async applyView(parent: TwapParentRecord, slice: TwapSliceRecord, view: ChildView, now: number, reason: string): Promise<TwapParentRecord> {
    const fresh = (await this.store.listSlices(parent.id)).find((s) => s.id === slice.id) ?? slice;
    const status = sliceStatusOf(view);
    await this.store.updateSlice(fresh.id, fresh.version, {
      status,
      filledQty: view.filledQty,
      workflowId: view.workflowId,
      workflowKey: view.workflowKey,
      completedAt: childTerminal(view.state) ? now : null,
    });
    await this.event(parent, "FILL", reason.slice(0, 64), fresh.status, status, now, fresh.id, {
      filledQty: view.filledQty,
      childState: view.state,
    });
    if (view.filledQty > fresh.targetQty + parent.quantityStep * 1e-6 || view.reason === "OVERFILL_DETECTED") {
      return this.fail(parent, "OVERFILL", now);
    }
    return (await this.store.loadParent(parent.id)) ?? parent;
  }

  private async cancelExpiredSlice(parent: TwapParentRecord, now: number): Promise<{ parent: TwapParentRecord; confirmed: boolean }> {
    const slices = await this.store.listSlices(parent.id);
    const live = slices.find((s) => s.status === "SUBMITTED" || s.status === "PARTIAL");
    if (!live || now < live.scheduledAt + parent.sliceIntervalMs) return { parent, confirmed: true };
    if (!live.workflowId) return { parent, confirmed: false };
    try {
      const view = await this.executor.cancel(live.workflowId, "EXTERNAL_CANCEL");
      const next = await this.applyView(parent, live, view, now, "SLICE_BOUNDARY");
      return { parent: next, confirmed: childTerminal(view.state) };
    } catch {
      return { parent, confirmed: false };
    }
  }

  private async replan(parent: TwapParentRecord, now: number): Promise<TwapParentRecord> {
    const slices = await this.store.listSlices(parent.id);
    const filled = sumFilled(slices);
    const committed = liveOutstanding(slices);
    const rawRemainder = parent.targetQty - filled - committed;
    const step = parent.quantityStep;
    const remainderSteps = floorSteps(Math.max(0, rawRemainder), step);
    const planTarget = stepsToQty(remainderSteps, step);
    const dust = Math.max(0, rawRemainder - planTarget);
    const pending = slices.filter((s) => s.status === "PENDING" && !s.qtyFrozen);
    const pendingSum = pending.reduce((s, sl) => s + sl.targetQty, 0);
    if (close(pendingSum, planTarget, step) && close(parent.unscheduledQty ?? 0, dust, step) && parent.unscheduledQty !== null) {
      return parent;
    }
    const policy = { ...parent.policy, policyVersion: parent.policyVersion };
    let planned: { index: number; qty: number; scheduledAt: number }[] = [];
    let jitter: string = "NONE";
    if (planTarget > 0) {
      const grid = snapToGrid(parent.startAt, parent.sliceIntervalMs, now);
      const fitted = this.fitPlan(planTarget, parent, policy, grid, parent.jitterSeed);
      planned = fitted.slices;
      jitter = fitted.jitter;
    }
    for (const slice of pending) {
      await this.store.updateSlice(slice.id, slice.version, { status: "SKIPPED", skipReason: "REPLAN", completedAt: now });
    }
    const maxIndex = slices.reduce((m, s) => Math.max(m, s.sliceIndex), -1);
    const planVersion = parent.planVersion + 1;
    if (planned.length > 0) {
      await this.store.insertSlices(
        parent.id,
        planned.map((sl, i) => ({
          sliceIndex: maxIndex + 1 + i,
          childKey: buildChildKey(parent.parentKey, maxIndex + 1 + i),
          planVersion,
          targetQty: sl.qty,
          scheduledAt: sl.scheduledAt,
        })),
      );
    }
    const unscheduled = dust + (planTarget - planned.reduce((s, sl) => s + sl.qty, 0));
    const next = await this.store.updateParent(
      parent.id,
      parent.version,
      { unscheduledQty: unscheduled, planVersion, cursorIndex: maxIndex + 1, reason: "ADAPTED" },
      now,
    );
    await this.event(next, "ADAPT", "REPLAN", parent.status, next.status, now, null, {
      planVersion,
      jitter,
      filledQty: filled,
      remainderQty: planTarget,
      unscheduledQty: unscheduled,
      previous: pending.map((s) => ({ index: s.sliceIndex, qty: s.targetQty })),
      next: planned,
    });
    return next;
  }

  /**
   * Plant so viel der Restmenge, wie Fenster und Slice-Grenzen tragen.
   * Was nicht mehr legal hineinpasst, bleibt unscheduled — der Tick wirft
   * deshalb nicht und schickt auch keine Order unter dem Mindestslice.
   */
  private fitPlan(
    planTarget: number,
    parent: TwapParentRecord,
    policy: TwapPolicy,
    grid: number,
    seed: string | null,
  ): { slices: { index: number; qty: number; scheduledAt: number }[]; jitter: string } {
    const step = parent.quantityStep;
    let qty = planTarget;
    let lastCode = "UNSCHEDULABLE";
    for (let attempt = 0; attempt < 8 && qty > 0; attempt++) {
      try {
        const plan = planTwap({
          targetQty: qty,
          quantityStep: step,
          minQuantity: parent.minQuantity,
          startAt: grid,
          deadlineAt: parent.deadlineAt,
          sliceIntervalMs: policy.sliceIntervalMs,
          minSliceQty: policy.minSliceQty,
          maxSliceQty: policy.maxSliceQty,
          minNotional: policy.minNotional,
          referencePrice: parent.limitPrice,
          maxParticipation: policy.maxParticipation,
          observedVolume: null,
          jitterFraction: policy.jitterFraction,
          jitterMs: policy.jitterMs,
          seed,
        });
        return { slices: plan.slices, jitter: qty + step * 1e-6 < planTarget ? "WINDOW_CLIPPED" : plan.jitter };
      } catch (e) {
        if (!(e instanceof TwapError) || !["WINDOW_TOO_SHORT", "BOUNDS_INFEASIBLE", "PLAN_INFEASIBLE"].includes(e.code)) {
          throw e;
        }
        lastCode = e.code;
        const slots = this.slotCount(grid, parent.deadlineAt, policy.sliceIntervalMs);
        const maxSteps = floorSteps(policy.maxSliceQty, step);
        const cap = stepsToQty(Math.max(0, slots) * Math.max(0, maxSteps), step);
        const next = Math.min(qty - step, cap);
        if (!(next > 0) || next >= qty) break;
        qty = next;
      }
    }
    return { slices: [], jitter: lastCode };
  }

  private slotCount(startAt: number, deadlineAt: number, intervalMs: number): number {
    let n = 0;
    for (let i = 0; i < 100_000; i++) {
      if (startAt + i * intervalMs >= deadlineAt) break;
      n++;
    }
    return n;
  }

  private pickDue(slices: readonly TwapSliceRecord[], now: number): TwapSliceRecord | null {
    return (
      slices
        .filter((s) => s.status === "PENDING" && s.scheduledAt <= now)
        .sort((a, b) => a.sliceIndex - b.sliceIndex)[0] ?? null
    );
  }

  private async submitOne(
    parent: TwapParentRecord,
    slice: TwapSliceRecord,
    workerId: string,
    now: number,
    book: DepthBook | null,
  ): Promise<{ parent: TwapParentRecord; submitted: boolean }> {
    const policy: TwapPolicy = { ...parent.policy, policyVersion: parent.policyVersion };
    let qty = slice.targetQty;
    let limit = slice.limitPrice;
    let reason = "FROZEN";
    let depthQty = slice.depthQty;
    let impactBps = slice.impactBps;
    let participationCap = slice.participationCap;
    if (!slice.qtyFrozen) {
      const decision = assessDepth({
        side: parent.side,
        now,
        book,
        plannedQty: slice.targetQty,
        quantityStep: parent.quantityStep,
        priceStep: parent.priceStep,
        minQuantity: parent.minQuantity,
        minSliceQty: policy.minSliceQty,
        maxSliceQty: policy.maxSliceQty,
        minNotional: policy.minNotional,
        maxParticipation: policy.maxParticipation,
        maxImpactBps: policy.maxImpactBps,
        maxBookAgeMs: policy.maxBookAgeMs,
        parentLimit: parent.limitPrice,
        offsetBps: policy.priceOffsetBps,
        staleAction: policy.staleDepthAction,
        conservativeSliceQty: policy.conservativeSliceQty,
        postOnly: policy.childPostOnly,
      });
      if (decision.action === "pause" || decision.qty === null || decision.limitPrice === null) {
        return { parent: await this.pause(parent, decision.reason, now), submitted: false };
      }
      qty = decision.qty;
      limit = decision.limitPrice;
      reason = decision.reason;
      depthQty = decision.availableDepth;
      impactBps = decision.impactBps;
      participationCap = decision.participationCap;
    }
    if (limit === null) return { parent: await this.pause(parent, "LIMIT_UNPRICEABLE", now), submitted: false };
    const claimed = await this.store.claimSlice(slice.id, slice.version, workerId, now, now - this.leaseMs);
    if (!claimed) return { parent, submitted: false };
    const patch: SlicePatch = slice.qtyFrozen
      ? { submitClaim: workerId }
      : { targetQty: qty, qtyFrozen: true, limitPrice: limit, depthQty, impactBps, participationCap };
    const frozen = await this.store.updateSlice(claimed.id, claimed.version, patch);
    const view = await this.executor.start({
      venue: parent.venue,
      mode: parent.mode,
      symbol: parent.symbol,
      side: parent.side,
      qty: frozen.targetQty,
      limitPrice: frozen.limitPrice ?? limit,
      seed: childWorkflowSeed(parent.parentKey, frozen.sliceIndex),
      policy: childExecutionPolicy(policy),
      hasStopLoss: parent.hasStopLoss,
    });
    const status = sliceStatusOf(view);
    await this.store.updateSlice(frozen.id, frozen.version, {
      status,
      filledQty: view.filledQty,
      workflowId: view.workflowId,
      workflowKey: view.workflowKey,
      submittedAt: now,
      completedAt: childTerminal(view.state) ? now : null,
      limitPrice: frozen.limitPrice ?? limit,
    });
    await this.event(parent, "SUBMIT", reason, "PENDING", status, now, frozen.id, {
      qty: frozen.targetQty,
      limitPrice: frozen.limitPrice ?? limit,
      impactBps,
      participationCap,
      depthQty,
      childState: view.state,
      workflowKey: view.workflowKey,
    });
    if (view.state === "REJECTED" || view.state === "FAILED") {
      return { parent: await this.pause((await this.store.loadParent(parent.id)) ?? parent, "CHILD_REJECTED", now), submitted: false };
    }
    return { parent: (await this.store.loadParent(parent.id)) ?? parent, submitted: true };
  }

  private async persistReconcile(parent: TwapParentRecord, now: number): Promise<TwapParentRecord> {
    const fresh = (await this.store.loadParent(parent.id)) ?? parent;
    const slices = await this.store.listSlices(fresh.id);
    const result = reconcileParent({
      now,
      deadlineAt: fresh.deadlineAt,
      targetQty: fresh.targetQty,
      quantityStep: fresh.quantityStep,
      unscheduledQty: fresh.unscheduledQty,
      slices,
      forced: fresh.status === "PAUSED" || fresh.status === "CANCELLED" || fresh.status === "FAILED" ? fresh.status : null,
      pauseReason: fresh.reason,
    });
    if (result.status === fresh.status && close(result.filledQty, fresh.filledQty, fresh.quantityStep)) return fresh;
    const next = await this.store.updateParent(
      fresh.id,
      fresh.version,
      { status: result.status, reason: result.reason, filledQty: result.filledQty },
      now,
    );
    await this.event(next, "RECONCILE", result.reason, fresh.status, result.status, now);
    return next;
  }

  private async persistEvaluation(parent: TwapParentRecord, now: number): Promise<void> {
    const slices = await this.store.listSlices(parent.id);
    const fills = await this.collectFills(slices);
    const draft = evaluateTwap({
      side: parent.side,
      targetQty: parent.targetQty,
      filledQty: sumFilled(slices),
      fills,
      startAt: parent.startAt,
      now,
      maxBookAgeMs: parent.policy.maxBookAgeMs,
      arrival:
        parent.arrivalMid === null
          ? null
          : {
              mid: parent.arrivalMid,
              eventTime: parent.arrivalEventTime ?? parent.startAt,
              availableAt: parent.arrivalAvailableAt ?? parent.startAt,
            },
      arrivalBook: null,
      parentLimit: parent.limitPrice,
    });
    await this.store.saveEvaluation({
      parentId: parent.id,
      evalKey: buildEvalKey(parent.parentKey, now, canonicalQty(sumFilled(slices)), parent.status),
      asOf: now,
      computedAt: now,
      completion: draft.completion,
      durationMs: draft.durationMs,
      coverage: draft.coverage,
      twapShortfallBps: draft.twapShortfallBps,
      immediateShortfallBps: draft.immediateShortfallBps,
      shortfallVsImmediateBps: draft.shortfallVsImmediateBps,
      arrivalPrice: draft.arrivalPrice,
      twapVwap: draft.twapVwap,
      immediateVwap: draft.immediateVwap,
      filledQty: sumFilled(slices),
      targetQty: parent.targetQty,
      reason: draft.reason,
      detail: { quantityMismatch: draft.quantityMismatch, arrivalReason: draft.arrivalReason },
    });
  }

  private async collectFills(slices: readonly TwapSliceRecord[]): Promise<TwapFillFact[]> {
    const fills: TwapFillFact[] = [];
    for (const slice of slices) {
      if (!slice.workflowId) continue;
      const rows = await this.executor.fills(slice.workflowId);
      for (const row of rows) fills.push(row);
    }
    return fills;
  }

  private async captureArrival(parent: TwapParentRecord, book: DepthBook | null, now: number): Promise<TwapParentRecord> {
    if (parent.arrivalMid !== null || !book) return parent;
    if (book.availableAt > parent.startAt || book.eventTime > parent.startAt) return parent;
    if (parent.startAt - book.eventTime > parent.policy.maxBookAgeMs) return parent;
    const mid = bookMid(book);
    if (mid === null) return parent;
    return this.store.updateParent(
      parent.id,
      parent.version,
      { arrivalMid: mid, arrivalEventTime: book.eventTime, arrivalAvailableAt: book.availableAt },
      now,
    );
  }

  private async ensurePlan(parent: TwapParentRecord, policy: TwapPolicy, seed: string | null): Promise<TwapParentRecord> {
    const plan = planTwap({
      targetQty: parent.targetQty,
      quantityStep: parent.quantityStep,
      minQuantity: parent.minQuantity,
      startAt: parent.startAt,
      deadlineAt: parent.deadlineAt,
      sliceIntervalMs: policy.sliceIntervalMs,
      minSliceQty: policy.minSliceQty,
      maxSliceQty: policy.maxSliceQty,
      minNotional: policy.minNotional,
      referencePrice: parent.limitPrice,
      maxParticipation: policy.maxParticipation,
      observedVolume: null,
      jitterFraction: policy.jitterFraction,
      jitterMs: policy.jitterMs,
      seed,
    });
    await this.store.insertSlices(
      parent.id,
      plan.slices.map((sl) => ({
        sliceIndex: sl.index,
        childKey: buildChildKey(parent.parentKey, sl.index),
        planVersion: 1,
        targetQty: sl.qty,
        scheduledAt: sl.scheduledAt,
      })),
    );
    const now = this.now();
    const next = await this.store.updateParent(
      parent.id,
      parent.version,
      { unscheduledQty: plan.unscheduledQty, planVersion: 1, reason: "PLANNED" },
      now,
    );
    await this.event(next, "PLAN", plan.jitter === "NONE" ? "PLANNED" : plan.jitter, null, next.status, now, null, {
      slices: plan.slices,
      unscheduledQty: plan.unscheduledQty,
    });
    return next;
  }

  private async pause(parent: TwapParentRecord, reason: string, now: number): Promise<TwapParentRecord> {
    const bounded = reason.slice(0, 64);
    if (parent.status === "PAUSED" && parent.reason === bounded) return parent;
    const next = await this.store.updateParent(parent.id, parent.version, { status: "PAUSED", reason: bounded }, now);
    await this.event(next, "PAUSE", bounded, parent.status, "PAUSED", now);
    return next;
  }

  private async fail(parent: TwapParentRecord, reason: string, now: number): Promise<TwapParentRecord> {
    const fresh = (await this.store.loadParent(parent.id)) ?? parent;
    const next = await this.store.updateParent(fresh.id, fresh.version, { status: "FAILED", reason }, now);
    await this.event(next, "RECONCILE", reason, fresh.status, "FAILED", now);
    return next;
  }

  private async event(
    parent: TwapParentRecord,
    kind: string,
    reason: string,
    fromStatus: string | null,
    toStatus: string | null,
    now: number,
    sliceId: string | null = null,
    detail: Record<string, unknown> = {},
  ): Promise<void> {
    const bounded = reason.slice(0, 64);
    await this.store.appendEvent({
      parentId: parent.id,
      sliceId,
      eventId: buildEventId(parent.parentKey, `${now}:${this.nonce++}:${randomUUID()}`, kind, bounded),
      kind,
      reason: bounded,
      fromStatus,
      toStatus,
      detail,
      eventTime: now,
      availableAt: now,
      computedAt: now,
      policyVersion: parent.policyVersion,
    });
    await auditTwap({
      parentKey: parent.parentKey,
      kind,
      reason: bounded,
      fromStatus,
      toStatus,
      policyVersion: parent.policyVersion,
    });
  }

  /** Pausen, die nicht durch einen frischen Tick still aufgehoben werden. */
  private holdPause(reason: string | null): boolean {
    return reason === "KILL_SWITCH_UNCONFIRMED" || reason === "DEADLINE_UNCONFIRMED" || reason === "CANCEL_UNCONFIRMED";
  }

  private assertWorker(workerId: string): void {
    if (!WORKER_RE.test(workerId)) throw new TwapError("INVALID_WORKER", "workerId muss 1..40 Zeichen [A-Za-z0-9_.:-] sein", "workerId");
  }
}
