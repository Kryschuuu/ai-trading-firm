/**
 * Factory-Audit (Task 02) — Regel 5: JEDER Factory-Aufruf mit
 * `mode != 'paper'` landet im Audit-Log (venue, mode, Ergebnis, timestamp).
 * Zusätzlich werden Ablehnungen unbekannter Venues auch im paper-Modus
 * protokolliert — das Audit-Log soll vollständig sein.
 *
 * Zweistufige Senke (Muster von `src/universe/audit.ts`):
 *   1. In-Memory-Ring (200 Einträge, prozesslokal) — IMMER verfügbar,
 *      deterministisch testbar, überlebt auch DB-Ausfall.
 *   2. `audit_log` (Event `BROKER_FACTORY`) — **Sicherheitsklasse** (S1,
 *      v1.36.18): Retry mit Backoff, persistenter Spool-Fallback (at-least-once),
 *      CRITICAL-Meldung + Zähler bei Totalverlust. Ein DB-Ausfall darf den
 *      Factory-Pfad weiterhin NICHT abbrechen (Live-Anfragen sind bereits
 *      entschieden), aber er darf ihn nicht mehr unbelegt zurücklassen.
 *
 * Leaking-Schutz: Einträge enthalten ausschließlich venue/mode/outcome/
 * capability/errorCode — keine Order-Daten, keine Kurse, keine Credentials.
 */
import type { ExecutionMode } from "../contracts/broker";
import { writeAuditRecord, type AuditWriteOutcome } from "@/lib/auditSink";

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
  __brokerFactoryAuditDegraded?: number;
};

/** Prozesslokales Audit-Log (Ring-Buffer). Exportiert für Tests + Health-View. */
export const factoryAuditRing: BrokerFactoryAuditEntry[] = (
  G.__brokerFactoryAudit ??= []
) as BrokerFactoryAuditEntry[];

/**
 * Protokolliert einen Factory-Aufruf. Wird von der Factory für jeden Aufruf
 * mit `mode != 'paper'` (plus alle UNKNOWN_VENUE-Ablehnungen) aufgerufen.
 * Wirft nicht (kein `failClosed`) — Audit-Ausfall ist kein Grund, den
 * Broker-Pfad zu blockieren; die Lücke wird gemeldet und nachgezogen.
 */
export async function recordBrokerFactoryCall(
  entry: Omit<BrokerFactoryAuditEntry, "at">
): Promise<AuditWriteOutcome> {
  const full: BrokerFactoryAuditEntry = { ...entry, at: new Date().toISOString() };
  factoryAuditRing.push(full);
  if (factoryAuditRing.length > RING_MAX) {
    factoryAuditRing.splice(0, factoryAuditRing.length - RING_MAX);
  }
  const outcome = await writeAuditRecord({
    event: "BROKER_FACTORY",
    level: full.outcome === "OK" ? "INFO" : "WARN",
    detail: {
      venue: full.venue,
      mode: full.mode,
      outcome: full.outcome,
      capability: full.capability,
      errorCode: full.errorCode,
    },
    // Sicherheitsklasse: Live-Versuche und Venue-Ablehnungen sind
    // prüfungsrelevante Ereignisse — sie dürfen nicht fehlen.
    auditClass: "security",
  });
  if (!outcome.durable || outcome.degraded) {
    G.__brokerFactoryAuditDegraded = (G.__brokerFactoryAuditDegraded ?? 0) + 1;
  }
  return outcome;
}

/**
 * S1: Anzahl Factory-Audits, die nicht sofort durable in `audit_log` waren
 * (Spool-Nachzug offen oder Totalverlust). Zusammen mit
 * `auditDurabilitySnapshot()` aus `src/lib/auditSink.ts` lesbar.
 */
export function readBrokerFactoryAuditDegradedCount(): number {
  return G.__brokerFactoryAuditDegraded ?? 0;
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
  G.__brokerFactoryAuditDegraded = 0;
}
