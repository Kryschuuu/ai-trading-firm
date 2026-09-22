/**
 * Tests: Execution-Policy — Policy, State-Machine, Mengen, Gates, Capabilities, Paper-Port.
 *
 * Reine Unit-Tests (kein Netzwerk, keine DB): Formeln, Bounds, Übergänge,
 * Negative Paths. Controller-E2E steht in `executionPolicy.controller.test.ts`,
 * Persistenz in `executionPolicy.db.test.ts`.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_EXECUTION_POLICY,
  EXECUTION_POLICY_BOUNDS,
  executionPolicyVersion,
  parseExecutionPolicy,
  ExecutionPolicyError,
} from "../src/execution/policy";
import {
  assertTransition,
  canTransition,
  ExecutionTransitionError,
  isTerminalState,
  nextVersion,
} from "../src/execution/stateMachine";
import {
  computeRemainder,
  floorToStep,
  limitPriceFromMid,
  roundToTick,
  sumFees,
  sumFills,
  ExecutionQuantityError,
} from "../src/execution/quantities";
import {
  estimateMarketSlippageBps,
  evaluateFallbackGates,
  evaluateSubmitGates,
} from "../src/execution/gates";
import {
  VENUE_EXECUTION_CAPABILITIES,
  executionCapabilitiesFor,
  cancelUnsupported,
  postOnlyUnsupported,
} from "../src/execution/capabilities";
import { PaperVenuePort } from "../src/execution/ports";
import { __resetAllSingletonsForTests } from "../src/lib/stateRegistry";
import { killSwitch } from "../src/lib/riskGuard";

describe("execution policy: Schema, Bounds, Versionierung", () => {
  it("Default-Policy ist gültig, opt-in Fallback=false, Post-Only mit hartem Fail", () => {
    assert.equal(DEFAULT_EXECUTION_POLICY.fallbackAllowed, false);
    assert.equal(DEFAULT_EXECUTION_POLICY.postOnly, true);
    assert.equal(DEFAULT_EXECUTION_POLICY.postOnlyFallback, "fail");
    assert.match(DEFAULT_EXECUTION_POLICY.policyVersion, /^eop1:[0-9a-f]{64}$/);
  });

  it("Version ist deterministisch und feldsensitiv", () => {
    const a = parseExecutionPolicy({ ...DEFAULT_EXECUTION_POLICY });
    const b = parseExecutionPolicy({ ...DEFAULT_EXECUTION_POLICY });
    assert.equal(a.policyVersion, b.policyVersion);
    const c = parseExecutionPolicy({ ...DEFAULT_EXECUTION_POLICY, ttlMs: DEFAULT_EXECUTION_POLICY.ttlMs + 1000 });
    assert.notEqual(a.policyVersion, c.policyVersion);
    assert.equal(executionPolicyVersion(DEFAULT_EXECUTION_POLICY), a.policyVersion);
  });

  it("Bounds werden fail-closed geprüft (kein stilles Klemmen)", () => {
    for (const field of ["ttlMs", "maxReprices", "priceOffsetBps", "maxSpreadBps", "maxSlippageBps", "maxNotional", "maxQuoteAgeMs", "cancelConfirmTimeoutMs", "maxCancelAttempts"] as const) {
      const bounds = EXECUTION_POLICY_BOUNDS[field];
      assert.throws(
        () => parseExecutionPolicy({ ...DEFAULT_EXECUTION_POLICY, [field]: bounds.min - 1 }),
        ExecutionPolicyError,
        `${field} unter Minimum muss werfen`
      );
      assert.throws(
        () => parseExecutionPolicy({ ...DEFAULT_EXECUTION_POLICY, [field]: bounds.max + 1 }),
        ExecutionPolicyError,
        `${field} über Maximum muss werfen`
      );
    }
    // Grenzwerte selbst sind gültig.
    for (const field of Object.keys(EXECUTION_POLICY_BOUNDS) as (keyof typeof EXECUTION_POLICY_BOUNDS)[]) {
      const bounds = EXECUTION_POLICY_BOUNDS[field];
      parseExecutionPolicy({ ...DEFAULT_EXECUTION_POLICY, [field]: bounds.min });
      parseExecutionPolicy({ ...DEFAULT_EXECUTION_POLICY, [field]: bounds.max });
    }
  });

  it("Negative Paths: kein Objekt, falsche Typen, NaN, unbekannter Fallback", () => {
    assert.throws(() => parseExecutionPolicy(null), ExecutionPolicyError);
    assert.throws(() => parseExecutionPolicy([]), ExecutionPolicyError);
    assert.throws(() => parseExecutionPolicy({ ...DEFAULT_EXECUTION_POLICY, postOnly: "yes" }), ExecutionPolicyError);
    assert.throws(() => parseExecutionPolicy({ ...DEFAULT_EXECUTION_POLICY, postOnlyFallback: "maker" }), ExecutionPolicyError);
    assert.throws(() => parseExecutionPolicy({ ...DEFAULT_EXECUTION_POLICY, ttlMs: Number.NaN }), ExecutionPolicyError);
    assert.throws(() => parseExecutionPolicy({ ...DEFAULT_EXECUTION_POLICY, ttlMs: 1.5 }), ExecutionPolicyError);
    assert.throws(() => parseExecutionPolicy({ ...DEFAULT_EXECUTION_POLICY, maxReprices: -1 }), ExecutionPolicyError);
    assert.throws(() => parseExecutionPolicy({}), ExecutionPolicyError);
  });

  it("Unbekannte Zusatzfelder werden ignoriert (additive Robustheit)", () => {
    const p = parseExecutionPolicy({ ...DEFAULT_EXECUTION_POLICY, futureField: 123 });
    assert.equal(p.policyVersion, DEFAULT_EXECUTION_POLICY.policyVersion);
  });
});

describe("execution state machine: Kanten und Version", () => {
  it("Happy-Path-Kanten sind erlaubt", () => {
    assert.equal(canTransition("NEW", "SUBMITTED"), true);
    assert.equal(canTransition("SUBMITTED", "ACK"), true);
    assert.equal(canTransition("ACK", "PARTIAL"), true);
    assert.equal(canTransition("PARTIAL", "CANCEL_PENDING"), true);
    assert.equal(canTransition("CANCEL_PENDING", "CANCELLED"), true);
    assert.equal(canTransition("CANCELLED", "FALLBACK_SUBMITTED"), true);
    assert.equal(canTransition("FALLBACK_SUBMITTED", "DONE"), true);
  });

  it("Verbotene Kanten werfen (kein Fallback ohne Cancel, kein Sprung aus NEW)", () => {
    assert.equal(canTransition("NEW", "FALLBACK_SUBMITTED"), false);
    assert.equal(canTransition("SUBMITTED", "FALLBACK_SUBMITTED"), false);
    assert.equal(canTransition("ACK", "FALLBACK_SUBMITTED"), false);
    assert.equal(canTransition("PARTIAL", "FALLBACK_SUBMITTED"), false);
    assert.equal(canTransition("CANCEL_PENDING", "FALLBACK_SUBMITTED"), false);
    assert.equal(canTransition("NEW", "DONE"), false);
    assert.equal(canTransition("ACK", "CANCELLED"), false);
    assert.throws(() => assertTransition("PARTIAL", "FALLBACK_SUBMITTED"), ExecutionTransitionError);
  });

  it("Reprice-Sonderkanten existieren bounded (REJECTED/CANCELLED → SUBMITTED)", () => {
    assert.equal(canTransition("REJECTED", "SUBMITTED"), true);
    assert.equal(canTransition("CANCELLED", "SUBMITTED"), true);
    assert.equal(canTransition("REJECTED", "FALLBACK_SUBMITTED"), false);
  });

  it("DONE/FAILED sind terminal", () => {
    assert.equal(isTerminalState("DONE"), true);
    assert.equal(isTerminalState("FAILED"), true);
    assert.equal(isTerminalState("PARTIAL"), false);
    assert.equal(canTransition("DONE", "SUBMITTED"), false);
    assert.equal(canTransition("FAILED", "NEW"), false);
  });

  it("nextVersion steigt strikt und validiert", () => {
    assert.equal(nextVersion(1), 2);
    assert.equal(nextVersion(41), 42);
    assert.throws(() => nextVersion(0), ExecutionTransitionError);
    assert.throws(() => nextVersion(-3), ExecutionTransitionError);
    assert.throws(() => nextVersion(1.5), ExecutionTransitionError);
  });
});

describe("execution quantities: Restmenge, Steps, Gebühren", () => {
  it("floorToStep rundet ab, nie auf", () => {
    assert.equal(floorToStep(1.999, 0.001), 1.999);
    assert.equal(floorToStep(1.9999, 0.001), 1.999);
    assert.equal(floorToStep(0.0005, 0.001), 0);
    assert.equal(floorToStep(10, 3), 9);
    assert.equal(floorToStep(-5, 1), 0);
    assert.throws(() => floorToStep(1, 0), ExecutionQuantityError);
  });

  it("roundToTick hält den Tick und verwirft invalide Preise", () => {
    assert.equal(roundToTick(100.04, 0.1), 100);
    assert.equal(roundToTick(100.05, 0.1), 100.1);
    assert.throws(() => roundToTick(0, 0.1), ExecutionQuantityError);
    assert.throws(() => roundToTick(100, 0), ExecutionQuantityError);
  });

  it("computeRemainder zieht Fills ab und rundet auf den Step", () => {
    const r = computeRemainder(1, [{ fillId: "a", orderId: "o", qty: 0.4, price: 100, feeQuote: 0 }], 0.001);
    assert.equal(r.filledQty, 0.4);
    assert.equal(r.remainderQty, 0.6);
    assert.equal(r.isDust, false);
  });

  it("Staub (Rest unter einem Step) wird als dust erkannt, nicht gehandelt", () => {
    const r = computeRemainder(1, [{ fillId: "a", orderId: "o", qty: 0.9999, price: 100, feeQuote: 0 }], 0.001);
    assert.equal(r.remainderQty, 0);
    assert.equal(r.isDust, true);
  });

  it("Überfüllung ist ein harter Fehler (kein Clamp)", () => {
    assert.throws(
      () => computeRemainder(1, [{ fillId: "a", orderId: "o", qty: 1.5, price: 100, feeQuote: 0 }], 0.001),
      /OVERFILL_DETECTED/
    );
  });

  it("Gebühren: NULL bei einem unbekannten Fill (unbekannt ≠ 0)", () => {
    assert.equal(sumFees([{ fillId: "a", orderId: "o", qty: 1, price: 100, feeQuote: 0.5 }]), 0.5);
    assert.equal(
      sumFees([
        { fillId: "a", orderId: "o", qty: 1, price: 100, feeQuote: 0.5 },
        { fillId: "b", orderId: "o", qty: 1, price: 100, feeQuote: null },
      ]),
      null
    );
    assert.equal(sumFees([]), 0);
  });

  it("sumFills validiert fail-closed", () => {
    assert.equal(sumFills([]), 0);
    assert.throws(() => sumFills([{ fillId: "a", orderId: "o", qty: 0, price: 100, feeQuote: 0 }]), ExecutionQuantityError);
    assert.throws(() => sumFills([{ fillId: "a", orderId: "o", qty: 1, price: -1, feeQuote: 0 }]), ExecutionQuantityError);
  });

  it("limitPriceFromMid: LONG unter Mid, SHORT über Mid, auf Tick", () => {
    assert.equal(limitPriceFromMid("LONG", 100, 100, 0.01), 99);
    assert.equal(limitPriceFromMid("SHORT", 100, 100, 0.01), 101);
    assert.throws(() => limitPriceFromMid("LONG", 0, 5, 0.01), ExecutionQuantityError);
  });
});

describe("execution gates: Submit und Fallback", () => {
  beforeEach(() => {
    __resetAllSingletonsForTests();
    killSwitch.disarm();
  });

  function ctx(over: Record<string, unknown> = {}) {
    return {
      venue: "PAPER" as const,
      mode: "paper" as const,
      symbol: "BTC",
      side: "LONG" as const,
      qty: 1,
      price: 100,
      hasStopLoss: true,
      quote: { mid: 100, bid: 99.99, ask: 100.01, spread: 0.0002, eventTime: 1000, availableAt: 1000 },
      account: { equity: 10_000, openPositions: 0 },
      now: 2000,
      maxSpreadBps: 50,
      maxQuoteAgeMs: 5000,
      maxNotional: 0,
      minQuantity: 0.001,
      quantityStep: 0.001,
      ...over,
    };
  }

  it("OK-Pfad besteht alle Gates", () => {
    const d = evaluateSubmitGates(ctx(), "SUBMIT");
    assert.equal(d.allowed, true);
    assert.equal(d.reason, "OK");
    assert.equal(d.notional, 100);
  });

  it("Kill-Switch stoppt jeden Submit", () => {
    killSwitch.pull("test");
    const d = evaluateSubmitGates(ctx(), "SUBMIT");
    assert.equal(d.allowed, false);
    assert.equal(d.reason, "KILL_SWITCH_ARMED");
  });

  it("Fehlender/ungültiger Quote stoppt (null ≠ 0)", () => {
    assert.equal(evaluateSubmitGates(ctx({ quote: null }), "SUBMIT").reason, "QUOTE_MISSING");
    assert.equal(
      evaluateSubmitGates(ctx({ quote: { mid: 0, bid: 0, ask: 0, spread: 0, eventTime: 1, availableAt: 1 } }), "SUBMIT").reason,
      "QUOTE_MISSING"
    );
  });

  it("Stale und Future-Quoten stoppen", () => {
    assert.equal(
      evaluateSubmitGates(ctx({ quote: { mid: 100, bid: 99, ask: 101, spread: 0.0002, eventTime: 1, availableAt: 1 }, now: 100_000 }), "SUBMIT").reason,
      "QUOTE_STALE"
    );
    assert.equal(
      evaluateSubmitGates(ctx({ quote: { mid: 100, bid: 99, ask: 101, spread: 0.0002, eventTime: 5000, availableAt: 5000 }, now: 2000 }), "SUBMIT").reason,
      "QUOTE_FUTURE"
    );
  });

  it("Unbekannter/weiter Spread stoppt", () => {
    assert.equal(
      evaluateSubmitGates(ctx({ quote: { mid: 100, bid: 99, ask: 101, spread: null, eventTime: 1, availableAt: 1 } }), "SUBMIT").reason,
      "SPREAD_UNKNOWN"
    );
    assert.equal(
      evaluateSubmitGates(ctx({ quote: { mid: 100, bid: 99, ask: 101, spread: 0.02, eventTime: 1, availableAt: 1 } }), "SUBMIT").reason,
      "SPREAD_TOO_WIDE"
    );
  });

  it("Risk-Guard, Notional-Cap, Minimum und Step werden erzwungen", () => {
    // Short ohne Freigabe (Default allowShort=false) → Risk-Guard blockt.
    assert.equal(evaluateSubmitGates(ctx({ side: "SHORT" }), "SUBMIT").reason, "RISK_GUARD_BLOCK");
    assert.equal(evaluateSubmitGates(ctx({ maxNotional: 50 }), "SUBMIT").reason, "NOTIONAL_POLICY_CAP");
    assert.equal(evaluateSubmitGates(ctx({ qty: 0.0005 }), "SUBMIT").reason, "QTY_BELOW_MINIMUM");
    assert.equal(evaluateSubmitGates(ctx({ qty: 1.0005 }), "SUBMIT").reason, "QTY_STEP_VIOLATION");
    assert.equal(evaluateSubmitGates(ctx({ account: null }), "SUBMIT").reason, "ACCOUNT_UNAVAILABLE");
  });

  it("Live-Modus ohne injizierte Gate-Prüfung ist DENY (fail-closed)", () => {
    const d = evaluateSubmitGates(ctx({ mode: "live" }), "SUBMIT");
    assert.equal(d.allowed, false);
    assert.equal(d.reason, "LIVE_GATE_DENY");
  });

  it("Fallback-Gates: Opt-in, bestätigter Cancel, Slippage", () => {
    assert.equal(evaluateFallbackGates({ fallbackAllowed: true, cancelConfirmed: true, estimatedSlippageBps: 5, maxSlippageBps: 30 }).allowed, true);
    assert.equal(evaluateFallbackGates({ fallbackAllowed: false, cancelConfirmed: true, estimatedSlippageBps: 5, maxSlippageBps: 30 }).reason, "FALLBACK_DISABLED");
    assert.equal(evaluateFallbackGates({ fallbackAllowed: true, cancelConfirmed: false, estimatedSlippageBps: 5, maxSlippageBps: 30 }).reason, "FALLBACK_NO_CONFIRMED_CANCEL");
    assert.equal(evaluateFallbackGates({ fallbackAllowed: true, cancelConfirmed: true, estimatedSlippageBps: 100, maxSlippageBps: 30 }).reason, "SLIPPAGE_TOO_HIGH");
    assert.equal(evaluateFallbackGates({ fallbackAllowed: true, cancelConfirmed: true, estimatedSlippageBps: null, maxSlippageBps: 30 }).reason, "SLIPPAGE_TOO_HIGH");
  });

  it("Slippage-Schätzung = halber Spread, null bei unbekanntem Spread", () => {
    assert.equal(estimateMarketSlippageBps(0.0004), 2);
    assert.equal(estimateMarketSlippageBps(null), null);
    assert.equal(estimateMarketSlippageBps(-1), null);
  });
});

describe("execution capabilities: ehrliche Venue-Tabelle", () => {
  it("PAPER kann alles (Simulation), BITUNIX Post-Only ohne atomares Replace, ALPACA kein Post-Only", () => {
    assert.deepEqual(VENUE_EXECUTION_CAPABILITIES.PAPER, { postOnly: true, cancelSingle: true, cancelReplaceAtomic: true });
    assert.deepEqual(VENUE_EXECUTION_CAPABILITIES.BITUNIX, { postOnly: true, cancelSingle: true, cancelReplaceAtomic: false });
    assert.deepEqual(VENUE_EXECUTION_CAPABILITIES.ALPACA, { postOnly: false, cancelSingle: true, cancelReplaceAtomic: true });
    assert.equal(executionCapabilitiesFor("PAPER").postOnly, true);
  });

  it("Stub-Venues melden ehrlich nichts", () => {
    for (const venue of ["IBKR", "BINANCE", "KRAKEN", "DYDX"] as const) {
      assert.deepEqual(executionCapabilitiesFor(venue), { postOnly: false, cancelSingle: false, cancelReplaceAtomic: false });
    }
  });

  it("Capability-Fehler tragen bounded Codes", () => {
    assert.equal(postOnlyUnsupported("ALPACA").code, "POST_ONLY_UNSUPPORTED");
    assert.equal(cancelUnsupported("DYDX").code, "CANCEL_UNSUPPORTED");
  });
});

describe("paper venue port: deterministische Simulation", () => {
  it("Post-Only, das nehmen würde, wird explizit als MAKER-Reject abgelehnt", async () => {
    const port = new PaperVenuePort({ now: () => 1000 });
    port.setQuote("BTC", { bid: 99, ask: 101, mid: 100, ts: 999 });
    const rej = await port.placeLimitOrder({ symbol: "BTC", side: "LONG", qty: 1, limitPrice: 101, postOnly: true, clientOrderId: "A" });
    assert.equal(rej.status, "REJECTED");
    assert.equal(rej.rejectCode, "POST_ONLY_WOULD_TAKE");
    const ok = await port.placeLimitOrder({ symbol: "BTC", side: "LONG", qty: 1, limitPrice: 99, postOnly: true, clientOrderId: "B" });
    assert.equal(ok.status, "ACK");
  });

  it("Derselbe Client-Key liefert dieselbe Order (kein Duplikat)", async () => {
    const port = new PaperVenuePort({ now: () => 1000 });
    port.setQuote("BTC", { bid: 99, ask: 101, mid: 100, ts: 999 });
    const a = await port.placeLimitOrder({ symbol: "BTC", side: "LONG", qty: 1, limitPrice: 99, postOnly: true, clientOrderId: "K" });
    const b = await port.placeLimitOrder({ symbol: "BTC", side: "LONG", qty: 1, limitPrice: 99, postOnly: true, clientOrderId: "K" });
    assert.equal(a.orderId, b.orderId);
    assert.equal(port.openOrderCount(), 1);
  });

  it("applyTrade füllt deterministisch mit Preis-Zeit-Priorität (Partial Fills)", async () => {
    const port = new PaperVenuePort({ now: () => 1000 });
    port.setQuote("BTC", { bid: 99, ask: 101, mid: 100, ts: 999 });
    await port.placeLimitOrder({ symbol: "BTC", side: "LONG", qty: 1, limitPrice: 100, postOnly: false, clientOrderId: "O1" });
    await port.placeLimitOrder({ symbol: "BTC", side: "LONG", qty: 1, limitPrice: 100, postOnly: false, clientOrderId: "O2" });
    const fills = port.applyTrade("BTC", 100, 1.5, 1500);
    assert.equal(fills.length, 2);
    assert.equal(fills[0].qty, 1);
    assert.equal(fills[1].qty, 0.5);
    assert.equal(fills[0].fillId, "paper-O1-f1");
    const view = await port.getOrder({ symbol: "BTC", orderId: "paper-O1" });
    assert.equal(view?.status, "FILLED");
    const view2 = await port.getOrder({ symbol: "BTC", orderId: "paper-O2" });
    assert.equal(view2?.status, "PARTIALLY_FILLED");
  });

  it("Cancel ist idempotent; unbekannte Order ist UNKNOWN (fail-closed)", async () => {
    const port = new PaperVenuePort({ now: () => 1000 });
    port.setQuote("BTC", { bid: 99, ask: 101, mid: 100, ts: 999 });
    await port.placeLimitOrder({ symbol: "BTC", side: "LONG", qty: 1, limitPrice: 99, postOnly: true, clientOrderId: "C" });
    const first = await port.cancelOrder({ symbol: "BTC", orderId: "paper-C", clientOrderId: "C" });
    assert.equal(first.status, "CONFIRMED");
    const second = await port.cancelOrder({ symbol: "BTC", orderId: "paper-C", clientOrderId: "C" });
    assert.equal(second.status, "CONFIRMED");
    assert.equal(second.reasonCode, "ALREADY_CANCELED");
    const unknown = await port.cancelOrder({ symbol: "BTC", orderId: "paper-X", clientOrderId: "X" });
    assert.equal(unknown.status, "UNKNOWN");
  });

  it("Market-Order füllt sofort zum Touch-Preis", async () => {
    const port = new PaperVenuePort({ now: () => 1000 });
    port.setQuote("BTC", { bid: 99, ask: 101, mid: 100, ts: 999 });
    const out = await port.placeMarketOrder({ symbol: "BTC", side: "LONG", qty: 2, clientOrderId: "M" });
    assert.equal(out.status, "ACK");
    assert.equal(out.fills.length, 1);
    assert.equal(out.fills[0].price, 101);
    assert.equal(out.fills[0].qty, 2);
  });
});
