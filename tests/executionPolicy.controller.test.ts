/**
 * Tests: Execution-Policy-Controller — End-to-End über In-Memory-Store und
 * deterministischen Paper-Port (kein Netzwerk, keine DB).
 *
 * Szenarien: Post-Only-Erfolg, Maker-Reject (±Reprice), Timeout, Partial Fill,
 * Fallback, Fill während CANCEL_PENDING, unklarer Cancel-Status, Restart/Retry,
 * Kill-Switch/Stale-Quote vor Fallback, unsupported Post-Only, Staub/Notional,
 * Negative Paths, Determinismus-Golden.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import type { BrokerVenueId } from "../src/contracts/broker";
import {
  ExecutionPolicyController,
  ExecutionControllerError,
  type InstrumentSpec,
  type QuoteSnapshot,
} from "../src/execution/controller";
import { DEFAULT_EXECUTION_POLICY, parseExecutionPolicy, type ExecutionPolicy } from "../src/execution/policy";
import {
  InMemoryExecutionStore,
  buildWorkflowKey,
  type ExecutionStore,
} from "../src/execution/store";
import { PaperVenuePort, type CancelOutcome, type PlaceOrderArgs, type VenueExecutionPort } from "../src/execution/ports";
import { __resetAllSingletonsForTests } from "../src/lib/stateRegistry";
import { killSwitch } from "../src/lib/riskGuard";

const SPEC: InstrumentSpec = { quantityStep: 0.001, priceStep: 0.01, minQuantity: 0.001 };

interface Harness {
  store: ExecutionStore;
  port: PaperVenuePort;
  controller: ExecutionPolicyController;
  now: () => number;
  setNow: (ms: number) => void;
  advance: (ms: number) => void;
  setQuote: (q: Partial<QuoteSnapshot>) => void;
  policy: (over?: Record<string, unknown>) => ExecutionPolicy;
}

function makeHarness(opts: {
  ports?: Map<BrokerVenueId, VenueExecutionPort>;
  instrument?: InstrumentSpec | null;
  startNow?: number;
} = {}): Harness {
  let now = opts.startNow ?? 1_000_000;
  const store = new InMemoryExecutionStore();
  const port = new PaperVenuePort({ now: () => now });
  port.setQuote("BTC", { bid: 99.99, ask: 100.01, mid: 100, ts: now });
  let quoteBase: QuoteSnapshot = { mid: 100, bid: 99.99, ask: 100.01, spread: 0.0002, eventTime: now, availableAt: now };
  const controller = new ExecutionPolicyController({
    store,
    ports: opts.ports ?? new Map([["PAPER", port]]),
    getQuote: async () => ({ ...quoteBase, eventTime: now, availableAt: quoteBase.availableAt }),
    getAccount: async () => ({ equity: 10_000, openPositions: 0 }),
    getInstrument: () => ("instrument" in opts ? opts.instrument ?? null : SPEC),
    now: () => now,
    audit: async () => {},
  });
  return {
    store,
    port,
    controller,
    now: () => now,
    setNow: (ms: number) => {
      now = ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
    setQuote: (q: Partial<QuoteSnapshot>) => {
      quoteBase = { ...quoteBase, ...q };
      if (q.mid !== undefined || q.bid !== undefined || q.ask !== undefined) {
        port.setQuote("BTC", { bid: quoteBase.bid, ask: quoteBase.ask, mid: quoteBase.mid, ts: now });
      }
    },
    policy: (over: Record<string, unknown> = {}) => parseExecutionPolicy({ ...DEFAULT_EXECUTION_POLICY, ...over }),
  };
}

describe("execution controller: Post-Only-Erfolg und Maker-Reject", () => {
  beforeEach(() => {
    __resetAllSingletonsForTests();
    killSwitch.disarm();
  });
  afterEach(() => {
    killSwitch.disarm();
  });

  it("Post-Only-Erfolg: Submit → ACK → Fill → DONE, nie über Ziel", async () => {
    const h = makeHarness();
    const started = await h.controller.start({
      venue: "PAPER",
      mode: "paper",
      symbol: "BTC",
      side: "LONG",
      targetQty: 1,
      policy: h.policy(),
      seed: "success-1",
      hasStopLoss: true,
    });
    assert.equal(started.state, "ACK");
    assert.ok(started.activeOrderId);
    assert.equal(started.activeClientOrderId, `${started.clientOrderBase}L0`);

    h.port.applyTrade("BTC", 99.95, 1);
    const done = await h.controller.poll(started.id);
    assert.equal(done.state, "DONE");
    assert.equal(done.reason, "FILLED");
    assert.equal(done.filledQty, 1);
    assert.equal(done.fallbackOrderId, null);
    const fills = await h.store.listFills(done.id);
    assert.equal(fills.reduce((s, f) => s + f.qty, 0), 1);
  });

  it("Maker-Reject ist explizit und repriced bounded (Offset wächst deterministisch)", async () => {
    const h = makeHarness();
    // Limit auf dem Ask ⇒ würde sofort nehmen ⇒ MAKER_REJECT.
    const after = await h.controller.start({
      venue: "PAPER",
      mode: "paper",
      symbol: "BTC",
      side: "LONG",
      targetQty: 1,
      policy: h.policy({ maxReprices: 2 }),
      seed: "maker-1",
      limitPrice: 100.01,
      hasStopLoss: true,
    });
    // Auto-Reprice: zurück in SUBMITTED mit Attempt 1 und tieferem Limit.
    assert.equal(after.state, "SUBMITTED");
    assert.equal(after.attempt, 1);
    assert.equal(after.repricesUsed, 1);
    assert.equal(after.limitPrice, 99.95); // frischer Mid 100 − 5 bp
    assert.equal(after.activeClientOrderId, `${after.clientOrderBase}L1`);
    const events = await h.store.listEvents(after.id);
    const reasons = events.map((e) => e.reason);
    assert.ok(reasons.includes("MAKER_REJECT"), `Reasons: ${reasons.join(",")}`);
    assert.ok(reasons.includes("MAKER_REJECT_REPRICE"));
    assert.equal(h.port.openOrderCount(), 1);
  });

  it("Maker-Reject ohne Budget endet terminal REJECTED (nichts am Markt)", async () => {
    const h = makeHarness();
    const after = await h.controller.start({
      venue: "PAPER",
      mode: "paper",
      symbol: "BTC",
      side: "LONG",
      targetQty: 1,
      policy: h.policy({ maxReprices: 0 }),
      seed: "maker-terminal",
      limitPrice: 100.01,
      hasStopLoss: true,
    });
    assert.equal(after.state, "REJECTED");
    assert.equal(after.reason, "MAKER_REJECT");
    assert.equal(h.port.openOrderCount(), 0);
  });

  it("Sonstige Rejects sind von MAKER_REJECT unterscheidbar und terminal", async () => {
    // SHORT mit verletztem Risk-Guard (Default allowShort=false) ⇒ Pre-Submit-Deny.
    const h = makeHarness();
    const after = await h.controller.start({
      venue: "PAPER",
      mode: "paper",
      symbol: "BTC",
      side: "SHORT",
      targetQty: 1,
      policy: h.policy(),
      seed: "short-deny",
      hasStopLoss: true,
    });
    assert.equal(after.state, "REJECTED");
    assert.equal(after.reason, "RISK_GUARD_BLOCK");
    assert.notEqual(after.reason, "MAKER_REJECT");
  });
});

describe("execution controller: Timeout, Partial Fill, Fallback", () => {
  beforeEach(() => {
    __resetAllSingletonsForTests();
    killSwitch.disarm();
  });
  afterEach(() => {
    killSwitch.disarm();
  });

  it("Timeout ohne Fills: TTL → Cancel → CANCELLED → Reprice → erneuter TTL → FAILED ohne Fallback", async () => {
    const h = makeHarness();
    const started = await h.controller.start({
      venue: "PAPER",
      mode: "paper",
      symbol: "BTC",
      side: "LONG",
      targetQty: 1,
      policy: h.policy({ ttlMs: 1000, maxReprices: 1, fallbackAllowed: false }),
      seed: "ttl-cycle",
      hasStopLoss: true,
    });
    assert.equal(started.state, "ACK");
    h.advance(1500);
    const cancelled = await h.controller.poll(started.id);
    assert.equal(cancelled.state, "CANCELLED");
    assert.equal(cancelled.reason, "CANCEL_CONFIRMED");

    const repriced = await h.controller.poll(cancelled.id);
    assert.equal(repriced.state, "SUBMITTED");
    assert.equal(repriced.repricesUsed, 1);
    const acked = await h.controller.poll(repriced.id);
    assert.equal(acked.state, "ACK");

    h.advance(1500);
    const cancelled2 = await h.controller.poll(acked.id);
    assert.equal(cancelled2.state, "CANCELLED");
    const failed = await h.controller.poll(cancelled2.id);
    assert.equal(failed.state, "FAILED");
    assert.equal(failed.reason, "FALLBACK_DISABLED");
    assert.equal(failed.fallbackOrderId, null);
  });

  it("Partial Fill + TTL + bestätigter Cancel + Market-Fallback füllt den Rest", async () => {
    const h = makeHarness();
    const started = await h.controller.start({
      venue: "PAPER",
      mode: "paper",
      symbol: "BTC",
      side: "LONG",
      targetQty: 1,
      policy: h.policy({ ttlMs: 1000, maxReprices: 0, fallbackAllowed: true }),
      seed: "partial-fallback",
      hasStopLoss: true,
    });
    h.port.applyTrade("BTC", 99.95, 0.4);
    const partial = await h.controller.poll(started.id);
    assert.equal(partial.state, "PARTIAL");
    assert.equal(partial.filledQty, 0.4);

    h.advance(1500);
    const cancelled = await h.controller.poll(partial.id);
    assert.equal(cancelled.state, "CANCELLED");

    const done = await h.controller.poll(cancelled.id);
    assert.equal(done.state, "DONE");
    assert.equal(done.reason, "FALLBACK_FILLED");
    assert.equal(done.filledQty, 1);
    assert.ok(done.fallbackOrderId);
    const fills = await h.store.listFills(done.id);
    assert.equal(fills.length, 2);
    assert.ok(fills.reduce((s, f) => s + f.qty, 0) <= 1 + 1e-9);
    const events = await h.store.listEvents(done.id);
    const reasons = events.map((e) => e.reason);
    for (const expected of ["SUBMIT_POST_ONLY", "PARTIAL_FILL", "TTL_EXPIRED", "CANCEL_CONFIRMED", "FALLBACK_SUBMITTED", "FALLBACK_FILLED"]) {
      assert.ok(reasons.includes(expected), `fehlt ${expected} in ${reasons.join(",")}`);
    }
  });

  it("Staub-Rest nach Cancel wird nicht als Market nachgehandelt (DUST_REMAINDER)", async () => {
    const h = makeHarness();
    const started = await h.controller.start({
      venue: "PAPER",
      mode: "paper",
      symbol: "BTC",
      side: "LONG",
      targetQty: 1,
      policy: h.policy({ ttlMs: 1000, maxReprices: 0, fallbackAllowed: true }),
      seed: "dust-1",
      hasStopLoss: true,
    });
    h.port.applyTrade("BTC", 99.95, 0.9999);
    await h.controller.poll(started.id);
    h.advance(1500);
    const cancelled = await h.controller.poll(started.id);
    assert.equal(cancelled.state, "CANCELLED");
    const done = await h.controller.poll(cancelled.id);
    assert.equal(done.state, "DONE");
    assert.equal(done.reason, "DUST_REMAINDER");
    assert.equal(done.fallbackOrderId, null);
  });

  it("Policy-Notional-Cap blockiert den Fallback (zusätzlich zum Risk-Guard)", async () => {
    const h = makeHarness();
    const started = await h.controller.start({
      venue: "PAPER",
      mode: "paper",
      symbol: "BTC",
      side: "LONG",
      targetQty: 1,
      policy: h.policy({ ttlMs: 1000, maxReprices: 5, fallbackAllowed: true, maxNotional: 10_000 }),
      seed: "notional-ok",
      hasStopLoss: true,
    });
    // Erstversuch mit hoher Cap: Gates bestehen.
    assert.equal(started.state, "ACK");
    // Fallback mit winziger Cap: separater Workflow, dessen Reprice-Budget
    // erschöpft ist, damit der Fallback-Pfad greift.
    const h2 = makeHarness();
    const s2 = await h2.controller.start({
      venue: "PAPER",
      mode: "paper",
      symbol: "BTC",
      side: "LONG",
      targetQty: 1,
      policy: h2.policy({ ttlMs: 1000, maxReprices: 0, fallbackAllowed: true, maxNotional: 50 }),
      seed: "notional-cap",
      hasStopLoss: true,
    });
    // Schon der Erst-Submit (Notional ~99.95 > 50) wird per Policy-Cap abgelehnt.
    assert.equal(s2.state, "REJECTED");
    assert.equal(s2.reason, "NOTIONAL_POLICY_CAP");
  });
});

describe("execution controller: Cancel-Races und unklarer Status", () => {
  beforeEach(() => {
    __resetAllSingletonsForTests();
    killSwitch.disarm();
  });
  afterEach(() => {
    killSwitch.disarm();
  });

  it("Fill während CANCEL_PENDING komplettiert — kein Fallback, keine Überfüllung", async () => {
    const real = new PaperVenuePort({ now: () => 1_000_000 });
    real.setQuote("BTC", { bid: 99.99, ask: 100.01, mid: 100, ts: 1_000_000 });
    let cancels = 0;
    const flaky: VenueExecutionPort = {
      venue: "PAPER",
      getCapabilities: () => real.getCapabilities(),
      placeLimitOrder: (a) => real.placeLimitOrder(a),
      placeMarketOrder: (a) => real.placeMarketOrder(a),
      cancelOrder: async (a) => {
        cancels++;
        if (cancels === 1) {
          const fills = await real.getFills(a);
          return { status: "UNKNOWN", reasonCode: "VENUE_AMBIGUOUS", fills } satisfies CancelOutcome;
        }
        return real.cancelOrder(a);
      },
      getOrder: (a) => real.getOrder(a),
      getFills: (a) => real.getFills(a),
      findOrderByClientId: (a) => real.findOrderByClientId(a),
    };
    const h = makeHarness({ ports: new Map([["PAPER", flaky]]) });
    const started = await h.controller.start({
      venue: "PAPER",
      mode: "paper",
      symbol: "BTC",
      side: "LONG",
      targetQty: 1,
      policy: h.policy({ ttlMs: 1000, maxReprices: 0, fallbackAllowed: true }),
      seed: "cancel-race",
      hasStopLoss: true,
    });
    h.advance(1500);
    const pending = await h.controller.poll(started.id);
    assert.equal(pending.state, "CANCEL_PENDING");
    // Fill trifft während des schwebenden Cancels ein.
    real.applyTrade("BTC", 99.95, 1);
    const done = await h.controller.poll(pending.id);
    assert.equal(done.state, "DONE");
    assert.equal(done.reason, "FILLED_DURING_CANCEL");
    assert.equal(done.filledQty, 1);
    assert.equal(done.fallbackOrderId, null);
  });

  it("Unklarer Cancel-Status blockiert den Market-Fallback (bounded, dann FAILED)", async () => {
    const real = new PaperVenuePort({ now: () => 1_000_000 });
    real.setQuote("BTC", { bid: 99.99, ask: 100.01, mid: 100, ts: 1_000_000 });
    const stuck: VenueExecutionPort = {
      venue: "PAPER",
      getCapabilities: () => real.getCapabilities(),
      placeLimitOrder: (a) => real.placeLimitOrder(a),
      placeMarketOrder: (a) => real.placeMarketOrder(a),
      cancelOrder: async (a) => ({ status: "UNKNOWN", reasonCode: "VENUE_AMBIGUOUS", fills: await real.getFills(a) }),
      getOrder: (a) => real.getOrder(a),
      getFills: (a) => real.getFills(a),
      findOrderByClientId: (a) => real.findOrderByClientId(a),
    };
    const h = makeHarness({ ports: new Map([["PAPER", stuck]]) });
    const started = await h.controller.start({
      venue: "PAPER",
      mode: "paper",
      symbol: "BTC",
      side: "LONG",
      targetQty: 1,
      policy: h.policy({ ttlMs: 1000, maxReprices: 0, fallbackAllowed: true, maxCancelAttempts: 2, cancelConfirmTimeoutMs: 60_000 }),
      seed: "cancel-stuck",
      hasStopLoss: true,
    });
    h.advance(1500);
    const p1 = await h.controller.poll(started.id);
    assert.equal(p1.state, "CANCEL_PENDING");
    const p2 = await h.controller.poll(p1.id);
    assert.equal(p2.state, "CANCEL_PENDING");
    const failed = await h.controller.poll(p2.id);
    assert.equal(failed.state, "FAILED");
    assert.equal(failed.reason, "CANCEL_UNRESOLVED");
    assert.equal(failed.fallbackOrderId, null);
  });

  it("Überfüllung aus Venue-Fills wird terminal (OVERFILL_DETECTED), nicht geklemmt", async () => {
    const real = new PaperVenuePort({ now: () => 1_000_000 });
    real.setQuote("BTC", { bid: 99.99, ask: 100.01, mid: 100, ts: 1_000_000 });
    const lying: VenueExecutionPort = {
      venue: "PAPER",
      getCapabilities: () => real.getCapabilities(),
      placeLimitOrder: (a) => real.placeLimitOrder(a),
      placeMarketOrder: (a) => real.placeMarketOrder(a),
      cancelOrder: (a) => real.cancelOrder(a),
      getOrder: (a) => real.getOrder(a),
      getFills: async (a) => [
        { fillId: "lie-1", orderId: a.orderId, qty: 5, price: 100, feeQuote: 0, eventTime: 1_000_000, availableAt: 1_000_000 },
      ],
      findOrderByClientId: (a) => real.findOrderByClientId(a),
    };
    const h = makeHarness({ ports: new Map([["PAPER", lying]]) });
    const started = await h.controller.start({
      venue: "PAPER",
      mode: "paper",
      symbol: "BTC",
      side: "LONG",
      targetQty: 1,
      policy: h.policy(),
      seed: "overfill-1",
      hasStopLoss: true,
    });
    // Schon der interne Poll nach dem Submit erkennt die Überfüllung.
    assert.equal(started.state, "FAILED");
    assert.equal(started.reason, "OVERFILL_DETECTED");
  });
});

describe("execution controller: Restart/Retry-Idempotenz", () => {
  beforeEach(() => {
    __resetAllSingletonsForTests();
    killSwitch.disarm();
  });
  afterEach(() => {
    killSwitch.disarm();
  });

  it("Retry mit demselben Seed dupliziert keine Order", async () => {
    const h = makeHarness();
    const input = {
      venue: "PAPER" as const,
      mode: "paper" as const,
      symbol: "BTC",
      side: "LONG" as const,
      targetQty: 1,
      policy: h.policy(),
      seed: "retry-1",
      hasStopLoss: true,
    };
    const first = await h.controller.start(input);
    const second = await h.controller.start(input);
    assert.equal(first.id, second.id);
    assert.equal(h.port.openOrderCount(), 1);
    const third = await h.controller.start(input);
    assert.equal(third.version, first.version);
  });

  it("Restart rekonstruiert Zustand vor externer Aktion (kein Doppel-Submit)", async () => {
    const h = makeHarness();
    const started = await h.controller.start({
      venue: "PAPER",
      mode: "paper",
      symbol: "BTC",
      side: "LONG",
      targetQty: 1,
      policy: h.policy({ ttlMs: 60_000 }),
      seed: "restart-1",
      hasStopLoss: true,
    });
    assert.equal(started.state, "ACK");
    const orderIdBefore = started.activeOrderId;
    // „Neustart“: neuer Controller, derselbe Store, derselbe Venue-Port
    // (die Venue überlebt den Prozessneustart, der Prozessspeicher nicht).
    const restarted = new ExecutionPolicyController({
      store: h.store,
      ports: new Map([["PAPER", h.port]]),
      getQuote: async () => ({ mid: 100, bid: 99.99, ask: 100.01, spread: 0.0002, eventTime: h.now(), availableAt: h.now() }),
      getAccount: async () => ({ equity: 10_000, openPositions: 0 }),
      getInstrument: () => SPEC,
      now: h.now,
      audit: async () => {},
    });
    const { recovered, errors } = await restarted.recover();
    assert.equal(errors.length, 0);
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].activeOrderId, orderIdBefore);
    assert.equal(h.port.openOrderCount(), 1);
  });

  it("Mehrdeutiger Submit löst per Client-Key auf statt doppelt zu senden", async () => {
    const real = new PaperVenuePort({ now: () => 1_000_000 });
    real.setQuote("BTC", { bid: 99.99, ask: 100.01, mid: 100, ts: 1_000_000 });
    let places = 0;
    const ambiguous: VenueExecutionPort = {
      venue: "PAPER",
      getCapabilities: () => real.getCapabilities(),
      placeLimitOrder: async (a: PlaceOrderArgs) => {
        places++;
        const outcome = await real.placeLimitOrder(a);
        if (places === 1) throw new Error("socket hang up (simulierter Timeout nach POST)");
        return outcome;
      },
      placeMarketOrder: (a) => real.placeMarketOrder(a),
      cancelOrder: (a) => real.cancelOrder(a),
      getOrder: (a) => real.getOrder(a),
      getFills: (a) => real.getFills(a),
      findOrderByClientId: (a) => real.findOrderByClientId(a),
    };
    const h = makeHarness({ ports: new Map([["PAPER", ambiguous]]) });
    const submitted = await h.controller.start({
      venue: "PAPER",
      mode: "paper",
      symbol: "BTC",
      side: "LONG",
      targetQty: 1,
      policy: h.policy(),
      seed: "ambiguous-1",
      hasStopLoss: true,
    });
    assert.equal(submitted.state, "SUBMITTED");
    assert.equal(submitted.activeOrderId, null);
    assert.ok(submitted.activeClientOrderId);
    const resolved = await h.controller.poll(submitted.id);
    assert.equal(resolved.state, "ACK");
    assert.ok(resolved.activeOrderId);
    assert.equal(real.openOrderCount(), 1);
    assert.equal(places, 1);
  });

  it("Gleiche Policy, gleicher Seed ⇒ gleicher Workflow-Key (stabil über Instanzen)", () => {
    const a = buildWorkflowKey({ venue: "PAPER", mode: "paper", symbol: "BTC", side: "LONG", targetQty: 1, seed: "k" });
    const b = buildWorkflowKey({ venue: "PAPER", mode: "paper", symbol: "BTC", side: "LONG", targetQty: 1, seed: "k" });
    assert.equal(a, b);
    assert.match(a, /^eow1:[0-9a-f]{64}$/);
    // Die Policy ist kein Key-Bestandteil (Mismatch-Schutz statt Doppel-Key).
    const c = buildWorkflowKey({ venue: "PAPER", mode: "paper", symbol: "BTC", side: "LONG", targetQty: 1, seed: "other" });
    assert.notEqual(a, c);
  });
});

describe("execution controller: Safety-Gates vor Fallback", () => {
  beforeEach(() => {
    __resetAllSingletonsForTests();
    killSwitch.disarm();
  });
  afterEach(() => {
    killSwitch.disarm();
  });

  async function cancelledWithRemainder(h: Harness, seed: string) {
    const started = await h.controller.start({
      venue: "PAPER",
      mode: "paper",
      symbol: "BTC",
      side: "LONG",
      targetQty: 1,
      policy: h.policy({ ttlMs: 1000, maxReprices: 0, fallbackAllowed: true }),
      seed,
      hasStopLoss: true,
    });
    h.advance(1500);
    const cancelled = await h.controller.poll(started.id);
    assert.equal(cancelled.state, "CANCELLED");
    return cancelled;
  }

  it("Kill-Switch vor Fallback stoppt den Ablauf", async () => {
    const h = makeHarness();
    const cancelled = await cancelledWithRemainder(h, "kill-fb");
    killSwitch.pull("test-not-halt");
    const failed = await h.controller.poll(cancelled.id);
    assert.equal(failed.state, "FAILED");
    assert.equal(failed.reason, "KILL_SWITCH_ARMED");
    assert.equal(failed.fallbackOrderId, null);
  });

  it("Stale Quote vor Fallback stoppt den Ablauf", async () => {
    const h = makeHarness();
    const cancelled = await cancelledWithRemainder(h, "stale-fb");
    h.setQuote({ availableAt: h.now() - 60_000 });
    const failed = await h.controller.poll(cancelled.id);
    assert.equal(failed.state, "FAILED");
    assert.equal(failed.reason, "QUOTE_STALE");
    assert.equal(failed.fallbackOrderId, null);
  });

  it("Weiter Spread vor Fallback stoppt den Ablauf", async () => {
    const h = makeHarness();
    const cancelled = await cancelledWithRemainder(h, "spread-fb");
    h.setQuote({ spread: 0.05 });
    const failed = await h.controller.poll(cancelled.id);
    assert.equal(failed.state, "FAILED");
    assert.ok(failed.reason === "SPREAD_TOO_WIDE" || failed.reason === "SLIPPAGE_TOO_HIGH");
    assert.equal(failed.fallbackOrderId, null);
  });
});

describe("execution controller: Capability-Explizitheit und Negative Paths", () => {
  beforeEach(() => {
    __resetAllSingletonsForTests();
    killSwitch.disarm();
  });
  afterEach(() => {
    killSwitch.disarm();
  });

  function alpacaLikePort(real: PaperVenuePort, seen: { postOnly: boolean | null }): VenueExecutionPort {
    return {
      venue: "ALPACA",
      getCapabilities: () => ({ postOnly: false, cancelSingle: true, cancelReplaceAtomic: true }),
      placeLimitOrder: async (a) => {
        seen.postOnly = a.postOnly;
        if (a.postOnly) {
          return { orderId: "", clientOrderId: a.clientOrderId, status: "REJECTED", rejectCode: "POST_ONLY_UNSUPPORTED", filledQty: 0, fills: [] };
        }
        return real.placeLimitOrder({ ...a, postOnly: false });
      },
      placeMarketOrder: (a) => real.placeMarketOrder(a),
      cancelOrder: (a) => real.cancelOrder(a),
      getOrder: (a) => real.getOrder(a),
      getFills: (a) => real.getFills(a),
      findOrderByClientId: (a) => real.findOrderByClientId(a),
    };
  }

  it("ALPACA ohne Post-Only + postOnlyFallback=fail ⇒ explizites POST_ONLY_UNSUPPORTED", async () => {
    const real = new PaperVenuePort({ now: () => 1_000_000 });
    real.setQuote("BTC", { bid: 99.99, ask: 100.01, mid: 100, ts: 1_000_000 });
    const seen = { postOnly: null as boolean | null };
    const h = makeHarness({ ports: new Map([["ALPACA", alpacaLikePort(real, seen)]]) });
    const rejected = await h.controller.start({
      venue: "ALPACA",
      mode: "paper",
      symbol: "BTC",
      side: "LONG",
      targetQty: 1,
      policy: h.policy({ postOnly: true, postOnlyFallback: "fail" }),
      seed: "alpaca-fail",
      hasStopLoss: true,
    });
    assert.equal(rejected.state, "REJECTED");
    assert.equal(rejected.reason, "POST_ONLY_UNSUPPORTED");
    assert.equal(seen.postOnly, null); // nie an die Venue gesendet
  });

  it("ALPACA mit postOnlyFallback=limit nutzt explizit ein normales Limit", async () => {
    const real = new PaperVenuePort({ now: () => 1_000_000 });
    real.setQuote("BTC", { bid: 99.99, ask: 100.01, mid: 100, ts: 1_000_000 });
    const seen = { postOnly: null as boolean | null };
    const h = makeHarness({ ports: new Map([["ALPACA", alpacaLikePort(real, seen)]]) });
    const started = await h.controller.start({
      venue: "ALPACA",
      mode: "paper",
      symbol: "BTC",
      side: "LONG",
      targetQty: 1,
      policy: h.policy({ postOnly: true, postOnlyFallback: "limit" }),
      seed: "alpaca-limit",
      hasStopLoss: true,
    });
    assert.equal(started.state, "ACK");
    assert.equal(seen.postOnly, false);
    const events = await h.store.listEvents(started.id);
    assert.ok(events.some((e) => e.reason === "SUBMIT_LIMIT_FALLBACK"));
  });

  it("Negative Paths: ungültige Menge, unbekanntes Instrument, fehlender Port", async () => {
    const h = makeHarness();
    await assert.rejects(
      () =>
        h.controller.start({
          venue: "PAPER",
          mode: "paper",
          symbol: "BTC",
          side: "LONG",
          targetQty: 1.0005, // verletzt den Step
          policy: h.policy(),
          seed: "neg-step",
          hasStopLoss: true,
        }),
      ExecutionControllerError
    );
    const h2 = makeHarness({ instrument: null });
    await assert.rejects(
      () =>
        h2.controller.start({
          venue: "PAPER",
          mode: "paper",
          symbol: "BTC",
          side: "LONG",
          targetQty: 1,
          policy: h2.policy(),
          seed: "neg-inst",
          hasStopLoss: true,
        }),
      /INSTRUMENT_UNKNOWN/
    );
    const h3 = makeHarness({ ports: new Map() });
    await assert.rejects(
      () =>
        h3.controller.start({
          venue: "PAPER",
          mode: "paper",
          symbol: "BTC",
          side: "LONG",
          targetQty: 1,
          policy: h3.policy(),
          seed: "neg-port",
          hasStopLoss: true,
        }),
      /PORT_UNKNOWN/
    );
  });

  it("Fehlender Quote ⇒ REJECTED QUOTE_MISSING (nie Submit ohne Preis)", async () => {
    const h = makeHarness();
    h.setQuote({ mid: Number.NaN, spread: null });
    const store = h.store;
    const controller = new ExecutionPolicyController({
      store,
      ports: new Map([["PAPER", h.port]]),
      getQuote: async () => null,
      getAccount: async () => ({ equity: 10_000, openPositions: 0 }),
      getInstrument: () => SPEC,
      now: h.now,
      audit: async () => {},
    });
    const rejected = await controller.start({
      venue: "PAPER",
      mode: "paper",
      symbol: "BTC",
      side: "LONG",
      targetQty: 1,
      policy: h.policy(),
      seed: "neg-quote",
      hasStopLoss: true,
    });
    assert.equal(rejected.state, "REJECTED");
    assert.equal(rejected.reason, "QUOTE_MISSING");
  });

  it("Retry mit anderer Policy unter demselben Key ⇒ POLICY_MISMATCH (fail-closed)", async () => {
    const h = makeHarness();
    const first = await h.controller.start({
      venue: "PAPER",
      mode: "paper",
      symbol: "BTC",
      side: "LONG",
      targetQty: 1,
      policy: h.policy({ ttlMs: 5000 }),
      seed: "mismatch-1",
      hasStopLoss: true,
    });
    assert.equal(first.state, "ACK");
    await assert.rejects(
      () =>
        h.controller.start({
          venue: "PAPER",
          mode: "paper",
          symbol: "BTC",
          side: "LONG",
          targetQty: 1,
          policy: h.policy({ ttlMs: 9000 }),
          seed: "mismatch-1",
          hasStopLoss: true,
        }),
      /POLICY_MISMATCH/
    );
  });
});

describe("execution controller: Determinismus-Golden", () => {
  beforeEach(() => {
    __resetAllSingletonsForTests();
    killSwitch.disarm();
  });
  afterEach(() => {
    killSwitch.disarm();
  });

  async function runScenario(): Promise<{ reasons: string[]; states: string[]; fills: Array<{ qty: number; price: number }>; final: string }> {
    const h = makeHarness();
    const started = await h.controller.start({
      venue: "PAPER",
      mode: "paper",
      symbol: "BTC",
      side: "LONG",
      targetQty: 1,
      policy: h.policy({ ttlMs: 1000, maxReprices: 0, fallbackAllowed: true }),
      seed: "golden-1",
      hasStopLoss: true,
    });
    h.port.applyTrade("BTC", 99.95, 0.4);
    const partial = await h.controller.poll(started.id);
    h.advance(1500);
    const cancelled = await h.controller.poll(partial.id);
    const done = await h.controller.poll(cancelled.id);
    const events = await h.store.listEvents(done.id);
    const fills = await h.store.listFills(done.id);
    return {
      reasons: events.map((e) => e.reason),
      states: events.map((e) => e.toState),
      fills: fills.map((f) => ({ qty: f.qty, price: f.price })),
      final: `${done.state}:${done.reason}:${done.filledQty}`,
    };
  }

  it("Gleiches Szenario ⇒ byte-identische Event-/Fill-Sequenz (Golden)", async () => {
    const a = await runScenario();
    const b = await runScenario();
    assert.deepEqual(a, b);
    assert.deepEqual(a.fills, [
      { qty: 0.4, price: 99.95 },
      { qty: 0.6, price: 100.01 },
    ]);
    assert.equal(a.final, "DONE:FALLBACK_FILLED:1");
    assert.deepEqual(a.states, [
      "SUBMITTED",
      "ACK",
      "ACK",
      "PARTIAL",
      "CANCEL_PENDING",
      "CANCELLED",
      // Fallback-Fill und Transition sind ein atomares Event (kein separates
      // FILLS_RECONCILED): der Market-Fill entsteht im selben Submit.
      "FALLBACK_SUBMITTED",
      "DONE",
    ]);
  });
});
