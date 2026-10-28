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
 *
 * **Cross-Prozess-Sicherheit (ASA-06):** `next dev`/`next start`, die CLI
 * (`npm run live:kill`) und der `micro-executor` schreiben dieselbe NDJSON.
 * Der Kettenkopf wird deshalb **nicht** nur einmal im Prozess gelesen:
 * `append()` nimmt unter einer Lock-Datei (`<audit>.lock`, `openSync(…, "wx")`)
 * die aktuelle Dateigröße, liest nur die **neu hinzugekommenen Bytes** ab dem
 * letzten bekannten Offset, verifiziert deren Verkettung und übernimmt den
 * Dateischwanz als Wahrheit — erst danach wird die neue Zeile berechnet und
 * per `fsync` geschrieben. Dadurch bleiben `seq` und `prevHash` über Prozesse
 * hinweg streng monoton (keine doppelten `seq`, kein veralteter `prevHash`).
 *
 * `verifyAuditChain()` cached das Ergebnis über `(size, mtimeMs, ctimeMs, ino)`,
 * damit wiederholte `GET /api/live/state`-Aufrufe bei unveränderter Datei in
 * O(1) antworten.
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { structuredLog } from "@/lib/logger";
import { telemetry } from "@/lib/telemetry";
import { LIVE_GATE_POLICY_VERSION } from "./config";

export const AUDIT_FILE_NAME = "audit-log.ndjson";
export const AUDIT_GENESIS_HASH = "0".repeat(64);
const RING_MAX = 500;

/** Alter (ms), ab dem eine Lock-Datei als verwaist gilt (Crash-Recovery). */
export const AUDIT_LOCK_STALE_MS = 10_000;
/** Maximale Wartezeit (ms) auf die Lock-Datei, bevor best-effort geschrieben wird. */
export const AUDIT_LOCK_TIMEOUT_MS = 2_000;
/** Warteintervall (ms) zwischen zwei Lock-Versuchen. */
const AUDIT_LOCK_RETRY_MS = 5;

export type LiveGateAuditAction =
  | "advance"
  | "disable"
  | "kill"
  | "kill-clear"
  | "enforce"
  | "crash-recovery"
  | "suite-stamp"
  | "four-eyes-first"
  | "four-eyes-second";

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

/** Signatur einer Audit-Datei — Grundlage der Ketten-Caches. */
interface AuditFileSignature {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
}

const EMPTY_CHAIN: AuditChainVerification = {
  ok: true,
  entries: 0,
  head: null,
  firstBrokenSeq: null,
  problem: null,
};

/** Kopie eines Verifikationsergebnisses (Cache darf nie mutierbar lecken). */
function copyVerification(result: AuditChainVerification): AuditChainVerification {
  return { ...result, head: result.head ? { ...result.head } : null };
}

/** Cache: absoluter Dateipfad → (Signatur, Ergebnis). */
const chainCache = new Map<string, { signature: AuditFileSignature; result: AuditChainVerification }>();

/** Signatur der Datei oder `null`, wenn sie (noch) nicht existiert. */
function signatureOf(file: string): AuditFileSignature | null {
  try {
    const stat = statSync(file);
    return { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: Number(stat.ino) };
  } catch {
    return null;
  }
}

/** Signatur-Vergleich: jede sichtbare Änderung invalidiert den Cache. */
function sameSignature(a: AuditFileSignature, b: AuditFileSignature): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.ino === b.ino;
}

/** Nur für Tests: Ketten-Cache leeren (z. B. nach `rm -rf` eines Test-Dirs). */
export function resetAuditChainCacheForTests(): void {
  chainCache.clear();
}

/**
 * Prüft die Hash-Kette einer Audit-Datei Zeile für Zeile:
 *   - Seq-Strenge (1-based, +1),
 *   - prevHash == hash des Vorgängers,
 *   - hash == Neuberechnung (Manipulationsschutz).
 * Fehlende Datei = leere, gültige Kette.
 *
 * **Performance (ASA-06):** Das Ergebnis wird anhand von
 * `(size, mtimeMs, ctimeMs, ino)` gecacht. `GET /api/live/state` (das pro
 * Request `overview()` aufruft) kostet damit bei unveränderter Datei genau
 * einen `stat()` statt eines vollständigen Datei-Parses inklusive SHA-256 über
 * jede Zeile. Jede Größen-, Zeitstempel- oder Inode-Änderung — also auch eine
 * Manipulation mit gleicher Länge — verwirft den Cache.
 */
export function verifyAuditChain(
  dir: string,
  fileName: string = AUDIT_FILE_NAME
): AuditChainVerification {
  const file = path.join(dir, fileName);
  const signature = signatureOf(file);
  if (!signature) {
    chainCache.delete(file);
    return copyVerification(EMPTY_CHAIN);
  }
  const cached = chainCache.get(file);
  if (cached && sameSignature(cached.signature, signature)) return copyVerification(cached.result);
  const result = verifyAuditFile(file);
  chainCache.set(file, { signature, result });
  return copyVerification(result);
}

/** Parst die gesamte Datei und setzt die Kettenregeln durch (Cache-frei). */
function verifyAuditFile(file: string): AuditChainVerification {
  let lines: string[];
  try {
    lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim().length > 0);
  } catch {
    return copyVerification(EMPTY_CHAIN);
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
 * Prüft, ob eine Lock-Datei verwaist ist: zu alt **oder** die PID darin lebt
 * nicht mehr (Prozess abgestürzt/`SIGKILL`).
 */
function isStaleLock(lockFile: string): boolean {
  try {
    const stat = statSync(lockFile);
    if (Date.now() - stat.mtimeMs > AUDIT_LOCK_STALE_MS) return true;
    const pid = Number.parseInt(readFileSync(lockFile, "utf8"), 10);
    if (!Number.isInteger(pid) || pid <= 0) return false; // fremdes Format: abwarten
    try {
      process.kill(pid, 0);
      return false; // Prozess lebt
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  } catch {
    // Lock ist zwischen `EEXIST` und `stat` verschwunden — kein Problem.
    return true;
  }
}

/** Synchrones Kurz-Warten ohne Busy-Loop (Atomics auf einem SharedArrayBuffer). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** `fsync` als best-effort (Plattformen ohne Support dürfen den Append nicht kippen). */
function fsyncSyncCompat(fd: number): void {
  try {
    fsyncSync(fd);
  } catch {
    /* fsync nicht verfügbar/nicht nötig — der Write selbst war erfolgreich. */
  }
}

/**
 * Audit-Senke je Live-Gate-Runtime (Data-Dir). `append` wirft NIE — ein
 * Audit-Schreibfehler darf den Gate-Pfad nicht blockieren (der In-Memory-Ring
 * bleibt Wahrheit; die Datei wird beim nächsten Schreiben fortgesetzt).
 */export class LiveGateAudit {
  private readonly ring: LiveGateAuditEntry[] = [];
  private head: AuditChainHead | null = null;
  /** Byte-Offset, bis zu dem die Datei bereits in `head` eingearbeitet ist. */
  private knownSize = 0;

  constructor(private readonly dir: string) {
    // Kette beim Start aus der Datei rekonstruieren (Crash-Recovery):
    // Kopf übernehmen; ist die Datei-Kette gebrochen, bleibt der Ring leer
    // und der Bruch wird über verifyAuditChain sichtbar (API/CI).
    const verified = verifyAuditChain(dir);
    if (verified.ok && verified.head) {
      this.head = verified.head;
      this.knownSize = signatureOf(this.file())?.size ?? 0;
    } else {
      // Gebrochene/unlesbare Kette: beim nächsten Append ab Byte 0 neu
      // einlesen und den Dateischwanz übernehmen, statt `seq = 1` doppelt zu
      // schreiben (der Bruch bleibt über `verifyAuditChain` sichtbar).
      this.knownSize = 0;
    }
  }

  /** Absoluter Pfad der Audit-NDJSON dieses Data-Dirs. */
  private file(): string {
    return path.join(this.dir, AUDIT_FILE_NAME);
  }

  /** Aktueller Kettenkopf (für State-Files: Truncation-Erkennung). */
  chainHead(): AuditChainHead | null {
    return this.head ? { ...this.head } : null;
  }

  append(input: LiveGateAuditInput): LiveGateAuditEntry {
    const file = this.file();
    try {
      mkdirSync(this.dir, { recursive: true });
    } catch {
      /* Verzeichnis nicht anlegbar: Ring bleibt Wahrheit (siehe unten). */
    }
    // Kurze exklusive Sperre: mehrere Prozesse (Next.js, CLI `live:kill`,
    // micro-executor) schreiben dieselbe Datei. Ohne Sperre könnten zwei
    // Prozesse denselben `prevHash` lesen und dieselbe `seq` schreiben.
    const release = this.acquireLock(file);
    try {
      // Datei-Wahrheit vor dem Schreiben einsammeln: nur die seit dem letzten
      // Append NEU hinzugekommenen Bytes parsen (O(neue Zeilen), nicht O(File)).
      this.syncHeadFromFile(file);

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
      // 2) Datei (best-effort, append-only + fsync)
      try {
        const line = `${JSON.stringify(entry)}\n`;
        const fd = openSync(file, "a");
        try {
          writeSync(fd, line, null, "utf8");
          // fsync: der Eintrag muss durable sein, bevor die Kette weiterläuft.
          fsyncSyncCompat(fd);
        } finally {
          closeSync(fd);
        }
        this.knownSize += Buffer.byteLength(line, "utf8");
      } catch {
        /* Datei nicht schreibbar (z. B. read-only-Fehlerdrill): Ring bleibt
           Wahrheit; Kette wird beim nächsten erfolgreichen Append fortgesetzt. */
      }
      // 3) DB (best-effort, dynamisch — Tests ohne PostgreSQL bleiben lauffähig)
      void this.persistToDb(entry);
      return entry;
    } finally {
      release();
    }
  }

  /**
   * Übernimmt Änderungen **anderer Prozesse**: liest ausschließlich die seit
   * `knownSize` neu geschriebenen Bytes, prüft deren Verkettung und setzt
   * `head` auf die letzte Zeile der Datei (Dateischwanz = Wahrheit).
   *
   * Schrumpft die Datei (Rotation/Truncation), wird sie vollständig neu
   * verifiziert. Eine halb geschriebene letzte Zeile (abgebrochener Prozess)
   * wird abgeschnitten, damit die neue Zeile nicht an ein Zeilenfragment klebt.
   */
  private syncHeadFromFile(file: string): void {
    const signature = signatureOf(file);
    if (!signature) {
      // Datei (noch) nicht vorhanden: In-Memory-Kette weiterführen, aber beim
      // nächsten Mal wieder ab Byte 0 lesen (Datei kann neu entstehen).
      this.knownSize = 0;
      return;
    }
    if (signature.size < this.knownSize) {
      const verified = verifyAuditFile(file);
      this.head = verified.ok ? verified.head : null;
      this.knownSize = signature.size;
      return;
    }
    if (signature.size === this.knownSize) return;

    const length = signature.size - this.knownSize;
    const buffer = Buffer.allocUnsafe(length);
    let read = 0;
    const fd = openSync(file, "r");
    try {
      read = readSync(fd, buffer, 0, length, this.knownSize);
    } finally {
      closeSync(fd);
    }
    let text = buffer.subarray(0, read).toString("utf8");
    let consumed = this.knownSize + read;
    if (!text.endsWith("\n")) {
      // Letzte Zeile ist unvollständig (Torn Write). Abschneiden: sonst würde
      // der neue Eintrag an ein Fragment angehängt und wäre unparsebar.
      const lastNewline = text.lastIndexOf("\n");
      const fragment = lastNewline < 0 ? text : text.slice(lastNewline + 1);
      consumed -= Buffer.byteLength(fragment, "utf8");
      text = lastNewline < 0 ? "" : text.slice(0, lastNewline + 1);
      try {
        truncateSync(file, consumed);
      } catch {
        /* Nur best-effort; die Zeile bleibt dann als Fragment sichtbar. */
      }
    }
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry: LiveGateAuditEntry;
      try {
        entry = JSON.parse(trimmed) as LiveGateAuditEntry;
      } catch {
        structuredLog("warn", "live_gate_audit_foreign_line_invalid", { dir: this.dir });
        continue;
      }
      if (typeof entry.seq !== "number" || typeof entry.hash !== "string") {
        structuredLog("warn", "live_gate_audit_foreign_line_incomplete", { dir: this.dir });
        continue;
      }
      const expectedSeq = (this.head?.seq ?? 0) + 1;
      if (entry.seq !== expectedSeq || (this.head && entry.prevHash !== this.head.hash)) {
        // Ein anderer Schreiber hat die Kette unterbrochen. Wir übernehmen den
        // Dateischwanz (Monotonie bleibt erhalten) und warnen — der Bruch
        // selbst bleibt über `verifyAuditChain()` sichtbar.
        telemetry.audit.writeFailures.inc({ auditClass: "telemetry", stage: "chain-sync" });
        structuredLog("warn", "live_gate_audit_chain_gap_detected", {
          dir: this.dir,
          expectedSeq,
          foundSeq: entry.seq,
        });
      }
      this.head = { seq: entry.seq, hash: entry.hash };
    }
    this.knownSize = consumed;
  }

  /**
   * Exklusive Lock-Datei `<audit>.lock` (`openSync(…, "wx")`).
   *
   * Verwaiste Sperren (Prozess abgestürzt) werden anhand des Lock-Alters
   * ({@link AUDIT_LOCK_STALE_MS}) und der PID-Lebendigkeit erkannt und
   * entfernt. Nach {@link AUDIT_LOCK_TIMEOUT_MS} wird best-effort ohne Sperre
   * geschrieben (ein Audit-Eintrag darf nie verloren gehen; das Restrisiko
   * eines `prevHash`-Splits ist kleiner als ein fehlender Kill-Eintrag).
   *
   * @returns Freigabefunktion (idempotent, wirft nie).
   */
  private acquireLock(file: string): () => void {
    const lockFile = `${file}.lock`;
    const deadline = Date.now() + AUDIT_LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        const fd = openSync(lockFile, "wx", 0o600);
        try {
          writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }), null, "utf8");
        } finally {
          closeSync(fd);
        }
        let released = false;
        return () => {
          if (released) return;
          released = true;
          try {
            unlinkSync(lockFile);
          } catch {
            /* bereits entfernt (Stale-Recovery eines anderen Prozesses) */
          }
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          // Verzeichnis nicht beschreibbar o. Ä. — best-effort fortfahren.
          return () => {};
        }
        if (isStaleLock(lockFile)) {
          try {
            unlinkSync(lockFile);
          } catch {
            /* Konkurrenz beim Aufräumen — nächster Versuch */
          }
          continue;
        }
        if (Date.now() >= deadline) {
          telemetry.audit.writeFailures.inc({ auditClass: "telemetry", stage: "chain-lock" });
          structuredLog("warn", "live_gate_audit_lock_timeout", { dir: this.dir });
          return () => {};
        }
        sleepSync(AUDIT_LOCK_RETRY_MS);
      }
    }
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
