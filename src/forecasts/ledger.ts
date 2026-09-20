/**
 * Persistenz des Forecast-Ledgers (RMA-P3-01, v1.55.0) — Drizzle/Postgres.
 *
 * ── Append-only ─────────────────────────────────────────────────────────────
 * `forecasts` und `forecast_resolutions` werden ausschließlich beschrieben,
 * niemals aktualisiert oder gelöscht. Der Wirksstatus eines Forecasts ist
 * ABGELEITET: die jüngste Resolution (höchstes `resolution_version`) bestimmt
 * RESOLVED/VOID; ohne Resolution ist der Forecast PENDING.
 *
 * ── Idempotenz ─────────────────────────────────────────────────────────────
 *   * Forecast: `forecasts_key_unique` (idempotency_key). Ein Retry liefert
 *     die bestehende Zeile (`created: false`) und schreibt nichts erneut.
 *   * Resolution: `forecast_resolutions_outcome_hash_unique` — dasselbe
 *     Outcome wird nicht doppelt protokolliert. Die Versionszuweisung läuft
 *     unter Zeilensperre des Forecasts (`SELECT … FOR UPDATE`), damit zwei
 *     parallele Writer nicht dieselbe Version beanspruchen.
 *   * Lauf-Manifest: `forecast_resolution_runs_key_unique`.
 *
 * ── Keine stille Mutation ──────────────────────────────────────────────────
 * Ein abweichendes Outcome zum selben Forecast (Datenkorrektur, Operator)
 * überschreibt die Historie nicht, sondern erhält die nächste
 * `resolution_version` (Audit-Event `FORECAST_RE_RESOLUTION`).
 *
 * ── Fail-closed ────────────────────────────────────────────────────────────
 * DB-Fehler werden geworfen (klassifiziert), nie in leere Ergebnisse oder
 * stille Erfolge übersetzt. `null`/fehlend bleibt sichtbar.
 */

import { and, asc, desc, eq, gte, isNull, lte, sql } from "drizzle-orm";

import { db } from "../db";
import {
  forecastResolutions,
  forecastResolutionRuns,
  forecastResolverCursors,
  forecasts,
} from "../db/schema";
import { auditWrite, type AuditLevel } from "../lib/auditSink";
import {
  FORECAST_HORIZONS,
  type ForecastCategory,
  type ForecastContract,
  type ForecastHorizonId,
  type ForecastResolution,
  type ForecastStatus,
  type ForecastVoidReason,
  type ResolutionCounts,
} from "./types";
import { forecastIdempotencyKey, resolutionOutcomeHash } from "./hashes";
import type { DueForecast, ForecastLedgerPort, ForecastQueryFilter } from "./ports";

/** Audit-Senke (injizierbar; Default `auditWrite`). */
export type ForecastAuditSink = (
  event: string,
  level: AuditLevel,
  detail: Record<string, unknown>,
  opts?: Parameters<typeof auditWrite>[3]
) => Promise<unknown>;

/** Datenbank-Handle (injizierbar für Tests und Transaktionen). */
export type ForecastDb = Pick<typeof db, "select" | "insert" | "execute" | "transaction">;

export interface ForecastLedgerDeps {
  db?: ForecastDb;
  audit?: ForecastAuditSink;
  now?: () => Date;
}

/** Fehler der Ledger-Persistenz (maschinelle Codes für API/Betrieb). */
export class ForecastLedgerError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail?: Record<string, unknown>
  ) {
    super(message);
    this.name = new.target.name;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Reine Abbildungen (ohne IO testbar)
// ─────────────────────────────────────────────────────────────────────────────

/** Wirksstatus aus der Resolution-Historie ableiten (rein, deterministisch). */
export function effectiveStatus(latest: ForecastResolution | null): ForecastStatus {
  if (latest === null) return "PENDING";
  return latest.status === "RESOLVED" ? "RESOLVED" : "VOID";
}

/** Neueste Resolution einer nach Version sortierten Liste bestimmen. */
export function latestOf(
  resolutions: readonly ForecastResolution[]
): ForecastResolution | null {
  let best: ForecastResolution | null = null;
  for (const resolution of resolutions) {
    if (best === null || resolution.resolutionVersion > best.resolutionVersion) best = resolution;
  }
  return best;
}

type ForecastRow = typeof forecasts.$inferSelect;
type ResolutionRow = typeof forecastResolutions.$inferSelect;

function numericOr(value: string | number | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** DB-Zeile → Vertrag (fail-closed bei strukturellen Schäden). */
export function contractFromRow(row: ForecastRow): ForecastContract {
  const categories = row.categories as readonly string[];
  const probabilities = (row.probabilities as readonly unknown[]).map((p) => Number(p));
  const horizonId = row.horizonId as ForecastHorizonId;
  if (!Array.isArray(categories) || categories.length < 2) {
    throw new ForecastLedgerError("row:invalid-categories", `Forecast ${row.id}: Kategorien beschädigt.`, {
      forecastId: row.id,
    });
  }
  if (!probabilities.every((p) => Number.isFinite(p))) {
    throw new ForecastLedgerError("row:invalid-probabilities", `Forecast ${row.id}: Wahrscheinlichkeiten beschädigt.`, {
      forecastId: row.id,
    });
  }
  const probability = numericOr(row.probability);
  const referenceClose = numericOr(row.referenceClose);
  if (probability === null || referenceClose === null) {
    throw new ForecastLedgerError("row:invalid-numerics", `Forecast ${row.id}: Zahlenfelder beschädigt.`, {
      forecastId: row.id,
    });
  }
  return {
    agentRole: row.agentRole,
    promptVersion: row.promptVersion,
    model: row.model,
    entityType: "instrument",
    entityId: row.entityId,
    symbol: row.symbol,
    targetKind: row.targetKind as ForecastContract["targetKind"],
    categories,
    probabilities,
    targetCategory: row.targetCategory as ForecastContract["targetCategory"],
    horizonId,
    timeframe: row.timeframe as ForecastContract["timeframe"],
    asOf: row.asOf,
    referenceTime: row.referenceTime,
    referenceClose,
    resolvesAt: row.resolvesAt,
    availabilityDeadline: row.availabilityDeadline,
    regime: row.regime,
    policyVersion: row.policyVersion,
    contractVersion: row.contractVersion,
  };
}

/** DB-Zeile → Resolution. */
export function resolutionFromRow(row: ResolutionRow): ForecastResolution {
  const referenceClose = numericOr(row.referenceClose);
  const outcomeClose = numericOr(row.outcomeClose);
  return {
    forecastId: row.forecastId,
    resolutionVersion: row.resolutionVersion,
    status: row.status as ForecastResolution["status"],
    outcome:
      row.status === "RESOLVED" && row.outcomeIndex !== null
        ? {
            outcomeIndex: row.outcomeIndex,
            outcomeLabel: (row.outcomeLabel ?? "") as ForecastCategory,
            outcomeBinary: row.outcomeBinary === 1 ? 1 : 0,
            referenceClose: referenceClose ?? Number.NaN,
            outcomeClose: outcomeClose ?? Number.NaN,
          }
        : null,
    voidReason: row.voidReason as ForecastVoidReason | null,
    resolutionKind: row.resolutionKind as ForecastResolution["resolutionKind"],
    resolvedAt: row.resolvedAt,
    policyVersion: row.policyVersion,
    outcomeManifest: (row.outcomeManifest ?? {}) as Readonly<Record<string, unknown>>,
    outcomeHash: row.outcomeHash,
  };
}

function toInsertValues(
  contract: ForecastContract,
  sourceManifest: Readonly<Record<string, unknown>>,
  idempotencyKey: string
): typeof forecasts.$inferInsert {
  const probability = contract.probabilities[contract.categories.indexOf(contract.targetCategory)] ?? Number.NaN;
  if (!Number.isFinite(probability)) {
    throw new ForecastLedgerError(
      "contract:target-missing",
      "Target-Kategorie fehlt im Vektor — kein Forecast ohne Target-Wahrscheinlichkeit.",
      { entityId: contract.entityId }
    );
  }
  return {
    idempotencyKey,
    agentRole: contract.agentRole,
    promptVersion: contract.promptVersion,
    model: contract.model,
    entityType: contract.entityType,
    entityId: contract.entityId,
    symbol: contract.symbol,
    targetKind: contract.targetKind,
    categories: [...contract.categories],
    probabilities: [...contract.probabilities],
    targetCategory: contract.targetCategory,
    probability: probability.toFixed(9),
    horizonId: contract.horizonId,
    horizonMinutes: FORECAST_HORIZONS[contract.horizonId],
    timeframe: contract.timeframe,
    asOf: contract.asOf,
    referenceTime: contract.referenceTime,
    referenceClose: contract.referenceClose.toFixed(9),
    resolvesAt: contract.resolvesAt,
    availabilityDeadline: contract.availabilityDeadline,
    regime: contract.regime,
    policyVersion: contract.policyVersion,
    contractVersion: contract.contractVersion,
    sourceManifest: { ...sourceManifest },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Drizzle-Implementierung
// ─────────────────────────────────────────────────────────────────────────────

const CURSOR_ID = "resolution";

export class DrizzleForecastLedger implements ForecastLedgerPort {
  private readonly database: ForecastDb;
  private readonly audit: ForecastAuditSink;
  private readonly now: () => Date;

  constructor(deps: ForecastLedgerDeps = {}) {
    this.database = deps.db ?? (db as ForecastDb);
    this.audit = deps.audit ?? auditWrite;
    this.now = deps.now ?? (() => new Date());
  }

  private async auditEvent(
    event: string,
    level: AuditLevel,
    detail: Record<string, unknown>
  ): Promise<void> {
    await this.audit(event, level, detail, { missionId: undefined, agentId: undefined });
  }

  async recordForecast(
    contract: ForecastContract,
    sourceManifest: Readonly<Record<string, unknown>>
  ): Promise<{ created: boolean; forecastId: string }> {
    const key = forecastIdempotencyKey(contract);
    const inserted = await this.database
      .insert(forecasts)
      .values(toInsertValues(contract, sourceManifest, key))
      .onConflictDoNothing({ target: forecasts.idempotencyKey })
      .returning({ id: forecasts.id });
    if (inserted.length > 0) {
      await this.auditEvent("FORECAST_RECORDED", "INFO", {
        forecastId: inserted[0].id,
        agentRole: contract.agentRole,
        entityId: contract.entityId,
        horizonId: contract.horizonId,
        policyVersion: contract.policyVersion,
      });
      return { created: true, forecastId: inserted[0].id };
    }
    const existing = await this.database
      .select({ id: forecasts.id })
      .from(forecasts)
      .where(eq(forecasts.idempotencyKey, key))
      .limit(1);
    if (existing.length === 0) {
      // ON CONFLICT ohne Rückgabezeile und ohne Bestand — inkonsistent, laut werfen.
      throw new ForecastLedgerError("forecast:lost", "Forecast-Insert verlor die Zeile (Unique-Konflikt ohne Bestand).", {
        idempotencyKey: key,
      });
    }
    return { created: false, forecastId: existing[0].id };
  }

  async appendResolution(draft: {
    forecastId: string;
    status: "RESOLVED" | "VOID";
    outcomeIndex: number | null;
    outcomeLabel: string | null;
    outcomeBinary: 0 | 1 | null;
    referenceClose: number | null;
    outcomeClose: number | null;
    voidReason: ForecastVoidReason | null;
    resolutionKind: "AUTOMATIC" | "OPERATOR";
    resolvedAt: Date;
    policyVersion: string;
    outcomeManifest: Readonly<Record<string, unknown>>;
  }): Promise<{ created: boolean; resolutionVersion: number; outcomeHash: string }> {
    const datasetHash = typeof draft.outcomeManifest.datasetHash === "string" ? draft.outcomeManifest.datasetHash : null;
    const outcomeHash = resolutionOutcomeHash({
      forecastId: draft.forecastId,
      status: draft.status,
      outcomeIndex: draft.outcomeIndex,
      voidReason: draft.voidReason,
      referenceClose: draft.referenceClose,
      outcomeClose: draft.outcomeClose,
      datasetHash,
      policyVersion: draft.policyVersion,
    });

    return this.database.transaction(async (tx) => {
      // Zeilensperre: Versionszuweisung je Forecast serialisieren.
      const locked = await tx.execute<{ id: string }>(
        sql`SELECT "id" FROM "forecasts" WHERE "id" = ${draft.forecastId}::uuid FOR UPDATE`
      );
      if (locked.rows.length === 0) {
        throw new ForecastLedgerError("forecast:not-found", `Forecast ${draft.forecastId} existiert nicht.`, {
          forecastId: draft.forecastId,
        });
      }

      const existing = await tx
        .select()
        .from(forecastResolutions)
        .where(eq(forecastResolutions.forecastId, draft.forecastId))
        .orderBy(desc(forecastResolutions.resolutionVersion));

      const sameOutcome = existing.find((row) => row.outcomeHash === outcomeHash);
      if (sameOutcome) {
        // Idempotenz-Treffer: identisches Outcome ist bereits protokolliert.
        return { created: false, resolutionVersion: sameOutcome.resolutionVersion, outcomeHash };
      }

      const version = (existing[0]?.resolutionVersion ?? 0) + 1;
      const previous = existing[0] ?? null;
      const written = await tx
        .insert(forecastResolutions)
        .values({
          forecastId: draft.forecastId,
          resolutionVersion: version,
          status: draft.status,
          outcomeIndex: draft.outcomeIndex,
          outcomeLabel: draft.outcomeLabel,
          outcomeBinary: draft.outcomeBinary,
          referenceClose: draft.referenceClose === null ? null : draft.referenceClose.toFixed(9),
          outcomeClose: draft.outcomeClose === null ? null : draft.outcomeClose.toFixed(9),
          voidReason: draft.voidReason,
          resolutionKind: draft.resolutionKind,
          resolvedAt: draft.resolvedAt,
          policyVersion: draft.policyVersion,
          outcomeHash,
          outcomeManifest: { ...draft.outcomeManifest },
        })
        .onConflictDoNothing({ target: [forecastResolutions.forecastId, forecastResolutions.outcomeHash] })
        .returning({ id: forecastResolutions.id });

      if (written.length === 0) {
        throw new ForecastLedgerError(
          "resolution:conflict",
          "Resolution kollidierte trotz Zeilensperre — Vorgang muss wiederholt werden.",
          { forecastId: draft.forecastId, outcomeHash }
        );
      }

      const reResolution = previous !== null && previous.outcomeHash !== outcomeHash;
      await this.auditEvent(
        reResolution ? "FORECAST_RE_RESOLUTION" : draft.status === "VOID" ? "FORECAST_VOID" : "FORECAST_RESOLVED",
        reResolution || draft.status === "VOID" ? "WARN" : "INFO",
        {
          forecastId: draft.forecastId,
          resolutionVersion: version,
          status: draft.status,
          voidReason: draft.voidReason,
          resolutionKind: draft.resolutionKind,
          previousVersion: previous?.resolutionVersion ?? null,
          outcomeHash,
        }
      );
      return { created: true, resolutionVersion: version, outcomeHash };
    });
  }

  async dueForecasts(now: Date, limit: number): Promise<DueForecast[]> {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new ForecastLedgerError("query:invalid-limit", `Ungültiges Limit ${String(limit)}.`);
    }
    const rows = await this.database
      .select({ forecast: forecasts })
      .from(forecasts)
      .leftJoin(forecastResolutions, eq(forecastResolutions.forecastId, forecasts.id))
      .where(and(isNull(forecastResolutions.id), lte(forecasts.availabilityDeadline, now)))
      .orderBy(asc(forecasts.availabilityDeadline), asc(forecasts.createdAt))
      .limit(limit);
    return rows.map((row) => ({
      forecastId: row.forecast.id,
      contract: contractFromRow(row.forecast),
      latestResolution: null,
      status: "PENDING" as ForecastStatus,
    }));
  }

  async maturingForecasts(now: Date, limit: number): Promise<DueForecast[]> {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new ForecastLedgerError("query:invalid-limit", `Ungültiges Limit ${String(limit)}.`);
    }
    const rows = await this.database
      .select({ forecast: forecasts })
      .from(forecasts)
      .leftJoin(forecastResolutions, eq(forecastResolutions.forecastId, forecasts.id))
      .where(
        and(
          isNull(forecastResolutions.id),
          lte(forecasts.resolvesAt, now),
          gte(forecasts.availabilityDeadline, now)
        )
      )
      .orderBy(asc(forecasts.resolvesAt), asc(forecasts.createdAt))
      .limit(limit);
    return rows.map((row) => ({
      forecastId: row.forecast.id,
      contract: contractFromRow(row.forecast),
      latestResolution: null,
      status: "PENDING" as ForecastStatus,
    }));
  }

  async loadForecast(forecastId: string): Promise<DueForecast | null> {
    const rows = await this.database
      .select()
      .from(forecasts)
      .where(eq(forecasts.id, forecastId))
      .limit(1);
    if (rows.length === 0) return null;
    const resolutions = await this.database
      .select()
      .from(forecastResolutions)
      .where(eq(forecastResolutions.forecastId, forecastId))
      .orderBy(desc(forecastResolutions.resolutionVersion));
    const latest = resolutions[0] ? resolutionFromRow(resolutions[0]) : null;
    return {
      forecastId: rows[0].id,
      contract: contractFromRow(rows[0]),
      latestResolution: latest,
      status: effectiveStatus(latest),
    };
  }

  /**
   * Score-/List-Lesepfad: Forecasts mit Filtern (alle optional) plus jüngster
   * Resolution. Bounded: `limit` ist Pflicht und wird nie still überschritten.
   */
  async queryForecasts(
    filter: ForecastQueryFilter,
    limit: number
  ): Promise<{ rows: DueForecast[]; truncated: boolean }> {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new ForecastLedgerError("query:invalid-limit", `Ungültiges Limit ${String(limit)}.`);
    }
    const conditions = [];
    if (filter.agentRole !== undefined) conditions.push(eq(forecasts.agentRole, filter.agentRole));
    if (filter.entityId !== undefined) conditions.push(eq(forecasts.entityId, filter.entityId));
    if (filter.horizonId !== undefined) conditions.push(eq(forecasts.horizonId, filter.horizonId));
    if (filter.regime !== undefined) conditions.push(eq(forecasts.regime, filter.regime));
    if (filter.promptVersion !== undefined) conditions.push(eq(forecasts.promptVersion, filter.promptVersion));
    if (filter.fromAsOf !== undefined) conditions.push(gte(forecasts.asOf, filter.fromAsOf));
    if (filter.toAsOf !== undefined) conditions.push(lte(forecasts.asOf, filter.toAsOf));

    // Eine Zeile mehr laden als verlangt: Erreichen der Quelle wird laut
    // gemeldet (`truncated`), niemals still gekürzt.
    const rows = await this.database
      .select()
      .from(forecasts)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(forecasts.asOf), desc(forecasts.createdAt))
      .limit(limit + 1);
    const truncated = rows.length > limit;
    const kept = rows.slice(0, limit);
    if (kept.length === 0) return { rows: [], truncated };

    const ids = kept.map((row) => row.id);
    const resolutions = await this.database
      .select()
      .from(forecastResolutions)
      .where(sql`${forecastResolutions.forecastId} IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})`);
    const byForecast = new Map<string, ResolutionRow[]>();
    for (const resolution of resolutions) {
      const list = byForecast.get(resolution.forecastId) ?? [];
      list.push(resolution);
      byForecast.set(resolution.forecastId, list);
    }
    return {
      truncated,
      rows: kept.map((row) => {
        const own = byForecast.get(row.id) ?? [];
        const latest = latestOf(own.map(resolutionFromRow));
        return {
          forecastId: row.id,
          contract: contractFromRow(row),
          latestResolution: latest,
          status: effectiveStatus(latest),
        };
      }),
    };
  }

  async advanceCursor(deadline: Date, runId: string | null): Promise<Date> {
    const updatedAt = this.now();
    const result = await this.database
      .insert(forecastResolverCursors)
      .values({
        cursorId: CURSOR_ID,
        watermarkDeadline: deadline,
        lastRunId: runId,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: [forecastResolverCursors.cursorId],
        set: {
          // Monotonie: der Wasserstand bewegt sich ausschließlich vorwärts.
          watermarkDeadline: sql`GREATEST(${forecastResolverCursors.watermarkDeadline}, ${deadline})`,
          lastRunId: runId,
          updatedAt,
        },
      })
      .returning({ watermarkDeadline: forecastResolverCursors.watermarkDeadline });
    return result[0]?.watermarkDeadline ?? deadline;
  }

  async readCursor(): Promise<{ watermarkDeadline: Date; lastRunId: string | null } | null> {
    const rows = await this.database
      .select()
      .from(forecastResolverCursors)
      .where(eq(forecastResolverCursors.cursorId, CURSOR_ID))
      .limit(1);
    if (rows.length === 0) return null;
    return { watermarkDeadline: rows[0].watermarkDeadline, lastRunId: rows[0].lastRunId };
  }

  async recordRun(manifest: {
    idempotencyKey: string;
    mode: "AUTOMATIC" | "OPERATOR";
    status: "SUCCEEDED" | "FAILED";
    counts: ResolutionCounts;
    cursorBefore: { watermarkDeadline: Date | null };
    cursorAfter: { watermarkDeadline: Date | null };
    codeVersion: string;
    errorCode: string | null;
    startedAt: Date;
    finishedAt: Date;
  }): Promise<{ created: boolean; runId: string }> {
    const inserted = await this.database
      .insert(forecastResolutionRuns)
      .values({
        idempotencyKey: manifest.idempotencyKey,
        mode: manifest.mode,
        status: manifest.status,
        countsJson: { ...manifest.counts },
        cursorBefore: { ...manifest.cursorBefore },
        cursorAfter: { ...manifest.cursorAfter },
        codeVersion: manifest.codeVersion,
        errorCode: manifest.errorCode,
        startedAt: manifest.startedAt,
        finishedAt: manifest.finishedAt,
      })
      .onConflictDoNothing({ target: forecastResolutionRuns.idempotencyKey })
      .returning({ id: forecastResolutionRuns.id });
    if (inserted.length > 0) return { created: true, runId: inserted[0].id };
    const existing = await this.database
      .select({ id: forecastResolutionRuns.id })
      .from(forecastResolutionRuns)
      .where(eq(forecastResolutionRuns.idempotencyKey, manifest.idempotencyKey))
      .limit(1);
    if (existing.length === 0) {
      throw new ForecastLedgerError("run:lost", "Lauf-Manifest-Insert verlor die Zeile (Unique-Konflikt ohne Bestand).", {
        idempotencyKey: manifest.idempotencyKey,
      });
    }
    return { created: false, runId: existing[0].id };
  }

  /**
   * Betriebsdiagnose: ältester fälliger, ungelöster Forecast — Basis für
   * Lag/Staleness (`now − deadline`). `null` = kein Rückstand.
   */
  async oldestOverdue(now: Date): Promise<{ forecastId: string; availabilityDeadline: Date } | null> {
    const rows = await this.database
      .select({ forecast: forecasts })
      .from(forecasts)
      .leftJoin(forecastResolutions, eq(forecastResolutions.forecastId, forecasts.id))
      .where(and(isNull(forecastResolutions.id), lte(forecasts.availabilityDeadline, now)))
      .orderBy(asc(forecasts.availabilityDeadline))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return { forecastId: row.forecast.id, availabilityDeadline: row.forecast.availabilityDeadline };
  }
}
