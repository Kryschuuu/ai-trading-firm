/**
 * Persistenz des Feature Stores (RMA-P6-01, v1.53.0) — Drizzle/Postgres.
 *
 * ── Atomarität ─────────────────────────────────────────────────────────────
 * `commitRun` schreibt **Manifest + Werte + Revisionen + Cursor in EINER
 * Transaktion**: entweder der Batch ist vollständig (inklusive Wasserstände)
 * sichtbar oder gar nicht. Ein Absturz mitten im Lauf hinterlässt einen
 * konsistenten Cursor-Stand; ein Neustart setzt dort ohne Lücke und ohne
 * Duplikat fort.
 *
 * ── Idempotenz ─────────────────────────────────────────────────────────────
 *   * Manifest: `feature_materialization_runs_key_unique` (idempotency_key) —
 *     ein Retry mit identischen Eingaben liefert das bestehende Manifest
 *     (`created: false`) und schreibt **nichts** erneut. Weicht der Inhalt bei
 *     gleichem Key ab (andere Definitions-Fingerprints), wird fail-closed
 *     abgelehnt (`run:idempotency-conflict`).
 *   * Werte: `feature_values_key_unique` — identische Werte werden nicht
 *     erneut geschrieben (Insert-Count < erwartet ⇒ Duplikat).
 *   * Revisionen: UNIQUE über `(Schlüssel, incoming_value_hash)` — derselbe
 *     Befund wird nicht doppelt protokolliert.
 *
 * ── Kein stilles Überschreiben ────────────────────────────────────────────
 * Ein abweichender Wert zum selben Schlüssel (echte Datenrevision) wird
 * **nicht** aktualisiert: der historische Wert bleibt gültig, der Befund landet
 * in `feature_data_revisions` (Audit-Event `FEATURE_VALUE_REVISION_DETECTED`).
 *
 * ── Lesepfade ─────────────────────────────────────────────────────────────
 * Alle Reads sind mengenseitig begrenzt (`FEATURE_LIMITS`); die PIT-Abfrage
 * filtert `event_time <= target_time AND available_at <= as_of` **in SQL**
 * (Index `feature_values_pit_idx`) und wirft, statt still zu kürzen. Fehler
 * werden klassifiziert geworfen — nie in leere Ergebnismengen übersetzt
 * (fail-closed: fehlende Zeilen sind sichtbar, nicht „0“).
 */
import { and, desc, eq, gte, inArray, lte, notInArray, or, sql } from "drizzle-orm";

import { db } from "../db";
import {
  featureDataRevisions,
  featureDefinitions,
  featureMaterializationCursors,
  featureMaterializationRuns,
  featureValues,
} from "../db/schema";
import { APP_VERSION } from "../lib/version";
import { isSupportedTimeframe, type SupportedTimeframe } from "../lib/marketdata/historicalStore";
import { auditWrite, type AuditLevel } from "../lib/auditSink";
import { metricLabel, telemetry } from "../lib/telemetry";
import {
  FEATURE_HASH_PATTERN,
  FEATURE_LIMITS,
  FeatureStoreError,
  isFeatureAvailabilityPolicy,
  isFeatureDtype,
  isFeatureNullReason,
  isFeatureQualityStatus,
  type FeatureCursor,
  type FeatureDataRevision,
  type FeatureDefinition,
  type FeatureMaterializationCounts,
  type FeatureMaterializationRunView,
  type FeatureRef,
  type FeatureSourceManifest,
  type FeatureValueDraft,
  type FeatureValueRow,
} from "./types";
import type {
  FeatureCoverage,
  FeatureSeriesScope,
  FeatureStorePort,
  FeatureValueKey,
  MaterializationCommit,
  MaterializationCommitResult,
  MaterializationRunRecord,
} from "./ports";

/** Audit-Senke (injizierbar; Default `auditWrite`, Klasse `telemetry`). */
export type FeatureAuditSink = (
  event: string,
  level: AuditLevel,
  detail: Record<string, unknown>,
  opts?: Parameters<typeof auditWrite>[3]
) => Promise<unknown>;

/** Datenbank-Handle (injizierbar für Tests und Transaktionen). */
export type FeatureDb = Pick<typeof db, "select" | "insert" | "delete" | "execute" | "transaction">;

export interface FeatureStoreDeps {
  db?: FeatureDb;
  audit?: FeatureAuditSink;
  /** Zeilen je Insert-Chunk (Parameterdeckel). */
  chunkSize?: number;
  now?: () => Date;
}

/** Fehler der Persistenz (maschinelle Codes für API/Betrieb). */
export class FeaturePersistenceError extends FeatureStoreError {}

const DEFAULT_CHUNK = FEATURE_LIMITS.insertChunkRows;

// ─────────────────────────────────────────────────────────────────────────────
// Reine Abbildungen (ohne IO testbar)
// ─────────────────────────────────────────────────────────────────────────────

/** Typ der Insert-Zeile in `feature_values` (aus dem Drizzle-Schema abgeleitet). */
export type FeatureValueInsert = typeof featureValues.$inferInsert;

/**
 * Abbildung `FeatureValueDraft → Insert-Zeile`.
 *
 * Fail-closed: eine Zeile ohne Wert **und** ohne Null-Grund, oder mit einem
 * Wert, dessen Spalte nicht zum `dtype` passt, wird abgewiesen (der CHECK der
 * DB würde sonst erst nach dem Insert greifen; früher ist besser).
 */
export function draftToInsert(draft: FeatureValueDraft, runId: string | null): FeatureValueInsert {
  const hasValue = draft.value !== null;
  if (hasValue === (draft.nullReason !== null)) {
    throw new FeaturePersistenceError(
      "value:invalid",
      "Zeile muss GENAU einen Wert oder einen Null-Grund tragen (unavailable ist keine 0).",
      { featureId: draft.featureId, entityId: draft.entityId }
    );
  }
  let valueNum: string | null = null;
  let valueBool: boolean | null = null;
  let valueText: string | null = null;
  if (hasValue) {
    switch (draft.dtype) {
      case "number":
        if (typeof draft.value !== "number" || !Number.isFinite(draft.value)) {
          throw new FeaturePersistenceError("value:invalid", "number-Feature mit nicht-endlichem Wert.", {
            featureId: draft.featureId,
          });
        }
        valueNum = String(draft.value);
        break;
      case "boolean":
        if (typeof draft.value !== "boolean") {
          throw new FeaturePersistenceError("value:invalid", "boolean-Feature mit nicht-boolean Wert.", {
            featureId: draft.featureId,
          });
        }
        valueBool = draft.value;
        break;
      case "enum":
        if (typeof draft.value !== "string") {
          throw new FeaturePersistenceError("value:invalid", "enum-Feature mit nicht-String-Wert.", {
            featureId: draft.featureId,
          });
        }
        valueText = draft.value;
        break;
      default:
        throw new FeaturePersistenceError("value:invalid", `unbekannter dtype "${String(draft.dtype)}".`, {
          featureId: draft.featureId,
        });
    }
  }
  return {
    runId,
    featureId: draft.featureId,
    featureVersion: draft.featureVersion,
    entityType: draft.entityType,
    entityId: draft.entityId,
    timeframe: draft.timeframe,
    eventTime: draft.eventTime,
    availableAt: draft.availableAt,
    computedAt: draft.computedAt,
    dtype: draft.dtype,
    valueNum,
    valueBool,
    valueText,
    nullReason: draft.nullReason,
    qualityStatus: draft.qualityStatus,
    definitionHash: draft.definitionHash,
    valueHash: draft.valueHash,
    sourceManifest: draft.sourceManifest,
  };
}

function toDate(value: unknown, field: string): Date {
  if (value instanceof Date) return value;
  if (typeof value === "string") {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return new Date(ms);
  }
  throw new FeaturePersistenceError("value:invalid", `Zeitfeld "${field}" ist kein gültiger Zeitpunkt.`, { field });
}

/** Prüft ein gespeichertes Source-Manifest (fail-closed bei Beschädigung). */
export function parseSourceManifest(raw: unknown): FeatureSourceManifest {
  if (raw === null || typeof raw !== "object") {
    throw new FeaturePersistenceError("value:manifest-invalid", "source_manifest fehlt oder ist kein Objekt.");
  }
  const manifest = raw as Record<string, unknown>;
  const datasetHash = manifest.datasetHash;
  const availabilityPolicy = manifest.availabilityPolicy;
  if (typeof datasetHash !== "string" || !FEATURE_HASH_PATTERN.test(datasetHash)) {
    throw new FeaturePersistenceError("value:manifest-invalid", "source_manifest.datasetHash ist kein ds1:-Fingerprint.");
  }
  if (!isFeatureAvailabilityPolicy(availabilityPolicy)) {
    throw new FeaturePersistenceError("value:manifest-invalid", "source_manifest.availabilityPolicy ist ungültig.");
  }
  const candleCount = manifest.candleCount;
  if (typeof candleCount !== "number" || !Number.isInteger(candleCount) || candleCount < 0) {
    throw new FeaturePersistenceError("value:manifest-invalid", "source_manifest.candleCount ist keine ganze Zahl ≥ 0.");
  }
  return {
    source: typeof manifest.source === "string" ? manifest.source : "unknown",
    candleCount,
    firstEventTime: String(manifest.firstEventTime),
    lastEventTime: String(manifest.lastEventTime),
    maxIngestedAt: String(manifest.maxIngestedAt),
    datasetHash,
    availabilityPolicy,
  };
}

/** Abbildung DB-Zeile → `FeatureValueRow` (numerische Spalten kommen als String). */
export function rowToValueRow(row: typeof featureValues.$inferSelect): FeatureValueRow {
  if (!isFeatureDtype(row.dtype)) {
    throw new FeaturePersistenceError("value:invalid", `Unbekannter dtype "${String(row.dtype)}" in feature_values.`);
  }
  if (!isSupportedTimeframe(row.timeframe)) {
    throw new FeaturePersistenceError("value:invalid", `Unbekannter Timeframe "${String(row.timeframe)}" in feature_values.`);
  }
  const nullReason = row.nullReason === null ? null : isFeatureNullReason(row.nullReason) ? row.nullReason : null;
  if (row.nullReason !== null && nullReason === null) {
    throw new FeaturePersistenceError("value:invalid", `Unbekannter null_reason "${String(row.nullReason)}".`);
  }
  if (!isFeatureQualityStatus(row.qualityStatus)) {
    throw new FeaturePersistenceError("value:invalid", `Unbekannter quality_status "${String(row.qualityStatus)}".`);
  }
  let value: number | boolean | string | null = null;
  switch (row.dtype) {
    case "number":
      value = row.valueNum === null ? null : Number(row.valueNum);
      if (value !== null && !Number.isFinite(value)) {
        throw new FeaturePersistenceError("value:invalid", "value_num ist keine endliche Zahl.");
      }
      break;
    case "boolean":
      value = row.valueBool;
      break;
    case "enum":
      value = row.valueText;
      break;
  }
  if ((value === null) === (nullReason === null)) {
    throw new FeaturePersistenceError(
      "value:invalid",
      "Gespeicherte Zeile verletzt die NULL-Invariante (genau Wert oder Grund).",
      { featureId: row.featureId, entityId: row.entityId }
    );
  }
  return {
    id: row.id,
    runId: row.runId,
    featureId: row.featureId,
    featureVersion: row.featureVersion,
    entityType: "instrument",
    entityId: row.entityId,
    timeframe: row.timeframe,
    dtype: row.dtype,
    eventTime: toDate(row.eventTime, "event_time"),
    availableAt: toDate(row.availableAt, "available_at"),
    computedAt: toDate(row.computedAt, "computed_at"),
    value,
    nullReason,
    qualityStatus: row.qualityStatus,
    definitionHash: row.definitionHash,
    valueHash: row.valueHash,
    sourceManifest: parseSourceManifest(row.sourceManifest),
    createdAt: toDate(row.createdAt, "created_at"),
  };
}

function parseCounts(raw: unknown): FeatureMaterializationCounts {
  if (raw === null || typeof raw !== "object") {
    throw new FeaturePersistenceError("run:counts-invalid", "Manifest-Zähler fehlen oder sind kein Objekt.");
  }
  const counts = raw as Record<string, unknown>;
  const read = (field: keyof FeatureMaterializationCounts): number => {
    const value = counts[field];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      throw new FeaturePersistenceError("run:counts-invalid", `Manifest-Zähler "${field}" ist keine ganze Zahl ≥ 0.`, {
        field,
      });
    }
    return value;
  };
  return {
    barsConsidered: read("barsConsidered"),
    skippedBeforeCursor: read("skippedBeforeCursor"),
    gapBars: read("gapBars"),
    valuesWritten: read("valuesWritten"),
    duplicates: read("duplicates"),
    revisions: read("revisions"),
    nullValues: read("nullValues"),
  };
}

function describeDbError(error: unknown): { message: string; state?: string; constraint?: string } {
  const candidate = error as { message?: unknown; code?: unknown; constraint?: unknown };
  return {
    message: typeof candidate?.message === "string" ? candidate.message : "unbekannter Datenbankfehler",
    state: typeof candidate?.code === "string" ? candidate.code : undefined,
    constraint: typeof candidate?.constraint === "string" ? candidate.constraint : undefined,
  };
}

function cursorRows(scope: FeatureSeriesScope): { where: ReturnType<typeof and>; } {
  return {
    where: and(
      inArray(featureMaterializationCursors.entityId, [...scope.entityIds]),
      inArray(featureMaterializationCursors.featureId, [...new Set(scope.refs.map((ref) => ref.featureId))]),
      eq(featureMaterializationCursors.timeframe, scope.timeframe)
    ),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Store
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Drizzle/Postgres-Ablage des Feature Stores.
 *
 * Alle Schreibpfade laufen über `commitRun` (Transaktion, Idempotency-Key) bzw.
 * `recordFailedRun` (Manifest ohne Werte). Es gibt bewusst **kein** `UPDATE` auf
 * Wertezeilen: Werte sind append-only, Änderungen werden als Revision
 * protokolliert.
 */
export class DrizzleFeatureStore implements FeatureStorePort {
  private readonly database: FeatureDb;
  private readonly audit: FeatureAuditSink;
  private readonly chunkSize: number;
  private readonly now: () => Date;

  constructor(deps: FeatureStoreDeps = {}) {
    this.database = deps.db ?? db;
    this.audit = deps.audit ?? (auditWrite as FeatureAuditSink);
    this.chunkSize = Math.max(1, Math.min(deps.chunkSize ?? DEFAULT_CHUNK, FEATURE_LIMITS.insertChunkRows));
    this.now = deps.now ?? (() => new Date());
  }

  private async auditEvent(
    event: string,
    level: AuditLevel,
    detail: Record<string, unknown>
  ): Promise<void> {
    await this.audit(event, level, detail, { auditClass: "telemetry" });
  }

  // ── Definitionen ─────────────────────────────────────────────────────────

  /**
   * Registriert Definitionen idempotent und prüft die Unveränderlichkeit gegen
   * die Datenbank: existiert `(feature_id, version)` bereits mit einem
   * **anderen** Definitions-Fingerprint, wird geworfen (`definition:immutable`).
   * Genau das verhindert, dass eine Semantikänderung ohne Versionssprung
   * stillschweigend alte Werte „umdeutet“.
   */
  async registerDefinitions(definitions: readonly FeatureDefinition[]): Promise<{ registered: number; existing: number }> {
    if (definitions.length === 0) return { registered: 0, existing: 0 };
    let registered = 0;
    let existing = 0;
    for (const def of definitions) {
      const inserted = await this.database
        .insert(featureDefinitions)
        .values({
          featureId: def.featureId,
          version: def.version,
          label: def.label,
          description: def.description,
          dtype: def.dtype,
          enumValues: def.enumValues ? [...def.enumValues] : null,
          unit: def.unit,
          valueDecimals: def.valueDecimals,
          entityType: def.entityType,
          timeframe: def.timeframe,
          lookbackBars: def.lookbackBars,
          dependencies: def.dependencies.map((dep) => ({ featureId: dep.featureId, version: dep.version })),
          computeKey: def.computeKey,
          config: { ...def.config },
          owner: def.owner,
          codeHash: def.codeHash,
          configHash: def.configHash,
          definitionHash: def.definitionHash,
        })
        .onConflictDoNothing({ target: [featureDefinitions.featureId, featureDefinitions.version] })
        .returning({ featureId: featureDefinitions.featureId });
      if (inserted.length > 0) {
        registered += 1;
        continue;
      }
      const stored = await this.database
        .select({ definitionHash: featureDefinitions.definitionHash })
        .from(featureDefinitions)
        .where(and(eq(featureDefinitions.featureId, def.featureId), eq(featureDefinitions.version, def.version)))
        .limit(1);
      const storedHash = stored[0]?.definitionHash;
      if (storedHash !== def.definitionHash) {
        throw new FeaturePersistenceError(
          "definition:immutable",
          `Definition ${def.featureId}@${def.version} ist bereits mit anderem Fingerprint registriert ` +
            `(${String(storedHash).slice(0, 12)}… ≠ ${def.definitionHash.slice(0, 12)}…). ` +
            "Definitionen sind unveränderlich — neue Semantik braucht eine neue Version.",
          { featureId: def.featureId, version: def.version }
        );
      }
      existing += 1;
    }
    if (registered > 0) {
      await this.auditEvent("FEATURE_DEFINITIONS_REGISTERED", "INFO", {
        registered,
        existing,
        definitions: definitions.map((def) => ({
          featureId: def.featureId,
          version: def.version,
          definitionHash: def.definitionHash,
          owner: def.owner,
        })),
        codeVersion: APP_VERSION,
      });
    }
    return { registered, existing };
  }

  // ── Cursor / Bestand ─────────────────────────────────────────────────────

  async readCursors(scope: FeatureSeriesScope): Promise<readonly FeatureCursor[]> {
    if (scope.entityIds.length === 0 || scope.refs.length === 0) return [];
    const rows = await this.database
      .select({
        featureId: featureMaterializationCursors.featureId,
        featureVersion: featureMaterializationCursors.featureVersion,
        entityId: featureMaterializationCursors.entityId,
        timeframe: featureMaterializationCursors.timeframe,
        watermarkEventTime: featureMaterializationCursors.watermarkEventTime,
        watermarkAvailableAt: featureMaterializationCursors.watermarkAvailableAt,
        lastRunId: featureMaterializationCursors.lastRunId,
      })
      .from(featureMaterializationCursors)
      .where(cursorRows(scope).where);
    return rows
      .filter((row): row is typeof row & { timeframe: SupportedTimeframe } => isSupportedTimeframe(row.timeframe))
      .map((row) => ({
        featureId: row.featureId,
        featureVersion: row.featureVersion,
        entityId: row.entityId,
        timeframe: row.timeframe,
        watermarkEventTime: toDate(row.watermarkEventTime, "watermark_event_time"),
        watermarkAvailableAt: toDate(row.watermarkAvailableAt, "watermark_available_at"),
        lastRunId: row.lastRunId,
      }));
  }

  /**
   * Liest vorhandene Wertezeilen (nur Schlüssel + Fingerprints) im Zeitfenster.
   *
   * Begrenzung: die Anfrage liest `limit + 1` Zeilen; ist die Grenze erreicht,
   * wirft die Methode (`value:read-limit`) — eine stillschweigend
   * abgeschnittene Menge würde die Duplikat-/Revisionsklassifikation
   * verfälschen.
   */
  async readKeys(
    scope: FeatureSeriesScope & { fromTs: Date; toTs: Date; limit: number }
  ): Promise<readonly FeatureValueKey[]> {
    if (scope.entityIds.length === 0 || scope.refs.length === 0) return [];
    const rows = await this.database
      .select({
        featureId: featureValues.featureId,
        featureVersion: featureValues.featureVersion,
        entityId: featureValues.entityId,
        timeframe: featureValues.timeframe,
        eventTime: featureValues.eventTime,
        valueHash: featureValues.valueHash,
        definitionHash: featureValues.definitionHash,
      })
      .from(featureValues)
      .where(
        and(
          inArray(featureValues.entityId, [...scope.entityIds]),
          inArray(featureValues.featureId, [...new Set(scope.refs.map((ref) => ref.featureId))]),
          eq(featureValues.timeframe, scope.timeframe),
          gte(featureValues.eventTime, scope.fromTs),
          lte(featureValues.eventTime, scope.toTs)
        )
      )
      .limit(scope.limit + 1);
    if (rows.length > scope.limit) {
      throw new FeaturePersistenceError(
        "value:read-limit",
        `Bestandslesung überschreitet die Grenze ${scope.limit} Zeilen — Batch verkleinern ` +
          "(eine abgeschnittene Menge würde Duplikate und Revisionen falsch klassifizieren).",
        { limit: scope.limit }
      );
    }
    return rows
      .filter((row): row is typeof row & { timeframe: SupportedTimeframe } => isSupportedTimeframe(row.timeframe))
      .map((row) => ({
        featureId: row.featureId,
        featureVersion: row.featureVersion,
        entityId: row.entityId,
        timeframe: row.timeframe,
        eventTime: toDate(row.eventTime, "event_time"),
        valueHash: row.valueHash,
        definitionHash: row.definitionHash,
      }));
  }

  // ── Atomarer Schreibpfad ─────────────────────────────────────────────────

  /**
   * Schreibt Manifest + Werte + Revisionen + Cursor in **einer** Transaktion.
   *
   * Reihenfolge in der Transaktion:
   *   1. Idempotency-Key prüfen (Replay ⇒ bestehendes Ergebnis, kein Write);
   *   2. Manifest einfügen (Run-ID-Kollision ⇒ `run:id-conflict`);
   *   3. Werte in Chunks einfügen (`ON CONFLICT DO NOTHING` als Race-Schutz);
   *   4. Revisionen protokollieren (ebenfalls idempotent);
   *   5. Cursor monoton fortschreiben (`GREATEST` — ein Rücksprung wäre ein
   *      stiller Doppel-Schreibpfad).
   */
  async commitRun(commit: MaterializationCommit): Promise<MaterializationCommitResult> {
    const run = commit.run;
    if (commit.values.length > FEATURE_LIMITS.batchRows) {
      throw new FeaturePersistenceError(
        "run:batch-too-large",
        `Batch überschreitet die harte Grenze von ${FEATURE_LIMITS.batchRows} Werten.`,
        { values: commit.values.length }
      );
    }
    const existingRun = await this.findRunByIdempotencyKey(run.idempotencyKey);
    if (existingRun) {
      const existingKeys = Object.keys(existingRun.definitionHashes);
      const incomingKeys = Object.keys(run.definitionHashes);
      const comparable = existingKeys.length > 0 && incomingKeys.length > 0;
      const same =
        JSON.stringify(existingKeys.sort().map((key) => [key, existingRun.definitionHashes[key]])) ===
        JSON.stringify(incomingKeys.sort().map((key) => [key, run.definitionHashes[key]]));
      if (comparable && !same) {
        throw new FeaturePersistenceError(
          "run:idempotency-conflict",
          `Idempotency-Key ${run.idempotencyKey.slice(0, 16)}… ist mit anderen Definitions-Fingerprints belegt — ` +
            "kein sicheres Replay möglich.",
          { runId: existingRun.id }
        );
      }
    }
    if (existingRun && existingRun.status === "SUCCEEDED") {
      // Replay: der Lauf ist vollständig und erfolgreich abgeschlossen — es wird
      // nichts geschrieben (kein zweiter Wert je Schlüssel, keine Revision).
      return {
        runId: existingRun.id,
        created: false,
        valuesInserted: existingRun.valuesWritten,
        duplicates: existingRun.valuesWritten,
        revisionsRecorded: existingRun.revisions,
      };
    }
    // Kein bestehender Lauf **oder** ein fehlgeschlagener/verworfener: der neue
    // Versuch ersetzt das alte Manifest (gleiche Zeile, gleiche Run-ID), damit
    // transiente Fehler und Revisionen wiederholbar bleiben, ohne die Historie
    // der Revisionen (FK auf die Run-ID) zu verlieren.
    const runId = existingRun?.id ?? run.id;

    let result: MaterializationCommitResult;
    try {
      result = await this.database.transaction(async (tx) => {
        const clash = await tx
          .select({ id: featureMaterializationRuns.id })
          .from(featureMaterializationRuns)
          .where(eq(featureMaterializationRuns.id, run.id))
          .limit(1);
        if (clash[0] && clash[0].id !== runId) {
          throw new FeaturePersistenceError("run:id-conflict", `Run-ID ${run.id} existiert bereits.`, { runId: run.id });
        }
        await tx.insert(featureMaterializationRuns).values({
          id: runId,
          idempotencyKey: run.idempotencyKey,
          mode: run.mode,
          status: run.status,
          timeframe: run.timeframe,
          availabilityPolicy: run.availabilityPolicy,
          featureRefs: run.featureRefs.map((ref) => `${ref.featureId}@${ref.version}`),
          entityIds: [...run.entityIds],
          fromTs: run.fromTs,
          toTs: run.toTs,
          countsJson: run.counts,
          definitionHashes: { ...run.definitionHashes },
          sourceManifests: { ...run.sourceManifests },
          cursorBefore: run.cursorBefore,
          cursorAfter: run.cursorAfter,
          codeVersion: run.codeVersion,
          errorCode: run.errorCode,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
        }).onConflictDoUpdate({
          target: [featureMaterializationRuns.idempotencyKey],
          set: {
            status: run.status,
            countsJson: run.counts,
            definitionHashes: { ...run.definitionHashes },
            sourceManifests: { ...run.sourceManifests },
            cursorAfter: run.cursorAfter,
            codeVersion: run.codeVersion,
            errorCode: run.errorCode,
            startedAt: run.startedAt,
            finishedAt: run.finishedAt,
          },
        });

        let inserted = 0;
        for (let i = 0; i < commit.values.length; i += this.chunkSize) {
          const chunk = commit.values.slice(i, i + this.chunkSize).map((draft) => draftToInsert(draft, runId));
          if (chunk.length === 0) continue;
          const written = await tx
            .insert(featureValues)
            .values(chunk)
            .onConflictDoNothing()
            .returning({ id: featureValues.id });
          inserted += written.length;
        }

        for (const cursor of run.cursorAfter) {
          const updatedAt = this.now();
          await tx
            .insert(featureMaterializationCursors)
            .values({
              featureId: cursor.featureId,
              featureVersion: cursor.featureVersion,
              entityId: cursor.entityId,
              timeframe: cursor.timeframe,
              watermarkEventTime: cursor.watermarkEventTime,
              watermarkAvailableAt: cursor.watermarkAvailableAt,
              lastRunId: runId,
              updatedAt,
            })
            .onConflictDoUpdate({
              target: [
                featureMaterializationCursors.featureId,
                featureMaterializationCursors.featureVersion,
                featureMaterializationCursors.entityId,
                featureMaterializationCursors.timeframe,
              ],
              set: {
                watermarkEventTime: sql`GREATEST(${featureMaterializationCursors.watermarkEventTime}, ${cursor.watermarkEventTime})`,
                watermarkAvailableAt: sql`GREATEST(${featureMaterializationCursors.watermarkAvailableAt}, ${cursor.watermarkAvailableAt})`,
                lastRunId: runId,
                updatedAt,
              },
            });
        }

        if (commit.revisions.length > 0) {
          await tx
            .insert(featureDataRevisions)
            .values(
              commit.revisions.map((revision) => ({
                featureId: revision.featureId,
                featureVersion: revision.featureVersion,
                entityId: revision.entityId,
                timeframe: revision.timeframe,
                eventTime: revision.eventTime,
                existingValueHash: revision.existingValueHash,
                incomingValueHash: revision.incomingValueHash,
                runId,
                detectedAt: revision.detectedAt,
              }))
            )
            .onConflictDoNothing();
        }

        return {
          runId,
          created: true,
          valuesInserted: inserted,
          duplicates: commit.values.length - inserted,
          revisionsRecorded: commit.revisions.length,
        };
      });
    } catch (error) {
      if (error instanceof FeatureStoreError) throw error;
      const described = describeDbError(error);
      await this.auditEvent("FEATURE_MATERIALIZATION_FAILED", "WARN", {
        runId,
        timeframe: run.timeframe,
        code: "run:db-error",
        sqlState: described.state,
        constraint: described.constraint,
        message: described.message,
      });
      telemetry.features.materializationRuns.inc({ result: "failed", mode: metricLabel(run.mode) });
      throw new FeaturePersistenceError(
        "run:db-error",
        `Write in feature_values/feature_materialization_runs fehlgeschlagen: ${described.message}`,
        { sqlState: described.state, constraint: described.constraint }
      );
    }

    if (commit.revisions.length > 0) {
      await this.auditEvent("FEATURE_VALUE_REVISION_DETECTED", "WARN", {
        revisions: commit.revisions.length,
        // Keine Entity-IDs als Metrik-Label; im Audit-Detail sind sie begrenzt
        // und für die Nachvollziehbarkeit erforderlich.
        samples: commit.revisions.slice(0, 10).map((revision) => ({
          featureId: revision.featureId,
          version: revision.featureVersion,
          entityId: revision.entityId,
          eventTime: revision.eventTime.toISOString(),
        })),
        timeframe: run.timeframe,
        hint: "Historische Werte bleiben unverändert — Rohdatenrevision prüfen und ggf. neue Featureversion materialisieren.",
        codeVersion: APP_VERSION,
      });
    }
    await this.auditEvent("FEATURE_MATERIALIZATION_COMPLETED", "INFO", {
      runId,
      mode: run.mode,
      timeframe: run.timeframe,
      availabilityPolicy: run.availabilityPolicy,
      counts: run.counts,
      valuesInserted: result.valuesInserted,
      entityCount: run.entityIds.length,
      codeVersion: run.codeVersion,
    });
    return result;
  }

  /** Manifest eines fehlgeschlagenen (oder verworfenen) Laufs ohne Werte. */
  async recordFailedRun(run: MaterializationRunRecord): Promise<void> {
    await this.database
      .insert(featureMaterializationRuns)
      .values({
        id: run.id,
        idempotencyKey: run.idempotencyKey,
        mode: run.mode,
        status: run.status,
        timeframe: run.timeframe,
        availabilityPolicy: run.availabilityPolicy,
        featureRefs: run.featureRefs.map((ref) => `${ref.featureId}@${ref.version}`),
        entityIds: [...run.entityIds],
        fromTs: run.fromTs,
        toTs: run.toTs,
        countsJson: run.counts,
        definitionHashes: { ...run.definitionHashes },
        sourceManifests: { ...run.sourceManifests },
        cursorBefore: run.cursorBefore,
        cursorAfter: run.cursorAfter,
        codeVersion: run.codeVersion,
        errorCode: run.errorCode,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
      })
      .onConflictDoNothing({ target: [featureMaterializationRuns.idempotencyKey] });
    await this.auditEvent("FEATURE_MATERIALIZATION_FAILED", "WARN", {
      runId: run.id,
      mode: run.mode,
      timeframe: run.timeframe,
      code: run.errorCode,
      codeVersion: run.codeVersion,
    });
    telemetry.features.materializationRuns.inc({ result: "failed", mode: metricLabel(run.mode) });
  }

  // ── Lesepfade ────────────────────────────────────────────────────────────

  /**
   * Zeilen für eine PIT-Abfrage. Der Filter `event_time <= targetTime` und
   * `available_at <= asOf` steht **in SQL** — die Look-ahead-Regel gilt damit
   * auch dann, wenn eine Abfrage über einen anderen Pfad kommt.
   */
  async readValues(query: {
    entities: readonly string[];
    refs: readonly FeatureRef[];
    timeframe: SupportedTimeframe;
    targetTime: Date;
    asOf: Date;
    limit: number;
  }): Promise<readonly FeatureValueRow[]> {
    if (query.entities.length === 0 || query.refs.length === 0) return [];
    const rows = await this.database
      .select()
      .from(featureValues)
      .where(
        and(
          inArray(featureValues.entityId, [...query.entities]),
          inArray(featureValues.featureId, [...new Set(query.refs.map((ref) => ref.featureId))]),
          eq(featureValues.timeframe, query.timeframe),
          lte(featureValues.eventTime, query.targetTime),
          lte(featureValues.availableAt, query.asOf)
        )
      )
      .limit(query.limit);
    const refKeys = new Set(query.refs.map((ref) => `${ref.featureId}@${ref.version}`));
    return rows
      .filter((row) => refKeys.has(`${row.featureId}@${row.featureVersion}`))
      .map((row) => rowToValueRow(row));
  }

  /**
   * Abdeckung je Featurereihe: Zeilen, Entities, NULL-Anteil, Qualität, jüngste
   * Event-/Verfügbarkeitszeit, Cursor-Wasserstand und Revisionszähler.
   * Ausschließlich Aggregate — keine Entity-IDs (Kardinalitätsregel).
   */
  async coverage(
    scope: { refs?: readonly FeatureRef[]; timeframe?: SupportedTimeframe } = {}
  ): Promise<readonly FeatureCoverage[]> {
    const valueConditions = [];
    if (scope.timeframe) valueConditions.push(eq(featureValues.timeframe, scope.timeframe));
    if (scope.refs && scope.refs.length > 0) {
      valueConditions.push(inArray(featureValues.featureId, [...new Set(scope.refs.map((ref) => ref.featureId))]));
    }
    const aggregates = await this.database
      .select({
        featureId: featureValues.featureId,
        featureVersion: featureValues.featureVersion,
        timeframe: featureValues.timeframe,
        entityType: featureValues.entityType,
        rows: sql<number>`count(*)::int`,
        entities: sql<number>`count(distinct ${featureValues.entityId})::int`,
        nullRows: sql<number>`count(*) filter (where ${featureValues.nullReason} is not null)::int`,
        unknownQualityRows: sql<number>`count(*) filter (where ${featureValues.qualityStatus} = 'UNKNOWN')::int`,
        minEventTime: sql<Date | string | null>`min(${featureValues.eventTime})`,
        maxEventTime: sql<Date | string | null>`max(${featureValues.eventTime})`,
        maxAvailableAt: sql<Date | string | null>`max(${featureValues.availableAt})`,
        maxComputedAt: sql<Date | string | null>`max(${featureValues.computedAt})`,
      })
      .from(featureValues)
      .where(valueConditions.length > 0 ? and(...valueConditions) : undefined)
      .groupBy(featureValues.featureId, featureValues.featureVersion, featureValues.timeframe, featureValues.entityType);

    const cursorConditions = [];
    if (scope.timeframe) cursorConditions.push(eq(featureMaterializationCursors.timeframe, scope.timeframe));
    if (scope.refs && scope.refs.length > 0) {
      cursorConditions.push(
        inArray(featureMaterializationCursors.featureId, [...new Set(scope.refs.map((ref) => ref.featureId))])
      );
    }
    const cursors = await this.database
      .select({
        featureId: featureMaterializationCursors.featureId,
        featureVersion: featureMaterializationCursors.featureVersion,
        timeframe: featureMaterializationCursors.timeframe,
        cursoredEntities: sql<number>`count(*)::int`,
        maxWatermark: sql<Date | string | null>`max(${featureMaterializationCursors.watermarkEventTime})`,
      })
      .from(featureMaterializationCursors)
      .where(cursorConditions.length > 0 ? and(...cursorConditions) : undefined)
      .groupBy(
        featureMaterializationCursors.featureId,
        featureMaterializationCursors.featureVersion,
        featureMaterializationCursors.timeframe
      );

    const revisionConditions = [];
    if (scope.timeframe) revisionConditions.push(eq(featureDataRevisions.timeframe, scope.timeframe));
    if (scope.refs && scope.refs.length > 0) {
      revisionConditions.push(inArray(featureDataRevisions.featureId, [...new Set(scope.refs.map((ref) => ref.featureId))]));
    }
    const revisions = await this.database
      .select({
        featureId: featureDataRevisions.featureId,
        featureVersion: featureDataRevisions.featureVersion,
        timeframe: featureDataRevisions.timeframe,
        revisions: sql<number>`count(*)::int`,
      })
      .from(featureDataRevisions)
      .where(revisionConditions.length > 0 ? and(...revisionConditions) : undefined)
      .groupBy(featureDataRevisions.featureId, featureDataRevisions.featureVersion, featureDataRevisions.timeframe);

    const cursorByKey = new Map(cursors.map((row) => [`${row.featureId}@${row.featureVersion}\u0000${row.timeframe}`, row]));
    const revisionByKey = new Map(revisions.map((row) => [`${row.featureId}@${row.featureVersion}\u0000${row.timeframe}`, row]));
    const iso = (value: Date | string | null): string | null => (value === null ? null : toDate(value, "coverage").toISOString());

    return aggregates
      .map((row) => {
        const key = `${row.featureId}@${row.featureVersion}\u0000${row.timeframe}`;
        const cursor = cursorByKey.get(key);
        return {
          featureId: row.featureId,
          featureVersion: row.featureVersion,
          timeframe: row.timeframe,
          entityType: row.entityType,
          rows: row.rows,
          entities: row.entities,
          nullRows: row.nullRows,
          unknownQualityRows: row.unknownQualityRows,
          minEventTime: iso(row.minEventTime),
          maxEventTime: iso(row.maxEventTime),
          maxAvailableAt: iso(row.maxAvailableAt),
          maxComputedAt: iso(row.maxComputedAt),
          cursoredEntities: cursor?.cursoredEntities ?? 0,
          maxWatermark: iso(cursor?.maxWatermark ?? null),
          revisions: revisionByKey.get(key)?.revisions ?? 0,
        } satisfies FeatureCoverage;
      })
      .sort((a, b) => a.featureId.localeCompare(b.featureId) || a.featureVersion - b.featureVersion);
  }

  /** Jüngste Materialisierungsläufe (Sicht ohne Manifest-Blobs). */
  async recentRuns(limit: number): Promise<readonly FeatureMaterializationRunView[]> {
    if (!Number.isInteger(limit) || limit < 1) return [];
    const rows = await this.database
      .select({
        id: featureMaterializationRuns.id,
        mode: featureMaterializationRuns.mode,
        status: featureMaterializationRuns.status,
        timeframe: featureMaterializationRuns.timeframe,
        availabilityPolicy: featureMaterializationRuns.availabilityPolicy,
        featureRefs: featureMaterializationRuns.featureRefs,
        entityIds: featureMaterializationRuns.entityIds,
        countsJson: featureMaterializationRuns.countsJson,
        codeVersion: featureMaterializationRuns.codeVersion,
        errorCode: featureMaterializationRuns.errorCode,
        startedAt: featureMaterializationRuns.startedAt,
        finishedAt: featureMaterializationRuns.finishedAt,
      })
      .from(featureMaterializationRuns)
      .orderBy(desc(featureMaterializationRuns.finishedAt))
      .limit(limit);
    return rows
      .filter((row) => isSupportedTimeframe(row.timeframe))
      .flatMap((row) => {
        const base = {
          id: row.id,
          mode: (row.mode === "BACKFILL" ? "BACKFILL" : "INCREMENTAL") as FeatureMaterializationRunView["mode"],
          status: (row.status === "FAILED" ? "FAILED" : "SUCCEEDED") as FeatureMaterializationRunView["status"],
          timeframe: row.timeframe as SupportedTimeframe,
          availabilityPolicy: isFeatureAvailabilityPolicy(row.availabilityPolicy) ? row.availabilityPolicy : "ingested",
          counts: parseCounts(row.countsJson),
          codeVersion: row.codeVersion,
          errorCode: row.errorCode,
          startedAt: toDate(row.startedAt, "started_at").toISOString(),
          finishedAt: toDate(row.finishedAt, "finished_at").toISOString(),
        } satisfies Omit<FeatureMaterializationRunView, "featureRefs" | "entityCount">;
        const featureRefs = Array.isArray(row.featureRefs) ? row.featureRefs : [];
        const entityCount = Array.isArray(row.entityIds) ? row.entityIds.length : 0;
        // Eine Sicht je (Entity × Feature): der Betrieb fragt „ist Reihe X für
        // Entity Y aktuell?“ — ein Lauf über n Features/Entities erscheint also
        // n-mal (siehe Port-Vertrag `recentRuns`).
        if (featureRefs.length === 0) return [{ ...base, featureRefs, entityCount }];
        return featureRefs.flatMap((ref) =>
          Array.from({ length: Math.max(1, entityCount) }, () => ({ ...base, featureRefs: [ref], entityCount: 1 }))
        );
      });
  }

  /** Jüngste protokollierte Datenrevisionen. */
  async recentRevisions(limit: number): Promise<readonly FeatureDataRevision[]> {
    if (!Number.isInteger(limit) || limit < 1) return [];
    const rows = await this.database
      .select()
      .from(featureDataRevisions)
      .orderBy(desc(featureDataRevisions.detectedAt))
      .limit(limit);
    return rows
      .filter((row): row is typeof row & { timeframe: SupportedTimeframe } => isSupportedTimeframe(row.timeframe))
      .map((row) => ({
        featureId: row.featureId,
        featureVersion: row.featureVersion,
        entityId: row.entityId,
        timeframe: row.timeframe,
        eventTime: toDate(row.eventTime, "event_time"),
        existingValueHash: row.existingValueHash,
        incomingValueHash: row.incomingValueHash,
        detectedAt: toDate(row.detectedAt, "detected_at"),
        runId: row.runId,
      }));
  }

  /**
   * Retention der Betriebsmetadaten: entfernt ausschließlich **wertfreie**
   * Manifeste (`FAILED` oder `valuesWritten = 0`), die nicht neuester Stand
   * sind und auf die kein Cursor zeigt. Wertezeilen und Revisionen werden nie
   * gelöscht — sie sind die Wahrheitsquelle.
   */
  async pruneRuns(keepLast: number): Promise<number> {
    const keep = Math.max(0, Math.floor(keepLast));
    const newest = this.database
      .select({ id: featureMaterializationRuns.id })
      .from(featureMaterializationRuns)
      .orderBy(desc(featureMaterializationRuns.finishedAt))
      .limit(keep);
    const deleted = await this.database
      .delete(featureMaterializationRuns)
      .where(
        and(
          notInArray(featureMaterializationRuns.id, newest),
          or(
            eq(featureMaterializationRuns.status, "FAILED"),
            sql`(${featureMaterializationRuns.countsJson} ->> 'valuesWritten') = '0'`
          ),
          sql`not exists (select 1 from feature_materialization_cursors where last_run_id = ${featureMaterializationRuns.id})`,
          // Revisionen referenzieren ihren Lauf (FK): ein Manifest mit
          // protokollierter Revision ist Teil der Nachvollziehbarkeit und bleibt.
          sql`not exists (select 1 from feature_data_revisions where run_id = ${featureMaterializationRuns.id})`
        )
      )
      .returning({ id: featureMaterializationRuns.id });
    if (deleted.length > 0) {
      await this.auditEvent("FEATURE_MATERIALIZATION_RUNS_PRUNED", "INFO", {
        pruned: deleted.length,
        keepLast: keep,
        codeVersion: APP_VERSION,
      });
    }
    return deleted.length;
  }

  private async findRunByIdempotencyKey(
    idempotencyKey: string
  ): Promise<{
    id: string;
    status: string;
    valuesWritten: number;
    revisions: number;
    definitionHashes: Record<string, string>;
  } | null> {
    const rows = await this.database
      .select({
        id: featureMaterializationRuns.id,
        status: featureMaterializationRuns.status,
        definitionHashes: featureMaterializationRuns.definitionHashes,
        countsJson: featureMaterializationRuns.countsJson,
      })
      .from(featureMaterializationRuns)
      .where(eq(featureMaterializationRuns.idempotencyKey, idempotencyKey))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    const counts = (row.countsJson ?? {}) as Record<string, unknown>;
    return {
      id: row.id,
      status: row.status,
      valuesWritten: typeof counts.valuesWritten === "number" ? counts.valuesWritten : 0,
      revisions: typeof counts.revisions === "number" ? counts.revisions : 0,
      definitionHashes: (row.definitionHashes ?? {}) as Record<string, string>,
    };
  }
}

/** Prozessweiter Store des Produktionspfads (lazy, injizierbar für Tests). */
let defaultStore: DrizzleFeatureStore | null = null;

export function getFeatureStore(): DrizzleFeatureStore {
  defaultStore ??= new DrizzleFeatureStore();
  return defaultStore;
}

/** Setzt den Prozess-Store zurück (nur Tests/Debug). */
export function resetFeatureStoreForTests(): void {
  defaultStore = null;
}
