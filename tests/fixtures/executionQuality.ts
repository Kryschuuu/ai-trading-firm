import type { Batch, Benchmark, Fill, Intent } from "../../src/executionQuality/model";
export const intent: Intent = {
  id: "intent-1", venue: "PAPER", mode: "paper", scope: "simulation-1",
  decisionId: "decision-1", clientOrderId: "client-1", parentIntentId: null,
  strategy: "trend-v1", instrument: "BTCUSD", quoteCurrency: "USD", side: "buy",
  orderType: "market", quantity: 10, limitPrice: null,
  decisionAt: 10000, submitAt: 11000, computedAt: 11000, inputHash: "a".repeat(64),
};
export const fill: Fill = {
  kind: "fill", intentId: intent.id, orderId: "order-1", fillId: "fill-1",
  eventTime: 12000, availableAt: 12000, computedAt: 12000,
  quantity: 4, price: 101, feeQuote: .4, feeReason: null, quality: "modeled", elapsedSubmitMs: 1000,
};
export const benchmark: Benchmark = {
  kind: "benchmark", intentId: intent.id, name: "decision", fillId: null,
  price: 100, reason: null, quality: "observed", source: "quote", inputHash: "b".repeat(64),
  eventTime: 10000, windowEnd: 10000, availableAt: 10000, computedAt: 11000,
};
export function fixture(): Batch {
  return structuredClone({ intent, events: [
    benchmark,
    { ...benchmark, name: "arrival", eventTime: 11000, windowEnd: 11000, availableAt: 11000 },
    { kind: "ack", intentId: intent.id, orderId: "order-1", eventTime: 11100, availableAt: 11100, computedAt: 11100, elapsedSubmitMs: 100 },
    fill,
    { ...fill, fillId: "fill-2", eventTime: 13000, availableAt: 13000, computedAt: 13000, quantity: 6, price: 102, feeQuote: .6, elapsedSubmitMs: 2000 },
  ] } as Batch);
}
