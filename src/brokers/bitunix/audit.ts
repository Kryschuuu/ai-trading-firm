/**
 * Audit privater Bitunix-API-Calls (Task 07, Regel 5).
 *
 * Jeder private Call → Ring + best-effort `audit_log`.
 * Payload enthält KEINE Secrets, keinen Body, keine volle Query.
 */
export interface BitunixPrivateAuditEntry {
  method: string;
  path: string;
  outcome: "OK" | "DENIED" | "ERROR";
  errorCode: string | null;
  at: string;
}

const RING_MAX = 200;

const G = globalThis as typeof globalThis & {
  __bitunixPrivateAudit?: BitunixPrivateAuditEntry[];
};

export const bitunixPrivateAuditRing: BitunixPrivateAuditEntry[] = (G.__bitunixPrivateAudit ??=
  []) as BitunixPrivateAuditEntry[];

export async function recordBitunixPrivateCall(
  entry: Omit<BitunixPrivateAuditEntry, "at">
): Promise<void> {
  const full: BitunixPrivateAuditEntry = { ...entry, at: new Date().toISOString() };
  bitunixPrivateAuditRing.push(full);
  if (bitunixPrivateAuditRing.length > RING_MAX) {
    bitunixPrivateAuditRing.splice(0, bitunixPrivateAuditRing.length - RING_MAX);
  }
  try {
    const { db } = await import("@/db");
    const { auditLog } = await import("@/db/schema");
    await db.insert(auditLog).values({
      event: "BITUNIX_PRIVATE_CALL",
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

export function readBitunixPrivateAudit(limit = 50): BitunixPrivateAuditEntry[] {
  return [...bitunixPrivateAuditRing].slice(-limit).reverse();
}

export function clearBitunixPrivateAuditForTests(): void {
  bitunixPrivateAuditRing.length = 0;
}
