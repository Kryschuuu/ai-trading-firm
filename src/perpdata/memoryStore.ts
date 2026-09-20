/**
 * Speicher-Ablage für Perp-Reihen (RMA-P2-02).
 *
 * Zwei Zwecke, identischer Vertrag zur Drizzle-Ablage (`store.ts`):
 *
 *   1. **`--dry-run`** des Sync-CLI: Fenster, Normalisierung, Qualität und
 *      Cursor werden vollständig durchlaufen, es wird nichts geschrieben. Eine
 *      eigene Trockenlauf-Senke ist nötig, weil „nichts tun“ sonst meaning
 *      hätte, die as-of-Kette aber bis einschließlich Store prüfen soll.
 *   2. **Tests** (Pipeline, Idempotenz, Restart-Replay) ohne Datenbank.
 *
 * Alle Append-only-Regeln sind hier **nachgebaut**, nicht attraper: gleicher
 * Schlüssel ⇒ gleiche Zeile (kein Überschreiben), abweichender Hash ⇒ Revision
 * (`revisionConflicts`), as-of-Filter `event_time <= asOf && available_at <= asOf`,
 * Cursor nur vorwärts. Ein Test gegen diese Ablage prüft damit die Fachlogik,
 * nicht die Datenbank.
 */
import { filterRowsAsOf } from "./query";
import { perpRowKey } from "./normalize";
import type {
  PerpCommit,
  PerpCommitResult,
  PerpCoverage,
  PerpCursor,
  PerpRunRecord,
  PerpStorePort,
} from "./ports";
import { PERP_LIMITS, type PerpFundingRow, type PerpLiquidationRow, type PerpOpenInterestRow, type PerpSeriesKind, type PerpSeriesQuery } from "./types";

const HOUR = 3_600_000;

/** Sicht auf die Messfelder aller drei Reihen (die Union hat sie nicht gemeinsam). */
interface PerpRowView {
  eventTime: Date;
  availableAt: Date;
  contentHash: string;
  missingReason: string | null;
  fundingRate?: number | null;
  contracts?: number | null;
  baseQuantity?: number | null;
  quoteValue?: number | null;
  quantityBase?: number | null;
  notionalQuote?: number | null;
}

function emptyKindCounts(): Record<PerpSeriesKind, number> {
  return { funding: 0, openInterest: 0, liquidations: 0 };
}

/** Jüngste `limit + 1` Zeilen — die +1 erlaubt dem Query-Layer die Kürzungs-Erkennung. */
function limitRows<T>(rows: readonly T[], limit: number): T[] {
  const budget = Math.max(1, limit) + 1;
  return rows.length <= budget ? [...rows] : rows.slice(rows.length - budget);
}

export class InMemoryPerpStore implements PerpStorePort {
  private readonly data: Record<PerpSeriesKind, Map<string, PerpFundingRow | PerpOpenInterestRow | PerpLiquidationRow>> = {
    funding: new Map(),
    openInterest: new Map(),
    liquidations: new Map(),
  };
  private readonly cursors = new Map<string, PerpCursor>();
  private readonly runs = new Map<string, PerpRunRecord>();
  private readonly runsByKey = new Map<string, string>();
  /** Kumulierte Abweichungen (Revisionen) über alle Commits. */
  revisions = 0;
  /** Commit-Folge (Tests prüfen Reihenfolge und Atomarität). */
  readonly commits: PerpCommitResult[] = [];

  /** Zeilenbestand einer Reihe (as-of-ungefiltert) — Testzugang. */
  rows(kind: PerpSeriesKind): (PerpFundingRow | PerpOpenInterestRow | PerpLiquidationRow)[] {
    return [...this.data[kind].values()];
  }

  get size(): number {
    return this.data.funding.size + this.data.openInterest.size + this.data.liquidations.size;
  }

  async commitRun(commit: PerpCommit): Promise<PerpCommitResult> {
    const run = commit.run;
    const priorRunId = this.runsByKey.get(run.idempotencyKey);
    if (priorRunId !== undefined && this.runs.get(priorRunId)?.status !== "FAILED") {
      const replay: PerpCommitResult = {
        runId: priorRunId,
        created: false,
        inserted: emptyKindCounts(),
        duplicates: emptyKindCounts(),
        revisionConflicts: 0,
        cursorsUpdated: 0,
        rejectedRows: 0,
      };
      this.commits.push(replay);
      return replay;
    }

    const inserted = emptyKindCounts();
    const duplicates = emptyKindCounts();
    let rejectedRows = 0;
    let revisionConflicts = 0;
    // Atomarität: Ziel-Maps kopiert schreiben, erst bei Erfolg übernehmen.
    const staging: Record<PerpSeriesKind, Map<string, PerpFundingRow | PerpOpenInterestRow | PerpLiquidationRow>> = {
      funding: new Map(this.data.funding),
      openInterest: new Map(this.data.openInterest),
      liquidations: new Map(this.data.liquidations),
    };
    for (const kind of run.kinds) {
      const rows = kind === "funding" ? commit.batch.funding : kind === "openInterest" ? commit.batch.openInterest : commit.batch.liquidations;
      for (const base of rows as readonly (PerpFundingRow | PerpOpenInterestRow | PerpLiquidationRow)[]) {
        const row = base as unknown as PerpRowView;
        const value =
          kind === "funding"
            ? row.fundingRate
            : kind === "openInterest"
              ? row.contracts ?? row.baseQuantity ?? row.quoteValue
              : row.quantityBase ?? row.notionalQuote;
        const hasMeasure = value !== null && value !== undefined;
        if (hasMeasure === (row.missingReason !== null)) {
          rejectedRows += 1;
          continue;
        }
        if (row.eventTime.getTime() > row.availableAt.getTime()) {
          rejectedRows += 1;
          continue;
        }
        const key = perpRowKey(base);
        const existing = staging[kind].get(key);
        if (existing === undefined) {
          staging[kind].set(key, base);
          inserted[kind] += 1;
          continue;
        }
        duplicates[kind] += 1;
        // Abweichender Inhalt zum selben Schlüssel: NICHT überschreiben,
        // sondern als Revision zählen (identisch zur DB-Ablage).
        if (existing.contentHash !== base.contentHash) {
          revisionConflicts += 1;
          this.revisions += 1;
        }
      }
    }

    this.data.funding = staging.funding;
    this.data.openInterest = staging.openInterest;
    this.data.liquidations = staging.liquidations;

    let cursorsUpdated = 0;
    for (const cursor of commit.cursors) {
      const key = `${cursor.venue}|${cursor.instrumentId}|${cursor.kind}`;
      const prior = this.cursors.get(key);
      const merged: PerpCursor = prior
        ? {
            ...cursor,
            watermarkEventTime: new Date(Math.max(prior.watermarkEventTime.getTime(), cursor.watermarkEventTime.getTime())),
            watermarkAvailableAt: new Date(Math.max(prior.watermarkAvailableAt.getTime(), cursor.watermarkAvailableAt.getTime())),
            consecutiveFailures: cursor.lastStatus === "OK" ? 0 : prior.consecutiveFailures + 1,
            lastStatus: prior.lastStatus === "UNSUPPORTED" && cursor.lastStatus === "OK" ? "UNSUPPORTED" : cursor.lastStatus,
            unsupportedReason: prior.unsupportedReason ?? cursor.unsupportedReason,
          }
        : cursor;
      this.cursors.set(key, merged);
      cursorsUpdated += 1;
    }

    this.runs.set(run.id, { ...run, id: run.id });
    this.runsByKey.set(run.idempotencyKey, run.id);
    const result: PerpCommitResult = {
      runId: run.id,
      created: true,
      inserted,
      duplicates,
      revisionConflicts,
      cursorsUpdated,
      rejectedRows,
    };
    this.commits.push(result);
    return result;
  }

  /** as-of-gefilterter Bestand je Reihe (wie der Store, inkl. Kürzung). */
  private async readKind<K extends PerpSeriesKind>(
    kind: K,
    query: PerpSeriesQuery
  ): Promise<readonly (PerpFundingRow & { kind: K })[]> {
    const wanted = new Set(query.instrumentIds);
    const rows = [...this.data[kind].values()]
      .filter((row) => (wanted.size === 0 || wanted.has(row.instrumentId)) && (query.venue ? row.venue === query.venue : true))
      .filter((row) => {
        const ms = row.eventTime.getTime();
        if (query.fromMs !== null && ms < query.fromMs) return false;
        if (query.toMs !== null && ms > query.toMs) return false;
        return true;
      })
      .sort((a, b) => a.eventTime.getTime() - b.eventTime.getTime());
    return filterRowsAsOf(rows, query.asOfMs) as never;
  }

  async readFunding(query: PerpSeriesQuery): Promise<readonly PerpFundingRow[]> {
    return limitRows(await this.readKind("funding", query), Math.max(1, query.limit)) as readonly PerpFundingRow[];
  }

  async readOpenInterest(query: PerpSeriesQuery): Promise<readonly PerpOpenInterestRow[]> {
    return limitRows(await this.readKind("openInterest", query), Math.max(1, query.limit)) as readonly PerpOpenInterestRow[];
  }

  async readLiquidations(query: PerpSeriesQuery): Promise<readonly PerpLiquidationRow[]> {
    return limitRows(await this.readKind("liquidations", query), Math.max(1, query.limit)) as readonly PerpLiquidationRow[];
  }

  async readCursors(scope: { venue?: string | null; instrumentIds?: readonly string[] }): Promise<readonly PerpCursor[]> {
    const wanted = scope.instrumentIds ? new Set(scope.instrumentIds) : null;
    return [...this.cursors.values()]
      .filter((cursor) => (scope.venue ? cursor.venue === scope.venue : true) && (wanted ? wanted.has(cursor.instrumentId) : true))
      .sort((a, b) => `${a.venue}${a.instrumentId}${a.kind}`.localeCompare(`${b.venue}${b.instrumentId}${b.kind}`));
  }

  async recentRuns(limit: number): Promise<readonly PerpRunRecord[]> {
    const wanted = Math.max(1, Math.min(50, Math.trunc(limit)));
    return [...this.runs.values()]
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .slice(0, wanted);
  }

  async coverage(asOfMs: number, venue?: string | null): Promise<readonly PerpCoverage[]> {
    const out: PerpCoverage[] = [];
    for (const kind of ["funding", "openInterest", "liquidations"] as const) {
      const byVenue = new Map<string, { rows: number[]; instruments: Set<string> }>();
      for (const row of this.data[kind].values()) {
        if (row.eventTime.getTime() > asOfMs || row.availableAt.getTime() > asOfMs) continue;
        if (venue && row.venue !== venue) continue;
        const entry = byVenue.get(row.venue) ?? { rows: [], instruments: new Set<string>() };
        entry.rows.push(row.eventTime.getTime());
        entry.instruments.add(row.instrumentId);
        byVenue.set(row.venue, entry);
      }
      for (const [key, entry] of [...byVenue.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        const times = entry.rows.sort((a, b) => a - b);
        out.push({
          venue: key,
          kind,
          rows: times.length,
          instruments: entry.instruments.size,
          nullRows: 0,
          invalidRows: 0,
          unknownQualityRows: 0,
          firstEventTime: times.length > 0 ? new Date(times[0]!).toISOString() : null,
          lastEventTime: times.length > 0 ? new Date(times[times.length - 1]!).toISOString() : null,
          ageMs: times.length > 0 ? Math.max(0, asOfMs - times[times.length - 1]!) : null,
        });
      }
    }
    return out;
  }

  async pruneRuns(keepLast: number): Promise<number> {
    const keep = Math.max(1, Math.min(PERP_LIMITS.maxBatches, Math.trunc(keepLast)));
    const byVenue = new Map<string, string[]>();
    for (const run of this.runs.values()) {
      const list = byVenue.get(run.venue) ?? [];
      list.push(run.id);
      byVenue.set(run.venue, list);
    }
    let pruned = 0;
    for (const ids of byVenue.values()) {
      const sorted = ids
        .map((id) => ({ id, startedAt: this.runs.get(id)?.startedAt.getTime() ?? 0 }))
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(keep);
      for (const entry of sorted) {
        this.runs.delete(entry.id);
        pruned += 1;
      }
    }
    return pruned;
  }

  /** Nur für Tests: Bestand und Cursor leeren. */
  clear(): void {
    this.data.funding.clear();
    this.data.openInterest.clear();
    this.data.liquidations.clear();
    this.cursors.clear();
    this.runs.clear();
    this.runsByKey.clear();
    this.commits.length = 0;
    this.revisions = 0;
  }
}

/** Altersangabe in Stunden (Report/CLI), `null` ohne Zeile. */
export function perpAgeHours(ageMs: number | null): number | null {
  if (ageMs === null || !Number.isFinite(ageMs)) return null;
  return Math.round((ageMs / HOUR) * 10) / 10;
}
