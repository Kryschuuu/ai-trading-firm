/**
 * Factory-Audit (Task 02) — Regel 5: JEDER Factory-Aufruf mit
 * `mode != 'paper'` landet im Audit-Log (venue, mode, Ergebnis, timestamp).
 * Zusätzlich werden Ablehnungen unbekannter Venues auch im paper-Modus
 * protokolliert — das Audit-Log soll vollständig sein.
 *
 * Zweistufige Senke (Muster von `src/universe/audit.ts`):
 *   1. In-Memory-Ring (200 Einträge, prozesslokal) — IMMER verfügbar,
 *      deterministisch testbar, überlebt auch DB-Ausfall.
 *   2. `audit_log` (Event `BROKER_FACTORY`) — best-effort über Drizzle;
 *      ein DB-Ausfall darf den Factory-Pfad NIEMALS abbrechen (Fail-Safe).
 *
 * Leaking-Schutz: Einträge enthalten ausschließlich venue/mode/outcome/
 * capability/errorCode — keine Order-Daten, keine Kurse, keine Credentials.
 */
import type { ExecutionMode } from "../contracts/broker";

export interface BrokerFactoryAuditEntry {
  /** Venue-ID (Whitelist-Wert oder gekürztes, gevalidiertes Fremd-Input). */
  venue: string;
  mode: ExecutionMode;
  /** OK = Adapter geliefert; DENIED = Gate/Capability-Verschließung. */
  outcome: "OK" | "DENIED";
  /** Fehlende Capability bei DENIED (sonst null). */
  capability: string | null;
  /** Fehlercode bei DENIED: LIVE_TRADING_GATE | NOT_SUPPORTED_CAPABILITY | UNKNOWN_VENUE. */
  errorCode: string | null;
  /** UTC ISO-8601-Zeitstempel. */
  at: string;
}

const RING_MAX = 200;

const G = globalThis as typeof globalThis & {
  __brokerFactoryAudit?: BrokerFactoryAuditEntry[];
};

/** Prozesslokales Audit-Log (Ring-Buffer). Exportiert für Tests + Health-View. */
export const factoryAuditRing: BrokerFactoryAuditEntry[] = (
  G.__brokerFactoryAudit ??= []
) as BrokerFactoryAuditEntry[];

/**
 * Protokolliert einen Factory-Aufruf. Wird von der Factory für jeden Aufruf
 * mit `mode != 'paper'` (plus alle UNKNOWN_VENUE-Ablehnungen) aufgerufen.
 * Wirft niemals — Audit-Ausfall ist kein Grund, den Broker-Pfad zu blockieren.
 */
export async function recordBrokerFactoryCall(
  entry: Omit<BrokerFactoryAuditEntry, "at">
): Promise<void> {
  const full: BrokerFactoryAuditEntry = { ...entry, at: new Date().toISOString() };
  factoryAuditRing.push(full);
  if (factoryAuditRing.length > RING_MAX) {
    factoryAuditRing.splice(0, factoryAuditRing.length - RING_MAX);
  }
  try {
    // Dynamischer Import: Tests ohne DB-Infrastruktur bleiben lauffähig.
    const { db } = await import("@/db");
    const { auditLog } = await import("@/db/schema");
    await db.insert(auditLog).values({
      event: "BROKER_FACTORY",
      level: full.outcome === "OK" ? "INFO" : "WARN",
      detail: {
        venue: full.venue,
        mode: full.mode,
        outcome: full.outcome,
        capability: full.capability,
        errorCode: full.errorCode,
      },
    });
  } catch {
    /* DB nicht bereit (z. B. Tests ohne PostgreSQL, Pre-Schema-Start):
       Der In-Memory-Ring bleibt die Wahrheit; kein Rethrow. */
  }
}

/** Letzten N Einträge (neueste zuerst) — für Health-/Debug-Views. */
export function readBrokerFactoryAudit(limit = 50): BrokerFactoryAuditEntry[] {
  return [...factoryAuditRing]
    .slice(-limit)
    .reverse();
}

/** Nur für Tests: Ring leeren. */
export function clearBrokerFactoryAuditForTests(): void {
  factoryAuditRing.length = 0;
}
