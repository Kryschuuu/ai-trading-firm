/** Insert a complete new capture inside the existing position/run transaction.
 * Failure rolls back BOTH business ledger and quality evidence. No external IO. */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { executionQualityEvents, executionQualityIntents } from "../db/schema";
import {
  digest,
  eventKey,
  parseBatch,
  uniqueEvents,
  validateLifecycle,
} from "./model";
export type QualityTransaction = Pick<
  NodePgDatabase<Record<string, never>>,
  "insert"
>;
export async function insertQualityBatch(
  tx: QualityTransaction,
  raw: unknown,
): Promise<void> {
  const b = parseBatch(raw),
    i = b.intent;
  validateLifecycle(i, b.events);
  await tx
    .insert(executionQualityIntents)
    .values({
      id: i.id,
      venue: i.venue,
      mode: i.mode,
      scope: i.scope,
      clientOrderId: i.clientOrderId,
      submitAt: new Date(i.submitAt),
      payload: i,
    });
  const rows = uniqueEvents(b.events).map((e) => ({
    id: eventKey(e),
    intentId: i.id,
    externalKey:
      e.kind === "benchmark"
        ? eventKey(e)
        : digest([
            i.venue,
            i.mode,
            i.scope,
            e.orderId,
            e.kind,
            e.kind === "fill" ? e.fillId : "ack",
          ]),
    kind: e.kind,
    availableAt: new Date(e.availableAt),
    payload: e,
  }));
  if (rows.length) await tx.insert(executionQualityEvents).values(rows);
}
