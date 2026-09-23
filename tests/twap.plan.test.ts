/**
 * TWAP-Planer, Depth-Entscheid und Shortfall (RMA-P4-03).
 * Reine Funktionen — kein Scheduler, keine Datenbank.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assessDepth, freshVolume, participationCapQty, walkBook, type DepthBook } from "../src/execution/twap/depth";
import { evaluateTwap } from "../src/execution/twap/evaluate";
import { TwapError } from "../src/execution/twap/errors";
import { unitSigned } from "../src/execution/twap/keys";
import { parseTwapPolicy } from "../src/execution/twap/policy";
import { planTwap, snapToGrid } from "../src/execution/twap/plan";
import { reconcileParent } from "../src/execution/twap/reconcile";

const T0 = Date.parse("2026-09-23T12:00:00.000Z");

function book(overrides: Partial<DepthBook> = {}): DepthBook {
  return {
    bids: [{ price: 99.9, qty: 50 }],
    asks: [{ price: 100.1, qty: 40 }],
    eventTime: T0,
    availableAt: T0,
    observedVolume: 100,
    volumeEventTime: T0,
    volumeAvailableAt: T0,
    ...overrides,
  };
}

describe("TWAP policy", () => {
  it("lehnt Sub-Sekunden-Intervalle ab", () => {
    assert.throws(() => parseTwapPolicy({ sliceIntervalMs: 999 }), (e: unknown) => e instanceof TwapError && e.code === "INVALID_POLICY");
  });

  it("verlangt bei conservative eine explizite Menge", () => {
    assert.throws(
      () => parseTwapPolicy({ staleDepthAction: "conservative" }),
      (e: unknown) => e instanceof TwapError && (e as TwapError).field === "conservativeSliceQty",
    );
  });

  it("versioniert kanonisch", () => {
    const a = parseTwapPolicy({});
    const b = parseTwapPolicy({});
    assert.equal(a.policyVersion, b.policyVersion);
    assert.match(a.policyVersion, /^etw1:[0-9a-f]{64}$/);
    assert.notEqual(a.policyVersion, parseTwapPolicy({ maxParticipation: 0.2 }).policyVersion);
  });
});

describe("TWAP planner", () => {
  const base = {
    quantityStep: 1,
    minQuantity: 1,
    startAt: T0,
    deadlineAt: T0 + 5 * 60_000,
    sliceIntervalMs: 60_000,
    minSliceQty: 1,
    maxSliceQty: 4,
    minNotional: 0,
    referencePrice: 100,
    maxParticipation: 1,
    observedVolume: null as number | null,
    jitterFraction: 0,
    jitterMs: 0,
    seed: "seed-a",
  };

  it("summiert exakt und hält Mindest-/Höchstslice", () => {
    const plan = planTwap({ ...base, targetQty: 10 });
    const sum = plan.slices.reduce((s, sl) => s + sl.qty, 0);
    assert.equal(sum, 10);
    assert.equal(plan.unscheduledQty, 0);
    for (const sl of plan.slices) {
      assert.ok(sl.qty >= 1 && sl.qty <= 4, `slice ${sl.qty}`);
      assert.ok(sl.scheduledAt >= T0 && sl.scheduledAt < base.deadlineAt);
    }
  });

  it("legt den Rundungsrest auf den letzten Slice", () => {
    const plan = planTwap({ ...base, targetQty: 10, maxSliceQty: 100, deadlineAt: T0 + 3 * 60_000 });
    assert.deepEqual(plan.slices.map((s) => s.qty), [3, 3, 4]);
  });

  it("reproduziert Jitter aus dem Seed und hält die Summe", () => {
    const input = { ...base, targetQty: 20, maxSliceQty: 10, jitterFraction: 0.2, jitterMs: 5_000, seed: "seed-a" };
    const a = planTwap(input);
    const b = planTwap(input);
    assert.deepEqual(a, b);
    const c = planTwap({ ...input, seed: "seed-b" });
    assert.notDeepEqual(a.slices.map((s) => s.scheduledAt), c.slices.map((s) => s.scheduledAt));
    assert.equal(a.slices.reduce((s, sl) => s + sl.qty, 0), 20);
    assert.equal(c.slices.reduce((s, sl) => s + sl.qty, 0), 20);
    for (const sl of a.slices) assert.ok(sl.qty >= 1 && sl.qty <= 10);
  });

  it("behandelt fehlendes Volumen nicht als unbegrenzt im Cap", () => {
    assert.equal(participationCapQty(null, 0.1, 1), null);
    assert.equal(participationCapQty(0, 0.1, 1), 0);
    assert.equal(participationCapQty(25, 0.1, 1), 2);
  });

  it("lehnt ein zu kurzes Fenster ab, statt Slices über dem Maximum zu planen", () => {
    assert.throws(
      () => planTwap({ ...base, targetQty: 10, maxSliceQty: 3, deadlineAt: T0 + 2 * 60_000 }),
      (e: unknown) => e instanceof TwapError && e.code === "WINDOW_TOO_SHORT",
    );
  });

  it("snappt auf das Eltern-Raster, exakt auf dem Punkt", () => {
    assert.equal(snapToGrid(T0, 60_000, T0 + 60_000), T0 + 60_000);
    assert.equal(snapToGrid(T0, 60_000, T0 + 60_001), T0 + 120_000);
  });

  it("ist seed-stabil im Vorzeichen-Generator", () => {
    assert.equal(unitSigned("s", "qty", 1), unitSigned("s", "qty", 1));
    assert.notEqual(unitSigned("s", "qty", 1), unitSigned("s", "qty", 2));
  });
});

describe("TWAP depth", () => {
  const common = {
    side: "LONG" as const,
    now: T0,
    plannedQty: 4,
    quantityStep: 1,
    priceStep: 0.1,
    minQuantity: 1,
    minSliceQty: 1,
    maxSliceQty: 10,
    minNotional: 0,
    maxParticipation: 0.1,
    maxImpactBps: 50,
    maxBookAgeMs: 5_000,
    parentLimit: 101,
    offsetBps: 0,
    staleAction: "pause" as const,
    conservativeSliceQty: null,
    postOnly: true,
  };

  it("pausiert stale Tiefe und benutzt das Buch nicht", () => {
    const stale = book({ availableAt: T0 - 10_000, eventTime: T0 - 10_000 });
    const d = assessDepth({ ...common, book: stale });
    assert.equal(d.action, "pause");
    assert.equal(d.reason, "DEPTH_STALE");
    assert.equal(d.qty, null);
  });

  it("pausiert ein zukünftiges Buch (kein Look-ahead)", () => {
    const future = book({ availableAt: T0 + 1_000, eventTime: T0 + 1_000 });
    const d = assessDepth({ ...common, book: future });
    assert.equal(d.action, "pause");
    assert.equal(d.reason, "DEPTH_FUTURE");
  });

  it("behandelt fehlendes Volumen nicht als 0 und nicht als unbegrenzt", () => {
    const missing = book({ observedVolume: null, volumeAvailableAt: null, volumeEventTime: null });
    assert.equal(freshVolume(missing, T0, 5_000), null);
    const d = assessDepth({ ...common, book: missing });
    assert.equal(d.action, "pause");
    assert.equal(d.reason, "VOLUME_UNKNOWN");
    assert.equal(d.participationCap, null);
  });

  it("sendet nichts, wenn das beobachtete Volumen 0 ist", () => {
    const empty = book({ observedVolume: 0 });
    const d = assessDepth({ ...common, book: empty });
    assert.equal(d.action, "pause");
    assert.equal(d.reason, "PARTICIPATION_BELOW_MIN");
    assert.equal(d.participationCap, 0);
  });

  it("clippt auf Participation und bleibt im Limit", () => {
    const d = assessDepth({ ...common, book: book(), plannedQty: 20, maxParticipation: 0.1 });
    assert.equal(d.action, "submit");
    assert.equal(d.qty, 10);
    assert.ok(d.limitPrice !== null && d.limitPrice <= 101);
    assert.ok(d.limitPrice! < 100.1);
    assert.equal(d.participationCap, 10);
  });

  it("nutzt den konservativen Fallback nur explizit und ohne erfundenen Impact", () => {
    const stale = book({ availableAt: T0 - 10_000, eventTime: T0 - 10_000 });
    const d = assessDepth({
      ...common,
      book: stale,
      staleAction: "conservative",
      conservativeSliceQty: 1,
      parentLimit: 99.5,
    });
    assert.equal(d.action, "submit");
    assert.equal(d.reason, "CONSERVATIVE");
    assert.equal(d.qty, 1);
    assert.equal(d.impactBps, null);
    assert.ok(d.limitPrice !== null && d.limitPrice <= 99.5);
  });
});

describe("TWAP evaluate + reconcile", () => {
  it("lässt Shortfall null, wenn die Ankunft fehlt — nicht 0", () => {
    const ev = evaluateTwap({
      side: "LONG",
      targetQty: 10,
      filledQty: 4,
      fills: [{ qty: 4, price: 100.2, eventTime: T0 + 1_000, availableAt: T0 + 1_000 }],
      startAt: T0,
      now: T0 + 2_000,
      maxBookAgeMs: 5_000,
      arrival: null,
      arrivalBook: null,
      parentLimit: 101,
    });
    assert.equal(ev.arrivalPrice, null);
    assert.equal(ev.twapShortfallBps, null);
    assert.equal(ev.shortfallVsImmediateBps, null);
    assert.equal(ev.completion, 0.4);
    assert.equal(ev.durationMs, 1_000);
    assert.equal(ev.coverage, null);
  });

  it("berichtet Deckung der Sofort-Baseline, statt eine volle Füllung zu erfinden", () => {
    const arrivalBook = book({ asks: [{ price: 100, qty: 3 }] });
    const ev = evaluateTwap({
      side: "LONG",
      targetQty: 10,
      filledQty: 3,
      fills: [{ qty: 3, price: 100.4, eventTime: T0 + 500, availableAt: T0 + 500 }],
      startAt: T0,
      now: T0 + 500,
      maxBookAgeMs: 5_000,
      arrival: { mid: 100, eventTime: T0, availableAt: T0 },
      arrivalBook,
      parentLimit: 101,
    });
    assert.equal(ev.coverage, 0.3);
    assert.equal(ev.immediateQty, 3);
    assert.ok(ev.twapShortfallBps !== null && ev.twapShortfallBps > 0);
    assert.equal(ev.quantityMismatch, false);
  });

  it("nutzt ein Buch nach dem Start nicht als Ankunft", () => {
    const ev = evaluateTwap({
      side: "LONG",
      targetQty: 2,
      filledQty: 0,
      fills: [],
      startAt: T0,
      now: T0 + 10_000,
      maxBookAgeMs: 5_000,
      arrival: { mid: 100, eventTime: T0 + 1, availableAt: T0 + 1 },
      arrivalBook: book({ eventTime: T0 + 1, availableAt: T0 + 1 }),
      parentLimit: null,
    });
    assert.equal(ev.arrivalReason, "FUTURE");
    assert.equal(ev.arrivalPrice, null);
    assert.equal(ev.coverage, null);
  });

  it("reconciliert den Parent aus Slice-Zeilen und erkennt Überfüllung", () => {
    const ok = reconcileParent({
      now: T0,
      deadlineAt: T0 + 60_000,
      targetQty: 9,
      quantityStep: 1,
      unscheduledQty: 0,
      slices: [
        { status: "CANCELLED", targetQty: 3, filledQty: 1 },
        { status: "PENDING", targetQty: 4, filledQty: 0 },
        { status: "PENDING", targetQty: 4, filledQty: 0 },
      ],
      forced: null,
      pauseReason: null,
    });
    assert.equal(ok.invariantOk, true);
    assert.equal(ok.filledQty, 1);
    assert.equal(ok.status, "RUNNING");

    const over = reconcileParent({
      now: T0,
      deadlineAt: T0 + 60_000,
      targetQty: 9,
      quantityStep: 1,
      unscheduledQty: 0,
      slices: [{ status: "DONE", targetQty: 9, filledQty: 9.1 }],
      forced: null,
      pauseReason: null,
    });
    assert.equal(over.status, "FAILED");
    assert.equal(over.reason, "OVERFILL");
  });

  it("Walk erfindet keine Tiefe jenseits des Limits", () => {
    const walk = walkBook({
      side: "LONG",
      levels: [
        { price: 100, qty: 2 },
        { price: 105, qty: 50 },
      ],
      qty: 10,
      limitPrice: 101,
    });
    assert.equal(walk.filled, 2);
    assert.equal(walk.available, 2);
    assert.equal(walk.impactBps, 0);
  });
});
