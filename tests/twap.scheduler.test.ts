/**
 * TWAP-Scheduler gegen In-Memory-Store und den echten Execution-Policy-Controller.
 *
 * Kein Netzwerk. Zeit, Buch und Quote sind injiziert und stammen aus demselben
 * Snapshot. `null` ist nie 0 und nie „unbegrenzt“.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import type { BrokerVenueId } from "../src/contracts/broker";
import { ExecutionPolicyController, type QuoteSnapshot } from "../src/execution/controller";
import { PaperVenuePort, type PlaceOrderArgs } from "../src/execution/ports";
import { InMemoryExecutionStore } from "../src/execution/store";
import { controllerChildExecutor } from "../src/execution/twap/child";
import type { DepthBook } from "../src/execution/twap/depth";
import { TwapError } from "../src/execution/twap/errors";
import { TwapScheduler } from "../src/execution/twap/scheduler";
import { InMemoryTwapStore } from "../src/execution/twap/store";
import { __resetAllSingletonsForTests } from "../src/lib/stateRegistry";
import { killSwitch } from "../src/lib/riskGuard";

const T0 = 1_700_000_000_000;
const SPEC = { quantityStep: 1, priceStep: 0.01, minQuantity: 1 };

interface Harness {
  store: InMemoryTwapStore;
  exec: InMemoryExecutionStore;
  port: PaperVenuePort;
  scheduler: TwapScheduler;
  now: () => number;
  setNow: (ms: number) => void;
  publish: (over?: Partial<DepthBook>) => void;
  places: PlaceOrderArgs[];
  markets: number;
  setKilled: (v: boolean) => void;
  setOpen: (v: boolean | null) => void;
  setConnected: (v: boolean | null) => void;
}

function makeHarness(): Harness {
  let now = T0;
  let killed = false;
  let open: boolean | null = true;
  let connected: boolean | null = true;
  let book: DepthBook | null = null;
  let quote: QuoteSnapshot | null = null;
  const store = new InMemoryTwapStore();
  const exec = new InMemoryExecutionStore();
  const port = new PaperVenuePort({ venue: "PAPER", now: () => now });
  const places: PlaceOrderArgs[] = [];
  let markets = 0;
  const place = port.placeLimitOrder.bind(port);
  port.placeLimitOrder = async (args) => {
    places.push({ ...args });
    return place(args);
  };
  const market = port.placeMarketOrder.bind(port);
  port.placeMarketOrder = async (args) => {
    markets += 1;
    return market(args);
  };
  const controller = new ExecutionPolicyController({
    store: exec,
    ports: new Map<BrokerVenueId, typeof port>([["PAPER", port]]),
    getQuote: async () => (quote ? { ...quote } : null),
    getAccount: async () => ({ equity: 10_000, openPositions: 0 }),
    getInstrument: () => SPEC,
    now: () => now,
    audit: async () => {},
  });
  const scheduler = new TwapScheduler({
    store,
    executor: controllerChildExecutor(controller, (id) => exec.listFills(id)),
    getBook: async () => (book ? { ...book, bids: book.bids.map((l) => ({ ...l })), asks: book.asks.map((l) => ({ ...l })) } : null),
    now: () => now,
    leaseMs: 30_000,
    isKilled: () => killed || killSwitch.isArmed(),
    isMarketOpen: () => open,
    isVenueConnected: () => connected,
  });
  const publish = (over: Partial<DepthBook> = {}) => {
    book = {
      bids: [{ price: 99.99, qty: 500 }],
      asks: [{ price: 100.01, qty: 500 }],
      eventTime: now,
      availableAt: now,
      observedVolume: 500,
      volumeEventTime: now,
      volumeAvailableAt: now,
      ...over,
    };
    quote = { mid: 100, bid: 99.99, ask: 100.01, spread: 0.0002, eventTime: now, availableAt: now };
    port.setQuote("BTC", { bid: 99.99, ask: 100.01, mid: 100, ts: now });
  };
  return {
    store,
    exec,
    port,
    scheduler,
    now: () => now,
    setNow: (ms: number) => {
      now = ms;
    },
    publish,
    places,
    get markets() {
      return markets;
    },
    setKilled: (v) => {
      killed = v;
    },
    setOpen: (v) => {
      open = v;
    },
    setConnected: (v) => {
      connected = v;
    },
  };
}

const POLICY = {
  sliceIntervalMs: 60_000,
  maxParticipation: 1,
  minSliceQty: 3,
  maxSliceQty: 3,
  maxImpactBps: 50,
  maxBookAgeMs: 5_000,
  childTtlMs: 3_600_000,
  staleDepthAction: "pause" as const,
};

async function startParent(h: Harness, over: Record<string, unknown> = {}) {
  return h.scheduler.start({
    venue: "PAPER",
    mode: "paper",
    symbol: "BTC",
    side: "LONG",
    targetQty: 9,
    startAt: T0,
    deadlineAt: T0 + 180_000,
    seed: "seed-a",
    limitPrice: 101,
    hasStopLoss: true,
    quantityStep: SPEC.quantityStep,
    priceStep: SPEC.priceStep,
    minQuantity: SPEC.minQuantity,
    ...over,
    policy: { ...POLICY, ...((over.policy as object) ?? {}) },
  });
}

describe("TWAP scheduler", () => {
  beforeEach(() => {
    __resetAllSingletonsForTests();
    killSwitch.disarm();
  });
  afterEach(() => {
    killSwitch.disarm();
  });

  it("plant [3,3,3], füllt 1, cancelt am Slot-Ende und legt genau eine Folge-Order", async () => {
    const h = makeHarness();
    h.publish();
    const parent = await startParent(h);
    const planned = await h.store.listSlices(parent.id);
    assert.deepEqual(planned.map((s) => s.targetQty), [3, 3, 3]);
    assert.equal(planned.reduce((s, sl) => s + sl.targetQty, 0) + (parent.unscheduledQty ?? 0), 9);

    const first = await h.scheduler.tick(parent.id, "worker-a");
    assert.equal(first.submitted, true, first.reason);
    assert.equal(h.places.length, 1);
    assert.equal(h.places[0]!.qty, 3);
    assert.ok(h.places[0]!.limitPrice <= 101);
    assert.ok(h.places[0]!.limitPrice < 100.01);

    h.port.applyTrade("BTC", 99.99, 1);
    h.setNow(T0 + 30_000);
    h.publish();
    const mid = await h.scheduler.tick(parent.id, "worker-a");
    assert.equal(mid.submitted, false);
    assert.equal(h.places.length, 1);
    const partial = (await h.store.listSlices(parent.id)).find((s) => s.sliceIndex === 0);
    assert.equal(partial?.filledQty, 1);
    assert.equal(partial?.status, "PARTIAL");

    h.setNow(T0 + 60_000);
    h.publish();
    const next = await h.scheduler.tick(parent.id, "worker-a");
    assert.equal(next.submitted, true, next.reason);
    assert.equal(h.places.length, 2);
    assert.equal(h.markets, 0);
    const after = await h.store.listSlices(parent.id);
    const filled = after.reduce((s, sl) => s + sl.filledQty, 0);
    assert.equal(parent.targetQty - filled, 8);
    const liveOrPending = after.filter((s) => s.status === "PENDING" || s.status === "SUBMITTED" || s.status === "PARTIAL");
    for (const sl of liveOrPending) {
      assert.ok(sl.targetQty >= 3, `slice ${sl.sliceIndex} unter Mindestlot`);
      assert.ok(sl.targetQty <= 3, `slice ${sl.sliceIndex} über Höchstslice`);
    }
    const accounted =
      filled +
      liveOrPending.reduce((s, sl) => s + Math.max(0, sl.targetQty - sl.filledQty), 0) +
      (next.parent.unscheduledQty ?? 0);
    assert.equal(accounted, 9);
  });

  it("stale, fehlendes, zukünftiges Buch und Volumen 0/null senden nichts", async () => {
    const cases: Array<{ name: string; book: Partial<DepthBook> | null }> = [
      { name: "stale", book: { eventTime: T0 - 10_000, availableAt: T0 - 10_000, volumeEventTime: T0, volumeAvailableAt: T0 } },
      { name: "missing", book: null },
      { name: "future", book: { eventTime: T0 + 1_000, availableAt: T0 + 1_000 } },
      { name: "volume-null", book: { observedVolume: null, volumeEventTime: null, volumeAvailableAt: null } },
      { name: "volume-zero", book: { observedVolume: 0 } },
    ];
    for (const c of cases) {
      const h = makeHarness();
      if (c.book === null) {
        // publish dann explizit leeren — getBook liefert null, wenn nie gesetzt.
      } else {
        h.publish(c.book);
      }
      const parent = await startParent(h, { seed: c.name });
      const tick = await h.scheduler.tick(parent.id, "worker-a");
      assert.equal(tick.submitted, false, c.name);
      assert.equal(tick.parent.status, "PAUSED", `${c.name}:${tick.reason}`);
      assert.equal(h.places.length, 0, c.name);
      assert.notEqual(tick.reason, "OK");
    }
  });

  it("Participation-Cap wird nicht überschritten und unter Min-Slice nicht gesendet", async () => {
    const h = makeHarness();
    h.publish({ observedVolume: 10 });
    const parent = await startParent(h, { policy: { maxParticipation: 0.1, minSliceQty: 3, maxSliceQty: 3 } });
    const tick = await h.scheduler.tick(parent.id, "worker-a");
    assert.equal(tick.submitted, false, tick.reason);
    assert.equal(h.places.length, 0);
    assert.equal(tick.parent.status, "PAUSED");
  });

  it("derselbe Seed reproduziert den Jitter, ein anderer Seed nicht zwingend die Uhr", async () => {
    const policy = { ...POLICY, minSliceQty: 1, maxSliceQty: 3, jitterFraction: 0.1, jitterMs: 1_000 };
    const a = makeHarness();
    const b = makeHarness();
    const left = await startParent(a, { seed: "same-seed", policy });
    const right = await startParent(b, { seed: "same-seed", policy });
    const la = (await a.store.listSlices(left.id)).map((s) => s.scheduledAt);
    const lb = (await b.store.listSlices(right.id)).map((s) => s.scheduledAt);
    assert.deepEqual(la, lb);
    assert.ok(la.some((t, i) => t !== T0 + i * 60_000), "Zeit-Jitter wurde nicht angewendet");
    const c = makeHarness();
    const other = await startParent(c, { seed: "other-seed", policy });
    const otherSlices = (await c.store.listSlices(other.id)).map((s) => s.scheduledAt);
    assert.notDeepEqual(la, otherSlices);
  });

  it("Restart und zweiter Worker erzeugen keine zweite Kind-Order", async () => {
    const h = makeHarness();
    h.publish();
    const parent = await startParent(h);
    const first = await h.scheduler.tick(parent.id, "worker-a");
    assert.equal(first.submitted, true, first.reason);
    const restarted = new TwapScheduler({
      store: h.store,
      executor: controllerChildExecutor(
        new ExecutionPolicyController({
          store: h.exec,
          ports: new Map([["PAPER", h.port]]),
          getQuote: async () => ({ mid: 100, bid: 99.99, ask: 100.01, spread: 0.0002, eventTime: h.now(), availableAt: h.now() }),
          getAccount: async () => ({ equity: 10_000, openPositions: 0 }),
          getInstrument: () => SPEC,
          now: h.now,
          audit: async () => {},
        }),
        (id) => h.exec.listFills(id),
      ),
      getBook: async () => ({
        bids: [{ price: 99.99, qty: 500 }],
        asks: [{ price: 100.01, qty: 500 }],
        eventTime: h.now(),
        availableAt: h.now(),
        observedVolume: 500,
        volumeEventTime: h.now(),
        volumeAvailableAt: h.now(),
      }),
      now: h.now,
      isKilled: () => false,
      isMarketOpen: () => true,
      isVenueConnected: () => true,
    });
    h.publish();
    const again = await restarted.tick(parent.id, "worker-b");
    assert.equal(again.submitted, false);
    assert.equal(h.places.length, 1);

    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let entered = false;
    const blocked = new PaperVenuePort({ venue: "PAPER", now: h.now });
    const raw = blocked.placeLimitOrder.bind(blocked);
    let blockedPlaces = 0;
    blocked.placeLimitOrder = async (args) => {
      blockedPlaces += 1;
      return raw(args);
    };
    blocked.setQuote("ETH", { bid: 99.99, ask: 100.01, mid: 100, ts: T0 });
    const exec2 = new InMemoryExecutionStore();
    const store2 = new InMemoryTwapStore();
    const controller = new ExecutionPolicyController({
      store: exec2,
      ports: new Map([["PAPER", blocked]]),
      getQuote: async () => ({ mid: 100, bid: 99.99, ask: 100.01, spread: 0.0002, eventTime: T0, availableAt: T0 }),
      getAccount: async () => ({ equity: 10_000, openPositions: 0 }),
      getInstrument: () => SPEC,
      now: () => T0,
      audit: async () => {},
    });
    const inner = controllerChildExecutor(controller, (id) => exec2.listFills(id));
    const dual = new TwapScheduler({
      store: store2,
      executor: {
        start: async (input) => {
          entered = true;
          await gate;
          return inner.start(input);
        },
        poll: (id) => inner.poll(id),
        cancel: (id, reason) => inner.cancel(id, reason),
        fills: (id) => inner.fills(id),
      },
      getBook: async () => ({
        bids: [{ price: 99.99, qty: 500 }],
        asks: [{ price: 100.01, qty: 500 }],
        eventTime: T0,
        availableAt: T0,
        observedVolume: 500,
        volumeEventTime: T0,
        volumeAvailableAt: T0,
      }),
      now: () => T0,
    });
    const p2 = await dual.start({
      venue: "PAPER",
      mode: "paper",
      symbol: "ETH",
      side: "LONG",
      targetQty: 9,
      startAt: T0,
      deadlineAt: T0 + 180_000,
      seed: "dual",
      policy: POLICY,
      limitPrice: 101,
      hasStopLoss: true,
      quantityStep: 1,
      priceStep: 0.01,
      minQuantity: 1,
    });
    const pending = dual.tick(p2.id, "worker-a");
    for (let i = 0; i < 50 && !entered; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(entered, true);
    const held = await dual.tick(p2.id, "worker-b");
    assert.equal(held.reason, "LEASE_HELD");
    release();
    await pending;
    assert.equal(blockedPlaces, 1);
  });

  it("Deadline und Kill-Switch canceln ohne Market-Chase", async () => {
    const h = makeHarness();
    h.publish();
    const parent = await startParent(h);
    const started = await h.scheduler.tick(parent.id, "worker-a");
    assert.equal(started.submitted, true, started.reason);
    h.setNow(T0 + 180_000);
    h.publish();
    const expired = await h.scheduler.tick(parent.id, "worker-a");
    assert.equal(expired.parent.status, "EXPIRED");
    assert.equal(h.places.length, 1);
    assert.equal(h.markets, 0);
    assert.equal(h.port.openOrderCount(), 0);

    const k = makeHarness();
    k.publish();
    const live = await startParent(k, { seed: "kill" });
    assert.equal((await k.scheduler.tick(live.id, "worker-a")).submitted, true);
    killSwitch.pull("test");
    k.setNow(T0 + 1_000);
    k.publish();
    const stopped = await k.scheduler.tick(live.id, "worker-a");
    assert.equal(stopped.parent.status, "CANCELLED");
    assert.equal(k.places.length, 1);
    assert.equal(k.markets, 0);
    assert.equal(k.port.openOrderCount(), 0);
  });

  it("Disconnect pausiert ohne Cancel, Markt zu cancelt", async () => {
    const h = makeHarness();
    h.publish();
    const parent = await startParent(h);
    await h.scheduler.tick(parent.id, "worker-a");
    h.setConnected(false);
    h.setNow(T0 + 1_000);
    h.publish();
    const paused = await h.scheduler.tick(parent.id, "worker-a");
    assert.equal(paused.parent.status, "PAUSED");
    assert.equal(paused.parent.reason, "VENUE_DISCONNECT");
    assert.equal(h.port.openOrderCount(), 1);
    assert.equal(h.markets, 0);

    const m = makeHarness();
    m.publish();
    const p2 = await startParent(m, { seed: "closed" });
    await m.scheduler.tick(p2.id, "worker-a");
    m.setOpen(false);
    m.setNow(T0 + 1_000);
    m.publish();
    const closed = await m.scheduler.tick(p2.id, "worker-a");
    assert.equal(closed.parent.status, "PAUSED");
    assert.equal(m.port.openOrderCount(), 0);
    assert.equal(m.markets, 0);
  });

  it("Parent-Status folgt den Kind-Zeilen; Policy-Mismatch ist laut", async () => {
    const h = makeHarness();
    h.publish();
    const parent = await startParent(h);
    for (const at of [T0, T0 + 60_000, T0 + 120_000]) {
      h.setNow(at);
      h.publish();
      const tick = await h.scheduler.tick(parent.id, "worker-a");
      assert.equal(tick.submitted, true, `${at}:${tick.reason}`);
      h.port.applyTrade("BTC", 99.99, 3);
      h.setNow(at + 1_000);
      h.publish();
      await h.scheduler.tick(parent.id, "worker-a");
    }
    const done = await h.store.loadParent(parent.id);
    const slices = await h.store.listSlices(parent.id);
    assert.equal(slices.reduce((s, sl) => s + sl.filledQty, 0), 9);
    assert.equal(done?.status, "COMPLETED");
    assert.equal(done?.filledQty, 9);
    const again = await startParent(h);
    assert.equal(again.id, parent.id);
    await assert.rejects(
      () =>
        h.store.createParent({
          parentKey: parent.parentKey,
          venue: "PAPER",
          mode: "paper",
          symbol: "BTC",
          side: "LONG",
          targetQty: 9,
          startAt: T0,
          deadlineAt: T0 + 180_000,
          sliceIntervalMs: 60_000,
          policyVersion: "etw1:other",
          policy: parent.policy,
          jitterSeed: "seed-a",
          limitPrice: 101,
          hasStopLoss: true,
          scope: "twap",
          quoteCurrency: "USD",
          quantityStep: 1,
          priceStep: 0.01,
          minQuantity: 1,
          now: T0,
        }),
      (e: unknown) => e instanceof TwapError && e.code === "POLICY_MISMATCH",
    );
  });
});
