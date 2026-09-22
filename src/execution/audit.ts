/**
 * Audit-/Metrik-Hilfen des Execution-Policy-Controllers (RMA-P4-02).
 *
 * Audit: jeder Zustandswechsel wird als strukturiertes `audit_log`-Event
 * (`EXECUTION_POLICY_TRANSITION`) mit Reason und Policyversion geschrieben —
 * Order-/Client-IDs stehen im Detail (kein Secret), NIEMALS als Metrik-Label.
 *
 * Metriken (bounded Labels — Venue, Zustände, geschlossene Reason-Codes):
 *   execution_policy_transitions_total{from,to,reason}
 *   execution_policy_rejects_total{venue,code}
 *   execution_policy_fallback_total{venue,outcome}
 *   execution_policy_overfill_total{venue}  (sollte immer 0 bleiben)
 */
import { auditWrite } from "../lib/auditSink";
import { metricLabel, telemetry } from "../lib/telemetry";
import type { ExecutionWorkflowState } from "./stateMachine";

export type ExecutionAuditWriter = (
  event: string,
  level: "INFO" | "WARN" | "CRITICAL",
  detail: Record<string, unknown>,
  opts?: { auditClass?: "security" | "telemetry"; agentId?: string; missionId?: string }
) => Promise<unknown>;

export interface TransitionAudit {
  workflowKey: string;
  venue: string;
  mode: string;
  from: ExecutionWorkflowState | null;
  to: ExecutionWorkflowState;
  reason: string;
  policyVersion: string;
  attempt: number;
  orderId: string | null;
  clientOrderId: string | null;
  filledQty: number;
  targetQty: number;
}

export async function auditTransition(
  t: TransitionAudit,
  write: ExecutionAuditWriter = auditWrite
): Promise<void> {
  const level = t.to === "FAILED" ? "WARN" : "INFO";
  try {
    await write(
      "EXECUTION_POLICY_TRANSITION",
      level,
      {
        workflowKey: t.workflowKey,
        venue: t.venue,
        mode: t.mode,
        from: t.from,
        to: t.to,
        reason: t.reason,
        policyVersion: t.policyVersion,
        attempt: t.attempt,
        orderId: t.orderId,
        clientOrderId: t.clientOrderId,
        filledQty: t.filledQty,
        targetQty: t.targetQty,
      },
      { auditClass: "security" }
    );
  } catch {
    // Audit-Fehler sind über auditSink bereits gezählt/alarmiert; der
    // Controller-Pfad bleibt deterministisch (kein Wurf aus der Beobachtung).
  }
  telemetry.executionPolicy.transitions.inc({
    from: metricLabel(t.from ?? "NONE"),
    to: metricLabel(t.to),
    reason: metricLabel(t.reason),
  });
}

export function countReject(venue: string, code: string): void {
  telemetry.executionPolicy.rejects.inc({ venue: metricLabel(venue), code: metricLabel(code) });
}

export function countFallback(venue: string, outcome: "SUBMITTED" | "BLOCKED" | "FILLED" | "FAILED"): void {
  telemetry.executionPolicy.fallbacks.inc({ venue: metricLabel(venue), outcome });
}

export function countOverfill(venue: string): void {
  telemetry.executionPolicy.overfills.inc({ venue: metricLabel(venue) });
}
