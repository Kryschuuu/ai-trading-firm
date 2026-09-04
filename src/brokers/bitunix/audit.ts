/**
 * Audit privater Bitunix-API-Calls (Task 07, Regel 5) und von
 * Positions-Anomalien (B2).
 *
 * Jeder private Call → Ring + `audit_log`. Der Auditpfad ist **Sicherheitsklasse**
 * (S1, v1.36.18): kein stilles `/* best-effort *\/` mehr, sondern
 *   1. Retry mit Backoff gegen `audit_log`,
 *   2. persistenter Fallback (Spool, at-least-once) wenn die DB nicht reachable ist,
 *   3. CRITICAL-Meldung + Prozess-Metrik, wenn keines von beidem durable war.
 *
 * Warum nicht fail-closed? Der Audit-Schreibvorgang passiert NACH dem Venue-Call.
 * Ein Wurf würde die Order an der Venue nicht ungeschehen machen, sondern nur den
 * lokalen Read-Pfad abbrechen — die Venue-Antwort wäre verloren. Durable ist der
 * Beleg trotzdem (Spool + Nachzug), und die Lücke ist gemeldet statt verschluckt.
 *
 * Payload enthält KEINE Secrets, keinen Body, keine volle Query.
 * Zusätzlich: verworfene Positionszeilen (B2) → Ring + Zähler (in-Prozess).
 */
import {
  auditDurabilitySnapshot,
  writeAuditRecord,
  type AuditWriteOutcome,
} from "@/lib/auditSink";

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
  __bitunixPositionAnomalies?: BitunixPositionAnomalyEntry[];
  __bitunixPositionAnomalyCount?: number;
  /** S1: wie viele Venue-Audits nicht direkt in `audit_log` landen konnten. */
  __bitunixAuditDegraded?: number;
};

export const bitunixPrivateAuditRing: BitunixPrivateAuditEntry[] = (G.__bitunixPrivateAudit ??=
  []) as BitunixPrivateAuditEntry[];

export async function recordBitunixPrivateCall(
  entry: Omit<BitunixPrivateAuditEntry, "at">
): Promise<AuditWriteOutcome> {
  const full: BitunixPrivateAuditEntry = { ...entry, at: new Date().toISOString() };
  bitunixPrivateAuditRing.push(full);
  if (bitunixPrivateAuditRing.length > RING_MAX) {
    bitunixPrivateAuditRing.splice(0, bitunixPrivateAuditRing.length - RING_MAX);
  }
  const outcome = await writeAuditRecord({
    event: "BITUNIX_PRIVATE_CALL",
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
    G.__bitunixAuditDegraded = (G.__bitunixAuditDegraded ?? 0) + 1;
  }
  return outcome;
}

export function readBitunixPrivateAudit(limit = 50): BitunixPrivateAuditEntry[] {
  return [...bitunixPrivateAuditRing].slice(-limit).reverse();
}

/**
 * S1: Anzahl der Venue-Audits, die nicht sofort durable in `audit_log` waren
 * (Spool-Nachzug oder Verlust). Prozesslokal, zusammen mit dem globalen
 * Snapshot aus `auditDurabilitySnapshot()` lesbar.
 */
export function readBitunixAuditDegradedCount(): number {
  return G.__bitunixAuditDegraded ?? 0;
}

/** Diagnose für Health/Ops: eigene Zähler + gemeinsamer Senken-Snapshot. */
export function readBitunixAuditDurability() {
  return {
    degraded: readBitunixAuditDegradedCount(),
    ringSize: bitunixPrivateAuditRing.length,
    durability: auditDurabilitySnapshot(),
  };
}

export function clearBitunixPrivateAuditForTests(): void {
  bitunixPrivateAuditRing.length = 0;
  G.__bitunixAuditDegraded = 0;
}

/**
 * B2 — verworfene Venue-Positionen (unbekannte/leere Richtung).
 *
 * `getPositions()` darf eine Position ohne verwertbare `side` **nicht** als LONG
 * interpretieren: das würde eine Short-Position im lokalen View als Long
 * erscheinen lassen (uPnL-Vorzeichen, Risk-Denominator, Geometrie — alles
 * falsch). Solche Zeilen werden verworfen und hier sichtbar gemacht, statt
 * maskiert. Der Ring ist bewusst klein und secret-frei (nur Symbol + Rohwert).
 */
export interface BitunixPositionAnomalyEntry {
  /** Venue-Symbol der betroffenen Zeile ("" wenn die Zeile keines trägt). */
  symbol: string;
  /** Rohe `side` (getrimmt/gekurzt) — unverändert, damit der Grund erkennbar bleibt. */
  rawSide: string;
  /** Verwerfungsgrund (erweiterbar; B2 kennt bisher nur die unbekannte Seite). */
  reason: "UNKNOWN_SIDE";
  at: string;
}

const POSITION_ANOMALY_RING_MAX = 50;

/** Rohwert im Audit auf 16 Zeichen kürzen (nie unlimitierte Venue-Antwort übernehmen). */
const ANOMALY_SIDE_MAX = 16;

export function recordBitunixPositionAnomaly(
  entry: Omit<BitunixPositionAnomalyEntry, "at">
): BitunixPositionAnomalyEntry {
  const full: BitunixPositionAnomalyEntry = {
    symbol: entry.symbol,
    rawSide: entry.rawSide.slice(0, ANOMALY_SIDE_MAX),
    reason: entry.reason,
    at: new Date().toISOString(),
  };
  G.__bitunixPositionAnomalyCount = (G.__bitunixPositionAnomalyCount ?? 0) + 1;
  const ring = (G.__bitunixPositionAnomalies ??= []) as BitunixPositionAnomalyEntry[];
  ring.push(full);
  if (ring.length > POSITION_ANOMALY_RING_MAX) {
    ring.splice(0, ring.length - POSITION_ANOMALY_RING_MAX);
  }
  return full;
}

/** kumulierte Anzahl verworfener Positionszeilen (seit Prozessstart / letztem Reset). */
export function readBitunixPositionAnomalyCount(): number {
  return G.__bitunixPositionAnomalyCount ?? 0;
}

/** die letzten Anomalien, neueste zuerst. */
export function readBitunixPositionAnomalies(limit = 20): BitunixPositionAnomalyEntry[] {
  return [...(G.__bitunixPositionAnomalies ?? [])].slice(-limit).reverse();
}

export function clearBitunixPositionAnomaliesForTests(): void {
  G.__bitunixPositionAnomalies = [];
  G.__bitunixPositionAnomalyCount = 0;
}
