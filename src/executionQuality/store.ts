/** PostgreSQL is the source of truth. One intent lock serializes concurrent fills;
 * a unique venue/mode/account/order/fill key additionally prevents cross-intent
 * duplication. No trading side effects, no retry of external order submission. */
import type {
  BrokerOrderResult,
  BrokerVenueId,
  ExecutionMode,
} from "../contracts/broker";
import type { Pool } from "pg";
import { pool } from "../db";
import {
  aggregate,
  canonical,
  digest,
  eventKey,
  parseBatch,
  QualityError,
  uniqueEvents,
  validateLifecycle,
  type Batch,
  type Intent,
  type QualityEvent,
} from "./model";

export function reportRange(from: number, to: number, asOf: number) {
  if (
    ![from, to, asOf].every(
      (n) => Number.isSafeInteger(n) && n >= 0 && n <= 8_640_000_000_000_000,
    ) ||
    to <= from ||
    to - from > 31 * 86400000 ||
    asOf < to
  )
    throw new QualityError("INVALID_REPORT_RANGE");
}
export class ExecutionQualityStore {
  constructor(private readonly connection: Pool = pool) {}
  async append(input: unknown): Promise<{ inserted: number }> {
    const batch = parseBatch(input),
      i = batch.intent;
    const client = await this.connection.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout = '10s'");
      await client.query(
        `INSERT INTO execution_quality_intents (id,venue,mode,scope,client_order_id,submit_at,payload)
        VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
        [
          i.id,
          i.venue,
          i.mode,
          i.scope,
          i.clientOrderId,
          new Date(i.submitAt),
          i,
        ],
      );
      const stored = await client.query<{ payload: Intent }>(
        "SELECT payload FROM execution_quality_intents WHERE id=$1 FOR UPDATE",
        [i.id],
      );
      if (canonical(stored.rows[0]?.payload) !== canonical(i))
        throw new QualityError("INTENT_CONFLICT");
      const previous = await client.query<{ payload: QualityEvent }>(
        "SELECT payload FROM execution_quality_events WHERE intent_id=$1 ORDER BY id LIMIT 10001",
        [i.id],
      );
      const events = uniqueEvents([
        ...previous.rows.map((r) => r.payload),
        ...batch.events,
      ]);
      if (events.length > 10000) throw new QualityError("EVENT_LIMIT");
      // Validate the entire history, not just this retry's delta.
      for (let offset = 0; offset < events.length; offset += 1000)
        parseBatch({ intent: i, events: events.slice(offset, offset + 1000) });
      validateLifecycle(i, events);
      let inserted = 0;
      for (const e of uniqueEvents(batch.events)) {
        const external =
          e.kind === "benchmark"
            ? eventKey(e)
            : digest([
                i.venue,
                i.mode,
                i.scope,
                e.orderId,
                e.kind,
                e.kind === "fill" ? e.fillId : "ack",
              ]);
        const result = await client.query(
          `INSERT INTO execution_quality_events (id,intent_id,external_key,kind,available_at,payload)
          VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`,
          [eventKey(e), i.id, external, e.kind, new Date(e.availableAt), e],
        );
        inserted += result.rowCount ?? 0;
      }
      await client.query("COMMIT");
      return { inserted };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async load(id: string): Promise<Batch | null> {
    const i = await this.connection.query<{ payload: Intent }>(
      "SELECT payload FROM execution_quality_intents WHERE id=$1",
      [id],
    );
    if (!i.rows[0]) return null;
    const e = await this.connection.query<{ payload: QualityEvent }>(
      "SELECT payload FROM execution_quality_events WHERE intent_id=$1 ORDER BY id LIMIT 10001",
      [id],
    );
    if (e.rows.length > 10000) throw new QualityError("EVENT_LIMIT");
    return { intent: i.rows[0].payload, events: e.rows.map((r) => r.payload) };
  }
  async claim(id: string, hash: string): Promise<boolean> {
    const result = await this.connection.query(
      "INSERT INTO execution_quality_submissions(intent_id,request_hash) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING intent_id",
      [id, hash],
    );
    const existing = await this.connection.query<{ request_hash: string }>(
      "SELECT request_hash FROM execution_quality_submissions WHERE intent_id=$1",
      [id],
    );
    if (existing.rows[0]?.request_hash !== hash)
      throw new QualityError("SUBMISSION_CONFLICT");
    return result.rowCount === 1;
  }
  async hasSubmission(id: string): Promise<boolean> {
    const result = await this.connection.query(
      "SELECT 1 FROM execution_quality_submissions WHERE intent_id=$1",
      [id],
    );
    return result.rowCount === 1;
  }
  async receipt(id: string): Promise<{
    result: BrokerOrderResult;
    at: number;
    elapsed: number | null;
  } | null> {
    const result = await this.connection.query<{
      result: BrokerOrderResult;
      observed_at: Date;
      elapsed_ms: string | null;
    }>(
      "SELECT result,observed_at,elapsed_ms FROM execution_quality_receipts WHERE intent_id=$1",
      [id],
    );
    const row = result.rows[0];
    return row
      ? {
          result: row.result,
          at: row.observed_at.getTime(),
          elapsed: row.elapsed_ms === null ? null : Number(row.elapsed_ms),
        }
      : null;
  }
  async saveReceipt(
    id: string,
    result: BrokerOrderResult,
    at = Date.now(),
    elapsed: number | null = null,
  ) {
    const idOK = (v: string) => /^[A-Za-z0-9_.:/-]{1,128}$/.test(v);
    const finite = (v: number) => Number.isFinite(v) && Math.abs(v) <= 1e15;
    if (
      !idOK(result.orderId) ||
      !idOK(result.symbol) ||
      !["LONG", "SHORT"].includes(result.side) ||
      ![
        "NEW",
        "PARTIALLY_FILLED",
        "FILLED",
        "CANCELED",
        "REJECTED",
        "UNKNOWN",
      ].includes(result.status) ||
      !finite(result.qty) ||
      result.qty < 0 ||
      !finite(result.fillPrice) ||
      result.fillPrice < 0 ||
      (result.filledQty !== undefined &&
        (!finite(result.filledQty) || result.filledQty < 0)) ||
      [result.stopLoss, result.takeProfit].some(
        (v) => v !== null && (!finite(v) || v <= 0),
      ) ||
      (result.feesQuote != null && !finite(result.feesQuote)) ||
      !Number.isSafeInteger(at) ||
      at < 0 ||
      (elapsed !== null && (!finite(elapsed) || elapsed < 0))
    )
      throw new QualityError("INVALID_RECEIPT");
    // Deliberate field projection: no provider reason strings or extension payloads.
    const safe: BrokerOrderResult = {
      orderId: result.orderId,
      symbol: result.symbol,
      side: result.side,
      qty: result.qty,
      filledQty:
        result.filledQty ?? (result.status === "FILLED" ? result.qty : 0),
      fillPrice: result.fillPrice,
      status:
        result.status === "REJECTED" && result.orderId === "ERROR"
          ? "UNKNOWN"
          : result.status,
      stopLoss: result.stopLoss,
      takeProfit: result.takeProfit,
      feesQuote: result.feesQuote ?? null,
    };
    await this.connection.query(
      "INSERT INTO execution_quality_receipts(intent_id,result,observed_at,elapsed_ms) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
      [id, safe, new Date(at), elapsed],
    );
  }
  /** Bounded oldest-first operations cohort, with explicit pagination cursor. */
  async page(
    venue: BrokerVenueId,
    mode: ExecutionMode,
    scope: string,
    after: string = "",
    limit = 100,
  ): Promise<Intent[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new QualityError("REPORT_LIMIT");
    const result = await this.connection.query<{ payload: Intent }>(
      "SELECT payload FROM execution_quality_intents i WHERE venue=$1 AND mode=$2 AND scope=$3 AND id > $4 AND NOT EXISTS (SELECT 1 FROM execution_quality_completed c WHERE c.intent_id=i.id) ORDER BY id LIMIT $5",
      [venue, mode, scope, after, limit],
    );
    return result.rows.map((r) => r.payload);
  }
  async finish(id: string) {
    await this.connection.query(
      "INSERT INTO execution_quality_completed(intent_id) VALUES ($1) ON CONFLICT DO NOTHING",
      [id],
    );
  }
  async sample(
    i: Intent,
    quote: { mid: number; eventTime: number; availableAt: number },
  ) {
    if (
      !Number.isFinite(quote.mid) ||
      quote.mid <= 0 ||
      quote.mid > 1e15 ||
      !Number.isSafeInteger(quote.eventTime) ||
      !Number.isSafeInteger(quote.availableAt) ||
      quote.eventTime > quote.availableAt ||
      quote.availableAt - quote.eventTime > 5000
    )
      throw new QualityError("INVALID_QUOTE");
    const key = digest([
      i.venue,
      i.mode,
      i.scope,
      i.instrument,
      quote.mid,
      quote.eventTime,
    ]);
    await this.connection.query(
      "INSERT INTO execution_quality_quotes(id,venue,mode,scope,instrument,mid,event_at,available_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING",
      [
        key,
        i.venue,
        i.mode,
        i.scope,
        i.instrument,
        quote.mid,
        new Date(quote.eventTime),
        new Date(quote.availableAt),
      ],
    );
  }
  async quoteAsOf(
    i: Intent,
    at: number,
  ): Promise<{
    mid: number;
    eventTime: number;
    availableAt: number;
    inputHash: string;
  } | null> {
    const result = await this.connection.query<{
      id: string;
      mid: string;
      event_at: Date;
      available_at: Date;
    }>(
      "SELECT id,mid,event_at,available_at FROM execution_quality_quotes WHERE venue=$1 AND mode=$2 AND scope=$3 AND instrument=$4 AND event_at <= $5 AND event_at >= $6 AND available_at <= $5 ORDER BY event_at DESC,id LIMIT 1",
      [
        i.venue,
        i.mode,
        i.scope,
        i.instrument,
        new Date(at),
        new Date(at - 1000),
      ],
    );
    const row = result.rows[0];
    return row
      ? {
          mid: Number(row.mid),
          eventTime: row.event_at.getTime(),
          availableAt: row.available_at.getTime(),
          inputHash: row.id,
        }
      : null;
  }
  /** One repeatable snapshot; never report a silently truncated population. */
  async report(from: number, to: number, asOf: number) {
    reportRange(from, to, asOf);
    const client = await this.connection.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query("SET LOCAL statement_timeout = '10s'");
      const intents = await client.query<{ payload: Intent }>(
        "SELECT payload FROM execution_quality_intents WHERE submit_at >= $1 AND submit_at < $2 ORDER BY submit_at,id LIMIT 501",
        [new Date(from), new Date(to)],
      );
      if (intents.rows.length > 500) throw new QualityError("REPORT_LIMIT");
      const ids = intents.rows.map((r) => r.payload.id);
      const events = await client.query<{ payload: QualityEvent }>(
        "SELECT payload FROM execution_quality_events WHERE intent_id = ANY($1::text[]) AND available_at <= $2 ORDER BY id LIMIT 10001",
        [ids, new Date(asOf)],
      );
      if (events.rows.length > 10000) throw new QualityError("REPORT_LIMIT");
      const batches: Batch[] = intents.rows.map((r) => ({
        intent: r.payload,
        events: events.rows
          .filter((e) => e.payload.intentId === r.payload.id)
          .map((e) => e.payload),
      }));
      const groups = aggregate(batches, asOf);
      await client.query("COMMIT");
      return {
        schemaVersion: 1,
        from,
        to,
        asOf,
        orderCount: batches.length,
        groups,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
