/**
 * Audit privater Bitunix-API-Calls (Task 07, Regel 5) und von
 * Positions-Anomalien (B2).
 *
 * Jeder private Call → Ring + best-effort `audit_log`.
 * Payload enthält KEINE Secrets, keinen Body, keine volle Query.
 * Zusätzlich: verworfene Positionszeilen (B2) → Ring + Zähler (in-Prozess).
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
  __bitunixPositionAnomalies?: BitunixPositionAnomalyEntry[];
  __bitunixPositionAnomalyCount?: number;
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
