/**
 * In-Memory-Ablage des Feature Stores für Tests (kein Produktionspfad).
 *
 * Implementiert denselben Port wie `DrizzleFeatureStore` (`src/features/ports.ts`)
 * und spiegelt dessen **semantische** Garantien ohne Datenbank:
 *
 *   * UNIQUE-Schlüssel je `(Feature, Version, Entity, Timeframe, Eventzeit)`;
 *   * Idempotency-Key je Materialisierungslauf: erfolgreicher Lauf ⇒ Replay,
 *     fehlgeschlagener/verworfener Lauf ⇒ neuer Versuch ersetzt das Manifest;
 *   * monotone Cursor (`GREATEST`);
 *   * Revisionen werden protokolliert, **nicht** überschrieben (und nur einmal
 *     je `(Schlüssel, eingehender Hash)`);
 *   * harte Lesegrenzen werfen, statt still zu kürzen;
 *   * `recentRuns` liefert eine Sicht je (Entity × Feature).
 *
 * Damit lassen sich Materialisierung, Cursor-Neustart, PIT-Abfrage und
 * Offline/Online-Parität **ohne Datenbank** prüfen. Die DB-Variante
 * (Constraints, Transaktion, Indizes) deckt `tests/featureStore.db.test.ts`
 * ab (Ping → Skip, wenn kein Postgres erreichbar ist).
 */
import {
  FeatureStoreError,
  FEATURE_LIMITS,
  type FeatureCoverage,
  type FeatureCursor,
  type FeatureDataRevision,
  type FeatureDefinition,
  type FeatureMaterializationRun,
  type FeatureMaterializationRunView,
  type FeatureRef,
  type FeatureSeriesScope,
  type FeatureStorePort,
  type FeatureValueKey,
  type FeatureValueRow,
  type MaterializationCommit,
  type MaterializationCommitResult,
  type MaterializationRunRecord,
} from "../../src/features";
import { valueKey } from "../../src/features/materialize";
import type { SupportedTimeframe } from "../../src/lib/marketdata/historicalStore";

export interface FeatureMemoryStoreOptions {
  /** Injizierte Uhr für `createdAt`/`updatedAt`. */
  now?: () => Date;
}

interface StoredRun {
  run: FeatureMaterializationRun;
  valuesWritten: number;
}

export class FeatureMemoryStore implements FeatureStorePort {
  readonly definitions = new Map<string, FeatureDefinition>();
  readonly values = new Map<string, FeatureValueRow>();
  readonly cursors = new Map<string, FeatureCursor>();
  readonly runs = new Map<string, StoredRun>();
  readonly revisions: FeatureDataRevision[] = [];
  /** Zähler für Diagnose und Testzusicherungen. */
  commits = 0;
  replays = 0;
  /** Wenn gesetzt, wirft jede Operation diesen Fehler (fail-closed-Test). */
  failure: Error | null = null;
  private valueIds = 0;

  constructor(private readonly opts: FeatureMemoryStoreOptions = {}) {}

  private guard(): void {
    if (this.failure) throw this.failure;
  }

  private now(): Date {
    return this.opts.now ? this.opts.now() : new Date();
  }

  private static definitionKey(featureId: string, version: number): string {
    return `${featureId}@${version}`;
  }

  private static cursorKey(featureId: string, featureVersion: number, entityId: string, timeframe: string): string {
    return `${featureId}\u0000${featureVersion}\u0000${entityId}\u0000${timeframe}`;
  }

  async registerDefinitions(
    definitions: readonly FeatureDefinition[]
  ): Promise<{ registered: number; existing: number }> {
    this.guard();
    let registered = 0;
    let existing = 0;
    for (const definition of definitions) {
      const key = FeatureMemoryStore.definitionKey(definition.featureId, definition.version);
      const stored = this.definitions.get(key);
      if (!stored) {
        this.definitions.set(key, definition);
        registered += 1;
        continue;
      }
      if (stored.definitionHash !== definition.definitionHash) {
        throw new FeatureStoreError(
          "definition:immutable",
          `Definition ${key} ist bereits mit anderem Fingerprint registriert — Definitionen sind unveränderlich.`,
          { featureId: definition.featureId, version: definition.version }
        );
      }
      existing += 1;
    }
    return { registered, existing };
  }

  async readCursors(scope: FeatureSeriesScope): Promise<readonly FeatureCursor[]> {
    this.guard();
    const entityIds = new Set(scope.entityIds);
    const featureIds = new Set(scope.refs.map((ref) => ref.featureId));
    return [...this.cursors.values()].filter(
      (cursor) =>
        entityIds.has(cursor.entityId) && featureIds.has(cursor.featureId) && cursor.timeframe === scope.timeframe
    );
  }

  async readKeys(
    scope: FeatureSeriesScope & { fromTs: Date; toTs: Date; limit: number }
  ): Promise<readonly FeatureValueKey[]> {
    this.guard();
    const entityIds = new Set(scope.entityIds);
    const refs = new Set(scope.refs.map((ref) => `${ref.featureId}@${ref.version}`));
    const rows = this.sortedRows().filter(
      (row) =>
        entityIds.has(row.entityId) &&
        refs.has(`${row.featureId}@${row.featureVersion}`) &&
        row.timeframe === scope.timeframe &&
        row.eventTime.getTime() >= scope.fromTs.getTime() &&
        row.eventTime.getTime() <= scope.toTs.getTime()
    );
    if (rows.length > scope.limit) {
      throw new FeatureStoreError(
        "value:read-limit",
        `Bestandslesung überschreitet die Grenze ${scope.limit} Zeilen — Batch verkleinern ` +
          "(eine abgeschnittene Menge würde Duplikate und Revisionen falsch klassifizieren).",
        { limit: scope.limit }
      );
    }
    return rows.map((row) => ({
      featureId: row.featureId,
      featureVersion: row.featureVersion,
      entityId: row.entityId,
      timeframe: row.timeframe,
      eventTime: row.eventTime,
      valueHash: row.valueHash,
      definitionHash: row.definitionHash,
    }));
  }

  async commitRun(commit: MaterializationCommit): Promise<MaterializationCommitResult> {
    this.guard();
    const run = commit.run;
    if (commit.values.length > FEATURE_LIMITS.batchRows) {
      throw new FeatureStoreError(
        "run:batch-too-large",
        `Batch überschreitet die harte Grenze von ${FEATURE_LIMITS.batchRows} Werten.`,
        { values: commit.values.length }
      );
    }
    const existing = [...this.runs.values()].find((entry) => entry.run.idempotencyKey === run.idempotencyKey);
    if (existing && existing.run.status === "SUCCEEDED") {
      this.replays += 1;
      return {
        runId: existing.run.id,
        created: false,
        valuesInserted: existing.valuesWritten,
        duplicates: existing.valuesWritten,
        revisionsRecorded: existing.run.counts.revisions,
      };
    }
    const runId = existing ? existing.run.id : run.id;
    if (!existing && this.runs.has(run.id)) {
      throw new FeatureStoreError("run:id-conflict", `Run-ID ${run.id} existiert bereits.`, { runId: run.id });
    }

    let inserted = 0;
    for (const draft of commit.values) {
      const key = valueKey(draft.featureId, draft.featureVersion, draft.entityId, draft.timeframe, draft.eventTime);
      if (this.values.has(key)) continue; // ON CONFLICT DO NOTHING
      this.valueIds += 1;
      this.values.set(key, {
        id: `value-${this.valueIds}`,
        runId,
        featureId: draft.featureId,
        featureVersion: draft.featureVersion,
        entityType: draft.entityType,
        entityId: draft.entityId,
        timeframe: draft.timeframe,
        dtype: draft.dtype,
        eventTime: draft.eventTime,
        availableAt: draft.availableAt,
        computedAt: draft.computedAt,
        value: draft.value,
        nullReason: draft.nullReason,
        qualityStatus: draft.qualityStatus,
        definitionHash: draft.definitionHash,
        valueHash: draft.valueHash,
        sourceManifest: draft.sourceManifest,
        createdAt: this.now(),
      });
      inserted += 1;
    }

    for (const cursor of commit.run.cursorAfter) {
      const key = FeatureMemoryStore.cursorKey(cursor.featureId, cursor.featureVersion, cursor.entityId, cursor.timeframe);
      const previous = this.cursors.get(key);
      this.cursors.set(key, {
        ...cursor,
        watermarkEventTime:
          previous && previous.watermarkEventTime.getTime() > cursor.watermarkEventTime.getTime()
            ? previous.watermarkEventTime
            : cursor.watermarkEventTime,
        watermarkAvailableAt:
          previous && previous.watermarkAvailableAt.getTime() > cursor.watermarkAvailableAt.getTime()
            ? previous.watermarkAvailableAt
            : cursor.watermarkAvailableAt,
        lastRunId: runId,
      });
    }

    let revisionsRecorded = 0;
    for (const revision of commit.revisions) {
      const duplicate = this.revisions.some(
        (known) =>
          known.featureId === revision.featureId &&
          known.featureVersion === revision.featureVersion &&
          known.entityId === revision.entityId &&
          known.timeframe === revision.timeframe &&
          known.eventTime.getTime() === revision.eventTime.getTime() &&
          known.incomingValueHash === revision.incomingValueHash
      );
      if (duplicate) continue;
      this.revisions.push({ ...revision, runId });
      revisionsRecorded += 1;
    }

    this.runs.set(runId, { run: { ...run, id: runId }, valuesWritten: inserted });
    this.commits += 1;
    return {
      runId,
      created: true,
      valuesInserted: inserted,
      duplicates: commit.values.length - inserted,
      revisionsRecorded,
    };
  }

  async recordFailedRun(run: MaterializationRunRecord): Promise<void> {
    this.guard();
    if ([...this.runs.values()].some((entry) => entry.run.idempotencyKey === run.idempotencyKey)) return;
    this.runs.set(run.id, { run, valuesWritten: run.counts.valuesWritten });
  }

  async readValues(query: {
    entities: readonly string[];
    refs: readonly FeatureRef[];
    timeframe: SupportedTimeframe;
    targetTime: Date;
    asOf: Date;
    limit: number;
  }): Promise<readonly FeatureValueRow[]> {
    this.guard();
    const entityIds = new Set(query.entities);
    const refs = new Set(query.refs.map((ref) => `${ref.featureId}@${ref.version}`));
    return this.sortedRows()
      .filter(
        (row) =>
          entityIds.has(row.entityId) &&
          refs.has(`${row.featureId}@${row.featureVersion}`) &&
          row.timeframe === query.timeframe &&
          row.eventTime.getTime() <= query.targetTime.getTime() &&
          row.availableAt.getTime() <= query.asOf.getTime()
      )
      .slice(0, Math.max(1, query.limit));
  }

  async coverage(
    scope: { refs?: readonly FeatureRef[]; timeframe?: SupportedTimeframe } = {}
  ): Promise<readonly FeatureCoverage[]> {
    this.guard();
    const refs = scope.refs ? new Set(scope.refs.map((ref) => `${ref.featureId}@${ref.version}`)) : null;
    const groups = new Map<string, FeatureValueRow[]>();
    for (const row of this.sortedRows()) {
      if (scope.timeframe && row.timeframe !== scope.timeframe) continue;
      if (refs && !refs.has(`${row.featureId}@${row.featureVersion}`)) continue;
      const key = `${row.featureId}@${row.featureVersion}\u0000${row.timeframe}`;
      const list = groups.get(key);
      if (list) list.push(row);
      else groups.set(key, [row]);
    }
    const iso = (ms: number): string => new Date(ms).toISOString();
    return [...groups.entries()]
      .map(([key, rows]) => {
        const [featureRef, timeframe] = key.split("\u0000");
        const [featureId, versionRaw] = featureRef.split("@");
        const cursorRows = [...this.cursors.values()].filter(
          (cursor) => cursor.featureId === featureId && cursor.featureVersion === Number(versionRaw) && cursor.timeframe === timeframe
        );
        const revisions = this.revisions.filter(
          (revision) =>
            revision.featureId === featureId &&
            revision.featureVersion === Number(versionRaw) &&
            revision.timeframe === timeframe
        );
        const eventTimes = rows.map((row) => row.eventTime.getTime());
        const availableTimes = rows.map((row) => row.availableAt.getTime());
        const computedTimes = rows.map((row) => row.computedAt.getTime());
        return {
          featureId,
          featureVersion: Number(versionRaw),
          timeframe,
          entityType: rows[0]?.entityType ?? "instrument",
          rows: rows.length,
          entities: new Set(rows.map((row) => row.entityId)).size,
          nullRows: rows.filter((row) => row.nullReason !== null).length,
          unknownQualityRows: rows.filter((row) => row.qualityStatus === "UNKNOWN").length,
          minEventTime: iso(Math.min(...eventTimes)),
          maxEventTime: iso(Math.max(...eventTimes)),
          maxAvailableAt: iso(Math.max(...availableTimes)),
          maxComputedAt: iso(Math.max(...computedTimes)),
          cursoredEntities: new Set(cursorRows.map((cursor) => cursor.entityId)).size,
          maxWatermark:
            cursorRows.length === 0
              ? null
              : iso(Math.max(...cursorRows.map((cursor) => cursor.watermarkEventTime.getTime()))),
          revisions: revisions.length,
        } satisfies FeatureCoverage;
      })
      .sort((a, b) => a.featureId.localeCompare(b.featureId) || a.featureVersion - b.featureVersion);
  }

  async recentRuns(limit: number): Promise<readonly FeatureMaterializationRunView[]> {
    this.guard();
    if (!Number.isInteger(limit) || limit < 1) return [];
    return [...this.runs.values()]
      .sort((a, b) => b.run.finishedAt.getTime() - a.run.finishedAt.getTime() || a.run.id.localeCompare(b.run.id))
      .slice(0, limit)
      .flatMap(({ run }) => {
        const base = {
          id: run.id,
          mode: run.mode,
          status: run.status,
          timeframe: run.timeframe,
          availabilityPolicy: run.availabilityPolicy,
          counts: run.counts,
          codeVersion: run.codeVersion,
          errorCode: run.errorCode,
          startedAt: run.startedAt.toISOString(),
          finishedAt: run.finishedAt.toISOString(),
        } satisfies Omit<FeatureMaterializationRunView, "featureRefs" | "entityCount">;
        // Eine Sicht je (Entity × Feature) — der Betrieb fragt „ist Reihe X für
        // Entity Y aktuell?“; Port-Vertrag in `src/features/ports.ts`.
        if (run.featureRefs.length === 0) return [{ ...base, featureRefs: [], entityCount: run.entityIds.length }];
        return run.featureRefs.flatMap((ref) =>
          Array.from({ length: Math.max(1, run.entityIds.length) }, () => ({
            ...base,
            featureRefs: [`${ref.featureId}@${ref.version}`],
            entityCount: 1,
          }))
        );
      });
  }

  async recentRevisions(limit: number): Promise<readonly FeatureDataRevision[]> {
    this.guard();
    if (!Number.isInteger(limit) || limit < 1) return [];
    return [...this.revisions]
      .sort((a, b) => b.detectedAt.getTime() - a.detectedAt.getTime())
      .slice(0, limit);
  }

  async pruneRuns(keepLast: number): Promise<number> {
    this.guard();
    const keep = Math.max(0, Math.floor(keepLast));
    const ordered = [...this.runs.values()].sort(
      (a, b) => b.run.finishedAt.getTime() - a.run.finishedAt.getTime() || a.run.id.localeCompare(b.run.id)
    );
    const protectedIds = new Set(ordered.slice(0, keep).map((entry) => entry.run.id));
    let pruned = 0;
    for (const entry of ordered.slice(keep)) {
      if (protectedIds.has(entry.run.id)) continue;
      const referencedByCursor = [...this.cursors.values()].some((cursor) => cursor.lastRunId === entry.run.id);
      const hasRevisions = this.revisions.some((revision) => revision.runId === entry.run.id);
      const valueless = entry.run.status === "FAILED" || entry.valuesWritten === 0;
      if (!valueless || referencedByCursor || hasRevisions) continue;
      this.runs.delete(entry.run.id);
      pruned += 1;
    }
    return pruned;
  }

  // ── Diagnose-Helfer der Tests ────────────────────────────────────────────

  /** Alle Wertzeilen einer Entity (deterministisch sortiert). */
  rowsFor(entityId: string): FeatureValueRow[] {
    return this.sortedRows().filter((row) => row.entityId === entityId);
  }

  /** Wertzeilen einer Featurereihe einer Entity (nach Eventzeit aufsteigend). */
  valuesFor(entityId: string, featureId: string, featureVersion = 1): FeatureValueRow[] {
    return this.rowsFor(entityId)
      .filter((row) => row.featureId === featureId && row.featureVersion === featureVersion)
      .sort((a, b) => a.eventTime.getTime() - b.eventTime.getTime());
  }

  /** Source-Manifeste einer Entity (dedupliziert). */
  manifestsFor(entityId: string): FeatureValueRow["sourceManifest"][] {
    const seen = new Map<string, FeatureValueRow["sourceManifest"]>();
    for (const row of this.rowsFor(entityId)) seen.set(row.sourceManifest.datasetHash, row.sourceManifest);
    return [...seen.values()];
  }

  /** Cursor einer Reihe (`null`, wenn die Reihe (noch) nicht materialisiert ist). */
  cursorOf(
    featureId: string,
    featureVersion: number,
    entityId: string,
    timeframe: SupportedTimeframe
  ): FeatureCursor | null {
    return this.cursors.get(FeatureMemoryStore.cursorKey(featureId, featureVersion, entityId, timeframe)) ?? null;
  }

  private sortedRows(): FeatureValueRow[] {
    return [...this.values.values()].sort(
      (a, b) =>
        a.featureId.localeCompare(b.featureId) ||
        a.featureVersion - b.featureVersion ||
        a.entityId.localeCompare(b.entityId) ||
        a.eventTime.getTime() - b.eventTime.getTime()
    );
  }
}
