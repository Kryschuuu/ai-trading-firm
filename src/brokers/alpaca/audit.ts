/**
 * Audit privater Alpaca-API-Calls (Task 12, Regel 5).
 *
 * Jeder private Call → Ring + `audit_log`. Der Auditpfad ist **Sicherheitsklasse**
 * (S1, v1.36.18): Retry mit Backoff, persistenter Spool-Fallback (at-least-once)
 * und CRITICAL-Meldung + Zähler, statt des bisherigen stillen
 * `/* best-effort *\/`-Schluckens.
 *
 * Kein fail-closed: der Call liegt hinter uns — eine abgesetzte Venue-Order
 * verschwindet nicht, wenn der lokale Beleg fehlschlägt. Belegt wird sie über
 * den Spool trotzdem.
 *
 * Payload enthält KEINE Secrets, keinen Body, keine volle Query.
 */
import { writeAuditRecord, type AuditWriteOutcome } from "@/lib/auditSink";

export interface AlpacaPrivateAuditEntry {
  method: string;
  path: string;
  outcome: "OK" | "DENIED" | "ERROR";
  errorCode: string | null;
  at: string;
}

const RING_MAX = 200;

const G = globalThis as typeof globalThis & {
  __alpacaPrivateAudit?: AlpacaPrivateAuditEntry[];
  /** S1: Venue-Audits, die nicht sofort durable waren (Spool oder Verlust). */
  __alpacaAuditDegraded?: number;
};

export const alpacaPrivateAuditRing: AlpacaPrivateAuditEntry[] = (G.__alpacaPrivateAudit ??=
  []) as AlpacaPrivateAuditEntry[];

export async function recordAlpacaPrivateCall(
  entry: Omit<AlpacaPrivateAuditEntry, "at">
): Promise<AuditWriteOutcome> {
  const full: AlpacaPrivateAuditEntry = { ...entry, at: new Date().toISOString() };
  alpacaPrivateAuditRing.push(full);
  if (alpacaPrivateAuditRing.length > RING_MAX) {
    alpacaPrivateAuditRing.splice(0, alpacaPrivateAuditRing.length - RING_MAX);
  }
  const outcome = await writeAuditRecord({
    event: "ALPACA_PRIVATE_CALL",
    level: full.outcome === "OK" ? "INFO" : "WARN",
    detail: {
      method: full.method,
      path: full.path,
      outcome: full.outcome,
      errorCode: full.errorCode,
    },
    auditClass: "security",
  });
  if (!outcome.durable || outcome.degraded) {
    G.__alpacaAuditDegraded = (G.__alpacaAuditDegraded ?? 0) + 1;
  }
  return outcome;
}

/** S1: Anzahl nicht sofort durabler Venue-Audits (Prozess-Metrik). */
export function readAlpacaAuditDegradedCount(): number {
  return G.__alpacaAuditDegraded ?? 0;
}

export function readAlpacaAuditDurability(): { degraded: number; ringSize: number } {
  return { degraded: readAlpacaAuditDegradedCount(), ringSize: alpacaPrivateAuditRing.length };
}

export function readAlpacaPrivateAudit(limit = 50): AlpacaPrivateAuditEntry[] {
  return [...alpacaPrivateAuditRing].slice(-limit).reverse();
}

export function clearAlpacaPrivateAuditForTests(): void {
  alpacaPrivateAuditRing.length = 0;
  G.__alpacaAuditDegraded = 0;
}
