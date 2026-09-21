/** Production mappings. Never infer a mid from a last trade or infer a fee
 * from an order acknowledgement. Missing source evidence stays explicitly null. */
import { buildClientOrderId } from "../brokers/reconciliation";
import type {
  BrokerOrderRequest,
  BrokerOrderResult,
  BrokerVenueId,
  ExecutionMode,
} from "../contracts/broker";
import {
  digest,
  parseBatch,
  type Batch,
  type Benchmark,
  type Fill,
  type Intent,
  type Reason,
} from "./model";

export interface DecisionContext {
  id: string;
  at: number;
  strategy: string;
  quoteCurrency: string;
  parentIntentId?: string;
  /** Same-process elapsed decision→submit duration; null after restart. */
  elapsedMs?: number | null;
  price?: {
    value: number;
    eventTime: number;
    availableAt: number;
    inputHash: string;
  };
}
export function qualityEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.EXECUTION_QUALITY_ENABLED;
  if (flag !== undefined && flag !== "true" && flag !== "false")
    throw new Error("INVALID_EXECUTION_QUALITY_FLAG");
  return flag === "true";
}
export function unavailable(
  intent: Intent,
  name: Benchmark["name"],
  reason: Reason = "MISSING",
  fill?: Fill,
): Benchmark {
  const at = fill
    ? fill.eventTime + Number(name.split("_")[1])
    : intent.submitAt;
  return {
    kind: "benchmark",
    intentId: intent.id,
    name,
    fillId: fill?.fillId ?? null,
    price: null,
    reason,
    quality:
      intent.mode === "paper" || intent.mode === "backtest"
        ? "modeled"
        : "observed",
    source: "unavailable",
    inputHash: intent.inputHash,
    eventTime: at,
    windowEnd: at,
    availableAt: Math.max(at, fill?.availableAt ?? at),
    computedAt: Math.max(at, fill?.availableAt ?? at),
  };
}
/** Stable order arguments only. Observation/monotonic clocks are not new orders. */
export function orderRequestHash(req: BrokerOrderRequest): string {
  return digest({
    symbol: req.symbol,
    side: req.side,
    qty: req.qty,
    riskNotional: req.riskNotional,
    limit: req.limitPrice ?? null,
    stop: req.stopLoss ?? null,
    take: req.takeProfit ?? null,
    decision: req.executionQuality?.id ?? null,
  });
}
export function newIntent(
  req: BrokerOrderRequest,
  venue: BrokerVenueId,
  mode: ExecutionMode,
  scope: string,
  now: number,
): Batch {
  const key = req.orderIntentId ?? req.clientOrderId;
  if (!key) throw new Error("EXECUTION_QUALITY_REQUIRES_STABLE_INTENT_ID");
  const context = req.executionQuality;
  const intent: Intent = {
    id: `eq-${digest([venue, mode, scope, key])}`,
    venue,
    mode,
    scope,
    decisionId: context?.id ?? null,
    clientOrderId: req.clientOrderId ?? buildClientOrderId(key),
    parentIntentId: context?.parentIntentId ?? null,
    strategy: context?.strategy ?? "UNATTRIBUTED",
    instrument: req.symbol,
    quoteCurrency: context?.quoteCurrency ?? "UNKNOWN",
    side: req.side === "LONG" ? "buy" : "sell",
    orderType: req.limitPrice === undefined ? "market" : "limit",
    quantity: req.qty,
    limitPrice: req.limitPrice ?? null,
    decisionAt: context?.at ?? null,
    submitAt: now,
    computedAt: now,
    decisionElapsedSubmitMs: context?.elapsedMs ?? null,
    requestHash: orderRequestHash(req),
    inputHash: digest({
      schema: 1,
      symbol: req.symbol,
      side: req.side,
      qty: req.qty,
      limit: req.limitPrice ?? null,
      decision: context ?? null,
    }),
  };
  let decision = unavailable(intent, "decision");
  if (context?.price) {
    const p = context.price;
    const reason =
      !Number.isFinite(p.value) || p.value <= 0
        ? "INVALID"
        : p.availableAt > context.at || p.eventTime > context.at
          ? "NOT_AVAILABLE_AS_OF"
          : context.at - p.eventTime > 5000
            ? "STALE"
            : null;
    decision = reason
      ? unavailable(intent, "decision", reason)
      : {
          ...decision,
          price: p.value,
          reason: null,
          source: "quote",
          quality: "observed",
          inputHash: p.inputHash,
          eventTime: p.eventTime,
          windowEnd: p.eventTime,
          availableAt: p.availableAt,
        };
  }
  return parseBatch({
    intent,
    events: [
      decision,
      unavailable(intent, "arrival"),
      unavailable(intent, "interval_vwap"),
    ],
  });
}
export function synchronousResult(
  batch: Batch,
  result: BrokerOrderResult,
  at: number,
  elapsed: number | null,
): Batch {
  const i = batch.intent;
  const events = [...batch.events];
  if (result.status !== "REJECTED" && result.status !== "UNKNOWN")
    events.push({
      kind: "ack",
      intentId: i.id,
      orderId: result.orderId,
      eventTime: at,
      availableAt: at,
      computedAt: at,
      elapsedSubmitMs: elapsed,
    });
  // Live aggregate order prices are deliberately NOT transformed into fills.
  if (
    (i.mode === "paper" || i.mode === "backtest") &&
    (result.status === "FILLED" || result.status === "PARTIALLY_FILLED")
  ) {
    const fee = result.feesQuote ?? null;
    events.push({
      kind: "fill",
      intentId: i.id,
      orderId: result.orderId,
      fillId: `${result.orderId}:0`,
      quantity: result.filledQty ?? result.qty,
      price: result.fillPrice,
      feeQuote: fee,
      feeReason: fee === null ? "MISSING" : null,
      quality: "modeled",
      eventTime: at,
      availableAt: at,
      computedAt: at,
      elapsedSubmitMs: elapsed,
    });
  }
  return parseBatch({ intent: i, events });
}
