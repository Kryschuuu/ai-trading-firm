/**
 * Routing-Audit (Task 09, Regel 4).
 *
 * JEDER Wechsel — inkl. Fallback und abgelehnter Eskalation — landet im Audit:
 *   {ts, agent, von, nach, Grund/Trigger, Policy-Version, approved/denied/fallback}
 *
 * Dreistufige Senke (Muster aus `src/brokers/control-plane/audit.ts` und
 * `src/cycle/ports.ts`):
 *   1. In-Memory-Ring (immer verfügbar, deterministisch testbar)
 *   2. NDJSON-Datei (`data/routing/audit.ndjson`) — vgl. task-01/06
 *   3. `audit_log` (Event `MODEL_ROUTING`) — best-effort, nie blockierend
 *
 * Der Audit-Pfad wirft NIE: Ein Audit-Ausfall darf keine Routing-Entscheidung
 * verhindern (aber jeder Wechsel wird trotzdem im Ring gehalten).
 */
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { AuditSink, RoutingAuditEntry } from "./types";

export const ROUTING_AUDIT_EVENT = "MODEL_ROUTING";
export const ROUTING_AUDIT_DIR = "data/routing";
export const ROUTING_AUDIT_FILE = "audit.ndjson";

const RING_MAX = 500;

const G = globalThis as typeof globalThis & {
  __routingAuditRing?: RoutingAuditEntry[];
};

/** In-Memory-Ring (neueste zuletzt) — Grundlage für Tests und API. */
export const routingAuditRing: RoutingAuditEntry[] = (G.__routingAuditRing ??=
  []) as RoutingAuditEntry[];

/** Nur Tests: Ring leeren. */
export function clearRoutingAuditForTests(): void {
  routingAuditRing.length = 0;
}

/** Letzte N Einträge (neueste zuerst). */
export function readRoutingAudit(limit = 100): RoutingAuditEntry[] {
  return [...routingAuditRing].slice(-Math.max(1, limit)).reverse();
}

/** Senke, die alles im Ring sammelt (Tests, Fallback). */
export class MemoryAuditSink implements AuditSink {
  readonly name = "memory";
  readonly entries: RoutingAuditEntry[] = [];

  write(entry: RoutingAuditEntry): void {
    this.entries.push(entry);
    pushRing(entry);
  }
}

/** Append-only NDJSON-Dateisenke (Default `data/routing/audit.ndjson`). */
export class FileAuditSink implements AuditSink {
  readonly name = "file";
  readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath =
      filePath ?? path.join(process.cwd(), ROUTING_AUDIT_DIR, ROUTING_AUDIT_FILE);
  }

  write(entry: RoutingAuditEntry): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o755 });
      appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch {
      /* Datei nicht beschreibbar: Ring bleibt die Wahrheit. */
    }
    pushRing(entry);
  }
}

/** Datenbank-Senke (`audit_log`, Event `MODEL_ROUTING`) — best-effort. */
export class DatabaseAuditSink implements AuditSink {
  readonly name = "database";

  async write(entry: RoutingAuditEntry): Promise<void> {
    pushRing(entry);
    if (!process.env.DATABASE_URL) return;
    try {
      const [{ db }, { auditLog }] = await Promise.all([import("@/db"), import("@/db/schema")]);
      await db.insert(auditLog).values({
        event: ROUTING_AUDIT_EVENT,
        level: entry.outcome === "denied" || entry.outcome === "budget_blocked" ? "WARN" : "INFO",
        detail: {
          ts: entry.ts,
          agent: entry.agent,
          from: entry.from,
          to: entry.to,
          reason: entry.reason,
          trigger: entry.trigger,
          policyVersion: entry.policyVersion,
          outcome: entry.outcome,
          task: entry.task ?? null,
          complexity: entry.complexity ?? null,
          detail: entry.detail ?? null,
        },
      });
    } catch {
      /* DB nicht bereit: Ring + Datei bleiben die Wahrheit. */
    }
  }
}

/** Mehrere Senken; ein Fehler einer Senke stoppt die anderen nicht. */
export class CompositeAuditSink implements AuditSink {
  readonly name = "composite";
  readonly sinks: readonly AuditSink[];

  constructor(sinks: AuditSink[]) {
    this.sinks = sinks;
  }

  async write(entry: RoutingAuditEntry): Promise<void> {
    pushRing(entry);
    for (const sink of this.sinks) {
      try {
        await sink.write(entry);
      } catch {
        /* Senke ausfalltolerant */
      }
    }
  }
}

function pushRing(entry: RoutingAuditEntry): void {
  routingAuditRing.push(entry);
  if (routingAuditRing.length > RING_MAX) {
    routingAuditRing.splice(0, routingAuditRing.length - RING_MAX);
  }
}

/** Standardsenke: Datei + Datenbank (Ring immer). */
export function createRoutingAuditSink(filePath?: string): CompositeAuditSink {
  return new CompositeAuditSink([new FileAuditSink(filePath), new DatabaseAuditSink()]);
}
