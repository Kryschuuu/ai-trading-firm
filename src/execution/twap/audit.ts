/**
 * Audit und Metriken des TWAP-Schedulers (RMA-P4-03).
 *
 * Labels sind ausschließlich Code-Konstanten (`outcome`, `reason`). Keine
 * Parent-Keys, Slice-Indizes oder Instrumente — die stehen im Event-Detail.
 */
import { auditWrite } from "../../lib/auditSink";
import { metricLabel, telemetry } from "../../lib/telemetry";

export async function auditTwap(detail: {
  parentKey: string;
  kind: string;
  reason: string;
  fromStatus: string | null;
  toStatus: string | null;
  policyVersion: string;
}): Promise<void> {
  const level = detail.toStatus === "FAILED" ? "WARN" : "INFO";
  try {
    await auditWrite(
      "TWAP_EXECUTION",
      level,
      {
        parentKey: detail.parentKey,
        kind: detail.kind,
        reason: detail.reason,
        from: detail.fromStatus,
        to: detail.toStatus,
        policyVersion: detail.policyVersion,
      },
      { auditClass: "security" },
    );
  } catch {
    // auditSink zählt den Fehlschlag bereits. Der Scheduler bleibt deterministisch.
  }
  try {
    telemetry.twap.events.inc({
      kind: metricLabel(detail.kind),
      reason: metricLabel(detail.reason),
    });
  } catch {
    // Metrik darf den Tick nicht werfen.
  }
}

export function countTwapTick(outcome: string, reason: string): void {
  try {
    telemetry.twap.ticks.inc({ outcome: metricLabel(outcome), reason: metricLabel(reason) });
  } catch {
    // Metrik darf den Tick nicht werfen.
  }
}
