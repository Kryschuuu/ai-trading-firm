/**
 * Simulate-only-Follower (STX-07-03 · Phase 7 · Paket 07-03).
 *
 * **Zweck:** die Hälfte des ersten lauffähigen Copy-Loops. Er nimmt einen
 * berechneten {@link FollowerOrderIntent} und führt ihn **ausschließlich
 * simuliert** aus.
 *
 * ## Strukturelle Unmöglichkeit eines echten Submits (STX-16)
 *
 * Der Follower kennt kein Venue-Interface. Er hält einen `PaperBroker`
 * (`src/lib/broker.ts` — der Prozess-Ledger mit der einen Fill-Simulation des
 * Projekts) und sonst nichts. Es gibt:
 *
 * - keinen `BrokerAdapter`, keinen Venue-Order-Pfad, keine transaktionale Order-Schleuse,
 * - keinen HTTP-Client, keinen WebSocket, keinen Credential-Pfad,
 * - kein `mode`-Feld, das man umlegen könnte: {@link CopyMode} ist ein Enum
 *   mit **genau einem** Wert (`SIMULATE_ONLY`), erzwungen durch die
 *   `copy_subscriptions`-CHECK-Constraint **und** durch den Typ.
 *
 * Ein `submit()` gegen eine echte Venue ist damit nicht „verboten", sondern
 * **nicht ausdrückbar**. Die Grep-Prüfung in `tests/copy.engine.test.ts`
 * sichert das zusätzlich ab.
 *
 * ## Wiederverwendung statt zweiter Implementierung
 *
 * - Fill-Simulation: `PaperBroker.submit()` / `PaperBroker.close()` — inklusive
 *   Kill-Switch, Guardrails, Cash-Check, Slippage, Gebühren und Partial Fills.
 * - Ausführungsqualität: `ExecutionQualityStore` + `newIntent()` +
 *   `synchronousResult()` aus `src/executionQuality/` — derselbe
 *   `execution_quality_intents`-Pfad wie im Live-Betrieb (STX-09). Kein
 *   zweiter Intent-/Receipt-Ledger.
 * - Stabile Venue-Client-Order-Id: `clientOrderIdFor()` aus
 *   `src/brokers/bitunix/orders.ts` — deterministisch je Leader-Event, damit
 *   ein Replay keine zweite Order erzeugt.
 *
 * ## Bekannte Grenzen des Paper-Ledgers (keine eigene Simulation)
 *
 * `PaperBroker` ist ein Einstiegspfad: kein Nachkauf (`POSITION_ALREADY_OPEN`)
 * und kein partielles Verkleinern. Ein Leader-`INCREASE` oder `DECREASE` wird
 * deshalb **abgelehnt** und als `FAILED`-Link protokolliert — nicht durch eine
 * erfundene Füll-Logik geglättet. `CLOSE` läuft über `PaperBroker.close()`.
 * Diese Grenze ist in `docs/COPY_TRADING.md` dokumentiert; eine Erweiterung des
 * Ledgers wäre ein eigener Prompt.
 */
import type { BrokerOrderRequest, BrokerOrderResult } from "@/contracts/broker";
import { clientOrderIdFor } from "@/brokers/bitunix/orders";
import { PaperBroker } from "@/lib/broker";
import { RISK_LIMITS } from "@/lib/riskGuard";
import type {
  CopyMode,
  FollowerOrderIntent,
  NormalizedLeaderTrade,
} from "@/copy/types";
import { newIntent, synchronousResult } from "@/executionQuality/capture";
import { ExecutionQualityStore } from "@/executionQuality/store";

// ─────────────────────────────────────────────────────────────────────────────
// Verträge
// ─────────────────────────────────────────────────────────────────────────────

/** Schmaler Store-Port — `ExecutionQualityStore` erfüllt ihn strukturell. */
export interface FollowerQualityStore {
  append(input: unknown): Promise<{ inserted: number }>;
}

export interface FollowerSimulationRequest {
  /** Immer `SIMULATE_ONLY` — der Typ lässt nichts anderes zu. */
  readonly mode: CopyMode;
  /** Follower-Konto (Audit-Label, kein Secret). */
  readonly followerAccount: string;
  /** Leader-Event-Schlüssel (Idempotenz + Ableitung der stabilen IDs). */
  /**
   * Stabile Follower-Intent-ID (vom Engine gebildet, deterministisch aus dem
   * Leader-Event). Sie ist der Idempotenz-Schlüssel dieses Laufs: derselbe
   * Wert ⇒ dieselbe Execution-Quality-Intent-ID ⇒ derselbe Fill.
   */
  readonly followerIntentId: string;
  readonly intent: FollowerOrderIntent;
  /**
   * Das vollständige Leader-Ereignis. Nötig, weil {@link FollowerOrderIntent}
   * (07-01) bewusst **keine** SL/TP/Entry trägt: es ist die berechnete
   * Follower-Order, nicht die Leader-Position. Stop-Geometrie und
   * Abweichungsmessung kommen aus dem Leader-Ereignis.
   */
  readonly leaderTrade: NormalizedLeaderTrade;
  readonly now?: number;
}

export type FollowerFillStatus =
  | "FILLED"
  | "PARTIALLY_FILLED"
  | "REJECTED";

export interface FollowerSimulationResult {
  readonly followerIntentId: string;
  /** `execution_quality_intents.id` — FK-Ziel des Copy-Links (STX-09). */
  readonly executionQualityIntentId: string | null;
  readonly clientOrderId: string;
  readonly status: FollowerFillStatus;
  readonly fillPrice: number | null;
  readonly filledQty: number | null;
  readonly feesQuote: number | null;
  /** Messwert, kein Trigger: Abweichung ggü. dem Leader-Fill in bp. */
  readonly observedDeviationBps: number | null;
  /** Benannter Ablehnungsgrund (nur bei `REJECTED`). */
  readonly detail: string;
}

export interface FollowerExecutor {
  simulate(request: FollowerSimulationRequest): Promise<FollowerSimulationResult>;
}

/** Kein-Schreib-Store für `--dry-run`: protokolliert, persistiert nichts. */
export function createNoopQualityStore(): FollowerQualityStore {
  return {
    async append(): Promise<{ inserted: number }> {
      return { inserted: 0 };
    },
  };
}

const SCOPE_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

export interface SimulatedFollowerOptions {
  readonly paperBroker: PaperBroker;
  readonly qualityStore?: FollowerQualityStore;
  /** Follower-Konto; wird zum Execution-Quality-Scope sanitisiert. */
  readonly scope?: string;
  readonly now?: () => number;
}

/**
 * Der simulate-only-Follower. Konstruktor nimmt **nur** einen `PaperBroker` —
 * das ist die strukturelle Sperre gegen jeden echten Submit.
 */
export class SimulatedFollower implements FollowerExecutor {
  private readonly paperBroker: PaperBroker;
  private readonly qualityStore: FollowerQualityStore;
  private readonly scope: string;
  private readonly now: () => number;

  constructor(opts: SimulatedFollowerOptions) {
    this.paperBroker = opts.paperBroker;
    this.qualityStore = opts.qualityStore ?? new ExecutionQualityStore();
    this.scope = opts.scope ?? "copy-paper";
    this.now = opts.now ?? (() => Date.now());
    if (!SCOPE_PATTERN.test(this.scope)) {
      throw new Error(
        "COPY_SCOPE_INVALID: Follower-Konto muss [A-Za-z0-9_.-]{1,64} erfüllen.",
      );
    }
  }

  async simulate(
    request: FollowerSimulationRequest,
  ): Promise<FollowerSimulationResult> {
    // Laufzeit-Guard für JS-Aufrufer: der Typ erlaubt nur SIMULATE_ONLY.
    if (request.mode !== "SIMULATE_ONLY") {
      throw new Error("COPY_MODE_NOT_SIMULATE_ONLY");
    }
    const intent = request.intent;
    const followerIntentId = request.followerIntentId;
    const occurredNow = request.now ?? this.now();

    const orderRequest = this.buildOrderRequest(request, occurredNow);
    const started = performance.now();
    const batch = newIntent(orderRequest, "PAPER", "paper", this.scope, occurredNow);
    const executionQualityIntentId = batch.intent.id;
    await this.qualityStore.append(batch);

    const outcome = this.executeOnPaperLedger(request, orderRequest);
    const elapsed = performance.now() - started;

    if (outcome.status === "REJECTED") {
      return {
        followerIntentId,
        executionQualityIntentId,
        clientOrderId: orderRequest.clientOrderId ?? "",
        status: "REJECTED",
        fillPrice: null,
        filledQty: null,
        feesQuote: null,
        observedDeviationBps: null,
        detail: outcome.detail,
      };
    }

    const result: BrokerOrderResult = {
      orderId: outcome.orderId,
      symbol: intent.symbol,
      side: intent.side,
      qty: outcome.filledQty,
      fillPrice: outcome.fillPrice,
      feesQuote: outcome.feesQuote,
      status: outcome.partial ? "PARTIALLY_FILLED" : "FILLED",
      reason: outcome.detail,
      stopLoss: orderRequest.stopLoss ?? null,
      takeProfit: orderRequest.takeProfit ?? null,
    };
    await this.qualityStore.append(
      synchronousResult(batch, result, this.now(), elapsed),
    );

    return {
      followerIntentId,
      executionQualityIntentId,
      clientOrderId: orderRequest.clientOrderId ?? "",
      status: outcome.partial ? "PARTIALLY_FILLED" : "FILLED",
      fillPrice: outcome.fillPrice,
      filledQty: outcome.filledQty,
      feesQuote: outcome.feesQuote,
      observedDeviationBps: deviationBps(
        request.leaderTrade.side,
        outcome.fillPrice,
        request.leaderTrade.entryPrice,
      ),
      detail: outcome.detail,
    };
  }

  /**
   * Baut den broker-unabhängigen Order-Request. `orderIntentId` ist deterministisch
   * aus dem Leader-Event abgeleitet — daraus folgen stabile
   * `execution_quality_intents.id` **und** stabiler `clientOrderId`.
   */
  private buildOrderRequest(
    request: FollowerSimulationRequest,
    now: number,
  ): BrokerOrderRequest {
    const intent = request.intent;
    const leaderTrade = request.leaderTrade;
    const symbol = intent.symbol;
    const seed = `copy:${request.followerIntentId}`;
    const qty = this.resolveQuantity(intent);
    return {
      symbol,
      side: intent.side,
      qty,
      riskNotional: Number.isFinite(intent.notional) ? Math.max(intent.notional, 0) : 0,
      orderIntentId: seed,
      clientOrderId: clientOrderIdFor(
        {
          symbol,
          side: intent.side,
          qty,
          riskNotional: Math.max(intent.notional, 0),
          stopLoss: leaderTrade.stopLoss ?? undefined,
          takeProfit: leaderTrade.takeProfit ?? undefined,
        },
        // Deterministische Seeds: gleicher Leader-Event ⇒ gleiche Client-Id.
        intent.createdAt,
        seed,
      ),
      stopLoss: this.resolveStopLoss(leaderTrade),
      takeProfit: leaderTrade.takeProfit ?? undefined,
      executionQuality: {
        id: seed,
        at: intent.createdAt,
        strategy: "COPY_SIMULATE_ONLY",
        quoteCurrency: "USD",
      },
    };
  }

  /**
   * Follower-Menge. Bei `CLOSE` zählt nicht die abgeleitete Menge (Notional 0),
   * sondern die **tatsächlich** offene Follower-Position — sonst wäre ein
   * Close ein No-op.
   */
  private resolveQuantity(intent: FollowerOrderIntent): number {
    if (intent.action !== "CLOSE") {
      return Number.isFinite(intent.quantity) && intent.quantity > 0 ? intent.quantity : 0;
    }
    const position = this.paperBroker.getPosition(intent.symbol);
    const qty = position && Number.isFinite(position.qty) ? position.qty : 0;
    return qty;
  }

  /**
   * Stop-Loss. `RISK_LIMITS.requireStopLoss` ist nicht abschaltbar
   * (`LIMIT_CEILINGS.requireStopLoss = [1,1]`). Fehlt ein Leader-Stop, wird der
   * bestehende Default (`RISK_LIMITS.defaultStopLossPct`) verwendet — keine
   * erfundene Geometrie, sondern die projektweite SSoT.
   */
  private resolveStopLoss(leaderTrade: NormalizedLeaderTrade): number | undefined {
    const leaderStop = leaderTrade.stopLoss;
    if (leaderStop !== null && Number.isFinite(leaderStop) && leaderStop > 0) {
      return leaderStop;
    }
    const entry = leaderTrade.entryPrice;
    if (entry === null || !Number.isFinite(entry) || entry <= 0) return undefined;
    const offset = entry * RISK_LIMITS.defaultStopLossPct;
    const stop = leaderTrade.side === "LONG" ? entry - offset : entry + offset;
    return Number.isFinite(stop) && stop > 0 ? Number(stop.toFixed(8)) : undefined;
  }

  /**
   * Führt auf dem Paper-Ledger aus. Kein eigener Fill — nur die bestehende
   * `submit()`-/`close()`-Semantik inklusive aller Guardrails.
   */
  private executeOnPaperLedger(
    request: FollowerSimulationRequest,
    orderRequest: BrokerOrderRequest,
  ):
    | {
        status: "FILLED";
        orderId: string;
        filledQty: number;
        fillPrice: number;
        feesQuote: number | null;
        partial: boolean;
        detail: string;
      }
    | { status: "REJECTED"; detail: string } {
    const intent = request.intent;
    const symbol = intent.symbol;

    if (orderRequest.qty <= 0 || !Number.isFinite(orderRequest.qty)) {
      return {
        status: "REJECTED",
        detail:
          intent.action === "CLOSE"
            ? "NO_FOLLOWER_POSITION"
            : "INVALID_FOLLOWER_QUANTITY",
      };
    }

    if (intent.action === "CLOSE") {
      const close = this.paperBroker.close(symbol, "COPY_CLOSE");
      if (!close) {
        return { status: "REJECTED", detail: "NO_FOLLOWER_POSITION" };
      }
      return {
        status: "FILLED",
        orderId: close.orderId,
        filledQty: close.qty,
        fillPrice: close.fillPrice,
        feesQuote: null,
        partial: false,
        detail: "PAPER_CLOSE",
      };
    }

    if (intent.action === "DECREASE") {
      // PaperBroker hat keinen partiellen Ausstieg. Fail-closed statt erfinden.
      return {
        status: "REJECTED",
        detail: "PAPER_LEDGER_HAS_NO_PARTIAL_REDUCE",
      };
    }

    const existing = this.paperBroker.getPosition(symbol);
    if (intent.action === "OPEN" && existing) {
      return {
        status: "REJECTED",
        detail: "FOLLOWER_POSITION_ALREADY_OPEN",
      };
    }

    const fill = this.paperBroker.submit({
      symbol,
      side: intent.side,
      qty: orderRequest.qty,
      riskNotional: orderRequest.riskNotional,
      stopLoss: orderRequest.stopLoss,
      takeProfit: orderRequest.takeProfit,
    });

    if (fill.status !== "FILLED") {
      return { status: "REJECTED", detail: fill.reason ?? "PAPER_REJECTED" };
    }
    return {
      status: "FILLED",
      orderId: fill.orderId,
      filledQty: fill.qty,
      fillPrice: fill.fillPrice,
      feesQuote: fill.fees ?? null,
      partial: fill.partial === true,
      detail: "PAPER_FILL",
    };
  }
}

/**
 * Abweichung unseres Fills ggü. dem Leader-Fill in Basispunkten.
 * Vorzeichenkonvention wie `src/executionQuality/model.ts`: **positiv = schlechter**
 * für beide Seiten. Reine Messung — nie ein Cancel-/Reject-Trigger (STX-09).
 */
export function deviationBps(
  side: "LONG" | "SHORT",
  followerFillPrice: number | null,
  leaderEntryPrice: number | null,
): number | null {
  if (
    followerFillPrice === null ||
    leaderEntryPrice === null ||
    !Number.isFinite(followerFillPrice) ||
    !Number.isFinite(leaderEntryPrice) ||
    leaderEntryPrice <= 0
  ) {
    return null;
  }
  const raw = ((followerFillPrice - leaderEntryPrice) / leaderEntryPrice) * 10_000;
  const signed = side === "LONG" ? raw : -raw;
  return Number.isFinite(signed) ? Number(signed.toFixed(6)) : null;
}
