/**
 * Audit privater Alpaca-API-Calls (Task 12, Regel 5).
 *
 * Jeder private Call → Ring + best-effort `audit_log`.
 * Payload enthält KEINE Secrets, keinen Body, keine volle Query.
 */
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
};

export const alpacaPrivateAuditRing: AlpacaPrivateAuditEntry[] = (G.__alpacaPrivateAudit ??=
  []) as AlpacaPrivateAuditEntry[];

export async function recordAlpacaPrivateCall(
  entry: Omit<AlpacaPrivateAuditEntry, "at">
): Promise<void> {
  const full: AlpacaPrivateAuditEntry = { ...entry, at: new Date().toISOString() };
  alpacaPrivateAuditRing.push(full);
  if (alpacaPrivateAuditRing.length > RING_MAX) {
    alpacaPrivateAuditRing.splice(0, alpacaPrivateAuditRing.length - RING_MAX);
  }
  try {
    const { db } = await import("@/db");
    const { auditLog } = await import("@/db/schema");
    await db.insert(auditLog).values({
      event: "ALPACA_PRIVATE_CALL",
      level: full.outcome === "OK" ? "INFO" : "WARN",
      detail: {
        method: full.method,
        path: full.path,
        outcome: full.outcome,
        errorCode: full.errorCode,
      },
    });
  } catch {
    /* best-effort */
  }
}

export function readAlpacaPrivateAudit(limit = 50): AlpacaPrivateAuditEntry[] {
  return [...alpacaPrivateAuditRing].slice(-limit).reverse();
}

export function clearAlpacaPrivateAuditForTests(): void {
  alpacaPrivateAuditRing.length = 0;
}
