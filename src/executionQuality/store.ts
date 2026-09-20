/** PostgreSQL is the source of truth. One intent lock serializes concurrent fills;
 * a unique venue/mode/account/order/fill key additionally prevents cross-intent
 * duplication. No trading side effects, no retry of external order submission. */
import type { Pool } from "pg";
import { pool } from "../db";
import { aggregate, canonical, digest, eventKey, parseBatch, QualityError, uniqueEvents, validateLifecycle, type Batch, type Intent, type QualityEvent } from "./model";

export function reportRange(from: number, to: number, asOf: number) {
  if (![from,to,asOf].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 8_640_000_000_000_000) || to <= from || to-from > 31*86400000 || asOf < to) throw new QualityError("INVALID_REPORT_RANGE");
}
export class ExecutionQualityStore {
  constructor(private readonly connection: Pool = pool) {}
  async append(input: unknown): Promise<{ inserted: number }> {
    const batch = parseBatch(input), i = batch.intent;
    const client = await this.connection.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout = '10s'");
      await client.query(`INSERT INTO execution_quality_intents (id,venue,mode,scope,client_order_id,submit_at,payload)
        VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`, [i.id,i.venue,i.mode,i.scope,i.clientOrderId,new Date(i.submitAt),i]);
      const stored = await client.query<{ payload: Intent }>("SELECT payload FROM execution_quality_intents WHERE id=$1 FOR UPDATE", [i.id]);
      if (canonical(stored.rows[0]?.payload) !== canonical(i)) throw new QualityError("INTENT_CONFLICT");
      const previous = await client.query<{ payload: QualityEvent }>("SELECT payload FROM execution_quality_events WHERE intent_id=$1 ORDER BY id LIMIT 10001", [i.id]);
      const events = uniqueEvents([...previous.rows.map(r => r.payload), ...batch.events]);
      if (events.length > 10000) throw new QualityError("EVENT_LIMIT");
      // Validate the entire history, not just this retry's delta.
      for (let offset = 0; offset < events.length; offset += 1000) parseBatch({ intent: i, events: events.slice(offset,offset+1000) });
      validateLifecycle(i, events);
      let inserted = 0;
      for (const e of uniqueEvents(batch.events)) {
        const external = e.kind === "benchmark" ? eventKey(e) : digest([i.venue,i.mode,i.scope,e.orderId,e.kind,e.kind === "fill" ? e.fillId : "ack"]);
        const result = await client.query(`INSERT INTO execution_quality_events (id,intent_id,external_key,kind,available_at,payload)
          VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`, [eventKey(e),i.id,external,e.kind,new Date(e.availableAt),e]);
        inserted += result.rowCount ?? 0;
      }
      await client.query("COMMIT");
      return { inserted };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }
  /** One repeatable snapshot; never report a silently truncated population. */
  async report(from: number, to: number, asOf: number) {
    reportRange(from,to,asOf);
    const client = await this.connection.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query("SET LOCAL statement_timeout = '10s'");
      const intents = await client.query<{ payload: Intent }>("SELECT payload FROM execution_quality_intents WHERE submit_at >= $1 AND submit_at < $2 ORDER BY submit_at,id LIMIT 501", [new Date(from),new Date(to)]);
      if (intents.rows.length > 500) throw new QualityError("REPORT_LIMIT");
      const ids = intents.rows.map(r => r.payload.id);
      const events = await client.query<{ payload: QualityEvent }>("SELECT payload FROM execution_quality_events WHERE intent_id = ANY($1::text[]) AND available_at <= $2 ORDER BY id LIMIT 10001", [ids,new Date(asOf)]);
      if (events.rows.length > 10000) throw new QualityError("REPORT_LIMIT");
      const batches: Batch[] = intents.rows.map(r => ({ intent: r.payload, events: events.rows.filter(e => e.payload.intentId === r.payload.id).map(e => e.payload) }));
      const groups = aggregate(batches,asOf);
      await client.query("COMMIT");
      return { schemaVersion: 1, from, to, asOf, orderCount: batches.length, groups };
    } catch (error) {
      await client.query("ROLLBACK"); throw error;
    } finally { client.release(); }
  }
}
