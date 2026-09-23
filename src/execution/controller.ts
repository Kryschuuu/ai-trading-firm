/**
 * Execution-Policy-Controller: versionierter Maker-Versuch mit TTL, Repricing
 * und optionalem Market-Fallback (RMA-P4-02).
 *
 * Ablauf (bounded, fail-closed):
 *   1. `start` — idempotent über `workflowKey`: Erstaufruf validiert, prüft die
 *      Submit-Gates und platziert EXACTLY-ONCE eine Limit-Order (Post-Only oder
 *      expliziter Limit-Fallback). Jeder Retry mit demselben Key liefert den
 *      bestehenden Workflow zurück und sendet NICHTS erneut.
 *   2. `poll` — EIN deterministischer Schritt: erst Venue-Wahrheit laden
 *      (Order + Fills) und persistieren, DANN handeln (ack/partial/done,
 *      TTL-Cancel, Reprice, Fallback). Kein Schritt handelt vor der
 *      Reconciliation; Fills während CANCEL_PENDING werden angerechnet, bevor
 *      irgendein Fallback gerechnet wird.
 *   3. TTL-Ablauf — Cancel anfordern, verifizieren (CANCEL_PENDING), erst nach
 *      BESTÄTIGTEM Cancel neu bepreisen (bounded Reprice-Budget) oder — nur
 *      opt-in und nur unter frischen Gates — die bestätigte Restmenge als
 *      Market fallbacken. Unklarer Cancel-Status blockiert den Fallback.
 *   4. `recover` — Neustart: alle offenen Workflows laden und je Workflow erst
 *      die Venue-Wahrheit rekonstruieren (inkl. Client-Key-Recovery nach
 *      mehrdeutigem Submit), bevor irgendeine externe Aktion erfolgt.
 *
 * Budgets (alle bounded, alle in der Policy):
 *   - Limit-Submits ≤ 1 + maxReprices (Erstversuch + Reprices nach
 *     Maker-Reject oder bestätigtem TTL-Cancel).
 *   - Market-Submits ≤ 1 (genau ein Fallback, nur aus CANCELLED).
 *   - Cancel-/Verify-Versuche ≤ maxCancelAttempts je Cancel-Phase.
 *
 * Reprice-Formel: Offset_neu = priceOffsetBps + 10 × repricesUsed (bp), d. h.
 * jeder Reprice rückt das Limit um 10 bp tiefer auf die Maker-Seite — gegen
 * wiederholte Maker-Rejects, deterministisch, ohne frische Willkür. Das Limit
 * wird VOR jedem Submit auf den Venue-Tick gerundet (Compliance, kein Bypass).
 *
 * Kein Schritt wirft rohe Venue-Texte nach außen: Reject-Codes werden via
 * `classifyPlaceReject` auf die geschlossene `PlaceRejectCode`-Liste abgebildet;
 * Workflow-Reasons sind geschlossene Codes (metrikfähig).
 */
import type { BrokerVenueId, ExecutionMode } from "../contracts/broker";
import {
  cancelUnsupported,
  postOnlyUnsupported,
} from "./capabilities";
import {
  auditTransition,
  countFallback,
  countOverfill,
  countReject,
  type ExecutionAuditWriter,
} from "./audit";
import {
  estimateMarketSlippageBps,
  evaluateFallbackGates,
  evaluateSubmitGates,
  type GateAccount,
  type GateContext,
  type GateQuote,
} from "./gates";
import type { ExecutionPolicy, ExecutionPolicyInput } from "./policy";
import {
  classifyPlaceReject,
  type CancelOutcome,
  type PlaceOutcome,
  type PortFill,
  type VenueExecutionPort,
} from "./ports";
import {
  computeRemainder,
  limitPriceFromMid,
  roundToTick,
  type FillFact,
} from "./quantities";
import {
  buildClientOrderBase,
  buildWorkflowKey,
  ExecutionStoreConflict,
  fallbackClientOrderId,
  limitAttemptClientOrderId,
  type ExecutionStore,
  type WorkflowFillRecord,
  type WorkflowRecord,
} from "./store";

export class ExecutionControllerError extends Error {
  readonly code: string;
  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "ExecutionControllerError";
    this.code = code;
  }
}

/** Venue-Spezifikation (Minimum-/Tick-Regeln — nie umgangen). */
export interface InstrumentSpec {
  quantityStep: number;
  priceStep: number;
  minQuantity: number;
}

export interface QuoteSnapshot {
  mid: number;
  bid: number;
  ask: number;
  spread: number | null;
  eventTime: number;
  availableAt: number;
}

export interface AccountSnapshot {
  equity: number;
  openPositions: number;
}

export interface ExecutionControllerDeps {
  store: ExecutionStore;
  ports: Map<BrokerVenueId, VenueExecutionPort>;
  getQuote: (venue: BrokerVenueId, symbol: string) => Promise<QuoteSnapshot | null>;
  getAccount: (venue: BrokerVenueId, mode: ExecutionMode) => Promise<AccountSnapshot | null>;
  getInstrument: (venue: BrokerVenueId, symbol: string) => InstrumentSpec | null;
  liveGateAllowed?: (venue: BrokerVenueId) => { allowed: boolean; code: string };
  /**
   * RMA-P1-05: asynchroner Strategy-Lifecycle-Check vor Live-Submit.
   * Liefert eine synchrone Closure für die Gates (frischer State dicht am
   * Submit — Race-Schutz gegen Degradation zwischen Prüfung und Order).
   */
  resolveLifecycleGate?: (
    strategyKey?: string | null,
    strategyVersion?: number | null
  ) => Promise<{
    allowed: boolean;
    code: string;
    strategyKey?: string | null;
    strategyVersion?: number | null;
    lifecycleState?: string | null;
  } | null>;
  now?: () => number;
  audit?: ExecutionAuditWriter;
}

export interface StartExecutionInput {
  venue: BrokerVenueId;
  mode: ExecutionMode;
  symbol: string;
  side: "LONG" | "SHORT";
  targetQty: number;
  policy: ExecutionPolicy;
  /** Idempotency-Seed (z. B. Intent-/Decision-ID) — Pflicht für stabile Keys. */
  seed: string;
  /** Überschreibt den abgeleiteten Workflow-Key (nur Tests/Recovery). */
  workflowKey?: string;
  /** Explizites Limit (sonst Mid ± Offset); wird auf den Tick gerundet. */
  limitPrice?: number;
  hasStopLoss?: boolean;
  /** RMA-P1-05: autorisierte Strategieversion der Order (enforce: Pflicht). */
  strategyKey?: string | null;
  strategyVersion?: number | null;
}

const REPRICE_OFFSET_STEP_BPS = 10;

function toGateQuote(q: QuoteSnapshot): GateQuote {
  return {
    mid: q.mid,
    bid: q.bid,
    ask: q.ask,
    spread: q.spread,
    eventTime: q.eventTime,
    availableAt: q.availableAt,
  };
}

function toGateAccount(a: AccountSnapshot): GateAccount {
  return { equity: a.equity, openPositions: a.openPositions };
}

function portFillToRecord(f: PortFill): WorkflowFillRecord {
  return {
    fillId: f.fillId,
    orderId: f.orderId,
    qty: f.qty,
    price: f.price,
    feeQuote: f.feeQuote,
    eventTime: f.eventTime,
    availableAt: f.availableAt,
  };
}

function recordsToFacts(fills: readonly WorkflowFillRecord[]): FillFact[] {
  return fills.map((f) => ({ fillId: f.fillId, orderId: f.orderId, qty: f.qty, price: f.price, feeQuote: f.feeQuote }));
}

/** Externe Cancel-Gründe. Kein Market-Fallback, solange die Policy ihn verbietet. */
export type ExternalCancelReason = "KILL_SWITCH" | "DEADLINE" | "PARENT_CANCEL" | "EXTERNAL_CANCEL";

export class ExecutionPolicyController {
  private readonly store: ExecutionStore;
  private readonly ports: Map<BrokerVenueId, VenueExecutionPort>;
  private readonly getQuote: ExecutionControllerDeps["getQuote"];
  private readonly getAccount: ExecutionControllerDeps["getAccount"];
  private readonly getInstrument: ExecutionControllerDeps["getInstrument"];
  private readonly liveGateAllowed: ExecutionControllerDeps["liveGateAllowed"];
  private readonly resolveLifecycleGate: ExecutionControllerDeps["resolveLifecycleGate"];
  /** Strategieversion je Workflow (RMA-P1-05) — für Reprice/Fallback-Gates. */
  private readonly strategyByWorkflow = new Map<
    string,
    { key: string | null; version: number | null }
  >();
  private readonly now: () => number;
  private readonly audit: ExecutionAuditWriter | undefined;

  constructor(deps: ExecutionControllerDeps) {
    this.store = deps.store;
    this.ports = deps.ports;
    this.getQuote = deps.getQuote;
    this.getAccount = deps.getAccount;
    this.getInstrument = deps.getInstrument;
    this.liveGateAllowed = deps.liveGateAllowed;
    this.resolveLifecycleGate = deps.resolveLifecycleGate;
    this.now = deps.now ?? (() => Date.now());
    this.audit = deps.audit;
  }

  /**
   * RMA-P1-05: Lifecycle-Gate Closure für `evaluateSubmitGates`.
   * Bei `live` wird der persistierte Zustand FRISCH vor dem Submit gelesen
   * (Race: Degradation zwischen Start und Order gewinnt immer).
   */
  private async buildLifecycleGate(
    mode: string,
    strategyKey?: string | null,
    strategyVersion?: number | null
  ): Promise<GateContext["lifecycleGate"]> {
    if (mode !== "live" || !this.resolveLifecycleGate) return undefined;
    const decision = await this.resolveLifecycleGate(strategyKey ?? null, strategyVersion ?? null);
    if (!decision) return undefined;
    return () => decision;
  }

  // ── Start (idempotent) ───────────────────────────────────────────────────

  async start(input: StartExecutionInput): Promise<WorkflowRecord> {
    const symbol = input.symbol.trim().toUpperCase();
    if (!symbol) throw new ExecutionControllerError("INVALID_INPUT", "symbol fehlt");
    if (input.side !== "LONG" && input.side !== "SHORT") {
      throw new ExecutionControllerError("INVALID_INPUT", "side muss LONG oder SHORT sein");
    }
    if (!Number.isFinite(input.targetQty) || input.targetQty <= 0) {
      throw new ExecutionControllerError("INVALID_INPUT", "targetQty muss endlich und > 0 sein");
    }
    if (!input.seed || input.seed.length === 0 || input.seed.length > 128) {
      throw new ExecutionControllerError("INVALID_INPUT", "seed muss 1..128 Zeichen lang sein");
    }
    const instrument = this.getInstrument(input.venue, symbol);
    if (!instrument) {
      throw new ExecutionControllerError("INSTRUMENT_UNKNOWN", `${input.venue}:${symbol} — keine Venue-Spezifikation (fail-closed).`);
    }
    this.assertQtyCompliant(input.targetQty, instrument);
    const port = this.ports.get(input.venue);
    if (!port) throw new ExecutionControllerError("PORT_UNKNOWN", `kein Venue-Port für ${input.venue}`);

    const now = this.now();
    const workflowKey =
      input.workflowKey ??
      buildWorkflowKey({
        venue: input.venue,
        mode: input.mode,
        symbol,
        side: input.side,
        targetQty: input.targetQty,
        seed: input.seed,
      });
    const { record, created } = await this.store.create({
      workflowKey,
      venue: input.venue,
      mode: input.mode,
      symbol,
      side: input.side,
      targetQty: input.targetQty,
      policy: policyInputOf(input.policy),
      policyVersion: input.policy.policyVersion,
      clientOrderBase: buildClientOrderBase(workflowKey),
      // Stop-Loss-Intent unveränderlich persistieren: Reprice und Fallback
      // resubmittieren mit demselben Intent (hartes Risk-Guard-Ceiling).
      hasStopLoss: input.hasStopLoss ?? false,
      limitPrice: null,
      now,
    });
    if (!created) {
      // Idempotenter Retry: bestehender Workflow — KEINE externe Aktion.
      if (record.policyVersion !== input.policy.policyVersion) {
        throw new ExecutionControllerError(
          "POLICY_MISMATCH",
          `Workflow ${workflowKey} läuft unter ${record.policyVersion}, angefragt ${input.policy.policyVersion} — ein Key, eine Policy.`
        );
      }
      return record;
    }

    // Neuer Workflow: Fähigkeiten auflösen (kein stilles Flag-Dropping).
    const caps = port.getCapabilities();
    let effectivePostOnly = input.policy.postOnly;
    let usedLimitFallback = false;
    if (input.policy.postOnly && !caps.postOnly) {
      if (input.policy.postOnlyFallback === "limit") {
        effectivePostOnly = false;
        usedLimitFallback = true;
      } else {
        countReject(input.venue, "POST_ONLY_UNSUPPORTED");
        const rejected = await this.transition(record, {
          patch: { state: "REJECTED", repricesUsed: input.policy.maxReprices, errorCode: "POST_ONLY_UNSUPPORTED", reason: "POST_ONLY_UNSUPPORTED" },
          event: {
            toState: "REJECTED",
            reason: "POST_ONLY_UNSUPPORTED",
            eventTime: now,
            availableAt: now,
            computedAt: now,
            detail: { postOnlyFallback: input.policy.postOnlyFallback },
          },
        });
        void postOnlyUnsupported(input.venue);
        return rejected;
      }
    }

    // Quote + Gates VOR dem ersten Submit.
    const quote = await this.getQuote(input.venue, symbol);
    const account = await this.getAccount(input.venue, input.mode);
    const limitPrice =
      input.limitPrice !== undefined
        ? roundToTick(input.limitPrice, instrument.priceStep)
        : quote
          ? limitPriceFromMid(input.side, quote.mid, input.policy.priceOffsetBps, instrument.priceStep)
          : null;
    if (limitPrice === null) {
      const rejected = await this.transition(record, {
        patch: { state: "REJECTED", repricesUsed: input.policy.maxReprices, errorCode: "QUOTE_MISSING", reason: "QUOTE_MISSING" },
        event: { toState: "REJECTED", reason: "QUOTE_MISSING", eventTime: now, availableAt: now, computedAt: now, detail: {} },
      });
      return rejected;
    }
    this.strategyByWorkflow.set(record.id, {
      key: input.strategyKey ?? null,
      version: input.strategyVersion ?? null,
    });
    const lifecycleGate1 = await this.buildLifecycleGate(input.mode, input.strategyKey ?? null, input.strategyVersion ?? null);
    const gates = evaluateSubmitGates(
      {
        venue: input.venue,
        mode: input.mode,
        symbol,
        side: input.side,
        qty: input.targetQty,
        price: limitPrice,
        hasStopLoss: input.hasStopLoss ?? false,
        quote: quote ? toGateQuote(quote) : null,
        account: account ? toGateAccount(account) : null,
        now,
        maxSpreadBps: input.policy.maxSpreadBps,
        maxQuoteAgeMs: input.policy.maxQuoteAgeMs,
        maxNotional: input.policy.maxNotional,
        minQuantity: instrument.minQuantity,
        quantityStep: instrument.quantityStep,
        liveGateAllowed: this.liveGateAllowed,
        lifecycleGate: lifecycleGate1,
      },
      "SUBMIT"
    );
    if (!gates.allowed) {
      countReject(input.venue, gates.reason);
      return this.transition(record, {
        patch: { state: "REJECTED", repricesUsed: input.policy.maxReprices, errorCode: gates.reason, reason: gates.reason, limitPrice },
        event: {
          toState: "REJECTED",
          reason: gates.reason,
          quoteMid: quote?.mid ?? null,
          spreadBps: quote?.spread !== null && quote?.spread !== undefined ? quote.spread * 10_000 : null,
          eventTime: now,
          availableAt: now,
          computedAt: now,
          detail: { gateDetail: gates.detail, ...(usedLimitFallback ? { postOnlyFallbackUsed: "limit" } : {}) },
        },
      });
    }

    // Exactly-once-Submit des Erstversuchs.
    const clientOrderId = limitAttemptClientOrderId(record.clientOrderBase, 0);
    let outcome: PlaceOutcome;
    try {
      outcome = await port.placeLimitOrder({
        symbol,
        side: input.side,
        qty: input.targetQty,
        limitPrice,
        postOnly: effectivePostOnly,
        clientOrderId,
      });
    } catch (e) {
      // Mehrdeutiger Submit (Timeout nach POST): als SUBMITTED mit Client-Key
      // persistieren — `poll` löst per findOrderByClientId auf, statt doppelt
      // zu senden.
      const submitted = await this.transition(record, {
        patch: {
          state: "SUBMITTED",
          attempt: 0,
          activeOrderId: null,
          activeClientOrderId: clientOrderId,
          limitPrice,
          submittedAt: now,
          reason: "SUBMIT_AMBIGUOUS",
        },
        event: {
          toState: "SUBMITTED",
          reason: "SUBMIT_AMBIGUOUS",
          orderId: null,
          clientOrderId,
          quoteMid: quote?.mid ?? null,
          spreadBps: quote?.spread !== null && quote?.spread !== undefined ? quote.spread * 10_000 : null,
          eventTime: now,
          availableAt: now,
          computedAt: now,
          detail: {
            transportError: e instanceof Error ? e.message.slice(0, 80) : "unknown",
            ...(usedLimitFallback ? { postOnlyFallbackUsed: "limit" } : {}),
          },
        },
      });
      return submitted;
    }

    if (outcome.status === "REJECTED") {
      return this.handleLimitReject(record, outcome, {
        limitPrice,
        quote,
        usedLimitFallback,
        now,
        instrument,
      });
    }
    const submitted = await this.transition(record, {
      patch: {
        state: "SUBMITTED",
        attempt: 0,
        activeOrderId: outcome.orderId,
        activeClientOrderId: outcome.clientOrderId,
        limitPrice,
        submittedAt: now,
        reason: usedLimitFallback ? "SUBMIT_LIMIT_FALLBACK" : "SUBMIT_POST_ONLY",
      },
      event: {
        toState: "SUBMITTED",
        reason: usedLimitFallback ? "SUBMIT_LIMIT_FALLBACK" : "SUBMIT_POST_ONLY",
        orderId: outcome.orderId,
        clientOrderId: outcome.clientOrderId,
        quoteMid: quote?.mid ?? null,
        spreadBps: quote?.spread !== null && quote?.spread !== undefined ? quote.spread * 10_000 : null,
        eventTime: now,
        availableAt: now,
        computedAt: now,
        detail: usedLimitFallback ? { postOnlyFallbackUsed: "limit" } : {},
      },
      newFills: outcome.fills.map(portFillToRecord),
    });
    // Sofortige Fills (Market-ähnliche Venue, Paper-Sofortfill) werden in
    // derselben Sequenz angerechnet — kein „ACK vergessen“.
    return this.poll(submitted.id);
  }

  // ── Poll (ein deterministischer Schritt) ──────────────────────────────────

  async poll(workflowId: string): Promise<WorkflowRecord> {
    const record = await this.store.loadById(workflowId);
    if (!record) throw new ExecutionControllerError("WORKFLOW_NOT_FOUND", `Workflow ${workflowId} unbekannt`);
    if (record.state === "DONE" || record.state === "FAILED") return record;
    const port = this.ports.get(record.venue);
    if (!port) throw new ExecutionControllerError("PORT_UNKNOWN", `kein Venue-Port für ${record.venue}`);
    const instrument = this.getInstrument(record.venue, record.symbol);
    if (!instrument) throw new ExecutionControllerError("INSTRUMENT_UNKNOWN", `${record.venue}:${record.symbol} unbekannt`);

    switch (record.state) {
      case "NEW":
        return record;
      case "SUBMITTED":
      case "ACK":
      case "PARTIAL":
        return this.pollLiveOrder(record, port, instrument);
      case "CANCEL_PENDING":
        return this.pollCancelPending(record, port, instrument);
      case "CANCELLED":
        return this.pollCancelled(record, port, instrument);
      case "FALLBACK_SUBMITTED":
        return this.pollFallback(record, port, instrument);
      case "REJECTED":
        return this.pollRejected(record, port, instrument);
      default:
        return record;
    }
  }

  // ── Recover (Neustart) ────────────────────────────────────────────────────

  /**
   * Rekonstruiert alle offenen Workflows: lädt die persistierte Wahrheit,
   * fragt VOR jeder externen Aktion die Venue-Wahrheit ab (Order + Fills,
   * inkl. Client-Key-Recovery) und setzt dann die normale Poll-Logik fort.
   * Fehler eines Workflows brechen die anderen nicht ab — sie werden im
   * Ergebnis gesammelt (laut, nicht still).
   */
  async recover(limit = 100): Promise<{ recovered: WorkflowRecord[]; errors: Array<{ id: string; code: string; message: string }> }> {
    const open = await this.store.listOpen(limit);
    const recovered: WorkflowRecord[] = [];
    const errors: Array<{ id: string; code: string; message: string }> = [];
    for (const w of open) {
      try {
        recovered.push(await this.poll(w.id));
      } catch (e) {
        const code = e instanceof ExecutionControllerError ? e.code : e instanceof ExecutionStoreConflict ? "STORE_CONFLICT" : "RECOVER_ERROR";
        errors.push({ id: w.id, code, message: e instanceof Error ? e.message.slice(0, 160) : "unknown" });
      }
    }
    return { recovered, errors };
  }

  // ── interne Pfade ─────────────────────────────────────────────────────────

  private async handleLimitReject(
    record: WorkflowRecord,
    outcome: PlaceOutcome,
    ctx: { limitPrice: number; quote: QuoteSnapshot | null; usedLimitFallback: boolean; now: number; instrument: InstrumentSpec }
  ): Promise<WorkflowRecord> {
    const code = outcome.rejectCode ?? "VENUE_REJECT";
    countReject(record.venue, code);
    // MAKER_REJECT ist EXPLIZIT von sonstigen Rejects unterscheidbar.
    const reason = code === "POST_ONLY_WOULD_TAKE" ? "MAKER_REJECT" : `VENUE_REJECT_${code}`;
    const repricable = code === "POST_ONLY_WOULD_TAKE" && record.repricesUsed < record.policy.maxReprices;
    const rejected = await this.transition(record, {
      patch: {
        state: "REJECTED",
        limitPrice: ctx.limitPrice,
        submittedAt: ctx.now,
        errorCode: repricable ? null : code,
        reason,
      },
      event: {
        toState: "REJECTED",
        reason,
        clientOrderId: outcome.clientOrderId,
        quoteMid: ctx.quote?.mid ?? null,
        spreadBps: ctx.quote?.spread !== null && ctx.quote?.spread !== undefined ? ctx.quote.spread * 10_000 : null,
        eventTime: ctx.now,
        availableAt: ctx.now,
        computedAt: ctx.now,
        detail: { rejectCode: code, ...(ctx.usedLimitFallback ? { postOnlyFallbackUsed: "limit" } : {}) },
      },
    });
    if (repricable) {
      const port = this.ports.get(record.venue);
      if (!port) throw new ExecutionControllerError("PORT_UNKNOWN", `kein Venue-Port für ${record.venue}`);
      return this.reprice(rejected, port, ctx.instrument, "MAKER_REJECT_REPRICE");
    }
    // Terminaler Reject: Budget als verbraucht markieren, damit `recover`
    // ihn nicht erneut aufgreift (REJECTED bleibt lesbar, wird aber übersprungen).
    return this.transition(rejected, {
      patch: { repricesUsed: rejected.policy.maxReprices },
      event: {
        toState: "REJECTED",
        reason: "REJECT_TERMINAL",
        eventTime: ctx.now,
        availableAt: ctx.now,
        computedAt: ctx.now,
        detail: { rejectCode: code },
      },
    });
  }

  /** Lädt Venue-Wahrheit (Order + Fills) und persistiert neue Fills zuerst. */
  private async reconcile(
    record: WorkflowRecord,
    port: VenueExecutionPort,
    orderId: string | null,
    clientOrderId: string | null
  ): Promise<{ record: WorkflowRecord; orderStatus: string | null; newFills: PortFill[] }> {
    let resolvedOrderId = orderId;
    if (!resolvedOrderId && clientOrderId && port.findOrderByClientId) {
      const found = await port.findOrderByClientId({ symbol: record.symbol, clientOrderId });
      if (found) {
        resolvedOrderId = found.orderId;
        const now = this.now();
        record = await this.transition(record, {
          patch: record.state === "FALLBACK_SUBMITTED"
            ? { fallbackOrderId: found.orderId }
            : { activeOrderId: found.orderId },
          event: {
            toState: record.state,
            reason: "ORDER_RECOVERED_BY_CLIENT_ID",
            orderId: found.orderId,
            clientOrderId,
            eventTime: now,
            availableAt: now,
            computedAt: now,
            detail: {},
          },
        });
      }
    }
    if (!resolvedOrderId) return { record, orderStatus: null, newFills: [] };
    const [view, venueFills] = await Promise.all([
      port.getOrder({ symbol: record.symbol, orderId: resolvedOrderId }),
      port.getFills({ symbol: record.symbol, orderId: resolvedOrderId }),
    ]);
    const stored = await this.store.listFills(record.id);
    const known = new Set(stored.map((f) => f.fillId));
    const fresh = venueFills.filter((f) => !known.has(f.fillId));
    if (fresh.length > 0) {
      const now = this.now();
      const computedAt = Math.max(now, ...fresh.map((f) => f.availableAt));
      try {
        record = await this.store.mutate(record.id, record.version, {
          patch: {},
          event: {
            toState: record.state,
            reason: "FILLS_RECONCILED",
            orderId: resolvedOrderId,
            filledQtyDelta: fresh.reduce((s, f) => s + f.qty, 0),
            feeDelta: fresh.some((f) => f.feeQuote === null) ? null : fresh.reduce((s, f) => s + (f.feeQuote ?? 0), 0),
            eventTime: Math.min(...fresh.map((f) => f.eventTime)),
            availableAt: Math.max(...fresh.map((f) => f.availableAt)),
            computedAt,
            detail: { newFills: fresh.length },
          },
          newFills: fresh.map(portFillToRecord),
        });
      } catch (e) {
        if (e instanceof Error && e.message.startsWith("OVERFILL_DETECTED")) {
          countOverfill(record.venue);
          const failed = await this.transition(record, {
            patch: { state: "FAILED", errorCode: "OVERFILL_DETECTED", reason: "OVERFILL_DETECTED" },
            event: {
              toState: "FAILED",
              reason: "OVERFILL_DETECTED",
              orderId: resolvedOrderId,
              eventTime: now,
              availableAt: now,
              computedAt: now,
              detail: { venueFilledQty: venueFills.reduce((s, f) => s + f.qty, 0), targetQty: record.targetQty },
            },
          });
          return { record: failed, orderStatus: "OVERFILL", newFills: [] };
        }
        throw e;
      }
    }
    return { record, orderStatus: view?.status ?? null, newFills: fresh };
  }

  private async pollLiveOrder(
    record: WorkflowRecord,
    port: VenueExecutionPort,
    instrument: InstrumentSpec
  ): Promise<WorkflowRecord> {
    const now = this.now();
    const reconciled = await this.reconcile(record, port, record.activeOrderId, record.activeClientOrderId);
    record = reconciled.record;
    if (record.state === "FAILED") return record;
    if (!record.activeOrderId) return record; // mehrdeutig — kein Doppel-Submit.

    const fills = await this.store.listFills(record.id);
    const remainder = computeRemainder(record.targetQty, recordsToFacts(fills), instrument.quantityStep);
    if (remainder.remainderQty <= 0 && !remainder.isDust) {
      return this.transition(record, {
        patch: { state: "DONE", reason: "FILLED" },
        event: { toState: "DONE", reason: "FILLED", orderId: record.activeOrderId, eventTime: now, availableAt: now, computedAt: now, detail: {} },
      });
    }
    if (reconciled.orderStatus === "FILLED") {
      // Venue meldet voll, Fills decken das Ziel (Rundung) — DONE.
      return this.transition(record, {
        patch: { state: "DONE", reason: "FILLED" },
        event: { toState: "DONE", reason: "FILLED", orderId: record.activeOrderId, eventTime: now, availableAt: now, computedAt: now, detail: {} },
      });
    }
    if (reconciled.orderStatus === "CANCELED") {
      // Externer Cancel (nicht vom Controller): als bestätigt übernehmen.
      return this.transition(record, {
        patch: { state: "CANCELLED", cancelRequestedAt: now, cancelConfirmedAt: now, reason: "EXTERNAL_CANCEL" },
        event: { toState: "CANCELLED", reason: "EXTERNAL_CANCEL", orderId: record.activeOrderId, eventTime: now, availableAt: now, computedAt: now, detail: {} },
      });
    }
    if (reconciled.orderStatus === "REJECTED") {
      countReject(record.venue, "VENUE_REJECT");
      const rejected = await this.transition(record, {
        patch: { state: "REJECTED", errorCode: "VENUE_REJECT", reason: "LATE_REJECT" },
        event: { toState: "REJECTED", reason: "LATE_REJECT", orderId: record.activeOrderId, eventTime: now, availableAt: now, computedAt: now, detail: {} },
      });
      return this.transition(rejected, {
        patch: { repricesUsed: rejected.policy.maxReprices },
        event: { toState: "REJECTED", reason: "REJECT_TERMINAL", eventTime: now, availableAt: now, computedAt: now, detail: {} },
      });
    }

    // ACK-/PARTIAL-Fortschritt (vor TTL-Prüfung — ein Fill schlägt den Timeout).
    if (record.state === "SUBMITTED" && (reconciled.orderStatus === "OPEN" || reconciled.orderStatus === "PARTIALLY_FILLED")) {
      const toPartial = remainder.filledQty > 0;
      record = await this.transition(record, {
        patch: { state: toPartial ? "PARTIAL" : "ACK", ackAt: record.ackAt ?? now, reason: toPartial ? "PARTIAL_FILL" : "ORDER_ACK" },
        event: {
          toState: toPartial ? "PARTIAL" : "ACK",
          reason: toPartial ? "PARTIAL_FILL" : "ORDER_ACK",
          orderId: record.activeOrderId,
          eventTime: now,
          availableAt: now,
          computedAt: now,
          detail: {},
        },
      });
    } else if (record.state === "ACK" && remainder.filledQty > 0) {
      record = await this.transition(record, {
        patch: { state: "PARTIAL", reason: "PARTIAL_FILL" },
        event: { toState: "PARTIAL", reason: "PARTIAL_FILL", orderId: record.activeOrderId, eventTime: now, availableAt: now, computedAt: now, detail: {} },
      });
    }

    // TTL-Prüfung (ab submittedAt; SUBMITTED ohne ACK altert gleich mit).
    const submittedAt = record.submittedAt ?? record.createdAt;
    if (now - submittedAt >= record.policy.ttlMs) {
      return this.requestCancel(record, port, "TTL_EXPIRED");
    }
    return record;
  }

  /**
   * Externer Abbruch (Kill-Switch, Deadline, Parent-Cancel) — kein Market-Pfad.
   *
   * Cancelt eine lebende Limit-Order und pollt bounded, bis der Workflow
   * terminal ist. Ein Market-Fallback entsteht daraus nur, wenn die Policy ihn
   * explizit erlaubt. TWAP-Kinder tragen `fallbackAllowed=false` und
   * `maxReprices=0`: nach bestätigtem Cancel endet der Workflow als FAILED
   * (`FALLBACK_DISABLED`), die Restmenge geht an den Parent zurück, nichts
   * wird aggressiv nachgejagt.
   *
   * Unbestätigter Cancel bleibt CANCEL_PENDING/FAILED `CANCEL_UNRESOLVED` —
   * der Aufrufer darf den Auftrag nicht als storniert behandeln.
   */
  async cancelOpen(
    workflowId: string,
    reason: ExternalCancelReason = "EXTERNAL_CANCEL"
  ): Promise<WorkflowRecord> {
    let record = await this.store.loadById(workflowId);
    if (!record) throw new ExecutionControllerError("WORKFLOW_NOT_FOUND", `Workflow ${workflowId} unbekannt`);
    if (record.state === "DONE" || record.state === "FAILED") return record;
    if (record.state === "REJECTED" && record.repricesUsed >= record.policy.maxReprices) return record;
    const port = this.ports.get(record.venue);
    if (!port) throw new ExecutionControllerError("PORT_UNKNOWN", `kein Venue-Port für ${record.venue}`);
    const instrument = this.getInstrument(record.venue, record.symbol);
    if (!instrument) throw new ExecutionControllerError("INSTRUMENT_UNKNOWN", `${record.venue}:${record.symbol} unbekannt`);
    const now = this.now();
    if (record.state === "NEW") {
      return this.transition(record, {
        patch: { state: "FAILED", errorCode: reason, reason },
        event: {
          toState: "FAILED",
          reason,
          eventTime: now,
          availableAt: now,
          computedAt: now,
          detail: { source: "external-cancel" },
        },
      });
    }
    if (record.state === "SUBMITTED" || record.state === "ACK" || record.state === "PARTIAL") {
      record = await this.requestCancel(record, port, reason);
    }
    for (let i = 0; i < 4; i++) {
      if (record.state === "DONE" || record.state === "FAILED") return record;
      if (record.state === "REJECTED" && record.repricesUsed >= record.policy.maxReprices) return record;
      record = await this.poll(record.id);
    }
    return record;
  }

  private async requestCancel(
    record: WorkflowRecord,
    port: VenueExecutionPort,
    trigger: "TTL_EXPIRED" | ExternalCancelReason
  ): Promise<WorkflowRecord> {
    const now = this.now();
    const caps = port.getCapabilities();
    if (!caps.cancelSingle || !record.activeOrderId || !record.activeClientOrderId) {
      if (!caps.cancelSingle) void cancelUnsupported(record.venue);
      return this.transition(record, {
        patch: { state: "FAILED", errorCode: "CANCEL_UNSUPPORTED", reason: "CANCEL_UNSUPPORTED" },
        event: { toState: "FAILED", reason: "CANCEL_UNSUPPORTED", orderId: record.activeOrderId, eventTime: now, availableAt: now, computedAt: now, detail: { trigger } },
      });
    }
    const pending = await this.transition(record, {
      patch: { state: "CANCEL_PENDING", cancelRequestedAt: now, cancelAttempts: record.cancelAttempts + 1, reason: trigger },
      event: { toState: "CANCEL_PENDING", reason: trigger, orderId: record.activeOrderId, eventTime: now, availableAt: now, computedAt: now, detail: {} },
    });
    let outcome: CancelOutcome;
    try {
      outcome = await port.cancelOrder({
        symbol: pending.symbol,
        orderId: pending.activeOrderId ?? "",
        clientOrderId: pending.activeClientOrderId ?? "",
      });
    } catch {
      // Transportfehler beim Cancel: Status UNKLAR — kein Fallback, Verify folgt.
      return pending;
    }
    if (outcome.status === "CONFIRMED") {
      // Fills des Cancel-Reports VOR der Bestätigung anrechnen (kein Überfüllen).
      if (outcome.fills.length > 0) {
        const stored = await this.store.listFills(pending.id);
        const known = new Set(stored.map((f) => f.fillId));
        const fresh = outcome.fills.filter((f) => !known.has(f.fillId));
        if (fresh.length > 0) {
          const computedAt = Math.max(now, ...fresh.map((f) => f.availableAt));
          const withFills = await this.store.mutate(pending.id, pending.version, {
            patch: {},
            event: {
              toState: "CANCEL_PENDING",
              reason: "FILLS_RECONCILED",
              orderId: pending.activeOrderId,
              filledQtyDelta: fresh.reduce((s, f) => s + f.qty, 0),
              eventTime: Math.min(...fresh.map((f) => f.eventTime)),
              availableAt: Math.max(...fresh.map((f) => f.availableAt)),
              computedAt,
              detail: { newFills: fresh.length, source: "cancel-report" },
            },
            newFills: fresh.map(portFillToRecord),
          });
          const fills = await this.store.listFills(withFills.id);
          const remainder = computeRemainder(withFills.targetQty, recordsToFacts(fills), this.specOf(withFills).quantityStep);
          if (remainder.remainderQty <= 0 && !remainder.isDust) {
            return this.transition(withFills, {
              patch: { state: "DONE", cancelConfirmedAt: now, reason: "FILLED_DURING_CANCEL" },
              event: { toState: "DONE", reason: "FILLED_DURING_CANCEL", orderId: withFills.activeOrderId, eventTime: now, availableAt: now, computedAt: now, detail: {} },
            });
          }
          return this.transition(withFills, {
            patch: { state: "CANCELLED", cancelConfirmedAt: now, reason: "CANCEL_CONFIRMED" },
            event: { toState: "CANCELLED", reason: "CANCEL_CONFIRMED", orderId: withFills.activeOrderId, eventTime: now, availableAt: now, computedAt: now, detail: { reasonCode: outcome.reasonCode } },
          });
        }
      }
      return this.transition(pending, {
        patch: { state: "CANCELLED", cancelConfirmedAt: now, reason: "CANCEL_CONFIRMED" },
        event: { toState: "CANCELLED", reason: "CANCEL_CONFIRMED", orderId: pending.activeOrderId, eventTime: now, availableAt: now, computedAt: now, detail: { reasonCode: outcome.reasonCode } },
      });
    }
    if (outcome.status === "FAILED" && outcome.reasonCode === "ALREADY_FILLED") {
      // Race: Cancel kam zu spät — Fills klären, kein Fallback ohne Wahrheit.
      return this.pollCancelPending(pending, port, this.specOf(pending));
    }
    // UNKNOWN oder FAILED: Status unklar — Verify im nächsten Poll, Fallback blockiert.
    return pending;
  }

  private specOf(record: WorkflowRecord): InstrumentSpec {
    const spec = this.getInstrument(record.venue, record.symbol);
    if (!spec) throw new ExecutionControllerError("INSTRUMENT_UNKNOWN", `${record.venue}:${record.symbol} unbekannt`);
    return spec;
  }

  private async pollCancelPending(
    record: WorkflowRecord,
    port: VenueExecutionPort,
    instrument: InstrumentSpec
  ): Promise<WorkflowRecord> {
    const now = this.now();
    const reconciled = await this.reconcile(record, port, record.activeOrderId, record.activeClientOrderId);
    record = reconciled.record;
    if (record.state === "FAILED") return record;
    const fills = await this.store.listFills(record.id);
    const remainder = computeRemainder(record.targetQty, recordsToFacts(fills), instrument.quantityStep);
    if (remainder.remainderQty <= 0 && !remainder.isDust) {
      // Fill während CANCEL_PENDING hat komplettiert — KEIN Fallback mehr.
      return this.transition(record, {
        patch: { state: "DONE", cancelConfirmedAt: record.cancelConfirmedAt ?? now, reason: "FILLED_DURING_CANCEL" },
        event: { toState: "DONE", reason: "FILLED_DURING_CANCEL", orderId: record.activeOrderId, eventTime: now, availableAt: now, computedAt: now, detail: {} },
      });
    }
    const status = reconciled.orderStatus;
    if (status === "CANCELED") {
      return this.transition(record, {
        patch: { state: "CANCELLED", cancelConfirmedAt: now, reason: "CANCEL_CONFIRMED" },
        event: { toState: "CANCELLED", reason: "CANCEL_CONFIRMED", orderId: record.activeOrderId, eventTime: now, availableAt: now, computedAt: now, detail: { source: "verify" } },
      });
    }
    if (status === "FILLED") {
      return this.transition(record, {
        patch: { state: "DONE", cancelConfirmedAt: now, reason: "FILLED_DURING_CANCEL" },
        event: { toState: "DONE", reason: "FILLED_DURING_CANCEL", orderId: record.activeOrderId, eventTime: now, availableAt: now, computedAt: now, detail: { source: "verify" } },
      });
    }
    // Noch offen oder unklar: bounded Retry oder terminaler Fail (NIEMALS Fallback).
    const requestedAt = record.cancelRequestedAt ?? record.updatedAt;
    const timedOut = now - requestedAt >= record.policy.cancelConfirmTimeoutMs;
    if (record.cancelAttempts < record.policy.maxCancelAttempts && !timedOut) {
      if (record.activeOrderId && record.activeClientOrderId) {
        try {
          const outcome = await port.cancelOrder({
            symbol: record.symbol,
            orderId: record.activeOrderId,
            clientOrderId: record.activeClientOrderId,
          });
          if (outcome.status === "CONFIRMED") {
            return this.transition(record, {
              patch: { state: "CANCELLED", cancelAttempts: record.cancelAttempts + 1, cancelConfirmedAt: now, reason: "CANCEL_CONFIRMED" },
              event: { toState: "CANCELLED", reason: "CANCEL_CONFIRMED", orderId: record.activeOrderId, eventTime: now, availableAt: now, computedAt: now, detail: { source: "retry" } },
            });
          }
        } catch {
          // Weiterhin unklar — Zähler erhöhen und erneut verifizieren.
        }
      }
      return this.transition(record, {
        patch: { cancelAttempts: record.cancelAttempts + 1 },
        event: { toState: "CANCEL_PENDING", reason: "CANCEL_RETRY", orderId: record.activeOrderId, eventTime: now, availableAt: now, computedAt: now, detail: { venueStatus: status } },
      });
    }
    if (status === "OPEN" || status === "PARTIALLY_FILLED") {
      // Definitiv noch live, Cancel erschöpft: zurück in den Live-Zustand ist
      // gefährlicher als ein terminaler Fail (unklare Halte) — fail-closed.
      return this.transition(record, {
        patch: { state: "FAILED", errorCode: "CANCEL_UNRESOLVED", reason: "CANCEL_UNRESOLVED" },
        event: { toState: "FAILED", reason: "CANCEL_UNRESOLVED", orderId: record.activeOrderId, eventTime: now, availableAt: now, computedAt: now, detail: { venueStatus: status, cancelAttempts: record.cancelAttempts } },
      });
    }
    return this.transition(record, {
      patch: { state: "FAILED", errorCode: "CANCEL_UNRESOLVED", reason: "CANCEL_UNRESOLVED" },
      event: { toState: "FAILED", reason: "CANCEL_UNRESOLVED", orderId: record.activeOrderId, eventTime: now, availableAt: now, computedAt: now, detail: { venueStatus: status, cancelAttempts: record.cancelAttempts } },
    });
  }

  private async pollCancelled(
    record: WorkflowRecord,
    port: VenueExecutionPort,
    instrument: InstrumentSpec
  ): Promise<WorkflowRecord> {
    const now = this.now();
    // Sicherheitshalber erneut reconciliieren (späte Fills nach Cancel).
    const reconciled = await this.reconcile(record, port, record.activeOrderId, record.activeClientOrderId);
    record = reconciled.record;
    if (record.state === "FAILED") return record;
    const fills = await this.store.listFills(record.id);
    const remainder = computeRemainder(record.targetQty, recordsToFacts(fills), instrument.quantityStep);
    if (remainder.remainderQty <= 0) {
      return this.transition(record, {
        patch: { state: "DONE", reason: remainder.isDust ? "DUST_REMAINDER" : "FILLED" },
        event: {
          toState: "DONE",
          reason: remainder.isDust ? "DUST_REMAINDER" : "FILLED",
          orderId: record.activeOrderId,
          eventTime: now,
          availableAt: now,
          computedAt: now,
          detail: remainder.isDust ? { dustQty: record.targetQty - remainder.filledQty } : {},
        },
      });
    }
    // Erst Reprice-Budget aufbrauchen (bounded Limits), dann Fallback.
    if (record.repricesUsed < record.policy.maxReprices) {
      return this.reprice(record, port, instrument, "TTL_REPRICE");
    }
    if (!record.policy.fallbackAllowed) {
      countFallback(record.venue, "BLOCKED");
      return this.transition(record, {
        patch: { state: "FAILED", errorCode: "FALLBACK_DISABLED", reason: "FALLBACK_DISABLED" },
        event: { toState: "FAILED", reason: "FALLBACK_DISABLED", orderId: record.activeOrderId, eventTime: now, availableAt: now, computedAt: now, detail: { remainderQty: remainder.remainderQty } },
      });
    }
    return this.fallback(record, port, instrument, remainder.remainderQty);
  }

  private async reprice(
    record: WorkflowRecord,
    port: VenueExecutionPort,
    instrument: InstrumentSpec,
    trigger: "MAKER_REJECT_REPRICE" | "TTL_REPRICE"
  ): Promise<WorkflowRecord> {
    const now = this.now();
    const quote = await this.getQuote(record.venue, record.symbol);
    const account = await this.getAccount(record.venue, record.mode);
    if (!quote) {
      // Kein Reprice ohne Quote — bei TTL-Ablauf: Fallback prüfen, sonst FAILED.
      if (record.state === "CANCELLED" && record.policy.fallbackAllowed) {
        const fills = await this.store.listFills(record.id);
        const remainder = computeRemainder(record.targetQty, recordsToFacts(fills), instrument.quantityStep);
        if (remainder.remainderQty > 0) return this.fallback(record, port, instrument, remainder.remainderQty);
      }
      return this.transition(record, {
        patch: { state: "FAILED", errorCode: "QUOTE_MISSING", reason: "QUOTE_MISSING" },
        event: { toState: "FAILED", reason: "QUOTE_MISSING", eventTime: now, availableAt: now, computedAt: now, detail: { trigger } },
      });
    }
    const fills = await this.store.listFills(record.id);
    const remainder = computeRemainder(record.targetQty, recordsToFacts(fills), instrument.quantityStep);
    if (remainder.remainderQty <= 0) {
      return this.transition(record, {
        patch: { state: "DONE", reason: remainder.isDust ? "DUST_REMAINDER" : "FILLED" },
        event: { toState: "DONE", reason: remainder.isDust ? "DUST_REMAINDER" : "FILLED", eventTime: now, availableAt: now, computedAt: now, detail: { trigger } },
      });
    }
    const offsetBps = record.policy.priceOffsetBps + REPRICE_OFFSET_STEP_BPS * record.repricesUsed;
    const limitPrice = limitPriceFromMid(record.side, quote.mid, offsetBps, instrument.priceStep);
    const strat2 = this.strategyByWorkflow.get(record.id);
    const lifecycleGate2 = await this.buildLifecycleGate(record.mode, strat2?.key ?? null, strat2?.version ?? null);
    const gates = evaluateSubmitGates(
      {
        venue: record.venue,
        mode: record.mode,
        symbol: record.symbol,
        side: record.side,
        qty: remainder.remainderQty,
        price: limitPrice,
        hasStopLoss: record.hasStopLoss,
        quote: toGateQuote(quote),
        account: account ? toGateAccount(account) : null,
        now,
        maxSpreadBps: record.policy.maxSpreadBps,
        maxQuoteAgeMs: record.policy.maxQuoteAgeMs,
        maxNotional: record.policy.maxNotional,
        minQuantity: instrument.minQuantity,
        quantityStep: instrument.quantityStep,
        liveGateAllowed: this.liveGateAllowed,
        lifecycleGate: lifecycleGate2,
      },
      "REPRICE"
    );
    if (!gates.allowed) {
      // Reprice verweigert: Fallback prüfen (nur aus CANCELLED), sonst FAILED.
      if (record.state === "CANCELLED" && record.policy.fallbackAllowed) {
        return this.fallback(record, port, instrument, remainder.remainderQty);
      }
      if (record.state === "CANCELLED" && !record.policy.fallbackAllowed) {
        countFallback(record.venue, "BLOCKED");
        return this.transition(record, {
          patch: { state: "FAILED", errorCode: gates.reason, reason: gates.reason },
          event: { toState: "FAILED", reason: gates.reason, eventTime: now, availableAt: now, computedAt: now, detail: { trigger, gateDetail: gates.detail } },
        });
      }
      return this.transition(record, {
        patch: { state: "FAILED", errorCode: gates.reason, reason: gates.reason },
        event: { toState: "FAILED", reason: gates.reason, eventTime: now, availableAt: now, computedAt: now, detail: { trigger, gateDetail: gates.detail } },
      });
    }
    const caps = port.getCapabilities();
    const effectivePostOnly = record.policy.postOnly && caps.postOnly;
    const attempt = record.attempt + 1;
    const clientOrderId = limitAttemptClientOrderId(record.clientOrderBase, attempt);
    let outcome: PlaceOutcome;
    try {
      outcome = await port.placeLimitOrder({
        symbol: record.symbol,
        side: record.side,
        qty: remainder.remainderQty,
        limitPrice,
        postOnly: effectivePostOnly,
        clientOrderId,
      });
    } catch {
      const submitted = await this.transition(record, {
        patch: { state: "SUBMITTED", attempt, activeOrderId: null, activeClientOrderId: clientOrderId, limitPrice, submittedAt: now, repricesUsed: record.repricesUsed + 1, reason: "SUBMIT_AMBIGUOUS" },
        event: { toState: "SUBMITTED", reason: "SUBMIT_AMBIGUOUS", orderId: null, clientOrderId, quoteMid: quote.mid, spreadBps: quote.spread !== null ? quote.spread * 10_000 : null, eventTime: now, availableAt: now, computedAt: now, detail: { trigger, attempt } },
      });
      return submitted;
    }
    if (outcome.status === "REJECTED") {
      const code = outcome.rejectCode ?? classifyPlaceReject("venue reject");
      countReject(record.venue, code);
      const reason = code === "POST_ONLY_WOULD_TAKE" ? "MAKER_REJECT" : `VENUE_REJECT_${code}`;
      const canRetry = code === "POST_ONLY_WOULD_TAKE" && record.repricesUsed + 1 < record.policy.maxReprices;
      const rejected = await this.transition(record, {
        patch: { state: "REJECTED", attempt, limitPrice, repricesUsed: record.repricesUsed + 1, errorCode: canRetry ? null : code, reason },
        event: { toState: "REJECTED", reason, clientOrderId: outcome.clientOrderId, quoteMid: quote.mid, spreadBps: quote.spread !== null ? quote.spread * 10_000 : null, eventTime: now, availableAt: now, computedAt: now, detail: { trigger, attempt, rejectCode: code } },
      });
      if (canRetry) return this.reprice(rejected, port, instrument, "MAKER_REJECT_REPRICE");
      return this.transition(rejected, {
        patch: { repricesUsed: rejected.policy.maxReprices },
        event: { toState: "REJECTED", reason: "REJECT_TERMINAL", eventTime: now, availableAt: now, computedAt: now, detail: { rejectCode: code } },
      });
    }
    return this.transition(record, {
      patch: {
        state: "SUBMITTED",
        attempt,
        activeOrderId: outcome.orderId,
        activeClientOrderId: outcome.clientOrderId,
        limitPrice,
        submittedAt: now,
        repricesUsed: record.repricesUsed + 1,
        cancelAttempts: 0,
        cancelRequestedAt: null,
        cancelConfirmedAt: null,
        reason: trigger,
      },
      event: {
        toState: "SUBMITTED",
        reason: trigger,
        orderId: outcome.orderId,
        clientOrderId: outcome.clientOrderId,
        quoteMid: quote.mid,
        spreadBps: quote.spread !== null ? quote.spread * 10_000 : null,
        eventTime: now,
        availableAt: now,
        computedAt: now,
        detail: { attempt },
      },
      newFills: outcome.fills.map(portFillToRecord),
    });
  }

  private async pollRejected(
    record: WorkflowRecord,
    port: VenueExecutionPort,
    instrument: InstrumentSpec
  ): Promise<WorkflowRecord> {
    // Nur REJECTED mit Rest-Budget wird fortgesetzt; terminale Rejects
    // (Budget erschöpft) sind No-Ops für `recover`.
    if (record.repricesUsed >= record.policy.maxReprices) return record;
    if (record.reason !== "MAKER_REJECT") return record;
    return this.reprice(record, port, instrument, "MAKER_REJECT_REPRICE");
  }

  private async fallback(
    record: WorkflowRecord,
    port: VenueExecutionPort,
    instrument: InstrumentSpec,
    remainderQty: number
  ): Promise<WorkflowRecord> {
    const now = this.now();
    const quote = await this.getQuote(record.venue, record.symbol);
    const account = await this.getAccount(record.venue, record.mode);
    const mid = quote?.mid ?? null;
    if (mid === null || !Number.isFinite(mid) || mid <= 0) {
      countFallback(record.venue, "BLOCKED");
      return this.transition(record, {
        patch: { state: "FAILED", errorCode: "QUOTE_MISSING", reason: "QUOTE_MISSING" },
        event: { toState: "FAILED", reason: "QUOTE_MISSING", eventTime: now, availableAt: now, computedAt: now, detail: { phase: "fallback" } },
      });
    }
    const strat3 = this.strategyByWorkflow.get(record.id);
    const lifecycleGate3 = await this.buildLifecycleGate(record.mode, strat3?.key ?? null, strat3?.version ?? null);
    const submitGates = evaluateSubmitGates(
      {
        venue: record.venue,
        mode: record.mode,
        symbol: record.symbol,
        side: record.side,
        qty: remainderQty,
        price: mid,
        hasStopLoss: record.hasStopLoss,
        quote: quote ? toGateQuote(quote) : null,
        account: account ? toGateAccount(account) : null,
        now,
        maxSpreadBps: record.policy.maxSpreadBps,
        maxQuoteAgeMs: record.policy.maxQuoteAgeMs,
        maxNotional: record.policy.maxNotional,
        minQuantity: instrument.minQuantity,
        quantityStep: instrument.quantityStep,
        liveGateAllowed: this.liveGateAllowed,
        lifecycleGate: lifecycleGate3,
      },
      "FALLBACK"
    );
    if (!submitGates.allowed) {
      countFallback(record.venue, "BLOCKED");
      return this.transition(record, {
        patch: { state: "FAILED", errorCode: submitGates.reason, reason: submitGates.reason },
        event: { toState: "FAILED", reason: submitGates.reason, eventTime: now, availableAt: now, computedAt: now, detail: { phase: "fallback", gateDetail: submitGates.detail } },
      });
    }
    const fallbackGates = evaluateFallbackGates({
      fallbackAllowed: record.policy.fallbackAllowed,
      cancelConfirmed: record.cancelConfirmedAt !== null && record.state === "CANCELLED",
      estimatedSlippageBps: estimateMarketSlippageBps(quote?.spread ?? null),
      maxSlippageBps: record.policy.maxSlippageBps,
    });
    if (!fallbackGates.allowed) {
      countFallback(record.venue, "BLOCKED");
      return this.transition(record, {
        patch: { state: "FAILED", errorCode: fallbackGates.reason, reason: fallbackGates.reason },
        event: { toState: "FAILED", reason: fallbackGates.reason, eventTime: now, availableAt: now, computedAt: now, detail: { phase: "fallback" } },
      });
    }
    const clientOrderId = fallbackClientOrderId(record.clientOrderBase);
    let outcome: PlaceOutcome;
    try {
      outcome = await port.placeMarketOrder({ symbol: record.symbol, side: record.side, qty: remainderQty, clientOrderId });
    } catch {
      countFallback(record.venue, "SUBMITTED");
      return this.transition(record, {
        patch: { state: "FALLBACK_SUBMITTED", fallbackOrderId: null, fallbackClientOrderId: clientOrderId, reason: "FALLBACK_SUBMIT_AMBIGUOUS" },
        event: { toState: "FALLBACK_SUBMITTED", reason: "FALLBACK_SUBMIT_AMBIGUOUS", orderId: null, clientOrderId, quoteMid: quote?.mid ?? null, spreadBps: quote?.spread !== null && quote?.spread !== undefined ? quote.spread * 10_000 : null, eventTime: now, availableAt: now, computedAt: now, detail: { remainderQty } },
      });
    }
    if (outcome.status === "REJECTED") {
      countFallback(record.venue, "FAILED");
      const code = outcome.rejectCode ?? "VENUE_REJECT";
      return this.transition(record, {
        patch: { state: "FAILED", errorCode: `FALLBACK_REJECT_${code}`, reason: `FALLBACK_REJECT_${code}` },
        event: { toState: "FAILED", reason: `FALLBACK_REJECT_${code}`, clientOrderId: outcome.clientOrderId, eventTime: now, availableAt: now, computedAt: now, detail: { remainderQty } },
      });
    }
    countFallback(record.venue, "SUBMITTED");
    const submitted = await this.transition(record, {
      patch: { state: "FALLBACK_SUBMITTED", fallbackOrderId: outcome.orderId, fallbackClientOrderId: outcome.clientOrderId, reason: "FALLBACK_SUBMITTED" },
      event: {
        toState: "FALLBACK_SUBMITTED",
        reason: "FALLBACK_SUBMITTED",
        orderId: outcome.orderId,
        clientOrderId: outcome.clientOrderId,
        quoteMid: quote?.mid ?? null,
        spreadBps: quote?.spread !== null && quote?.spread !== undefined ? quote.spread * 10_000 : null,
        eventTime: now,
        availableAt: now,
        computedAt: now,
        detail: { remainderQty },
      },
      newFills: outcome.fills.map(portFillToRecord),
    });
    return this.pollFallback(submitted, port, instrument);
  }

  private async pollFallback(
    record: WorkflowRecord,
    port: VenueExecutionPort,
    instrument: InstrumentSpec
  ): Promise<WorkflowRecord> {
    const now = this.now();
    const reconciled = await this.reconcile(record, port, record.fallbackOrderId, record.fallbackClientOrderId);
    record = reconciled.record;
    if (record.state === "FAILED") return record;
    if (!record.fallbackOrderId) return record; // mehrdeutig — Recovery folgt.
    if (reconciled.orderStatus === "REJECTED" || reconciled.orderStatus === "CANCELED") {
      countFallback(record.venue, "FAILED");
      return this.transition(record, {
        patch: { state: "FAILED", errorCode: "FALLBACK_FAILED", reason: "FALLBACK_FAILED" },
        event: { toState: "FAILED", reason: "FALLBACK_FAILED", orderId: record.fallbackOrderId, eventTime: now, availableAt: now, computedAt: now, detail: { venueStatus: reconciled.orderStatus } },
      });
    }
    const fills = await this.store.listFills(record.id);
    const remainder = computeRemainder(record.targetQty, recordsToFacts(fills), instrument.quantityStep);
    if (remainder.remainderQty <= 0) {
      countFallback(record.venue, "FILLED");
      return this.transition(record, {
        patch: { state: "DONE", reason: remainder.isDust ? "DUST_REMAINDER" : "FALLBACK_FILLED" },
        event: { toState: "DONE", reason: remainder.isDust ? "DUST_REMAINDER" : "FALLBACK_FILLED", orderId: record.fallbackOrderId, eventTime: now, availableAt: now, computedAt: now, detail: {} },
      });
    }
    // Market-Fallback ohne Vollfüllung: KEIN zweiter Fallback (bounded = 1).
    // Entweder Venue liefert noch (nächster Poll) oder der Rest bleibt offen —
    // ein zweiter Market wäre unboundedes Risiko. Nach einmaligem Abwarten
    // (Quote frisch, Order live) bleibt der Workflow in FALLBACK_SUBMITTED;
    // der Operator sieht den offenen Rest im Event-Log. Terminal wird er NICHT
    // automatisch, damit kein stiller Teilfill als „erledigt“ gilt.
    return record;
  }

  // ── Helfer ─────────────────────────────────────────────────────────────────

  private assertQtyCompliant(qty: number, spec: InstrumentSpec): void {
    if (qty < spec.minQuantity) {
      throw new ExecutionControllerError("INVALID_INPUT", `targetQty ${qty} < Venue-Minimum ${spec.minQuantity}`);
    }
    if (spec.quantityStep > 0) {
      const steps = qty / spec.quantityStep;
      if (Math.abs(steps - Math.round(steps)) > 1e-6) {
        throw new ExecutionControllerError("INVALID_INPUT", `targetQty ${qty} verletzt den Venue-Step ${spec.quantityStep}`);
      }
    }
  }

  private async transition(
    record: WorkflowRecord,
    mutation: {
      patch: import("./store").WorkflowPatch;
      event: import("./store").WorkflowEventInput;
      newFills?: WorkflowFillRecord[];
    }
  ): Promise<WorkflowRecord> {
    const next = await this.store.mutate(record.id, record.version, mutation);
    await auditTransition(
      {
        workflowKey: next.workflowKey,
        venue: next.venue,
        mode: next.mode,
        from: record.state,
        to: next.state,
        reason: mutation.event.reason,
        policyVersion: next.policyVersion,
        attempt: next.attempt,
        orderId: mutation.event.orderId ?? next.activeOrderId ?? next.fallbackOrderId,
        clientOrderId: mutation.event.clientOrderId ?? next.activeClientOrderId ?? next.fallbackClientOrderId,
        filledQty: next.filledQty,
        targetQty: next.targetQty,
      },
      this.audit
    );
    return next;
  }
}

function policyInputOf(policy: ExecutionPolicy): ExecutionPolicyInput {
  return {
    postOnly: policy.postOnly,
    postOnlyFallback: policy.postOnlyFallback,
    ttlMs: policy.ttlMs,
    maxReprices: policy.maxReprices,
    priceOffsetBps: policy.priceOffsetBps,
    fallbackAllowed: policy.fallbackAllowed,
    maxSpreadBps: policy.maxSpreadBps,
    maxSlippageBps: policy.maxSlippageBps,
    maxNotional: policy.maxNotional,
    maxQuoteAgeMs: policy.maxQuoteAgeMs,
    cancelConfirmTimeoutMs: policy.cancelConfirmTimeoutMs,
    maxCancelAttempts: policy.maxCancelAttempts,
  };
}
