/**
 * Live-Gate-Audit (Task 11) — append-only mit HASH-KETTE.
 *
 * Jeder Übergang, jeder Deny, jeder Kill, jeder Enforce-Entscheid landet hier:
 *   { seq, ts, actor, venue, from, to, action, result, reason, policyVersion,
 *     prevHash, hash }
 *
 * Hash-Kette: `hash = sha256(canonical(entry ohne hash))`, kanonisch = JSON-
 * Array der Felder in FESTER Reihenfolge (siehe AUDIT_FIELDS). Jeder Eintrag
 * enthält den Hash des Vorgängers (Genesis: 64 Nullen). Manipulation eines
 * Eintrags oder Einfügen/Entfernen bricht die Kette → verifyAuditChain()
 * schlägt an (Tests, CI-Security-Suite, Live-Gate-API).
 *
 * Senken (fail-safe, Audit wirft NIE):
 *   1. NDJSON-Datei `${dir}/audit-log.ndjson` (append-only, lokal)
 *   2. In-Memory-Ring (500) — immer verfügbar, auch bei Datei-/DB-Fehler
 *   3. `audit_log` (Event LIVE_GATE) — Zweitabzug via Drizzle; ein Fehler zählt
 *      und warnt (S1, v1.36.18), bricht das Gate aber nie (Ring + Kette sind
 *      bereits durable)
 *
 * Leaking-Schutz: nur strukturierte Felder, keine Secrets, keine Order-Daten.
 */
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { structuredLog } from "@/lib/logger";
import { telemetry } from "@/lib/telemetry";
import { LIVE_GATE_POLICY_VERSION } from "./config";

export const AUDIT_FILE_NAME = "audit-log.ndjson";
export const AUDIT_GENESIS_HASH = "0".repeat(64);
const RING_MAX = 500;

export type LiveGateAuditAction =
  | "advance"
  | "disable"
  | "kill"
  | "kill-clear"
  | "enforce"
  | "crash-recovery"
  | "suite-stamp"
  | "four-eyes-first";

export type LiveGateAuditResult = "OK" | "DENIED" | "KILLED" | "ABORTED";

export interface LiveGateAuditEntry {
  seq: number;
  ts: string;
  actor: string;
  venue: string;
  from: string | null;
  to: string | null;
  action: LiveGateAuditAction;
  result: LiveGateAuditResult;
  reason: string;
  policyVersion: string;
  prevHash: string;
  hash: string;
}

export type LiveGateAuditInput = Omit<LiveGateAuditEntry, "seq" | "ts" | "policyVersion" | "prevHash" | "hash"> & {
  ts?: string;
  policyVersion?: string;
};

/** Feste Feldreihenfolge des kanonischen Hash-Inputs (stabile Diffs). */
export const AUDIT_FIELDS = [
  "seq",
  "ts",
  "actor",
  "venue",
  "from",
  "to",
  "action",
  "result",
  "reason",
  "policyVersion",
  "prevHash",
] as const;

/** Kanonischer Hash über den Entry-Inhalt ohne `hash`-Feld selbst. */
export function computeAuditHash(entry: Omit<LiveGateAuditEntry, "hash">): string {
  const canonical = JSON.stringify(AUDIT_FIELDS.map((f) => (entry as Record<string, unknown>)[f]));
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export interface AuditChainHead {
  seq: number;
  hash: string;
}

export interface AuditChainVerification {
  ok: boolean;
  entries: number;
  head: AuditChainHead | null;
  firstBrokenSeq: number | null;
  problem: string | null;
}

/**
 * Prüft die Hash-Kette einer Audit-Datei Zeile für Zeile:
 *   - Seq-Strenge (1-based, +1),
 *   - prevHash == hash des Vorgängers,
 *   - hash == Neuberechnung (Manipulationsschutz).
 * Fehlende Datei = leere, gültige Kette.
 */
export function verifyAuditChain(
  dir: string,
  fileName: string = AUDIT_FILE_NAME
): AuditChainVerification {
  const file = path.join(dir, fileName);
  let lines: string[];
  try {
    lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim().length > 0);
  } catch {
    return { ok: true, entries: 0, head: null, firstBrokenSeq: null, problem: null };
  }
  let prevHash = AUDIT_GENESIS_HASH;
  let expectedSeq = 1;
  let head: AuditChainHead | null = null;
  for (const line of lines) {
    let entry: LiveGateAuditEntry;
    try {
      entry = JSON.parse(line) as LiveGateAuditEntry;
    } catch {
      return {
        ok: false,
        entries: expectedSeq - 1,
        head,
        firstBrokenSeq: expectedSeq,
        problem: `Audit-Zeile ${expectedSeq} ist kein gültiges JSON (Manipulation/Truncation).`,
      };
    }
    if (entry.seq !== expectedSeq) {
      return {
        ok: false,
        entries: expectedSeq - 1,
        head,
        firstBrokenSeq: expectedSeq,
        problem: `Seq-Bruch: erwartet ${expectedSeq}, gefunden ${String(entry.seq)}.`,
      };
    }
    if (entry.prevHash !== prevHash) {
      return {
        ok: false,
        entries: expectedSeq - 1,
        head,
        firstBrokenSeq: expectedSeq,
        problem: `prevHash-Bruch bei Seq ${expectedSeq} (Kette unterbrochen/eingefügt).`,
      };
    }
    const recomputed = computeAuditHash(entry);
    if (recomputed !== entry.hash) {
      return {
        ok: false,
        entries: expectedSeq - 1,
        head,
        firstBrokenSeq: expectedSeq,
        problem: `Hash-Abweichung bei Seq ${expectedSeq}: Eintrag wurde verändert.`,
      };
    }
    prevHash = entry.hash;
    head = { seq: entry.seq, hash: entry.hash };
    expectedSeq += 1;
  }
  return { ok: true, entries: lines.length, head, firstBrokenSeq: null, problem: null };
}

/**
 * Audit-Senke je Live-Gate-Runtime (Data-Dir). `append` wirft NIE — ein
 * Audit-Schreibfehler darf den Gate-Pfad nicht blockieren (der In-Memory-Ring
 * bleibt Wahrheit; die Datei wird beim nächsten Schreiben fortgesetzt).
 */
export class LiveGateAudit {
  private readonly ring: LiveGateAuditEntry[] = [];
  private head: AuditChainHead | null = null;

  constructor(private readonly dir: string) {
    // Kette beim Start aus der Datei rekonstruieren (Crash-Recovery):
    // Kopf übernehmen; ist die Datei-Kette gebrochen, bleibt der Ring leer
    // und der Bruch wird über verifyAuditChain sichtbar (API/CI).
    const verified = verifyAuditChain(dir);
    if (verified.ok && verified.head) {
      this.head = verified.head;
    }
  }

  /** Aktueller Kettenkopf (für State-Files: Truncation-Erkennung). */
  chainHead(): AuditChainHead | null {
    return this.head ? { ...this.head } : null;
  }

  append(input: LiveGateAuditInput): LiveGateAuditEntry {
    const seq = (this.head?.seq ?? 0) + 1;
    const prevHash = this.head?.hash ?? AUDIT_GENESIS_HASH;
    const base: Omit<LiveGateAuditEntry, "hash"> = {
      seq,
      ts: input.ts ?? new Date().toISOString(),
      actor: input.actor,
      venue: input.venue,
      from: input.from ?? null,
      to: input.to ?? null,
      action: input.action,
      result: input.result,
      reason: input.reason,
      policyVersion: input.policyVersion ?? LIVE_GATE_POLICY_VERSION,
      prevHash,
    };
    const entry: LiveGateAuditEntry = { ...base, hash: computeAuditHash(base) };
    // 1) Ring (immer)
    this.ring.push(entry);
    if (this.ring.length > RING_MAX) this.ring.splice(0, this.ring.length - RING_MAX);
    this.head = { seq, hash: entry.hash };
    // 2) Datei (best-effort, append-only)
    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(path.join(this.dir, AUDIT_FILE_NAME), JSON.stringify(entry) + "\n", "utf8");
    } catch {
      /* Datei nicht schreibbar (z. B. read-only-Fehlerdrill): Ring bleibt
         Wahrheit; Kette wird beim nächsten erfolgreichen Append fortgesetzt. */
    }
    // 3) DB (best-effort, dynamisch — Tests ohne PostgreSQL bleiben lauffähig)
    void this.persistToDb(entry);
    return entry;
  }

  private async persistToDb(entry: LiveGateAuditEntry): Promise<void> {
    try {
      const { db } = await import("@/db");
      const { auditLog } = await import("@/db/schema");
      await db.insert(auditLog).values({
        event: "LIVE_GATE",
        level:
          entry.result === "OK" ? "INFO" : entry.result === "KILLED" ? "CRITICAL" : "WARN",
        detail: {
          seq: entry.seq,
          actor: entry.actor,
          venue: entry.venue,
          from: entry.from,
          to: entry.to,
          action: entry.action,
          result: entry.result,
          reason: entry.reason,
          policyVersion: entry.policyVersion,
          prevHash: entry.prevHash,
          hash: entry.hash,
        },
      });
      // S1 (v1.36.18): Die Hash-Kette in Ring + NDJSON ist bereits durable —
      // der DB-Zweitabzug ist Reserve. Ein Fehlschlag wird deshalb über die
      // Telemetrie-Klasse gezählt und gewarnt, statt verschluckt zu werden.
    } catch (e) {
      telemetry.audit.writeFailures.inc({ auditClass: "telemetry", stage: "db" });
      structuredLog("warn", "live_gate_audit_db_failed", {
        seq: entry.seq,
        action: entry.action,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /** Letzte N Einträge (neueste zuerst) — API/Debug, keine Secrets. */
  recent(limit = 20): LiveGateAuditEntry[] {
    return [...this.ring].slice(-limit).reverse();
  }

  /** Letzter Kill-Eintrag (für API-Anzeige). */
  lastKill(): LiveGateAuditEntry | null {
    return [...this.ring].reverse().find((e) => e.action === "kill") ?? null;
  }
}
