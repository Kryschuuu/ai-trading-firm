/**
 * Control-Plane-Audit (Task 08) — Regel 4: JEDES Ereignis
 * (Credential gespeichert/geloescht/geaendert, Verbindungstest,
 * Permission-Probe, Zustandswechsel) landet im Audit-Log —
 * OHNE Secrets, ohne Klartext, ohne Envelope-Inhalte.
 *
 * Zweistufige Senke (Muster von src/brokers/audit.ts):
 *   1. In-Memory-Ring (200 Eintraege) — immer verfuegbar, deterministisch
 *      testbar, ueberlebt DB-Ausfall.
 *   2. `audit_log` (Event `BROKER_CONTROL_PLANE`) — **Sicherheitsklasse**
 *      (S1, v1.36.18): Retry mit Backoff, persistenter Spool-Fallback
 *      (at-least-once), CRITICAL-Meldung + Zähler statt stiller Senke.
 *      Ein DB-Ausfall bricht den Control-Plane-Pfad weiterhin NIE ab —
 *      Credential-Operationen sind dann aber belegt, nicht verlustig.
 *
 * actor: Audit-ID aus dem RBAC-Kern (`src/auth`, Task 10) —
 * local-open und Admin-Token → "admin", Operator → "operator",
 * Viewer → "viewer". Niemals Token-Werte.
 */
import { writeAuditRecord, type AuditWriteOutcome } from "@/lib/auditSink";

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
  __controlPlaneAuditDegraded?: number;
};

export const controlPlaneAuditRing: ControlPlaneAuditEntry[] = (
  G.__controlPlaneAudit ??= []
) as ControlPlaneAuditEntry[];

/**
 * Protokolliert ein Control-Plane-Ereignis. Wirft nur, wenn `failClosed`
 * gesetzt ist und weder DB noch Spool durable waren (S1) — dann bleibt die
 * zugehörige Mutation aus. Andernfalls wird das Durable-Ergebnis geliefert,
 * damit Aufrufer eine gemeldete Audit-Lücke auswerten können.
 */
export async function recordControlPlaneEvent(
  entry: Omit<ControlPlaneAuditEntry, "at">,
  opts: { failClosed?: boolean } = {}
): Promise<AuditWriteOutcome> {
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
  const outcome = await writeAuditRecord({
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
    // Credential-Ops, Zustandswechsel und Ablehnungen sind sicherheitsrelevant:
    // Klasse `security` (Retry + Spool + Alarm), kein stilles catch.
    // `failClosed` nutzen Aufrufer, die HIER noch nichts geändert haben (z. B.
    // vor store.put): ohne durablen Beleg bleibt die Mutation aus.
    auditClass: "security",
    failClosed: opts.failClosed,
  });
  if (!outcome.durable || outcome.degraded) {
    G.__controlPlaneAuditDegraded = (G.__controlPlaneAuditDegraded ?? 0) + 1;
  }
  return outcome;
}

/**
 * S1: Control-Plane-Audits, die nicht sofort durable in `audit_log` waren.
 * Nonzero heisst: Spool-Nachzug offen oder (bei unbeschreibbarem Spool) eine
 * gemeldete Lücke — beides löst CRITICAL-Zeilen im Journal aus.
 */
export function readControlPlaneAuditDegradedCount(): number {
  return G.__controlPlaneAuditDegraded ?? 0;
}

/** Letzte N Eintraege (neueste zuerst) — fuer Tests/Health-Views. */
export function readControlPlaneAudit(limit = 50): ControlPlaneAuditEntry[] {
  return [...controlPlaneAuditRing].slice(-limit).reverse();
}

/** Nur Tests: Ring und Zähler leeren. */
export function clearControlPlaneAuditForTests(): void {
  controlPlaneAuditRing.length = 0;
  G.__controlPlaneAuditDegraded = 0;
}
