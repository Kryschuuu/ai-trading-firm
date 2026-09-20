/** Read-only venue recovery + append-only quality facts. No call to placeOrder,
 * cancel, close, or any risk authority. Missing/truncated evidence is explicit. */
import type { BrokerAdapter, ExecutionEvidence } from "../contracts/broker";
import { auditWrite } from "../lib/auditSink";
import { telemetry } from "../lib/telemetry";
import { unavailable } from "./capture";
import {
  canonical,
  compareText,
  digest,
  parseBatch,
  QualityError,
  type Batch,
  type Fill,
  type QualityEvent,
} from "./model";
import { ExecutionQualityStore } from "./store";

export function evidenceEvents(
  batch: Batch,
  evidence: ExecutionEvidence,
  receivedAt: number,
): QualityEvent[] {
  const seen = new Map<string, ExecutionEvidence["fills"][number]>();
  for (const f of evidence.fills) {
    const old = seen.get(f.id);
    if (old && canonical(old) !== canonical(f))
      throw new QualityError("VENUE_FILL_CONFLICT");
    seen.set(f.id, f);
  }
  const rows = [...seen.values()].sort(
    (a, b) => a.at - b.at || compareText(a.id, b.id),
  );
  const qty = rows.reduce((s, f) => s + f.quantity, 0);
  if (
    !Number.isFinite(evidence.filledQuantity) ||
    evidence.filledQuantity < 0 ||
    Math.abs(qty - evidence.filledQuantity) >
      Math.max(qty, evidence.filledQuantity) * 1e-10
  )
    throw new QualityError("INCOMPLETE_VENUE_FILLS");
  if (
    evidence.feeQuoteTotal !== null &&
    (!Number.isFinite(evidence.feeQuoteTotal) ||
      !rows.every((f) => f.feeQuote !== null) ||
      Math.abs(
        rows.reduce((s, f) => s + f.feeQuote!, 0) - evidence.feeQuoteTotal,
      ) > 1e-8)
  )
    throw new QualityError("BROKER_FEE_MISMATCH");
  const events: QualityEvent[] = [];
  if (!batch.events.some((e) => e.kind === "ack"))
    events.push({
      kind: "ack",
      intentId: batch.intent.id,
      orderId: evidence.orderId,
      eventTime: receivedAt,
      availableAt: receivedAt,
      computedAt: receivedAt,
      elapsedSubmitMs: null,
    });
  for (const f of rows) {
    if (f.at < batch.intent.submitAt || f.at > receivedAt)
      throw new QualityError("INVALID_VENUE_FILL_TIME");
    const old = batch.events.find(
      (e): e is Fill => e.kind === "fill" && e.fillId === f.id,
    );
    const event: Fill = {
      kind: "fill",
      intentId: batch.intent.id,
      orderId: evidence.orderId,
      fillId: f.id,
      quantity: f.quantity,
      price: f.price,
      feeQuote: f.feeQuote,
      feeReason: f.feeQuote === null ? "MISSING" : null,
      quality: "observed",
      eventTime: f.at,
      availableAt: old?.availableAt ?? receivedAt,
      computedAt: old?.computedAt ?? receivedAt,
      elapsedSubmitMs: null,
    };
    if (old && digest(old) !== digest(event))
      throw new QualityError("VENUE_FILL_CONFLICT");
    if (!old) events.push(event);
  }
  parseBatch({ intent: batch.intent, events });
  return events;
}

/** One bounded page. A returned cursor must be followed before starting a new
 * sweep. CLI watch does so, while process restart safely starts a fresh sweep. */
export async function reconcileQuality(
  adapter: BrokerAdapter,
  scope: string,
  after = "",
  store = new ExecutionQualityStore(),
  now = Date.now,
  audit: (
    ...args: Parameters<typeof auditWrite>
  ) => Promise<unknown> = auditWrite,
) {
  const intents = await store.page(adapter.id, adapter.mode, scope, after);
  let captured = 0,
    unavailableCount = 0,
    failures = 0;
  for (const i of intents) {
    let terminal = false;
    let batch = await store.load(i.id);
    if (!batch) continue;
    const receipt = await store.receipt(i.id);
    terminal =
      (i.mode === "paper" || i.mode === "backtest") &&
      !!receipt &&
      ["FILLED", "CANCELED", "REJECTED"].includes(receipt.result.status);
    if (
      i.mode === "paper" &&
      batch.events
        .filter((e): e is Fill => e.kind === "fill")
        .reduce((s, f) => s + f.quantity, 0) >= i.quantity
    )
      terminal = true;
    // Samples are kept across restarts so a late job cannot replace a historical
    // horizon with today's quote. Unsupported L1 sources produce null coverage.
    const quoteProvider = adapter.getExecutionQuote ?? adapter.getOrderBook;
    if (quoteProvider) {
      try {
        const book = await quoteProvider.call(adapter, i.instrument),
          at = now();
        const bid = book.bids[0]?.price,
          ask = book.asks[0]?.price;
        if (!(ask >= bid && bid > 0)) throw new QualityError("INVALID_QUOTE");
        await store.sample(i, {
          mid: (bid + ask) / 2,
          eventTime: book.ts,
          availableAt: at,
        });
      } catch {
        unavailableCount++;
        telemetry.executionQuality.inc({ result: "marketdata_unavailable" });
      }
    }
    try {
      if (
        (i.mode === "live" || i.mode === "testnet") &&
        adapter.getExecutionEvidence
      ) {
        const evidence = await adapter.getExecutionEvidence(
          i.clientOrderId,
          i.instrument,
          i.submitAt,
        );
        if (evidence) {
          terminal = ["FILLED", "CANCELED", "REJECTED"].includes(
            evidence.status ?? "UNKNOWN",
          );
          const events = evidenceEvents(batch, evidence, now());
          if (events.length)
            captured += (await store.append({ intent: i, events })).inserted;
          batch = (await store.load(i.id)) ?? batch;
          // A recovered receipt represents only observed venue facts. Never send
          // the original order again just because it was missing a local receipt.
          if (
            (await store.hasSubmission(i.id)) &&
            !(await store.receipt(i.id))
          ) {
            const qty = evidence.filledQuantity,
              notional = batch.events
                .filter((e): e is Fill => e.kind === "fill")
                .reduce((s, f) => s + f.price * f.quantity, 0);
            await store.saveReceipt(i.id, {
              orderId: evidence.orderId,
              symbol: i.instrument,
              side: i.side === "buy" ? "LONG" : "SHORT",
              qty: i.quantity,
              filledQty: qty,
              fillPrice: qty ? notional / qty : 0,
              status:
                evidence.status ??
                (qty >= i.quantity
                  ? "FILLED"
                  : qty > 0
                    ? "PARTIALLY_FILLED"
                    : "NEW"),
              stopLoss: null,
              takeProfit: null,
            });
          }
        } else unavailableCount++;
      }
      const benchmarks: QualityEvent[] = [];
      for (const f of batch.events.filter(
        (e): e is Fill => e.kind === "fill",
      )) {
        for (const horizon of [1000, 5000, 30000] as const) {
          const name = `adverse_${horizon}` as const,
            target = f.eventTime + horizon;
          if (
            now() < target ||
            batch.events.some(
              (e) =>
                e.kind === "benchmark" &&
                e.name === name &&
                e.fillId === f.fillId,
            )
          )
            continue;
          const q = await store.quoteAsOf(i, target);
          const base = unavailable(i, name, "MISSING", f);
          benchmarks.push(
            q
              ? {
                  ...base,
                  price: q.mid,
                  reason: null,
                  quality: "observed",
                  source: "book",
                  eventTime: q.eventTime,
                  windowEnd: q.eventTime,
                  availableAt: q.availableAt,
                  computedAt: now(),
                  inputHash: q.inputHash,
                }
              : { ...base, computedAt: Math.max(now(), base.availableAt) },
          );
        }
      }
      if (benchmarks.length)
        captured += (await store.append({ intent: i, events: benchmarks }))
          .inserted;
      const all = [...batch.events, ...benchmarks];
      if (
        terminal &&
        all
          .filter((e): e is Fill => e.kind === "fill")
          .every((f) =>
            [1000, 5000, 30000].every((h) =>
              all.some(
                (e) =>
                  e.kind === "benchmark" &&
                  e.fillId === f.fillId &&
                  e.name === `adverse_${h}`,
              ),
            ),
          )
      )
        await store.finish(i.id);
    } catch (error) {
      failures++;
      telemetry.executionQuality.inc({ result: "reconcile_failed" });
      await audit("EXECUTION_QUALITY", "WARN", {
        stage: "reconcile",
        code:
          error instanceof QualityError
            ? error.code
            : "PROVIDER_OR_STORE_UNAVAILABLE",
        venue: adapter.id,
        mode: adapter.mode,
      });
    }
  }
  const nextCursor =
    intents.length === 100 ? intents[intents.length - 1].id : null;
  await audit("EXECUTION_QUALITY", "INFO", {
    stage: "reconcile",
    scanned: intents.length,
    captured,
    unavailable: unavailableCount,
    failures,
  });
  return {
    scanned: intents.length,
    captured,
    unavailable: unavailableCount,
    failures,
    nextCursor,
  };
}
