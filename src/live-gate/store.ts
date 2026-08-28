/**
 * Live-Gate-Persistenz (Task 11) — per-Venue State-Files, atomar + crash-safe.
 *
 * Design:
 *   - Eine Datei pro Venue: `${dir}/venue-${VENUE}.json`
 *   - Atomares Schreiben: tmp-Datei + fsync + rename (niemals halb geschriebene
 *     State-Files; ein Absturz mid-write lässt die alte Datei intakt).
 *   - Crash-Recovery (Lese-Pfad, wirft NIE):
 *       * Datei fehlt                → Initialzustand DISCONNECTED
 *       * JSON ungültig / State unbekannt → DISCONNECTED + Crash-Recovery-Audit
 *         (korrupte Datei wird als `.corrupt-<ts>` konserviert, Forensik)
 *       * pendingTransition vorhanden  → Transition war halboffen (Crash zwischen
 *         Intent und Commit): Intent wird verworfen, Zustand bleibt beim `from`,
 *         auditiert als crash-recovery/ABORTED. Der Zustand ist danach
 *         konsistent — halboffene Übergänge zählen als FEHLGESCHLAGEN.
 *   - Schreib-Fehler beim Mutieren (transition/kill-Reset) WERFEN — fail-safe:
 *     eine Transition, die nicht persistiert werden kann, findet nicht statt.
 */
import { mkdirSync, closeSync, openSync, readFileSync, renameSync, writeFileSync, existsSync, copyFileSync, rmSync } from "node:fs";
import path from "node:path";
import { isLiveGateState, type LiveGateState } from "./states";
import type { LiveGateAudit, AuditChainHead } from "./audit";

export const SCHEMA_VERSION = 1;

export interface LiveGatePendingTransition {
  id: string;
  from: LiveGateState;
  to: LiveGateState;
  startedAt: string;
  actor: string;
}

export interface LiveGateKillMarker {
  scope: string;
  at: string;
  actor: string;
  reason: string;
}

export interface LiveGateVenueRecord {
  schemaVersion: typeof SCHEMA_VERSION;
  venue: string;
  state: LiveGateState;
  updatedAt: string | null;
  updatedBy: string | null;
  /** Intent eines laufenden Übergangs (Crash-Semantik: siehe Header). */
  pendingTransition: LiveGatePendingTransition | null;
  /** Zeitpunkt des Eintritts in LIVE_PENDING (Cooldown-Basis). */
  livePendingAt: string | null;
  /** Erste 4-Augen-Bestätigung (nur gesetzt, bis die zweite folgt). */
  pendingApproval: { approvedBy: string; at: string } | null;
  /** Kill-Marker (bleibt nach Kill gesetzt bis zum nächsten Neudurchlauf). */
  killed: LiveGateKillMarker | null;
  history: {
    transitions: number;
    denials: number;
    kills: number;
    lastTransitionAt: string | null;
  };
  /** Kettenkopf beim letzten Schreiben — Truncation-Erkennung des Audits. */
  auditHead: AuditChainHead | null;
}

export function createInitialVenueRecord(venue: string): LiveGateVenueRecord {
  return {
    schemaVersion: SCHEMA_VERSION,
    venue,
    state: "DISCONNECTED",
    updatedAt: null,
    updatedBy: null,
    pendingTransition: null,
    livePendingAt: null,
    pendingApproval: null,
    killed: null,
    history: { transitions: 0, denials: 0, kills: 0, lastTransitionAt: null },
    auditHead: null,
  };
}

function venueFile(dir: string, venue: string): string {
  return path.join(dir, `venue-${venue.toUpperCase()}.json`);
}

/** Kanonische, stabile Serialisierung (feste Feldreihenfolge). */
function serializeRecord(record: LiveGateVenueRecord): string {
  return JSON.stringify(
    {
      schemaVersion: record.schemaVersion,
      venue: record.venue,
      state: record.state,
      updatedAt: record.updatedAt,
      updatedBy: record.updatedBy,
      pendingTransition: record.pendingTransition,
      livePendingAt: record.livePendingAt,
      pendingApproval: record.pendingApproval,
      killed: record.killed,
      history: {
        transitions: record.history.transitions,
        denials: record.history.denials,
        kills: record.history.kills,
        lastTransitionAt: record.history.lastTransitionAt,
      },
      auditHead: record.auditHead,
    },
    null,
    2
  );
}

/** Atomar schreiben: tmp + fsync + rename (crash-safe). */
export function atomicWriteFile(file: string, content: string): void {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeFileSync(fd, content, "utf8");
  } finally {
    closeSync(fd);
  }
  // fsync auf der Datei (Inhalt) — Verzeichnis-Fsync ist auf allen gängigen
  // Plattformen nicht portabel verfügbar; rename ist auf POSIX atomar.
  renameSync(tmp, file);
}

/**
 * Persistenter Zustandsspeicher der Live-Gate-Machine.
 * `read` ist fail-safe (liefert IMMER einen gültigen Record), `write` wirft
 * bei IO-Fehlern (Transition wird abgebrochen = fail-safe).
 */
export class LiveGateStore {
  private readonly cache = new Map<string, LiveGateVenueRecord>();

  constructor(
    private readonly dir: string,
    private readonly audit: LiveGateAudit
  ) {}

  /** Liest den Venue-Record (Cache → Datei → Initialzustand). Wirft nie. */
  read(venueRaw: string): LiveGateVenueRecord {
    const venue = venueRaw.toUpperCase();
    const cached = this.cache.get(venue);
    if (cached) return { ...cached };

    const file = venueFile(this.dir, venue);
    let record: LiveGateVenueRecord | null = null;
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as LiveGateVenueRecord;
        if (
          !parsed ||
          parsed.schemaVersion !== SCHEMA_VERSION ||
          !isLiveGateState(parsed.state) ||
          parsed.venue?.toUpperCase() !== venue
        ) {
          throw new Error("schema");
        }
        record = {
          ...createInitialVenueRecord(venue),
          ...parsed,
          history: { ...createInitialVenueRecord(venue).history, ...parsed.history },
        };
      } catch {
        // Korrupt/ungültig: konservieren + fail-safe DISCONNECTED + Audit.
        try {
          copyFileSync(file, `${file}.corrupt-${Date.now()}`);
        } catch {
          /* Konservierung best-effort. */
        }
        this.audit.append({
          actor: "system",
          venue,
          from: null,
          to: "DISCONNECTED",
          action: "crash-recovery",
          result: "ABORTED",
          reason: "State-File ungültig/korrupt — fail-safe DISCONNECTED (Datei konserviert).",
        });
        record = createInitialVenueRecord(venue);
      }
    } else {
      record = createInitialVenueRecord(venue);
    }

    // Halboffene Transition (Crash zwischen Intent und Commit) → ABORTED.
    if (record.pendingTransition) {
      const pending = record.pendingTransition;
      record.pendingTransition = null;
      record.auditHead = this.audit.chainHead();
      try {
        this.write(venue, record);
      } catch {
        /* Schreibfehler: Record bleibt im Cache konsistent. */
      }
      this.audit.append({
        actor: pending.actor,
        venue,
        from: pending.from,
        to: null,
        action: "crash-recovery",
        result: "ABORTED",
        reason: `Halboffene Transition ${pending.from}->${pending.to} (Crash/Timeout) — als fehlgeschlagen auditiert, Zustand bleibt ${pending.from}.`,
      });
    }

    this.cache.set(venue, record);
    return { ...record };
  }

  /** Schreibt atomar + aktualisiert den Cache. Wirft bei IO-Fehler. */
  write(venueRaw: string, record: LiveGateVenueRecord): void {
    const venue = venueRaw.toUpperCase();
    atomicWriteFile(venueFile(this.dir, venue), serializeRecord(record));
    this.cache.set(venue, record);
  }

  /** Lesenden Zugriff ohne Datei (Tests/Introspektion). */
  fileFor(venue: string): string {
    return venueFile(this.dir, venue);
  }

  /** Nur Tests: Cache leeren (Dateien bleiben). */
  clearMemoryCacheForTests(): void {
    this.cache.clear();
  }

  /** Nur Tests: Record aus Cache verwerfen, sodass neu gelesen wird. */
  evictForTests(venue: string): void {
    this.cache.delete(venue.toUpperCase());
  }

  /** Nur Tests: Datei entfernen (Fehlerdrills). */
  removeForTests(venue: string): void {
    this.cache.delete(venue.toUpperCase());
    rmSync(venueFile(this.dir, venue), { force: true });
  }
}
