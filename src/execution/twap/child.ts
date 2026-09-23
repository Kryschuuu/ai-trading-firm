/**
 * Brücke vom TWAP-Scheduler zum Execution-Policy-Controller (P4.2).
 *
 * Kinder werden nicht an einem zweiten Order-Pfad gesendet. `start` ist über
 * den Workflow-Key idempotent; ein Restart mit derselben eingefrorenen Menge
 * und demselben Seed legt keine zweite Order an. `cancel` nutzt `cancelOpen`
 * und damit keinen Market-Fallback, solange die Kinder-Policy ihn verbietet.
 */
import type { ExternalCancelReason, ExecutionPolicyController } from "../controller";
import type { ExecutionPolicy } from "../policy";
import type { WorkflowFillRecord } from "../store";
import type { BrokerVenueId, ExecutionMode } from "../../contracts/broker";

export interface ChildFill {
  fillId: string;
  qty: number;
  price: number;
  feeQuote: number | null;
  eventTime: number;
  availableAt: number;
}

export interface ChildView {
  workflowId: string;
  workflowKey: string;
  state: string;
  filledQty: number;
  reason: string | null;
  fills: ChildFill[];
}

export interface ChildStartInput {
  venue: BrokerVenueId;
  mode: ExecutionMode;
  symbol: string;
  side: "LONG" | "SHORT";
  qty: number;
  limitPrice: number;
  seed: string;
  policy: ExecutionPolicy;
  hasStopLoss: boolean;
}

export interface ChildExecutor {
  start(input: ChildStartInput): Promise<ChildView>;
  poll(workflowId: string): Promise<ChildView>;
  cancel(workflowId: string, reason: ExternalCancelReason): Promise<ChildView>;
  fills(workflowId: string): Promise<ChildFill[]>;
}

function toFills(rows: readonly WorkflowFillRecord[]): ChildFill[] {
  return rows.map((f) => ({
    fillId: f.fillId,
    qty: f.qty,
    price: f.price,
    feeQuote: f.feeQuote,
    eventTime: f.eventTime,
    availableAt: f.availableAt,
  }));
}

export function controllerChildExecutor(
  controller: ExecutionPolicyController,
  listFills: (workflowId: string) => Promise<WorkflowFillRecord[]>,
): ChildExecutor {
  async function viewOf(workflowId: string, record: { id: string; workflowKey: string; state: string; filledQty: number; reason: string | null }): Promise<ChildView> {
    return {
      workflowId: record.id,
      workflowKey: record.workflowKey,
      state: record.state,
      filledQty: record.filledQty,
      reason: record.reason,
      fills: toFills(await listFills(workflowId)),
    };
  }
  return {
    async start(input) {
      const record = await controller.start({
        venue: input.venue,
        mode: input.mode,
        symbol: input.symbol,
        side: input.side,
        targetQty: input.qty,
        policy: input.policy,
        seed: input.seed,
        limitPrice: input.limitPrice,
        hasStopLoss: input.hasStopLoss,
      });
      return viewOf(record.id, record);
    },
    async poll(workflowId) {
      let record = await controller.poll(workflowId);
      if (record.state === "CANCELLED") record = await controller.poll(workflowId);
      return viewOf(workflowId, record);
    },
    async cancel(workflowId, reason) {
      const record = await controller.cancelOpen(workflowId, reason);
      return viewOf(workflowId, record);
    },
    fills(workflowId) {
      return listFills(workflowId).then(toFills);
    },
  };
}
