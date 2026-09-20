/**
 * Orchestrierung des Feature Stores (RMA-P6-01, v1.53.0).
 *
 * Dieses Modul verdrahtet die reinen Bausteine (Registry, Planer, PIT-Join,
 * Paritätsvergleich) mit einer Ablage (`./ports.ts`) — und genau hier liegt der
 * **Produktionspfad**:
 *
 * ```text
 * Rohkerzen (Historical Store)
 *   → planMaterialization                (deterministisch, Look-ahead-frei)
 *   → classifyDraftsAgainstExisting      (neu / Duplikat / Revision)
 *   → commitRun                          (Manifest + Werte + Cursor, EINE Transaktion)
 *   → Point-in-Time-Abfrage / Paritätsjob
 * ```
 *
 * Die Funktionen sind ohne Datenbank testbar: die Ablage wird als Port
 * injiziert, die Uhr wird injiziert, die Rohdaten kommen über einen Leser. Es
 * gibt **keine** stille Uhr (`Date.now()` im Kern) und **keine** globalen
 * Defaults, die das Verhalten von Tests verändern könnten.
 *
 * Alle Metriken werden hier (einmal) gezählt — die Ablage schreibt Audit-Events,
 * aber keine Zähler, damit Werte nicht doppelt in die Exposition geraten.
 */
import { randomUUID } from "node:crypto";

import { auditWrite, type AuditLevel } from "../lib/auditSink";
import { APP_VERSION } from "../lib/version";
import { metricLabel, telemetry } from "../lib/telemetry";
import { SUPPORTED_TIMEFRAME_MS, type SupportedTimeframe } from "../lib/marketdata/historicalStore";
import { datasetHashOf } from "./compute";
import { emptyCounts, materializationRunKey, planMaterialization, type MaterializePlan } from "./materialize";
import { assertParityWithinLimits, compareParity, type ParityReport } from "./parity";
import { runPitQuery, type PitQueryRequest } from "./pitQuery";
import { getSliceRegistry } from "./definitions";
import type { FeatureRegistry } from "./registry";
import {
  FeatureStoreError,
  FEATURE_LIMITS,
  type FeatureDataRevision,
  type FeatureMaterializationCounts,
  type FeatureQualityStatus,
  type FeatureRef,
  type FeatureSourceManifest,
} from "./types";
import type { FeatureCoverage, FeatureStorePort, MaterializationRunRecord } from "./ports";

/** Injizierbare Audit-Senke (Default `auditWrite`, Klasse `telemetry`). */
export type FeatureServiceAudit = (
  event: string,
  level: AuditLevel,
  detail: Record<string, unknown>,
  opts?: Parameters<typeof auditWrite>[3]
) => Promise<unknown>;

/** Abhängigkeiten des Materialisierungslaufs (alle injizierbar). */
export interface MaterializeDeps {
  store: FeatureStorePort;
  registry?: FeatureRegistry;
  audit?: FeatureServiceAudit;
  /** Injizierte Uhr (Berechnungszeitpunkte, Laufzeitstempel). */
  now?: () => Date;
  /** Injizierte Run-ID (Tests: deterministisch). */
  newRunId?: () => string;
  codeVersion?: string;
}

/** Eingabe eines Materialisierungslaufs über eine Entity-Menge. */
export interface MaterializeSliceInput {
  refs: readonly FeatureRef[];
  entities: readonly string[];
  timeframe: SupportedTimeframe;
  /** Rohkerzen je Entity (vollständige Reihe, unsortiert erlaubt). */
  barsFor: (entityId: string) => readonly import("./registry").FeatureBarSource[];
  /** Materialisierungs-Horizont: nur Bars mit Schlusszeit ≤ `asOf`. */
  asOf: Date;
  availabilityPolicy: "bar_close" | "ingested";
  mode: "INCREMENTAL" | "BACKFILL";
  /** Qualitätsstatus je Bar (Source-Quality-Propagation). */
  qualityForBar?: (entityId: string, eventTimeMs: number) => FeatureQualityStatus;
  /** Zeitfenster-Grenzen des Laufs (nur für Manifest/Idempotency-Key). */
  fromTs?: Date | null;
  toTs?: Date | null;
  batchRows?: number;
  maxBatches?: number;
  /** Trockenlauf: rechnen, klassifizieren, aber nichts schreiben. */
  dryRun?: boolean;
}

/** Ergebnis eines Materialisierungslaufs. */
export interface MaterializeSliceResult {
  batches: number;
  runsCreated: number;
  runsReplayed: number;
  valuesWritten: number;
  duplicates: number;
  revisions: number;
  nullValues: number;
  skippedBeforeCursor: number;
  gapBars: number;
  /** `true`, wenn das Batch-/Laufzeitlimit erreicht wurde (weitere Läufe nötig). */
  truncated: boolean;
  /**
   * `true`, wenn mindestens ein Batch **verworfen** wurde, weil er eine
   * Rohdatenrevision berührt (siehe `FEATURE_DATA_REVISION_DETECTED`): es wurde
   * nichts geschrieben und kein Cursor fortgeschrieben. Rohdatenbasis klären
   * (Backfill-Quelle prüfen) oder eine neue Featureversion materialisieren.
   */
  revisionBlocked: boolean;
  /** Cursor-Stand nach dem Lauf je `feature@version|entity`. */
  cursors: readonly { featureId: string; version: number; entityId: string; watermarkEventTime: string }[];
  /** Definitionen, die zu einer Datenrevision geführt haben (Drift-Warnung). */
  definitionDrift: readonly string[];
  dryRun: boolean;
}

/**
 * Materialisiert einen Slice (mehrere Entities, mehrere Features) in bounded
 * Batches.
 *
 * Ablauf je Batch:
 *   1. Plan für eine Entity (`planMaterialization`) — deterministisch und
 *      Look-ahead-frei (nur geschlossene Bars, Cursor wird berücksichtigt).
 *   2. Bestandslesung + Klassifikation (neu / Duplikat / Revision).
 *   3. Atomarer Commit (Manifest + Werte + Cursor) — außer im Trockenlauf.
 *
 * Der Lauf endet, wenn alle Entities aufgebraucht sind **oder** das
 * Batch-Limit greift (`truncated: true` — ein erneuter Aufruf setzt am Cursor
 * fort, ohne Lücke und ohne Duplikat).
 *
 * @throws {FeatureStoreError} bei ungültigem Scope oder nicht registrierten
 *   Features (`FEATURE_UNKNOWN`, `FEATURE_PLAN_INVALID`, `FEATURE_SCOPE_*`).
 */
export async function materializeSlice(
  input: MaterializeSliceInput,
  deps: MaterializeDeps
): Promise<MaterializeSliceResult> {
  const registry = deps.registry ?? getSliceRegistry();
  const audit = deps.audit ?? (auditWrite as FeatureServiceAudit);
  const clock = deps.now ?? (() => new Date());
  const newRunId = deps.newRunId ?? (() => randomUUID());
  const codeVersion = deps.codeVersion ?? APP_VERSION;
  const batchRows = Math.max(1, Math.min(input.batchRows ?? FEATURE_LIMITS.batchRows, FEATURE_LIMITS.batchRows));
  const maxBatches = Math.max(1, Math.min(input.maxBatches ?? FEATURE_LIMITS.maxBatches, FEATURE_LIMITS.maxBatches));

  if (input.entities.length === 0) {
    throw new FeatureStoreError("FEATURE_SCOPE_EMPTY", "Mindestens eine Entity ist Pflicht.");
  }
  if (input.entities.length > FEATURE_LIMITS.materializeEntities) {
    throw new FeatureStoreError(
      "FEATURE_SCOPE_LIMIT",
      `Maximal ${FEATURE_LIMITS.materializeEntities} Entities je Lauf (erhalten: ${input.entities.length}).`,
      { entities: input.entities.length }
    );
  }
  if (input.refs.length === 0) {
    throw new FeatureStoreError("FEATURE_SCOPE_EMPTY", "Mindestens ein Feature ist Pflicht.");
  }
  for (const entityId of input.entities) {
    if (entityId.length > FEATURE_LIMITS.entityIdLength || !/^[\x20-\x7E]{1,64}$/.test(entityId)) {
      throw new FeatureStoreError("FEATURE_SCOPE_INVALID", "Entity-ID ist unzulässig (druckbares ASCII, max. 64 Zeichen).");
    }
  }

  const ordered = registry.topoOrder(input.refs);
  const requestedRefs: FeatureRef[] = ordered.map((def) => ({ featureId: def.featureId, version: def.version }));

  if (!input.dryRun) {
    await deps.store.registerDefinitions(ordered);
  }

  const result: MaterializeSliceResult = {
    batches: 0,
    runsCreated: 0,
    runsReplayed: 0,
    valuesWritten: 0,
    duplicates: 0,
    revisions: 0,
    nullValues: 0,
    skippedBeforeCursor: 0,
    gapBars: 0,
    truncated: false,
    revisionBlocked: false,
    cursors: [],
    definitionDrift: [],
    dryRun: input.dryRun === true,
  };
  const cursorOut: { featureId: string; version: number; entityId: string; watermarkEventTime: string }[] = [];
  const drift = new Set<string>();

  const entities = [...input.entities].sort();
  for (let round = 0; round < maxBatches; round++) {
    let progressed = false;
    let anyTruncated = false;
    for (const entityId of entities) {
      const bars = input.barsFor(entityId);
      const cursors = await deps.store.readCursors({ entityIds: [entityId], refs: requestedRefs, timeframe: input.timeframe });
      const plan = planMaterialization({
        registry,
        refs: requestedRefs,
        entityId,
        timeframe: input.timeframe,
        bars,
        asOf: input.asOf.getTime(),
        cursors,
        availabilityPolicy: input.availabilityPolicy,
        computedAt: clock(),
        maxRows: batchRows,
        qualityForBar: input.qualityForBar ? (eventTimeMs) => input.qualityForBar!(entityId, eventTimeMs) : undefined,
      });
      if (plan.drafts.length === 0) {
        if (plan.truncated) anyTruncated = true;
        continue;
      }
      progressed = true;
      result.batches += 1;
      result.truncated = result.truncated || plan.truncated;
      anyTruncated = anyTruncated || plan.truncated;

      const outcome = await commitPlan(plan, {
        deps,
        registry,
        audit,
        entityId,
        timeframe: input.timeframe,
        availabilityPolicy: input.availabilityPolicy,
        mode: input.mode,
        codeVersion,
        fromTs: input.fromTs ?? null,
        toTs: input.toTs ?? null,
        runId: newRunId(),
        startedAt: clock(),
        dryRun: input.dryRun === true,
      });
      result.runsCreated += outcome.created;
      result.runsReplayed += outcome.replayed;
      result.valuesWritten += outcome.counts.valuesWritten;
      result.duplicates += outcome.counts.duplicates;
      result.revisions += outcome.counts.revisions;
      result.nullValues += outcome.counts.nullValues;
      result.skippedBeforeCursor += outcome.counts.skippedBeforeCursor;
      result.gapBars += outcome.counts.gapBars;
      if (outcome.blockedRevision) {
        result.revisionBlocked = true;
        await audit(
          "FEATURE_DATA_REVISION_REJECTED",
          "WARN",
          {
            featureId: outcome.blockedRevision.featureId,
            version: outcome.blockedRevision.featureVersion,
            entityId: outcome.blockedRevision.entityId,
            timeframe: outcome.blockedRevision.timeframe,
            eventTime: outcome.blockedRevision.eventTime.toISOString(),
            existingValueHash: outcome.blockedRevision.existingValueHash,
            incomingValueHash: outcome.blockedRevision.incomingValueHash,
            code: "FEATURE_DATA_REVISION_DETECTED",
            hint:
              "Der Batch wurde verworfen: derselbe Wertschlüssel hat einen anderen Inhalt (Rohdatenrevision). " +
              "Historische Werte bleiben unverändert; Cursor bleibt stehen.",
          },
          { auditClass: "telemetry" }
        );
      }
      for (const key of outcome.definitionDrift) drift.add(key);
      for (const cursor of plan.cursors) {
        cursorOut.push({
          featureId: cursor.featureId,
          version: cursor.featureVersion,
          entityId: cursor.entityId,
          watermarkEventTime: cursor.watermarkEventTime.toISOString(),
        });
      }
    }
    if (!progressed || !anyTruncated) break;
  }

  result.cursors = cursorOut;
  result.definitionDrift = [...drift].sort();
  if (result.definitionDrift.length > 0) {
    await audit(
      "FEATURE_DEFINITION_DRIFT_DETECTED",
      "WARN",
      {
        definitionDrift: result.definitionDrift,
        timeframe: input.timeframe,
        hint:
          "Gespeicherte Werte stammen von einer anderen Definition als der heute registrierten. " +
          "Neue Semantik braucht eine neue Featureversion und einen Backfill; historische Werte bleiben unverändert.",
      },
      { auditClass: "telemetry" }
    );
  }
  telemetry.features.materializationRuns.inc({
    result: input.dryRun ? "dry_run" : result.runsCreated > 0 ? "ok" : result.runsReplayed > 0 ? "replayed" : "noop",
    mode: metricLabel(input.mode),
  });
  return result;
}

/** Ein Commit je Plan (oder Trockenlauf-Klassifikation ohne Write). */
async function commitPlan(
  plan: MaterializePlan,
  ctx: {
    deps: MaterializeDeps;
    registry: FeatureRegistry;
    audit: FeatureServiceAudit;
    entityId: string;
    timeframe: SupportedTimeframe;
    availabilityPolicy: "bar_close" | "ingested";
    mode: "INCREMENTAL" | "BACKFILL";
    codeVersion: string;
    fromTs: Date | null;
    toTs: Date | null;
    runId: string;
    startedAt: Date;
    dryRun: boolean;
  }
): Promise<{
  created: number;
  replayed: number;
  counts: FeatureMaterializationCounts;
  definitionDrift: readonly string[];
  blockedRevision: FeatureDataRevision | null;
}> {
  const counts = emptyCounts();
  const eventTimes = plan.drafts.map((draft) => draft.eventTime.getTime());
  const fromTs = new Date(Math.min(...eventTimes));
  const toTs = new Date(Math.max(...eventTimes));
  const existing = await ctx.deps.store.readKeys({
    entityIds: [ctx.entityId],
    refs: plan.drafts.map((draft) => ({ featureId: draft.featureId, version: draft.featureVersion })),
    timeframe: ctx.timeframe,
    fromTs,
    toTs,
    limit: Math.max(1, plan.drafts.length + 1),
  });
  const { classifyDraftsAgainstExisting } = await import("./materialize");
  const classified = classifyDraftsAgainstExisting(plan.drafts, existing, ctx.registry);

  const blocked = classified.revision;
  counts.valuesWritten = classified.written.length;
  counts.duplicates = classified.duplicates;
  counts.revisions = blocked === null ? 0 : 1;
  counts.nullValues = classified.written.filter((draft) => draft.value === null).length;
  counts.barsConsidered = plan.counts.barsConsidered;
  counts.skippedBeforeCursor = plan.counts.skippedBeforeCursor;
  counts.gapBars = plan.counts.gapBars;

  for (const draft of classified.written) {
    telemetry.features.materializationValues.inc({
      result: draft.value === null ? "null_value" : "written",
      reason: metricLabel(draft.nullReason ?? draft.featureId),
    });
  }
  if (blocked) {
    // Fail-closed: der Batch berührt eine Rohdatenrevision ⇒ es wird NICHTS
    // geschrieben, der Cursor bleibt stehen, der Befund wird protokolliert.
    telemetry.features.materializationValues.inc({ result: "revision", reason: metricLabel(blocked.featureId) });
  }
  if (classified.duplicates > 0) {
    telemetry.features.materializationValues.inc({ result: "duplicate", reason: "existing" }, classified.duplicates);
  }

  if (ctx.dryRun) {
    return { created: 0, replayed: 0, counts, definitionDrift: [], blockedRevision: blocked };
  }

  const definitionHashes: Record<string, string> = {};
  for (const def of ctx.registry.topoOrder(
    plan.drafts.map((draft) => ({ featureId: draft.featureId, version: draft.featureVersion }))
  )) {
    definitionHashes[`${def.featureId}@${def.version}`] = def.definitionHash;
  }
  const datasetHashes: Record<string, string> = {};
  const sourceManifests: Record<string, FeatureSourceManifest> = {};
  if (plan.sourceManifest) {
    datasetHashes[ctx.entityId] = plan.sourceManifest.datasetHash;
    sourceManifests[ctx.entityId] = plan.sourceManifest;
  }

  const run: MaterializationRunRecord = {
    id: ctx.runId,
    idempotencyKey: materializationRunKey({
      registry: ctx.registry,
      refs: plan.drafts.map((draft) => ({ featureId: draft.featureId, version: draft.featureVersion })),
      entityIds: [ctx.entityId],
      timeframe: ctx.timeframe,
      availabilityPolicy: ctx.availabilityPolicy,
      mode: ctx.mode,
      fromTs: fromTs.getTime(),
      toTs: toTs.getTime(),
      datasetHashes,
      codeVersion: ctx.codeVersion,
    }),
    mode: ctx.mode,
    status: blocked === null ? "SUCCEEDED" : "FAILED",
    timeframe: ctx.timeframe,
    availabilityPolicy: ctx.availabilityPolicy,
    featureRefs: plan.cursors.map((cursor) => ({ featureId: cursor.featureId, version: cursor.featureVersion })),
    entityIds: [ctx.entityId],
    fromTs,
    toTs,
    counts,
    definitionHashes,
    sourceManifests,
    cursorBefore: [],
    // Bei einem verworfenen Lauf wird der Cursor NICHT fortgeschrieben.
    cursorAfter: blocked === null ? plan.cursors : [],
    codeVersion: ctx.codeVersion,
    errorCode: blocked === null ? null : "FEATURE_DATA_REVISION_DETECTED",
    startedAt: ctx.startedAt,
    finishedAt: ctx.deps.now ? ctx.deps.now() : new Date(),
  };

  const outcome = await ctx.deps.store.commitRun({
    run,
    values: blocked === null ? classified.written : [],
    revisions: blocked === null ? [] : [{ ...blocked, runId: null }],
  });
  if (!outcome.created) {
    // Replay: es wurde nichts geschrieben. `counts.duplicates` stammt aus der
    // Klassifikation dieses Plans (identische Werte zum selben Schlüssel) —
    // das Replay-Ergebnis NICHT noch einmal addieren, sonst doppelt gezählt.
    counts.valuesWritten = 0;
  }
  return {
    created: outcome.created ? 1 : 0,
    replayed: outcome.created ? 0 : 1,
    counts,
    definitionDrift: classified.definitionDrift.map((ref) => `${ref.featureId}@${ref.version}`),
    blockedRevision: blocked,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Betriebssicht
// ─────────────────────────────────────────────────────────────────────────────

/** Status einer Featurereihe für die Read-API (Abdeckung + Lag). */
export interface FeatureStatusView extends FeatureCoverage {
  label: string;
  dtype: string;
  unit: string | null;
  /** Definition ist registriert (Registry) — `false` = Store kennt eine alte Version. */
  registered: boolean;
  definitionHash: string | null;
  /**
   * **Materialisierungs-Rückstand** in ms gegenüber dem jüngsten zu `now`
   * abgeschlossenen Bar: `max(0, now − timeframe − maxEventTime)`.
   * `0` = die Reihe ist aktuell; `null` = es gibt (noch) keine Werte.
   */
  lagMs: number | null;
}

/** Statusbericht des Feature Stores (bounded, ohne Entity-IDs). */
export interface FeatureStoreStatus {
  codeVersion: string;
  generatedAt: string;
  timeframe: SupportedTimeframe;
  definitions: readonly {
    featureId: string;
    version: number;
    label: string;
    dtype: string;
    unit: string | null;
    timeframe: string;
    lookbackBars: number;
    dependencies: readonly string[];
    owner: string;
    definitionHash: string;
    codeHash: string;
    configHash: string;
  }[];
  series: readonly FeatureStatusView[];
  runs: Awaited<ReturnType<FeatureStorePort["recentRuns"]>>;
  revisions: Awaited<ReturnType<FeatureStorePort["recentRevisions"]>>;
}

/**
 * Betriebsbericht: Definitionen, Abdeckung, Lag, jüngste Läufe und
 * protokollierte Revisionen. Bewusst **ohne** Entity-IDs in Labels/Metriken
 * (Kardinalitätsregel) — Entities erscheinen ausschließlich in Detailfeldern.
 */
export async function featureStoreStatus(deps: {
  store: FeatureStorePort;
  registry?: FeatureRegistry;
  timeframe?: SupportedTimeframe;
  now?: () => Date;
  runLimit?: number;
  revisionLimit?: number;
}): Promise<FeatureStoreStatus> {
  const registry = deps.registry ?? getSliceRegistry();
  const now = deps.now ?? (() => new Date());
  const timeframe = deps.timeframe ?? registry.definitions()[0]?.timeframe ?? "1h";
  const coverage = await deps.store.coverage({ timeframe });
  const runs = await deps.store.recentRuns(deps.runLimit ?? 10);
  const revisions = await deps.store.recentRevisions(deps.revisionLimit ?? 10);
  const nowMs = now().getTime();
  const byKey = new Map(coverage.map((row) => [`${row.featureId}@${row.featureVersion}`, row]));

  const series: FeatureStatusView[] = [];
  for (const def of registry.definitions()) {
    const view = byKey.get(`${def.featureId}@${def.version}`);
    byKey.delete(`${def.featureId}@${def.version}`);
    series.push({
      featureId: def.featureId,
      featureVersion: def.version,
      timeframe: def.timeframe,
      entityType: def.entityType,
      rows: view?.rows ?? 0,
      entities: view?.entities ?? 0,
      nullRows: view?.nullRows ?? 0,
      unknownQualityRows: view?.unknownQualityRows ?? 0,
      minEventTime: view?.minEventTime ?? null,
      maxEventTime: view?.maxEventTime ?? null,
      maxAvailableAt: view?.maxAvailableAt ?? null,
      maxComputedAt: view?.maxComputedAt ?? null,
      cursoredEntities: view?.cursoredEntities ?? 0,
      maxWatermark: view?.maxWatermark ?? null,
      revisions: view?.revisions ?? 0,
      label: def.label,
      dtype: def.dtype,
      unit: def.unit,
      registered: true,
      definitionHash: def.definitionHash,
      lagMs:
        view?.maxEventTime === null || view?.maxEventTime === undefined
          ? null
          : Math.max(0, nowMs - SUPPORTED_TIMEFRAME_MS[def.timeframe] - Date.parse(view.maxEventTime)),
    });
  }
  // Reihen im Store, die (noch) nicht in der Registry stehen: sichtbar machen,
  // nicht verstecken (Rollback-/Vorversions-Diagnose).
  for (const row of byKey.values()) {
    series.push({
      ...row,
      label: "(nicht registriert)",
      dtype: "unknown",
      unit: null,
      registered: false,
      definitionHash: null,
      lagMs: row.maxEventTime
        ? Math.max(0, nowMs - SUPPORTED_TIMEFRAME_MS[timeframe] - Date.parse(row.maxEventTime))
        : null,
    });
  }
  return {
    codeVersion: APP_VERSION,
    generatedAt: now().toISOString(),
    timeframe,
    definitions: registry.definitions().map((def) => ({
      featureId: def.featureId,
      version: def.version,
      label: def.label,
      dtype: def.dtype,
      unit: def.unit,
      timeframe: def.timeframe,
      lookbackBars: def.lookbackBars,
      dependencies: def.dependencies.map((dep) => `${dep.featureId}@${dep.version}`),
      owner: def.owner,
      definitionHash: def.definitionHash,
      codeHash: def.codeHash,
      configHash: def.configHash,
    })),
    series,
    runs,
    revisions,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Paritätsjob
// ─────────────────────────────────────────────────────────────────────────────

/** Eingabe des Paritätsvergleichs für eine Entity. */
export interface ParityCheckInput {
  refs: readonly FeatureRef[];
  entityId: string;
  timeframe: SupportedTimeframe;
  bars: readonly import("./registry").FeatureBarSource[];
  asOf: Date;
  /** Zeitraum, in dem gespeicherte Zeilen verglichen werden. */
  fromTs: Date;
  toTs: Date;
  availabilityPolicy?: "bar_close" | "ingested";
  maxRows?: number;
}

/** Ergebnis eines Paritätsvergleichs (Report + Umfang). */
export interface ParityCheckResult {
  report: ParityReport;
  offlineDrafts: number;
  storedRows: number;
}

/**
 * Vergleicht offline berechnete Werte (Politik `bar_close`, Backtest-Sicht) mit
 * den im Store liegenden Werten derselben Definitionsfingerprints.
 *
 * Der Vergleich ist **inhaltlich** (`valueHash`): identische Rohdaten ergeben
 * identische Werte; jede Abweichung wird mit Grund gemeldet (`VALUE_MISMATCH`,
 * `DATASET_REVISION`, `MISSING_STORED`, `DEFINITION_MISMATCH`).
 */
export async function parityCheck(
  input: ParityCheckInput,
  deps: { store: FeatureStorePort; registry?: FeatureRegistry; now?: () => Date }
): Promise<ParityCheckResult> {
  const registry = deps.registry ?? getSliceRegistry();
  const ordered = registry.topoOrder(input.refs);
  const refs: FeatureRef[] = ordered.map((def) => ({ featureId: def.featureId, version: def.version }));
  const plan = planMaterialization({
    registry,
    refs,
    entityId: input.entityId,
    timeframe: input.timeframe,
    bars: input.bars,
    asOf: input.asOf.getTime(),
    availabilityPolicy: input.availabilityPolicy ?? "bar_close",
    computedAt: deps.now ? deps.now() : new Date(),
    maxRows: Math.max(1, Math.min(input.maxRows ?? FEATURE_LIMITS.batchRows, FEATURE_LIMITS.batchRows)),
  });
  // Nur der **verlangte** Zeitraum wird verglichen: ein Paritätsjob über
  // `[fromTs, toTs]` darf nicht die halbe Historie als „fehlt im Store“
  // melden (der Store wird ebenfalls auf dieses Fenster gelesen).
  const windowed = plan.drafts.filter(
    (draft) => draft.eventTime.getTime() >= input.fromTs.getTime() && draft.eventTime.getTime() <= input.toTs.getTime()
  );
  const limit = FEATURE_LIMITS.pitSourceRows - 1;
  const storedKeys = await deps.store.readKeys({
    entityIds: [input.entityId],
    refs,
    timeframe: input.timeframe,
    fromTs: input.fromTs,
    toTs: input.toTs,
    limit,
  });
  assertParityWithinLimits(windowed.length, storedKeys.length);
  const storedRows = await deps.store.readValues({
    entities: [input.entityId],
    refs,
    timeframe: input.timeframe,
    // Vergleichshorizont ist `toTs`, Sichtbarkeitshorizont die `asOf` des
    // Aufrufers: sonst würde eine `ingested`-Reihe (availableAt = Schluss + 1 min)
    // am eigenen `toTs` vorbeifallen und fälschlich als „fehlt“ gelten.
    asOf: input.asOf,
    targetTime: input.toTs,
    limit,
  });
  const report = compareParity({ offline: windowed, stored: storedRows, registry, maxDivergences: 20 });
  telemetry.features.parityChecks.inc({ result: report.divergent > 0 ? "divergent" : "match" });
  return { report, offlineDrafts: windowed.length, storedRows: storedRows.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// Diagnose-Hilfen und Produktions-Read-Pfad
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Anzahl geschlossener Bars im Zeitraum (Diagnose/Coverage-Hinweis) — reine
 * Funktion, damit Betrieb und Tests dieselbe Erwartung rechnen.
 */
export function expectedBarsInRange(fromTs: number, toTs: number, timeframe: SupportedTimeframe): number {
  const step = SUPPORTED_TIMEFRAME_MS[timeframe];
  if (!Number.isFinite(step) || step <= 0 || toTs <= fromTs) return 0;
  return Math.floor((toTs - fromTs) / step) + 1;
}

/** Filtert Bars auf ein Zeitfenster (Diagnose-Hilfe, rein). */
export function barsInRange(
  bars: readonly import("./registry").FeatureBarSource[],
  fromTs: number,
  toTs: number,
  timeframe: SupportedTimeframe
): readonly import("./registry").FeatureBarSource[] {
  return bars.filter((bar) => bar.time + SUPPORTED_TIMEFRAME_MS[timeframe] >= fromTs && bar.time + SUPPORTED_TIMEFRAME_MS[timeframe] <= toTs);
}

/**
 * PIT-Abfrage über den Store (Produktionspfad der Read-API).
 *
 * @throws {FeatureStoreError} `FEATURE_UNKNOWN` (unbekanntes Feature),
 *   `FEATURE_PIT_SOURCE_TRUNCATED` (Quellgrenze erreicht).
 */
export async function pitQuery(
  request: PitQueryRequest,
  deps: { store: FeatureStorePort; registry?: FeatureRegistry; maxLagMs?: number }
) {
  const registry = deps.registry ?? getSliceRegistry();
  return runPitQuery(request, deps.store, registry, { maxLagMs: deps.maxLagMs });
}

/** Dataset-Hash einer Rohserie (Diagnose/CLI: `--print-dataset-hash`). */
export function datasetHashForDiagnostics(bars: readonly import("./registry").FeatureBarSource[]): string {
  return datasetHashOf(bars);
}

export { emptyCounts };
