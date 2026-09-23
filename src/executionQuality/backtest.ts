/** The backtest engine indexes candles by OPEN time. Quality observations are
 * anchored at the completed bar boundary, not at that open timestamp. Costs and
 * trading decisions remain byte-compatible; only evidence time is normalized. */

import { BROKER_VENUE_IDS, type BrokerVenueId } from "../contracts/broker";
import type { SimulatedFill } from "../lib/marketdata/simulator";
import { digest, parseBatch, type Batch, type Benchmark } from "./model";
import { unavailable } from "./capture";
export function simulatedBatch(input: {
  symbol: string;
  venue: string;
  quote: string;
  strategy: string;
  at: number;
  reference: number;
  fill: SimulatedFill;
  inputHash: string;
}): Batch {
  const { fill: f } = input;
  const id = `sim-${digest([input.symbol, input.at, f.orderId, input.inputHash])}`;
  const intent: Batch["intent"] = {
    id,
    venue: BROKER_VENUE_IDS.includes(input.venue as BrokerVenueId)
      ? (input.venue as BrokerVenueId)
      : "PAPER",
    mode: "backtest",
    scope: "unpersisted-replay",
    decisionId: id,
    clientOrderId: id,
    parentIntentId: null,
    strategy: `s-${digest(input.strategy).slice(0, 32)}`,
    instrument: input.symbol,
    quoteCurrency: input.quote || "UNKNOWN",
    side: f.side === "LONG" ? "buy" : "sell",
    orderType: "market",
    quantity: f.requestedQty,
    limitPrice: null,
    decisionAt: input.at,
    submitAt: input.at,
    computedAt: input.at,
    inputHash: input.inputHash,
    decisionElapsedSubmitMs: 0,
  };
  const at = input.at + f.latencyMs;
  const benchmark: Benchmark = {
    ...unavailable(intent, "decision"),
    price: input.reference,
    reason: null,
    quality: "modeled",
    source: "simulation",
  };
  return parseBatch({
    intent,
    events: [
      benchmark,
      { ...benchmark, name: "arrival" },
      unavailable(intent, "interval_vwap"),
      {
        kind: "ack",
        intentId: id,
        orderId: f.orderId,
        eventTime: input.at,
        availableAt: input.at,
        computedAt: input.at,
        elapsedSubmitMs: 0,
      },
      ...(f.status === "REJECTED"
        ? []
        : [
            {
              kind: "fill",
              intentId: id,
              orderId: f.orderId,
              fillId: `${f.orderId}:0`,
              eventTime: at,
              availableAt: at,
              computedAt: at,
              elapsedSubmitMs: f.latencyMs,
              price: f.fillPrice,
              quantity: f.filledQty,
              feeQuote: f.fees,
              feeReason: null,
              quality: "modeled",
            },
          ]),
    ],
  });
}
/** Scope includes immutable run inputs + IS/OOS window, preventing double count
 * across retries while keeping independent experiment populations separate. */
export function scopeReplay(
  batch: Batch,
  scope: string,
  computedAt: number,
): Batch {
  const id = `eq-${digest([scope, batch.intent.id])}`;
  return parseBatch({
    intent: {
      ...batch.intent,
      id,
      scope,
      decisionId: id,
      clientOrderId: id,
      computedAt: Math.max(computedAt, batch.intent.submitAt),
    },
    events: batch.events.map((e) => ({
      ...e,
      intentId: id,
      computedAt: Math.max(computedAt, e.availableAt),
    })),
  });
}
