/**
 * Persistenz des Cross-Sectional-Momentum-Rankings (RMA-P2-04, v1.63.0) —
 * SERVER-seitig (`@/db`-Import; niemals aus Client-Import-Graphen ziehen).
 *
 * Vertrag:
 *   - **Idempotenz:** `idempotency_key` = der Hex-Teil der deterministischen
 *     Snapshot-ID (SHA-256 über Schema|Timeframe|AsOf|UniverseHash|DataHash|
 *     ConfigHash|CodeVersion) + `ON CONFLICT DO NOTHING` — Retries und
 *     Neustarts desselben Laufs schreiben KEINE zweite Zeile und sind als
 *     `written: false` sichtbar.
 *   - **Konflikt-Guard (fail-closed):** existiert bereits eine
 *     Mitglied-Zeile zum (Snapshot, Instrument) mit anderem `value_hash`,
 *     wird sie NICHT überschrieben, sondern protokolliert (Audit-Event +
 *     bounded Counter). Deterministisch ist das ein Unmögliche-Branch —
 *     der Guard schützt gegen korrupte Teilläufe, nicht gegen „Variation".
 *   - **PIT-Lesezugriff:** `loadLatestSnapshot({ asOfMs })` liefert die
 *     jüngste Zeile mit `as_of ≤ asOfMs` (Index-Scan) — spätere Snapshots
 *     sind für frühere Zeitpunkte strukturell unsichtbar.
 *   - **Retention:** `pruneCrossSectionalSnapshots` entfernt alte Snapshots
 *     (FK-Cascade nimmt die Mitglieder mit).
 *
 * Beobachtung: bounded Metrik `cross_sectional_runs_total` (Labels:
 * geschlossene Ergebnis-Codes) + strukturiertes Audit-Event
 * `cross_sectional_snapshot_persisted`. KEINE Instrument-IDs als
 * Metrik-Labels (die stehen ausschließlich im Audit-Event/Kontext).
 */

import { createHash } from "node:crypto";

import { and, asc, desc, eq, lte } from "drizzle-orm";

import { db } from "../db";
import { crossSectionalRankings, crossSectionalSnapshots } from "../db/schema";
import { structuredLog } from "../lib/logger";
import { telemetry } from "../lib/telemetry";
import { computeStability } from "./snapshot";
import { stableStringify } from "./math";
import type {
  CrossSectionalSnapshot,
  ExclusionReason,
  SnapshotStability,
  UniverseMember,
} from "./types";
import { EXCLUSION_REASONS } from "./types";

/** Default-Retention der Snapshot-Historie (ms) — 180 Tage. */
export const CROSS_SECTIONAL_RETENTION_MS = 180 * 24 * 60 * 60_000;
/** Obergrenze geladener Snapshot-Zeilen (gebounded; Aufrufer paginieren). */
export const CROSS_SECTIONAL_LOAD_MAX = 200;

/** Ergebnis eines Persist-Laufs. */
export interface PersistResult {
  /** `true` = neue Zeile geschrieben; `false` = Idempotenz-No-Op. */
  written: boolean;
  /** ID des Snapshots (deterministisch). */
  snapshotId: string;
  /** Anzahl geschriebener/geprüfter Mitglieder-Zeilen. */
  memberRows: number;
  /** Abweichende Mitglieder-Zeilen (fail-closed protokolliert, nie überschrieben). */
  conflicts: number;
}

/**
 * Stabiler Idempotenz-Key (hex-SHA-256) — der Hex-Teil der Snapshot-ID
 * (deterministisch über die fachliche Identität; `computedAt` NICHT
 * enthalten, damit ein Retry derselben fachlichen Eingabe kein neues
 * Wissen ist).
 */
export function idempotencyKeyOf(snapshot: CrossSectionalSnapshot): string {
  return hashIdempotencyKey(snapshot);
}

/**
 * Rechnet den Idempotenz-Key aus den fachlichen Identitätsfeldern nach
 * (SHA-256, hex) — identisch zu {@link snapshotIdOf} in `./snapshot.ts`.
 */
export function hashIdempotencyKey(snapshot: CrossSectionalSnapshot): string {
  return createHash("sha256")
    .update(
      [
        `v${snapshot.schemaVersion}`,
        snapshot.timeframe,
        snapshot.asOf,
        snapshot.provenance.universeHash,
        snapshot.provenance.dataHash,
        snapshot.provenance.configHash,
        snapshot.provenance.codeVersion,
      ].join("|"),
      "utf8",
    )
    .digest("hex");
}

/** Zeilengen Value-Hash eines Mitglieds (Konflikt-Guard, Determinismus). */
export function memberValueHash(member: UniverseMember, horizonIds: readonly string[]): string {
  const canonical = {
    instrumentId: member.instrumentId,
    status: member.status,
    rank: member.rank,
    percentile: member.percentile,
    composite: member.composite,
    rawReturns: Object.fromEntries(
      horizonIds.map((h) => [
        h,
        member.rawReturns[h]
          ? { total: member.rawReturns[h]!.total, volAdjusted: member.rawReturns[h]!.volAdjusted, barsUsed: member.rawReturns[h]!.barsUsed, available: member.rawReturns[h]!.available }
          : null,
      ]),
    ),
    winsorized: Object.fromEntries(horizonIds.map((h) => [h, member.winsorized[h] ?? null])),
    zScores: Object.fromEntries(horizonIds.map((h) => [h, member.zScores[h] ?? null])),
    horizonCoverage: member.horizonCoverage,
    lastBarTs: member.lastBarTs,
    lastAvailableAt: member.lastAvailableAt,
    barsUsed: member.barsUsed,
    exclusionReason: member.exclusionReason,
  };
  return createHash("sha256").update(stableStringify(canonical), "utf8").digest("hex");
}

/** Normalisiert die Exclusion-Counts (nur geschlossene Gründe, > 0). */
function exclusionCountsObject(snapshot: CrossSectionalSnapshot): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of EXCLUSION_REASONS) {
    const v = snapshot.exclusionCounts[r as ExclusionReason];
    if (v && v > 0) out[r] = v;
  }
  return out;
}

/**
 * Persistiert EINE Snapshot-Zeile + ihre Mitglieder (idempotent, atomar
 * genug für den CLI-Pfad: Snapshot-Zeile zuerst, dann Mitglieder).
 *
 * @throws {Error} bei DB-Fehlern oder invariierender Eingabe (fail-loud;
 *   der CLI-Caller entscheidet über den Exit-Code).
 */
export async function persistCrossSectionalSnapshot(snapshot: CrossSectionalSnapshot): Promise<PersistResult> {
  const key = hashIdempotencyKey(snapshot);
  if (key !== snapshot.provenance.snapshotId.replace(/^xs1:/, "")) {
    throw new Error(
      "persistCrossSectionalSnapshot: snapshotId passt nicht zur fachlichen Identität " +
        "(Provenance manipuliert oder berechnet) — Persistenz verweigert.",
    );
  }
  const horizonIds = snapshot.config.horizons.map((h) => h.id);
  const stability: SnapshotStability | null = snapshot.stability;

  const inserted = await db
    .insert(crossSectionalSnapshots)
    .values({
      snapshotId: snapshot.provenance.snapshotId,
      idempotencyKey: key,
      asOf: new Date(snapshot.asOf),
      computedAt: new Date(snapshot.computedAt),
      schemaVersion: snapshot.schemaVersion,
      codeVersion: snapshot.provenance.codeVersion,
      configVersion: snapshot.config.version,
      configHash: snapshot.provenance.configHash,
      universeHash: snapshot.provenance.universeHash,
      dataHash: snapshot.provenance.dataHash,
      timeframe: snapshot.timeframe,
      availabilityPolicy: snapshot.availabilityPolicy,
      universeSize: snapshot.universeSize,
      rankedCount: snapshot.rankedCount,
      excludedCount: snapshot.excludedCount,
      coverage: String(snapshot.coverage),
      exclusionCounts: exclusionCountsObject(snapshot),
      stability,
      survivorshipNote: snapshot.survivorshipNote,
    })
    .onConflictDoNothing({ target: crossSectionalSnapshots.idempotencyKey })
    .returning({ id: crossSectionalSnapshots.id });
  const written = inserted.length > 0;
  telemetry.crossSectional.persist.inc({ result: written ? "written" : "duplicate" });

  // Mitglieder: je RANKED/EXCLUDED eine Zeile (ON CONFLICT DO NOTHING).
  const rows = snapshot.members.map((m) => ({
    snapshotId: snapshot.provenance.snapshotId,
    instrumentId: m.instrumentId,
    status: m.status,
    rank: m.rank,
    percentile: m.percentile === null ? null : String(m.percentile),
    composite: m.composite === null ? null : String(m.composite),
    rawReturns: Object.fromEntries(
      horizonIds.map((h) => {
        const hr = m.rawReturns[h];
        return [
          h,
          hr
            ? { total: hr.total, volAdjusted: hr.volAdjusted, barsUsed: hr.barsUsed, available: hr.available, reason: hr.reason }
            : null,
        ];
      }),
    ),
    zScores: Object.fromEntries(horizonIds.map((h) => [h, m.zScores[h] ?? null])),
    winsorized: Object.fromEntries(horizonIds.map((h) => [h, m.winsorized[h] ?? null])),
    horizonCoverage: String(m.horizonCoverage),
    lastBarTs: m.lastBarTs === null ? null : new Date(m.lastBarTs),
    lastAvailableAt: m.lastAvailableAt === null ? null : new Date(m.lastAvailableAt),
    barsUsed: m.barsUsed,
    exclusionReason: m.exclusionReason,
    valueHash: memberValueHash(m, horizonIds),
  }));

  let conflicts = 0;
  if (rows.length > 0) {
    // Batch-Einfügen (drizzle values()); Konflikte = stille No-Ops.
    await db.insert(crossSectionalRankings).values(rows).onConflictDoNothing();
    // Konflikt-Guard: vorhandene Zeilen mit anderem Value-Hash protokollieren.
    const existing = await db
      .select({ instrumentId: crossSectionalRankings.instrumentId, valueHash: crossSectionalRankings.valueHash })
      .from(crossSectionalRankings)
      .where(eq(crossSectionalRankings.snapshotId, snapshot.provenance.snapshotId));
    const existingByInstrument = new Map(existing.map((e) => [e.instrumentId, e.valueHash]));
    for (const row of rows) {
      const stored = existingByInstrument.get(row.instrumentId);
      if (stored !== undefined && stored !== row.valueHash) conflicts += 1;
    }
    if (conflicts > 0) {
      telemetry.crossSectional.rankConflicts.inc({ result: "detected" });
      structuredLog("warn", "cross_sectional_ranking_conflict", {
        snapshotId: snapshot.provenance.snapshotId,
        conflicts,
        asOfMs: snapshot.asOf,
      });
    }
  }

  telemetry.crossSectional.runs.inc({
    result: "ok",
    outcome: written ? "persisted" : "idempotent",
  });
  structuredLog("info", "cross_sectional_snapshot_persisted", {
    snapshotId: snapshot.provenance.snapshotId,
    asOfMs: snapshot.asOf,
    computedAtMs: snapshot.computedAt,
    universeSize: snapshot.universeSize,
    rankedCount: snapshot.rankedCount,
    coverage: String(snapshot.coverage),
    written,
    memberRows: rows.length,
    conflicts,
    topExclusionReasons: Object.entries(exclusionCountsObject(snapshot))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([k, v]) => `${k}:${v}`)
      .join(","),
  });

  return { written, snapshotId: snapshot.provenance.snapshotId, memberRows: rows.length, conflicts };
}

/** Geladene Snapshot-Zeile (DB-Form, numbers als number). */
export interface LoadedCrossSectionalSnapshot {
  snapshotId: string;
  asOf: Date;
  computedAt: Date;
  schemaVersion: number;
  codeVersion: string;
  configVersion: number;
  configHash: string;
  universeHash: string;
  dataHash: string;
  timeframe: string;
  availabilityPolicy: string;
  universeSize: number;
  rankedCount: number;
  excludedCount: number;
  coverage: number;
  exclusionCounts: Record<string, number>;
  stability: SnapshotStability | null;
  survivorshipNote: string;
  members: CrossSectionalMemberRow[];
}

/** Geladene Mitglieder-Zeile (DB-Form). */
export interface CrossSectionalMemberRow {
  instrumentId: string;
  status: "RANKED" | "EXCLUDED";
  rank: number | null;
  percentile: number | null;
  composite: number | null;
  rawReturns: Record<string, unknown>;
  zScores: Record<string, unknown>;
  winsorized: Record<string, unknown>;
  horizonCoverage: number;
  lastBarTs: Date | null;
  lastAvailableAt: Date | null;
  barsUsed: number;
  exclusionReason: string | null;
}

/**
 * Point-in-Time-Lesezugriff: die JÜNGSTE Snapshot-Zeile mit
 * `as_of ≤ asOfMs` (optional: passender Timeframe) + ihre Mitglieder.
 * `null`, wenn keine existiert. Spätere Snapshots sind für den
 * Zielzeitpunkt strukturell unsichtbar (kein Look-ahead in der Auswertung).
 */
export async function loadLatestSnapshot(opts: {
  asOfMs?: number;
  timeframe?: string;
}): Promise<LoadedCrossSectionalSnapshot | null> {
  const conditions = [];
  if (opts.asOfMs !== undefined) conditions.push(lte(crossSectionalSnapshots.asOf, new Date(opts.asOfMs)));
  if (opts.timeframe) conditions.push(eq(crossSectionalSnapshots.timeframe, opts.timeframe));
  const snapshot = await db
    .select()
    .from(crossSectionalSnapshots)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(crossSectionalSnapshots.asOf), desc(crossSectionalSnapshots.computedAt))
    .limit(1);
  if (snapshot.length === 0) return null;
  const row = snapshot[0];
  const members = await db
    .select()
    .from(crossSectionalRankings)
    .where(eq(crossSectionalRankings.snapshotId, row.snapshotId))
    .orderBy(asc(crossSectionalRankings.rank), asc(crossSectionalRankings.instrumentId));
  return mapSnapshotRow(row, mapMemberRows(members));
}

function mapSnapshotRow(
  row: typeof crossSectionalSnapshots.$inferSelect,
  members: CrossSectionalMemberRow[],
): LoadedCrossSectionalSnapshot {
  return {
    snapshotId: row.snapshotId,
    asOf: row.asOf,
    computedAt: row.computedAt,
    schemaVersion: row.schemaVersion,
    codeVersion: row.codeVersion,
    configVersion: row.configVersion,
    configHash: row.configHash,
    universeHash: row.universeHash,
    dataHash: row.dataHash,
    timeframe: row.timeframe,
    availabilityPolicy: row.availabilityPolicy,
    universeSize: row.universeSize,
    rankedCount: row.rankedCount,
    excludedCount: row.excludedCount,
    coverage: Number(row.coverage),
    exclusionCounts: (row.exclusionCounts ?? {}) as Record<string, number>,
    stability: row.stability as SnapshotStability | null,
    survivorshipNote: row.survivorshipNote,
    members,
  };
}

function mapMemberRows(rows: (typeof crossSectionalRankings.$inferSelect)[]): CrossSectionalMemberRow[] {
  return rows.map((r) => ({
    instrumentId: r.instrumentId,
    status: r.status as "RANKED" | "EXCLUDED",
    rank: r.rank,
    percentile: r.percentile === null ? null : Number(r.percentile),
    composite: r.composite === null ? null : Number(r.composite),
    rawReturns: (r.rawReturns ?? {}) as Record<string, unknown>,
    zScores: (r.zScores ?? {}) as Record<string, unknown>,
    winsorized: (r.winsorized ?? {}) as Record<string, unknown>,
    horizonCoverage: Number(r.horizonCoverage),
    lastBarTs: r.lastBarTs,
    lastAvailableAt: r.lastAvailableAt,
    barsUsed: r.barsUsed,
    exclusionReason: r.exclusionReason,
  }));
}

/** Historie der Snapshots (neueste zuerst, gebounded). */
export async function listSnapshots(opts: { limit?: number; timeframe?: string } = {}): Promise<
  Omit<LoadedCrossSectionalSnapshot, "members">[]
> {
  const limit = Math.min(Math.max(1, opts.limit ?? 50), CROSS_SECTIONAL_LOAD_MAX);
  const rows = await db
    .select()
    .from(crossSectionalSnapshots)
    .where(opts.timeframe ? eq(crossSectionalSnapshots.timeframe, opts.timeframe) : undefined)
    .orderBy(desc(crossSectionalSnapshots.asOf), desc(crossSectionalSnapshots.computedAt))
    .limit(limit);
  return rows.map((r) => ({
    snapshotId: r.snapshotId,
    asOf: r.asOf,
    computedAt: r.computedAt,
    schemaVersion: r.schemaVersion,
    codeVersion: r.codeVersion,
    configVersion: r.configVersion,
    configHash: r.configHash,
    universeHash: r.universeHash,
    dataHash: r.dataHash,
    timeframe: r.timeframe,
    availabilityPolicy: r.availabilityPolicy,
    universeSize: r.universeSize,
    rankedCount: r.rankedCount,
    excludedCount: r.excludedCount,
    coverage: Number(r.coverage),
    exclusionCounts: (r.exclusionCounts ?? {}) as Record<string, number>,
    stability: r.stability as SnapshotStability | null,
    survivorshipNote: r.survivorshipNote,
  }));
}

/**
 * Hält die Stabilität gegen den unmittelbar vorherigen Snapshot (gleicher
 * Timeframe, `as_of < current.asOf`) fest und persistiert den Snapshot —
 * der Produktivschreibpfad. Bei idempotentem No-Op bleibt die bestehende
 * Zeile unverändert (inkl. Stability).
 */
export async function persistCrossSectionalSnapshotWithStability(
  snapshot: CrossSectionalSnapshot,
): Promise<PersistResult & { stability: SnapshotStability | null }> {
  // Vorherigen Snapshot suchen (NUR wenn der eigene noch nicht existiert —
  // sonst würde der Retry sich selbst als Vorgänger nehmen).
  const existing = await db
    .select({ snapshotId: crossSectionalSnapshots.snapshotId })
    .from(crossSectionalSnapshots)
    .where(eq(crossSectionalSnapshots.idempotencyKey, hashIdempotencyKey(snapshot)))
    .limit(1);

  let stability = snapshot.stability;
  if (existing.length === 0) {
    const prev = await db
      .select()
      .from(crossSectionalSnapshots)
      .where(
        and(
          lte(crossSectionalSnapshots.asOf, new Date(snapshot.asOf - 1)),
          eq(crossSectionalSnapshots.timeframe, snapshot.timeframe),
        ),
      )
      .orderBy(desc(crossSectionalSnapshots.asOf), desc(crossSectionalSnapshots.computedAt))
      .limit(1);
    if (prev.length > 0) {
      const prevMembers = await db
        .select({
          instrumentId: crossSectionalRankings.instrumentId,
          rank: crossSectionalRankings.rank,
          status: crossSectionalRankings.status,
        })
        .from(crossSectionalRankings)
        .where(eq(crossSectionalRankings.snapshotId, prev[0].snapshotId));
      const prevRanks = new Map<string, number>();
      for (const m of prevMembers) {
        if (m.status === "RANKED" && m.rank !== null) prevRanks.set(m.instrumentId, m.rank);
      }
      const currentRanks = new Map<string, number>();
      for (const m of snapshot.members) {
        if (m.status === "RANKED" && m.rank !== null) currentRanks.set(m.instrumentId, m.rank);
      }
      // Reine Stabilitäts-Funktion (./snapshot) — deterministisch.
      stability = computeStability(currentRanks, { snapshotId: prev[0].snapshotId, ranks: prevRanks }, snapshot.config.stabilityTopK);
    }
  }

  const withStab = stability === null ? snapshot : { ...snapshot, stability };
  const result = await persistCrossSectionalSnapshot(withStab);
  return { ...result, stability };
}

/**
 * Retention: entfernt Snapshots mit `as_of < now − retentionMs`
 * (FK-Cascade entfernt die Mitglieder). Liefert die entfernte Anzahl.
 */
export async function pruneCrossSectionalSnapshots(opts: {
  retentionMs?: number;
  nowMs?: number;
} = {}): Promise<{ pruned: number }> {
  const retentionMs = opts.retentionMs ?? CROSS_SECTIONAL_RETENTION_MS;
  const nowMs = opts.nowMs ?? Date.now();
  const cutoff = new Date(nowMs - retentionMs);
  const deleted = await db
    .delete(crossSectionalSnapshots)
    .where(lte(crossSectionalSnapshots.asOf, cutoff))
    .returning({ id: crossSectionalSnapshots.id });
  telemetry.crossSectional.persist.inc({ result: "pruned" });
  return { pruned: deleted.length };
}
