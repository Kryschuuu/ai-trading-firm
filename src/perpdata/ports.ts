/**
 * Ports der Perpetual-Daten (RMA-P2-02) — die schmale Grenze zwischen
 * Fachlogik (Sync, Qualität, as-of-Abfrage) und Ablage (Postgres, Speicher).
 *
 * Wie beim Feature Store (RMA-P6-01) gilt: **eine Ablage, die nicht erreichbar
 * ist, wirft** — sie antwortet nie mit `[]`. „DB aus“ und „keine Sätze“ sind
 * fachlich verschiedene Zustände und dürfen im Consumer nie dasselbe Ergebnis
 * erzeugen (Baseline-Regel 3).
 */
import type {
  PerpAvailabilityPolicy,
  PerpFundingRow,
  PerpKindCapability,
  PerpKindSyncStats,
  PerpLiquidationRow,
  PerpOpenInterestRow,
  PerpSeriesKind,
  PerpSeriesQuery,
  PerpSyncFailure,
  PerpSyncMode,
  PerpSyncStatus,
} from "./types";

/** Zeilen einer Charge, die geschrieben werden soll. */
export interface PerpWriteBatch {
  funding: readonly PerpFundingRow[];
  openInterest: readonly PerpOpenInterestRow[];
  liquidations: readonly PerpLiquidationRow[];
}

/** Wasserstand einer Reihe (Restart-/Retry-Anker). */
export interface PerpCursor {
  venue: string;
  instrumentId: string;
  kind: PerpSeriesKind;
  watermarkEventTime: Date;
  watermarkAvailableAt: Date;
  lastRunId: string | null;
  consecutiveFailures: number;
  lastStatus: "OK" | "PARTIAL" | "FAILED" | "UNSUPPORTED";
  unsupportedReason: string | null;
}

/** Manifest eines Sync-Laufs (Erfolg wie Teilerfolg). */
export interface PerpRunRecord {
  id: string;
  idempotencyKey: string;
  venue: string;
  mode: PerpSyncMode;
  status: PerpSyncStatus;
  availabilityPolicy: PerpAvailabilityPolicy;
  fromTs: Date;
  toTs: Date;
  kinds: readonly PerpSeriesKind[];
  instrumentIds: readonly string[];
  counts: Partial<Record<PerpSeriesKind, PerpKindSyncStats>> & {
    /** Vom Quality-Layer gemeldete Befunde je Klasse. */
    qualityFindings?: Record<string, number>;
    /** Abweichende Sätze zum selben Schlüssel (nicht überschrieben). */
    revisionConflicts?: number;
    rejectedRows?: number;
    requests?: number;
  };
  capabilities: Record<PerpSeriesKind, PerpKindCapability>;
  failures: readonly PerpSyncFailure[];
  codeVersion: string;
  errorCode: string | null;
  startedAt: Date;
  finishedAt: Date;
}

/** Atomarer Schreibauftrag: Manifest + Zeilen + Cursor in EINER Transaktion. */
export interface PerpCommit {
  run: PerpRunRecord;
  batch: PerpWriteBatch;
  cursors: readonly PerpCursor[];
}

/** Ergebnis eines Commits. */
export interface PerpCommitResult {
  runId: string;
  /** `false` = Replay (Idempotenzschlüssel bereits vorhanden) ⇒ nichts geschrieben. */
  created: boolean;
  inserted: Record<PerpSeriesKind, number>;
  duplicates: Record<PerpSeriesKind, number>;
  revisionConflicts: number;
  cursorsUpdated: number;
  /** Vom Persistenz-Layer abgewiesene Zeilen (Wert/Grund-Verstöße). */
  rejectedRows: number;
}

/** Abdeckung je (Venue, Reihenart) — Betriebs-/Statussicht. */
export interface PerpCoverage {
  venue: string;
  kind: PerpSeriesKind;
  rows: number;
  instruments: number;
  /** Zeilen ohne Wert (nur Grund) — Sichtbarkeit von `null ≠ 0`. */
  nullRows: number;
  invalidRows: number;
  unknownQualityRows: number;
  firstEventTime: string | null;
  lastEventTime: string | null;
  /** Alter der jüngsten verfügbaren Zeile in ms (gegen `asOf`). */
  ageMs: number | null;
}

/** Lesen von Reihen (as-of-gefiltert) — von Store **und** Speicher genutzt. */
export interface PerpSeriesSource {
  readFunding(query: PerpSeriesQuery): Promise<readonly PerpFundingRow[]>;
  readOpenInterest(query: PerpSeriesQuery): Promise<readonly PerpOpenInterestRow[]>;
  readLiquidations(query: PerpSeriesQuery): Promise<readonly PerpLiquidationRow[]>;
}

/** Vollständiger Ablage-Port (Schreiben + Lesen + Betrieb). */
export interface PerpStorePort extends PerpSeriesSource {
  commitRun(commit: PerpCommit): Promise<PerpCommitResult>;
  readCursors(scope: { venue?: string | null; instrumentIds?: readonly string[] }): Promise<readonly PerpCursor[]>;
  recentRuns(limit: number): Promise<readonly PerpRunRecord[]>;
  coverage(asOfMs: number, venue?: string | null): Promise<readonly PerpCoverage[]>;
  /** Retention der Lauf-Manifeste (Zeilen bleiben immer erhalten). */
  pruneRuns(keepLast: number): Promise<number>;
}
