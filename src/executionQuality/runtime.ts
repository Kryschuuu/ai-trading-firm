import type {
  BrokerOrderRequest,
  BrokerOrderResult,
  BrokerVenueId,
  ExecutionMode,
  MarketOrderBook,
} from "../contracts/broker";
import { auditWrite } from "../lib/auditSink";
import { telemetry } from "../lib/telemetry";
import { newIntent, orderRequestHash, qualityEnabled } from "./capture";
import { synchronousResult } from "./capture";
import { digest, QualityError, type Batch } from "./model";
import { ExecutionQualityStore } from "./store";

export interface CaptureStore {
  load(id: string): Promise<Batch | null>;
  append(input: unknown): Promise<{ inserted: number }>;
  claim(id: string, hash: string): Promise<boolean>;
  receipt(id: string): Promise<{
    result: BrokerOrderResult;
    at: number;
    elapsed: number | null;
  } | null>;
  saveReceipt(
    id: string,
    result: BrokerOrderResult,
    at: number,
    elapsed: number | null,
  ): Promise<void>;
}
/** Capture wraps the existing gated executor; it never replaces it or retries it.
 * Persisted claims survive process death. Read-only reconciliation resolves an
 * uncertain acknowledgement; absent evidence fails closed on every retry. */
export async function captureOrder(opts: {
  venue: BrokerVenueId;
  mode: ExecutionMode;
  request: BrokerOrderRequest;
  execute: (request: BrokerOrderRequest) => Promise<BrokerOrderResult>;
  book?: () => Promise<MarketOrderBook>;
  store?: CaptureStore;
  enabled?: boolean;
  scope?: string;
  quoteCurrency?: string;
  audit?: (...args: Parameters<typeof auditWrite>) => Promise<unknown>;
}): Promise<BrokerOrderResult> {
  if (!(opts.enabled ?? qualityEnabled())) return opts.execute(opts.request);
  const store = opts.store ?? new ExecutionQualityStore();
  const audit = opts.audit ?? auditWrite;
  // Scope is an opaque deployment-account namespace, never an actual account ID.
  const scope = opts.scope ?? process.env.EXECUTION_QUALITY_SCOPE;
  if (!scope || !/^[A-Za-z0-9_.-]{1,64}$/.test(scope))
    throw new QualityError("MISSING_CAPTURE_SCOPE");
  const req = opts.request;
  let start = performance.now();
  const draft = newIntent(req, opts.venue, opts.mode, scope, Date.now());
  if (!req.executionQuality && opts.quoteCurrency)
    draft.intent.quoteCurrency = opts.quoteCurrency;
  const old = await store.load(draft.intent.id);
  const batch = old ?? draft;
  if (!old) {
    if (opts.book) {
      try {
        const book = await opts.book();
        const bid = book.bids[0]?.price,
          ask = book.asks[0]?.price;
        const received = Date.now();
        start = performance.now();
        const reason =
          !Number.isFinite(bid) ||
          !Number.isFinite(ask) ||
          bid <= 0 ||
          ask < bid ||
          !Number.isSafeInteger(book.ts)
            ? "INVALID"
            : book.ts > received
              ? "NOT_AVAILABLE_AS_OF"
              : received - book.ts > 5000
                ? "STALE"
                : null;
        const valid = reason === null;
        // Submit is defined immediately before dispatch after collecting arrival.
        batch.intent.submitAt = received;
        batch.intent.computedAt = received;
        const arrival = batch.events.find(
          (e) => e.kind === "benchmark" && e.name === "arrival",
        );
        if (arrival?.kind === "benchmark")
          Object.assign(
            arrival,
            valid
              ? {
                  price: (bid + ask) / 2,
                  reason: null,
                  source: "book",
                  quality: "observed",
                  eventTime: book.ts,
                  windowEnd: book.ts,
                  availableAt: received,
                  computedAt: received,
                  inputHash: digest({ bid, ask, ts: book.ts }),
                }
              : { reason },
          );
      } catch {
        telemetry.executionQuality.inc({ result: "marketdata_unavailable" });
        await audit("EXECUTION_QUALITY", "WARN", {
          stage: "arrival",
          code: "MARKETDATA_UNAVAILABLE",
        });
      }
    }
    await store.append(batch);
  }
  const requestHash = orderRequestHash(req);
  if (!(await store.claim(batch.intent.id, requestHash))) {
    const previous = await store.receipt(batch.intent.id);
    if (previous) {
      // Repair a crash between durable receipt and append without resubmitting.
      const missing = synchronousResult(
        { ...batch, events: [] },
        previous.result,
        previous.at,
        previous.elapsed,
      ).events.filter(
        (e) =>
          !batch.events.some(
            (old) =>
              old.kind === e.kind &&
              (e.kind !== "fill" ||
                (old.kind === "fill" && old.fillId === e.fillId)),
          ),
      );
      if (missing.length)
        await store.append({ intent: batch.intent, events: missing });
      telemetry.executionQuality.inc({ result: "replayed" });
      return {
        ...previous.result,
        stopLoss: previous.result.stopLoss ?? req.stopLoss ?? null,
        takeProfit: previous.result.takeProfit ?? req.takeProfit ?? null,
      };
    }
    throw new QualityError("SUBMISSION_UNCERTAIN_RECONCILE_ONLY");
  }
  // Stable client key reaches the existing venue serializer, preserving all gates.
  let result: BrokerOrderResult;
  try {
    result = await opts.execute({
      ...req,
      clientOrderId: batch.intent.clientOrderId,
    });
  } catch (error) {
    telemetry.executionQuality.inc({ result: "submission_uncertain" });
    await audit("EXECUTION_QUALITY", "CRITICAL", {
      stage: "submit",
      code: "SUBMISSION_UNCERTAIN_RECONCILE_ONLY",
      venue: opts.venue,
      mode: opts.mode,
    });
    throw error;
  }
  try {
    const at = Date.now(),
      elapsed = performance.now() - start;
    await store.saveReceipt(batch.intent.id, result, at, elapsed);
    await store.append(synchronousResult(batch, result, at, elapsed));
    telemetry.executionQuality.inc({ result: "captured" });
    await audit("EXECUTION_QUALITY", "INFO", {
      stage: "submit",
      code: "CAPTURED",
      venue: opts.venue,
      mode: opts.mode,
    });
  } catch {
    telemetry.executionQuality.inc({ result: "persist_failed" });
    await audit("EXECUTION_QUALITY", "CRITICAL", {
      stage: "submit",
      code: "RESULT_UNRECORDED_RECONCILE_ONLY",
      venue: opts.venue,
      mode: opts.mode,
    });
    throw new QualityError("RESULT_UNRECORDED_RECONCILE_ONLY");
  }
  return result;
}
