/**
 * Control-Plane-Audit (Task 08) — Regel 4: JEDES Ereignis
 * (Credential gespeichert/geloescht/geaendert, Verbindungstest,
 * Permission-Probe, Zustandswechsel) landet im Audit-Log —
 * OHNE Secrets, ohne Klartext, ohne Envelope-Inhalte.
 *
 * Zweistufige Senke (Muster von src/brokers/audit.ts):
 *   1. In-Memory-Ring (200 Eintraege) — immer verfuegbar, deterministisch
 *      testbar, ueberlebt DB-Ausfall.
 *   2. `audit_log` (Event `BROKER_CONTROL_PLANE`) — best-effort; ein
 *      DB-Ausfall bricht den Control-Plane-Pfad NIE ab (Fail-Safe).
 *
 * actor: es existiert noch kein Session-/Rollensystem → konstant "admin"
 * (minimaler Admin-Guard, siehe src/brokers/control-plane/guard.ts).
 * TODO(task-10): echte Actor-ID/Rolle aus dem zentralen RBAC-System.
 */
export type ControlPlaneAction =
  | "credential.saved"
  | "credential.changed"
  | "credential.deleted"
  | "connection.test"
  | "connection.discover"
  | "permission.probe"
  | "state.transition"
  | "action.denied";

export interface ControlPlaneAuditEntry {
  actor: string;
  venue: string;
  action: ControlPlaneAction;
  result: "OK" | "DENIED" | "ERROR";
  /** Maschinenlesbarer Code (z. B. PROBE_FAILED), niemals Secret-Inhalt. */
  errorCode?: string | null;
  /** Zusatzkontext, der KEINE Secrets enthalten darf (z. B. Layer-Name). */
  meta?: Record<string, string | number | boolean | null>;
  at: string;
}

const RING_MAX = 200;

const G = globalThis as typeof globalThis & {
  __controlPlaneAudit?: ControlPlaneAuditEntry[];
};

export const controlPlaneAuditRing: ControlPlaneAuditEntry[] = (
  G.__controlPlaneAudit ??= []
) as ControlPlaneAuditEntry[];

/** Protokolliert ein Control-Plane-Ereignis. Wirft niemals. */
export async function recordControlPlaneEvent(
  entry: Omit<ControlPlaneAuditEntry, "at">
): Promise<void> {
  const full: ControlPlaneAuditEntry = {
    actor: entry.actor || "admin",
    venue: entry.venue,
    action: entry.action,
    result: entry.result,
    errorCode: entry.errorCode ?? null,
    meta: entry.meta,
    at: new Date().toISOString(),
  };
  controlPlaneAuditRing.push(full);
  if (controlPlaneAuditRing.length > RING_MAX) {
    controlPlaneAuditRing.splice(0, controlPlaneAuditRing.length - RING_MAX);
  }
  try {
    const { db } = await import("@/db");
    const { auditLog } = await import("@/db/schema");
    await db.insert(auditLog).values({
      event: "BROKER_CONTROL_PLANE",
      level: full.result === "OK" ? "INFO" : "WARN",
      detail: {
        actor: full.actor,
        venue: full.venue,
        action: full.action,
        result: full.result,
        errorCode: full.errorCode,
        meta: full.meta ?? null,
      },
    });
  } catch {
    /* DB nicht bereit: Ring bleibt die Wahrheit; kein Rethrow. */
  }
}

/** Letzte N Eintraege (neueste zuerst) — fuer Tests/Health-Views. */
export function readControlPlaneAudit(limit = 50): ControlPlaneAuditEntry[] {
  return [...controlPlaneAuditRing].slice(-limit).reverse();
}

/** Nur Tests: Ring leeren. */
export function clearControlPlaneAuditForTests(): void {
  controlPlaneAuditRing.length = 0;
}
