/**
 * Trade-PnL-Attribution — Persistenz & Auswertung (RMA-P1-06, v1.57.0).
 *
 * ── Append-only ─────────────────────────────────────────────────────────────
 * `trade_attributions` und `trade_attribution_entries` werden ausschließlich
 * eingefügt. Die SQL-Migration blockiert UPDATE/DELETE/TRUNCATE auf DB-Ebene
 * (Trigger `trade_attribution_immutable`). Eine Korrektur erfolgt als NEUE
 * Zeile mit neuer Methodenversion — historische Ergebnisse bleiben erhalten.
 *
 * ── Idempotenz ──────────────────────────────────────────────────────────────
 * UNIQUE (journal_id, method_version) am Kopf + UNIQUE (attribution_id,
 * source_type, source_id) an den Posten + eine Transaktion: Retries, Doppel-
 * Ticks und Prozess-Restarts erzeugen keine zweite Attribution. Ein Retry
 * liefert die bestehende Zeile als `created: false` zurück.
 *
 * ── Fail-closed ────────────────────────────────────────────────────────────
 * Invaliden Eingaben (NaN-PnL, unbekannte Methodenversion) wird NICHT
 * persistiert — sie werfen AttributionError und bleiben über das Audit-Event
 * JOURNAL_ATTRIBUTION_FAILED sichtbar. Ein UNATTRIBUTABLE-Ergebnis wird
 * hingegen PERSISTIERT (sichtbare Lücke mit geschlossenem Grund, z. B.
 * SNAPSHOT_SCHEMA_V1 für Altzeilen) — historische Zeilen werden nie mit
 * geschätzten Quellen gefüllt.
 *
 * ── Kein Einfluss auf den Handelspfad ───────────────────────────────────────
 * Alle Schreibfunktionen werden ausschließlich nach Abschluss des Closes
 * aufgerufen (completeJournalRow) bzw. vom Backfill-CLI; Fehler können den
 * Close nicht mehr blockieren (Aufrufer fängt).
 */

import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";

import { db } from "../db";
import {
  positions as positionsTable,
  tradeAttributionEntries,
  tradeAttributions,
  tradeJournal,
} from "../db/schema";
import { auditWrite, flagMissedAudit } from "../lib/auditSink";
import { telemetry } from "../lib/telemetry";
import { computeTradeAttribution } from "./model";
import {
  ATTRIBUTION_DECLARATION,
  AttributionError,
  type AttributionStatus,
  type TradeAttribution,
} from "./types";

export type { AttributionStatus };

/** Bounded Grenzen der Read-API (keine unbeschränkten Payloads). */
export const ATTRIBUTION_LIMITS = {
  defaultListLimit: 50,
  maxListLimit: 200,
  /** Obergrenze des Backfill-Batches pro Lauf (Restart-sicher, klein halten). */
  maxBackfillBatch: 1000,
  defaultBackfillBatch: 500,
} as const;

// ── Schreibpfad ─────────────────────────────────────────────────────────────

export interface RecordAttributionInput {
  journalId: string;
  positionId: string;
  /** Ereigniszeit des Closes (Journal closed_at). */
  closedAt: Date;
  symbol: string;
  side: "LONG" | "SHORT";
  regime: string;
  /** Realisiertes PnL der Buchungsquelle (Journal `pnl`, vor Gebühren). */
  grossPnl: number;
  fees: number | null;
  funding: number | null;
  slippage?: number | null;
  /** Entry-Decision-Snapshot der Journal-Zeile (v1 oder v2). */
  snapshot: unknown;
  /** Default: konfigurierte Methodenversion (TRADE_ATTRIBUTION_METHOD_VERSION). */
  methodVersion?: number;
  now?: Date;
}

export interface RecordAttributionResult {
  created: boolean;
  /** true, wenn (journal_id, method_version) bereits existierte (Idempotenz). */
  duplicate: boolean;
  status: AttributionStatus;
  methodVersion: number;
  attributionId: string | null;
  unattributableReason: string | null;
}

/**
 * Berechnet und persistiert die Attribution eines geschlossenen Trades —
 * idempotent pro (journal_id, method_version), atomar in einer Transaktion.
 * Wirft bei invaliden Eingaben (AttributionError); UNATTRIBUTABLE-Ergebnisse
 * werden persistiert (sichtbare Lücke). Audit: JOURNAL_ATTRIBUTED (nur bei
 * tatsächlich neuer ATTRIBUTED-Zeile — Duplikate und Lücken spammen nicht).
 */
export async function recordTradeAttribution(
  input: RecordAttributionInput
): Promise<RecordAttributionResult> {
  const methodVersion = input.methodVersion ?? 1;
  if (!Number.isInteger(methodVersion) || methodVersion < 1) {
    throw new AttributionError("invalid-method-version", "Methodenversion muss ≥ 1 sein.");
  }

  const result = computeTradeAttribution({
    methodVersion,
    symbol: input.symbol,
    side: input.side,
    grossPnl: input.grossPnl,
    fees: input.fees,
    funding: input.funding,
    slippage: input.slippage ?? null,
    snapshot: input.snapshot,
  });

  // Idempotenz-Vorprüfung (der Unique-Index fängt Rassen zusätzlich ab).
  const [existing] = await db
    .select({ id: tradeAttributions.id, status: tradeAttributions.status })
    .from(tradeAttributions)
    .where(
      and(
        eq(tradeAttributions.journalId, input.journalId),
        eq(tradeAttributions.methodVersion, methodVersion)
      )
    )
    .limit(1);
  if (existing) {
    telemetry.attribution.captures.inc({ result: "duplicate" });
    return {
      created: false,
      duplicate: true,
      status: existing.status as AttributionStatus,
      methodVersion,
      attributionId: existing.id,
      unattributableReason: null,
    };
  }

  const inserted = await db.transaction(async (tx) => {
    const [header] = await tx
      .insert(tradeAttributions)
      .values({
        journalId: input.journalId,
        positionId: input.positionId,
        methodVersion,
        status: result.status,
        unattributableReason: result.unattributableReason,
        snapshotHash: result.snapshotHash,
        snapshotSchemaVersion: result.snapshotSchemaVersion,
        symbol: result.symbol,
        side: result.side,
        regime: input.regime || "UNKNOWN",
        closedAt: input.closedAt,
        pnlGross: num(result.grossPnl),
        fees: result.fees === null ? null : num(result.fees),
        funding: result.funding === null ? null : num(result.funding),
        slippageMemo: result.slippageMemo === null ? null : num(result.slippageMemo),
        pnlNet: num(result.netPnl),
        sourcesSum: num(result.sourcesSum),
        costsSum: num(result.costsSum),
        residual: num(result.residual),
        unknownCosts: [...result.unknownCosts],
        participants: result.participants,
        abstentions: result.abstentions,
        computedAt: input.now ?? new Date(),
      })
      .onConflictDoNothing({
        target: [tradeAttributions.journalId, tradeAttributions.methodVersion],
      })
      .returning({ id: tradeAttributions.id });
    if (!header) return null; // Rasse verloren: existierende Zeile gilt.
    if (result.entries.length > 0) {
      await tx
        .insert(tradeAttributionEntries)
        .values(
          result.entries.map((entry) => ({
            attributionId: header.id,
            sourceType: entry.sourceType,
            sourceId: entry.sourceId.slice(0, 200),
            sourceVersion: entry.sourceVersion.slice(0, 100),
            role: entry.role,
            alignment: entry.alignment,
            weight: entry.weight === null ? null : num(entry.weight),
            contribution: num(entry.contribution),
          }))
        )
        .onConflictDoNothing({
          target: [
            tradeAttributionEntries.attributionId,
            tradeAttributionEntries.sourceType,
            tradeAttributionEntries.sourceId,
          ],
        });
    }
    return header;
  });

  if (!inserted) {
    telemetry.attribution.captures.inc({ result: "duplicate" });
    return {
      created: false,
      duplicate: true,
      status: result.status,
      methodVersion,
      attributionId: null,
      unattributableReason: result.unattributableReason,
    };
  }

  telemetry.attribution.captures.inc({
    result: result.status === "ATTRIBUTED" ? "attributed" : "unattributable",
  });

  if (result.status === "ATTRIBUTED") {
    await attributionAudit("JOURNAL_ATTRIBUTED", "INFO", {
      journalId: input.journalId,
      positionId: input.positionId,
      methodVersion,
      declaration: ATTRIBUTION_DECLARATION,
      status: result.status,
      sources: result.participants,
      abstentions: result.abstentions,
      netPnl: round8(result.netPnl),
      sourcesSum: round8(result.sourcesSum),
      costsSum: round8(result.costsSum),
      residual: round8(result.residual),
      unknownCosts: [...result.unknownCosts],
      via: "journal",
    });
  }

  return {
    created: true,
    duplicate: false,
    status: result.status,
    methodVersion,
    attributionId: inserted.id,
    unattributableReason: result.unattributableReason,
  };
}

// ── Lesepfad: Details ───────────────────────────────────────────────────────

export interface AttributionFilter {
  symbol?: string;
  regime?: string;
  status?: AttributionStatus;
  methodVersion?: number;
  /** Zeitraum-Filter auf die Ereigniszeit (closed_at), inklusiv. */
  from?: Date;
  to?: Date;
}

export interface AttributionDetailRow {
  id: string;
  journalId: string;
  positionId: string;
  methodVersion: number;
  status: AttributionStatus;
  unattributableReason: string | null;
  snapshotHash: string;
  snapshotSchemaVersion: number;
  symbol: string;
  side: "LONG" | "SHORT";
  regime: string;
  closedAt: string;
  declaration: typeof ATTRIBUTION_DECLARATION;
  pnlGross: number;
  fees: number | null;
  funding: number | null;
  slippageMemo: number | null;
  pnlNet: number;
  sourcesSum: number;
  costsSum: number;
  residual: number;
  unknownCosts: string[];
  participants: number;
  abstentions: number;
  entries?: Array<{
    sourceType: string;
    sourceId: string;
    sourceVersion: string;
    role: string | null;
    alignment: number;
    weight: number | null;
    contribution: number;
  }>;
}

/**
 * Bounded Detailabfrage: neueste Closes zuerst (closed_at DESC, id als
 * Tiebreak), hart geklemmtes Limit, `truncated` zeigt das Erreichen der
 * Grenze laut an. `includeEntries` liefert die Beitragsposten je Zeile.
 */
export async function queryTradeAttributions(
  filter: AttributionFilter,
  limit: number,
  includeEntries: boolean
): Promise<{ rows: AttributionDetailRow[]; truncated: boolean }> {
  const bounded = Math.max(1, Math.min(ATTRIBUTION_LIMITS.maxListLimit, Math.trunc(limit)));
  const where = buildFilter(filter);
  const rows = await db
    .select()
    .from(tradeAttributions)
    .where(where)
    .orderBy(desc(tradeAttributions.closedAt), desc(tradeAttributions.id))
    .limit(bounded + 1);

  const truncated = rows.length > bounded;
  const page = rows.slice(0, bounded);
  const out: AttributionDetailRow[] = page.map(headerFromRow);

  if (includeEntries && page.length > 0) {
    const ids = page.map((r) => r.id);
    const entryRows = await db
      .select()
      .from(tradeAttributionEntries)
      .where(inArray(tradeAttributionEntries.attributionId, ids))
      .orderBy(asc(tradeAttributionEntries.sourceType), asc(tradeAttributionEntries.sourceId));
    const byAttribution = new Map<string, AttributionDetailRow["entries"]>();
    for (const e of entryRows) {
      const list = byAttribution.get(e.attributionId) ?? [];
      list.push({
        sourceType: e.sourceType,
        sourceId: e.sourceId,
        sourceVersion: e.sourceVersion,
        role: e.role,
        alignment: e.alignment,
        weight: e.weight === null ? null : Number(e.weight),
        contribution: Number(e.contribution),
      });
      byAttribution.set(e.attributionId, list);
    }
    for (const row of out) {
      row.entries = byAttribution.get(row.id) ?? [];
    }
  }
  return { rows: out, truncated };
}

// ── Lesepfad: Aggregation ───────────────────────────────────────────────────

export type AttributionDimension = "agent" | "rule" | "regime" | "cost";

export const ATTRIBUTION_DIMENSIONS: readonly AttributionDimension[] = [
  "agent",
  "rule",
  "regime",
  "cost",
] as const;

export interface AttributionGroup {
  key: string;
  /** Anzahl der Attributionen mit Beiträgen dieser Quelle bzw. in diesem Regime. */
  trades: number;
  /** Summierte Beiträge (Kontowährung). */
  contributionSum: number;
}

export interface AttributionAggregate {
  dimension: AttributionDimension;
  declaration: typeof ATTRIBUTION_DECLARATION;
  methodVersion: number | null;
  groups: AttributionGroup[];
  totals: {
    attributions: number;
    attributed: number;
    unattributable: number;
    netSum: number;
    sourcesSum: number;
    costsSum: number;
    residualSum: number;
    feesSum: number | null;
    fundingSum: number | null;
  };
  /** Coverage gegen die Journal-Zeilen desselben Zeitraums (Scheingenauigkeitsschutz). */
  coverage: {
    closedTrades: number;
    attributedTrades: number;
    share: number | null;
  };
  /** Reconciliation der Aggregate gegen die Detail-Zeilen (Δ ≤ 1e-6). */
  reconciliation: {
    sourcesSum: number;
    costsSum: number;
    residualSum: number;
    netSum: number;
    delta: number;
    ok: boolean;
  };
}

/**
 * Dimensionale Aggregation (agent | rule | regime | cost) über den Zeitraum.
 * SQL-seitige GROUP BYs (keine unbeschränkten Rowloads); die Reconciliation
 * prüft Σ Quellen + Σ Kosten + Σ Residual == Σ Netto über dieselbe Filtermenge.
 */
export async function aggregateTradeAttributions(
  dimension: AttributionDimension,
  filter: AttributionFilter
): Promise<AttributionAggregate> {
  const where = buildFilter(filter);

  // Kopf-Summen (Totals + Reconciliation) über dieselbe Filtermenge.
  const [totalsRow] = await db
    .select({
      count: sql<number>`count(*)::int`,
      attributed: sql<number>`count(*) FILTER (WHERE ${tradeAttributions.status} = 'ATTRIBUTED')::int`,
      unattributable: sql<number>`count(*) FILTER (WHERE ${tradeAttributions.status} = 'UNATTRIBUTABLE')::int`,
      netSum: sql<string>`COALESCE(sum(${tradeAttributions.pnlNet}), 0)`,
      sourcesSum: sql<string>`COALESCE(sum(${tradeAttributions.sourcesSum}), 0)`,
      costsSum: sql<string>`COALESCE(sum(${tradeAttributions.costsSum}), 0)`,
      residualSum: sql<string>`COALESCE(sum(${tradeAttributions.residual}), 0)`,
      feesSum: sql<string | null>`sum(${tradeAttributions.fees})`,
      fundingSum: sql<string | null>`sum(${tradeAttributions.funding})`,
      methodVersions: sql<string>`MIN(${tradeAttributions.methodVersion})::text || CASE WHEN MIN(${tradeAttributions.methodVersion}) = MAX(${tradeAttributions.methodVersion}) THEN '' ELSE '*' END`,
    })
    .from(tradeAttributions)
    .where(where);

  // Gruppen: regime aus dem Kopf, sonst aus den Posten.
  const groups: AttributionGroup[] = [];
  if (dimension === "regime") {
    const regimeRows = await db
      .select({
        key: tradeAttributions.regime,
        trades: sql<number>`count(*)::int`,
        contributionSum: sql<string>`COALESCE(sum(${tradeAttributions.pnlNet}), 0)`,
      })
      .from(tradeAttributions)
      .where(where)
      .groupBy(tradeAttributions.regime);
    for (const r of regimeRows) {
      groups.push({
        key: r.key,
        trades: r.trades,
        contributionSum: Number(r.contributionSum),
      });
    }
  } else {
    const sourceType =
      dimension === "agent" ? "AGENT" : dimension === "rule" ? "RULE" : "COST";
    const entryRows = await db
      .select({
        key: tradeAttributionEntries.sourceId,
        trades: sql<number>`count(DISTINCT ${tradeAttributionEntries.attributionId})::int`,
        contributionSum: sql<string>`COALESCE(sum(${tradeAttributionEntries.contribution}), 0)`,
      })
      .from(tradeAttributionEntries)
      .innerJoin(tradeAttributions, eq(tradeAttributionEntries.attributionId, tradeAttributions.id))
      .where(and(where, eq(tradeAttributionEntries.sourceType, sourceType)))
      .groupBy(tradeAttributionEntries.sourceId);
    for (const r of entryRows) {
      groups.push({
        key: r.key,
        trades: r.trades,
        contributionSum: Number(r.contributionSum),
      });
    }
  }
  groups.sort((a, b) => b.contributionSum - a.contributionSum || a.key.localeCompare(b.key));

  // Coverage: geschlossene Journal-Zeilen im Zeitraum (gleiche Zeitachse).
  const journalWhere = buildJournalWhere(filter);
  const [coverageRow] = await db
    .select({ closed: sql<number>`count(*)::int` })
    .from(tradeJournal)
    .where(journalWhere);
  const attributed = totalsRow?.attributed ?? 0;
  const closedTrades = coverageRow?.closed ?? 0;

  const netSum = Number(totalsRow?.netSum ?? 0);
  const sourcesSum = Number(totalsRow?.sourcesSum ?? 0);
  const costsSum = Number(totalsRow?.costsSum ?? 0);
  const residualSum = Number(totalsRow?.residualSum ?? 0);
  const delta = Math.abs(sourcesSum + costsSum + residualSum - netSum);
  const mvRaw = totalsRow?.methodVersions ?? "";
  const methodVersion = mvRaw.endsWith("*") ? null : Number(mvRaw);

  return {
    dimension,
    declaration: ATTRIBUTION_DECLARATION,
    methodVersion: Number.isFinite(methodVersion) ? methodVersion : null,
    groups,
    totals: {
      attributions: totalsRow?.count ?? 0,
      attributed,
      unattributable: totalsRow?.unattributable ?? 0,
      netSum,
      sourcesSum,
      costsSum,
      residualSum,
      feesSum: totalsRow?.feesSum == null ? null : Number(totalsRow.feesSum),
      fundingSum: totalsRow?.fundingSum == null ? null : Number(totalsRow.fundingSum),
    },
    coverage: {
      closedTrades,
      attributedTrades: attributed,
      share: closedTrades > 0 ? attributed / closedTrades : null,
    },
    reconciliation: {
      sourcesSum,
      costsSum,
      residualSum,
      netSum,
      delta,
      ok: delta <= 1e-6,
    },
  };
}

// ── Backfill ────────────────────────────────────────────────────────────────

export interface BackfillOptions {
  methodVersion?: number;
  /** Batch-Obergrenze (Default 500, max 1000) — Restart-sicher in kleinen Batches. */
  batchLimit?: number;
  dryRun?: boolean;
  from?: Date;
  to?: Date;
}

export interface BackfillCounts {
  methodVersion: number;
  considered: number;
  attributed: number;
  unattributable: number;
  duplicates: number;
  failed: number;
  dryRun: boolean;
}

/**
 * Backfill historischer, geschlossener Journal-Zeilen OHNE Attribution der
 * Methodenversion: berechnet und schreibt (idempotent). Altzeilen ohne
 * ausreichenden Snapshot (v1-Snapshots, UNKNOWN-Attribution) werden als
 * UNATTRIBUTABLE PERSISTIERT — sichtbare Lücke, niemals geschätzte Quellen.
 * Restart-sicher: das Batch ist begrenzt, wiederholte Läufe überspringen
 * bereits attribuierte Zeilen (Idempotenz-Schlüssel).
 */
export async function backfillTradeAttributions(
  options: BackfillOptions = {}
): Promise<BackfillCounts> {
  const methodVersion = options.methodVersion ?? 1;
  const batchLimit = Math.max(
    1,
    Math.min(ATTRIBUTION_LIMITS.maxBackfillBatch, options.batchLimit ?? ATTRIBUTION_LIMITS.defaultBackfillBatch)
  );

  // Geschlossene Zeilen ohne Attribution dieser Methodenversion, älteste zuerst.
  const pending = await db
    .select({
      id: tradeJournal.id,
      positionId: tradeJournal.positionId,
      symbol: tradeJournal.symbol,
      side: tradeJournal.side,
      regime: tradeJournal.regime,
      closedAt: tradeJournal.closedAt,
      pnl: tradeJournal.pnl,
      snapshot: tradeJournal.decisionSnapshot,
    })
    .from(tradeJournal)
    .leftJoin(
      tradeAttributions,
      and(
        eq(tradeAttributions.journalId, tradeJournal.id),
        eq(tradeAttributions.methodVersion, methodVersion)
      )
    )
    .where(
      and(
        isNotNullClosedAt(),
        isNull(tradeAttributions.id),
        options.from ? gte(tradeJournal.closedAt, options.from) : undefined,
        options.to ? lte(tradeJournal.closedAt, options.to) : undefined
      )
    )
    .orderBy(asc(tradeJournal.closedAt))
    .limit(batchLimit);

  const counts: BackfillCounts = {
    methodVersion,
    considered: pending.length,
    attributed: 0,
    unattributable: 0,
    duplicates: 0,
    failed: 0,
    dryRun: options.dryRun ?? false,
  };

  for (const row of pending) {
    // Fail-closed: ohne realisiertes PnL der Buchungsquelle (NULL in der
    // Journal-Zeile) gibt es kein Reconciliationsziel — NICHT als 0 raten.
    const grossPnl = row.pnl === null ? null : Number(row.pnl);
    if (grossPnl === null || !Number.isFinite(grossPnl)) {
      counts.failed += 1;
      continue;
    }
    if (options.dryRun) {
      // Nur klassifizieren, nichts schreiben.
      const result = computeTradeAttribution({
        methodVersion,
        symbol: row.symbol,
        side: row.side === "SHORT" ? "SHORT" : "LONG",
        grossPnl,
        fees: null,
        funding: null,
        snapshot: row.snapshot,
      });
      if (result.status === "ATTRIBUTED") counts.attributed += 1;
      else counts.unattributable += 1;
      continue;
    }
    // Funding aus der Position (Buchungsfakt, falls lesbar; sonst unbekannt).
    let funding: number | null = null;
    try {
      const [posRow] = await db
        .select({ fundingPaid: positionsTable.fundingPaid })
        .from(positionsTable)
        .where(eq(positionsTable.id, row.positionId))
        .limit(1);
      const n = posRow ? Number(posRow.fundingPaid) : NaN;
      funding = Number.isFinite(n) ? n : null;
    } catch {
      funding = null;
    }
    try {
      const res = await recordTradeAttribution({
        journalId: row.id,
        positionId: row.positionId,
        closedAt: row.closedAt as Date,
        symbol: row.symbol,
        side: row.side === "SHORT" ? "SHORT" : "LONG",
        regime: row.regime || "UNKNOWN",
        grossPnl,
        fees: null,
        funding,
        snapshot: row.snapshot,
        methodVersion,
      });
      if (res.duplicate) counts.duplicates += 1;
      else if (res.status === "ATTRIBUTED") counts.attributed += 1;
      else counts.unattributable += 1;
    } catch {
      counts.failed += 1;
    }
  }
  return counts;
}

// ── Helfer ──────────────────────────────────────────────────────────────────

function buildFilter(filter: AttributionFilter) {
  return and(
    filter.symbol ? eq(tradeAttributions.symbol, filter.symbol) : undefined,
    filter.regime ? eq(tradeAttributions.regime, filter.regime) : undefined,
    filter.status ? eq(tradeAttributions.status, filter.status) : undefined,
    filter.methodVersion ? eq(tradeAttributions.methodVersion, filter.methodVersion) : undefined,
    filter.from ? gte(tradeAttributions.closedAt, filter.from) : undefined,
    filter.to ? lte(tradeAttributions.closedAt, filter.to) : undefined
  );
}

function buildJournalWhere(filter: AttributionFilter) {
  return and(
    isNotNullClosedAt(),
    filter.from ? gte(tradeJournal.closedAt, filter.from) : undefined,
    filter.to ? lte(tradeJournal.closedAt, filter.to) : undefined
  );
}

/** `closed_at IS NOT NULL` als Bedingung (typsicher ohne non-null assertion). */
function isNotNullClosedAt() {
  return sql`${tradeJournal.closedAt} IS NOT NULL`;
}

function headerFromRow(row: typeof tradeAttributions.$inferSelect): AttributionDetailRow {
  return {
    id: row.id,
    journalId: row.journalId,
    positionId: row.positionId,
    methodVersion: row.methodVersion,
    status: row.status as AttributionStatus,
    unattributableReason: row.unattributableReason,
    snapshotHash: row.snapshotHash,
    snapshotSchemaVersion: row.snapshotSchemaVersion,
    symbol: row.symbol,
    side: row.side === "SHORT" ? "SHORT" : "LONG",
    regime: row.regime,
    closedAt: row.closedAt.toISOString(),
    declaration: ATTRIBUTION_DECLARATION,
    pnlGross: Number(row.pnlGross),
    fees: row.fees === null ? null : Number(row.fees),
    funding: row.funding === null ? null : Number(row.funding),
    slippageMemo: row.slippageMemo === null ? null : Number(row.slippageMemo),
    pnlNet: Number(row.pnlNet),
    sourcesSum: Number(row.sourcesSum),
    costsSum: Number(row.costsSum),
    residual: Number(row.residual),
    unknownCosts: [...(row.unknownCosts ?? [])],
    participants: row.participants,
    abstentions: row.abstentions,
  };
}

function num(x: number): string {
  return String(x);
}

function round8(x: number): number {
  return Math.round(x * 1e8) / 1e8;
}

async function attributionAudit(
  event: string,
  level: "INFO" | "WARN" | "CRITICAL",
  detail: Record<string, unknown>
): Promise<void> {
  try {
    const res = await auditWrite(event, level, detail, { auditClass: "security" });
    if (!res.durable) {
      flagMissedAudit(event, { ...detail, reason: res.error ?? "audit nicht durable" });
    }
  } catch (e) {
    flagMissedAudit(event, { ...detail, error: e instanceof Error ? e.message : String(e) });
  }
}

// Re-export für bequeme Imports (API-Routen, Tests).
export { AttributionError };
export type { TradeAttribution };
