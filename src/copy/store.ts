/**
 * PostgreSQL order-link store (STX-07-02).
 *
 * This persists only the idempotency link/state around a follower intent. It
 * never creates an execution intent or receipt, and it never submits an order.
 * Fill-quality is stored as an observation; it is not a cancel/reject trigger.
 */
import type { Pool } from "pg";

import { pool } from "@/db";
import { writeAuditRecord, type AuditRecord } from "@/lib/auditSink";
import { metricLabel, telemetry } from "@/lib/telemetry";
import type { PolicyCode } from "./policy";

export const COPY_ORDER_LINK_STATES = [
  "PENDING",
  "SENT",
  "PARTIAL",
  "FILLED",
  "FAILED",
  "DIVERGED",
] as const;
export type CopyOrderLinkState = (typeof COPY_ORDER_LINK_STATES)[number];

/**
 * Persistierbare Policy-Codes — deckungsgleich mit der DB-CHECK-Constraint
 * `copy_order_links_policy_code_check` (drizzle/2026-10-03_copy_subscriptions.sql
 * bzw. 2026-10-04_copy_engine_gates.sql). `NO_BASELINE` (07-03) ist enthalten,
 * wird von der Engine aber bewusst NIE geschrieben: ohne Baseline entsteht
 * keine Zeile.
 */
const POLICY_CODES: readonly PolicyCode[] = [
  "HALTED",
  "MAX_EVENT_NOTIONAL",
  "MAX_DAY_NOTIONAL",
  "MAX_SLIPPAGE",
  "MAX_POSITIONS",
  "MAX_DAILY_LOSS",
  "MAX_LEVERAGE",
  "NO_MAPPING",
  "NO_BASELINE",
];
const SAFE_ID = /^[A-Za-z0-9_.:/-]{1,128}$/;
const TERMINAL_STATES: readonly CopyOrderLinkState[] = ["FILLED", "FAILED", "DIVERGED"];
const ALLOWED_TRANSITIONS: Readonly<Record<CopyOrderLinkState, readonly CopyOrderLinkState[]>> = {
  PENDING: ["SENT", "FAILED", "DIVERGED"],
  SENT: ["PARTIAL", "FILLED", "FAILED", "DIVERGED"],
  PARTIAL: ["FILLED", "FAILED", "DIVERGED"],
  FILLED: [],
  FAILED: [],
  DIVERGED: [],
};

export interface CreateCopyIntentInput {
  /** Stable source event key; retries must reuse it. */
  readonly leaderEventId: string;
  /** Stable existing follower-intent key; retries must reuse it. */
  readonly followerIntentId: string;
  /** Existing execution_quality_intents.id; this store never creates it. */
  readonly executionQualityIntentId?: string | null;
  /**
   * Follower-Notional dieses Events (07-03). Nur Messwert für das kumulative
   * Tages-Notional der Copy-Policy (`maxNotionalPerDay`); es ist **keine**
   * Order und kein Receipt. `null` bis der Follower gerechnet hat.
   */
  readonly followerNotional?: number | null;
}

export interface CopyOrderLink {
  readonly id: string;
  readonly leaderEventId: string;
  readonly followerIntentId: string;
  readonly executionQualityIntentId: string | null;
  readonly state: CopyOrderLinkState;
  readonly policyCode: PolicyCode | null;
  readonly observedDeviationBps: number | null;
  /** Follower-Notional des Events (Messwert, keine Order). */
  readonly followerNotional: number | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type CopyStoreErrorCode =
  | "INVALID_LINK_ID"
  | "INVALID_POLICY_CODE"
  | "INVALID_DEVIATION"
  | "LINK_NOT_FOUND"
  | "LINK_IDENTITY_CONFLICT"
  | "INVALID_FOLLOWER_NOTIONAL"
  | "ILLEGAL_TRANSITION"
  | "TERMINAL_STATE"
  | "CORRUPT_ROW";

export class CopyStoreError extends Error {
  constructor(readonly code: CopyStoreErrorCode, message: string = code) {
    super(message);
    this.name = "CopyStoreError";
  }
}

type DbLink = {
  id: string;
  leader_event_id: string;
  follower_intent_id: string;
  execution_quality_intent_id: string | null;
  state: string;
  policy_code: string | null;
  observed_deviation_bps: string | null;
  follower_notional: string | null;
  created_at: Date;
  updated_at: Date;
};

export type CopyAuditWriter = (record: AuditRecord) => Promise<unknown>;

function validateId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new CopyStoreError("INVALID_LINK_ID");
  }
}

function isPolicyCode(value: unknown): value is PolicyCode {
  return typeof value === "string" && POLICY_CODES.includes(value as PolicyCode);
}

function mapRow(row: DbLink | undefined): CopyOrderLink {
  if (!row || !COPY_ORDER_LINK_STATES.includes(row.state as CopyOrderLinkState)) {
    throw new CopyStoreError("CORRUPT_ROW");
  }
  if (row.policy_code !== null && !isPolicyCode(row.policy_code)) {
    throw new CopyStoreError("CORRUPT_ROW");
  }
  const deviation = row.observed_deviation_bps === null ? null : Number(row.observed_deviation_bps);
  if (deviation !== null && !Number.isFinite(deviation)) {
    throw new CopyStoreError("CORRUPT_ROW");
  }
  const followerNotional =
    row.follower_notional === null || row.follower_notional === undefined
      ? null
      : Number(row.follower_notional);
  if (followerNotional !== null && !Number.isFinite(followerNotional)) {
    throw new CopyStoreError("CORRUPT_ROW");
  }
  return {
    id: row.id,
    leaderEventId: row.leader_event_id,
    followerIntentId: row.follower_intent_id,
    executionQualityIntentId: row.execution_quality_intent_id,
    state: row.state as CopyOrderLinkState,
    policyCode: row.policy_code as PolicyCode | null,
    observedDeviationBps: deviation,
    followerNotional:
      row.follower_notional === null ? null : Number(row.follower_notional),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function metricState(state: CopyOrderLinkState | null): string {
  return metricLabel(state ?? "NONE", "NONE");
}

/** PostgreSQL-backed state/link store; DB is injectable for tests. */
export class CopyStore {
  constructor(
    private readonly connection: Pool = pool,
    private readonly auditWriter: CopyAuditWriter = writeAuditRecord,
  ) {}

  /** Insert a PENDING link, or return the exact prior link on an idempotent retry. */
  async createIntent(input: CreateCopyIntentInput): Promise<CopyOrderLink> {
    validateId(input?.leaderEventId);
    validateId(input?.followerIntentId);
    const executionQualityIntentId = input.executionQualityIntentId ?? null;
    if (executionQualityIntentId !== null) validateId(executionQualityIntentId);
    const followerNotional = input.followerNotional ?? null;
    if (
      followerNotional !== null &&
      (!Number.isFinite(followerNotional) || followerNotional < 0 || followerNotional > 1e15)
    ) {
      throw new CopyStoreError("INVALID_FOLLOWER_NOTIONAL");
    }

    const client = await this.connection.connect();
    let row: DbLink | undefined;
    let created = false;
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const inserted = await client.query<DbLink>(
        `INSERT INTO copy_order_links
          (leader_event_id, follower_intent_id, execution_quality_intent_id, state, follower_notional)
        VALUES ($1, $2, $3, 'PENDING', $4)
        ON CONFLICT DO NOTHING
        RETURNING id, leader_event_id, follower_intent_id, execution_quality_intent_id,
          state, policy_code, observed_deviation_bps, follower_notional, created_at, updated_at`,
        [input.leaderEventId, input.followerIntentId, executionQualityIntentId, followerNotional],
      );
      created = inserted.rowCount === 1;
      row = inserted.rows[0];
      if (!row) {
        const existing = await client.query<DbLink>(
          `SELECT id, leader_event_id, follower_intent_id, execution_quality_intent_id,
            state, policy_code, observed_deviation_bps, follower_notional, created_at, updated_at
          FROM copy_order_links WHERE follower_intent_id = $1 FOR UPDATE`,
          [input.followerIntentId],
        );
        row = existing.rows[0];
        if (
          !row ||
          row.leader_event_id !== input.leaderEventId ||
          (executionQualityIntentId !== null &&
            row.execution_quality_intent_id !== executionQualityIntentId)
        ) {
          throw new CopyStoreError("LINK_IDENTITY_CONFLICT");
        }
      }
      const result = mapRow(row);
      await client.query("COMMIT");
      if (created) {
        telemetry.copy.linkWrites.inc({ result: "created" });
        telemetry.copy.transitions.inc({ from: "NONE", to: "PENDING", result: "transitioned" });
        await this.auditTransition(result, null, "PENDING", null, null);
      } else {
        telemetry.copy.linkWrites.inc({ result: "duplicate" });
      }
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      telemetry.copy.linkWrites.inc({ result: "failed" });
      throw error;
    } finally {
      client.release();
    }
  }

  async loadByFollowerIntentId(followerIntentId: string): Promise<CopyOrderLink | null> {
    validateId(followerIntentId);
    const result = await this.connection.query<DbLink>(
      `SELECT id, leader_event_id, follower_intent_id, execution_quality_intent_id,
        state, policy_code, observed_deviation_bps, follower_notional, created_at, updated_at
      FROM copy_order_links WHERE follower_intent_id = $1`,
      [followerIntentId],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  /**
   * Kumuliertes Follower-Notional der aktiven Links **seit Tagesbeginn** (UTC).
   *
   * Basis der Copy-Policy-Prüfung `maxNotionalPerDay`. Bewusst aus derselben
   * Tabelle gelesen statt aus einer neuen: es gibt keine vierte Copy-Tabelle,
   * und der Wert überlebt einen Neustart — ein Tageslimit, das ein Restart
   * zurücksetzt, wäre kein Limit.
   */
  async dayNotional(now: Date = new Date()): Promise<number> {
    const result = await this.connection.query<{ total: string | null }>(
      `SELECT COALESCE(SUM(follower_notional), 0)::text AS total
       FROM copy_order_links
       WHERE created_at >= date_trunc('day', $1::timestamptz)
         AND state IN ('PENDING', 'SENT', 'PARTIAL', 'FILLED')`,
      [now],
    );
    const total = Number(result.rows[0]?.total ?? 0);
    return Number.isFinite(total) ? total : 0;
  }

  /** PENDING → SENT. Replaying this call after PARTIAL is a no-op, never a rewind. */
  markSent(followerIntentId: string): Promise<CopyOrderLink> {
    return this.transition(followerIntentId, "SENT");
  }

  /** SENT → PARTIAL. A partial fill is a state observation, not a second intent. */
  markPartial(followerIntentId: string): Promise<CopyOrderLink> {
    return this.transition(followerIntentId, "PARTIAL");
  }

  /**
   * SENT/PARTIAL → FILLED. Deviation is measurement-only: it is recorded even
   * when larger than the pre-submit spread threshold, and never cancels a fill.
   */
  markFilled(
    followerIntentId: string,
    observedDeviationBps?: number | null,
  ): Promise<CopyOrderLink> {
    if (
      observedDeviationBps !== undefined &&
      observedDeviationBps !== null &&
      (!Number.isFinite(observedDeviationBps) || Math.abs(observedDeviationBps) > 1e9)
    ) {
      throw new CopyStoreError("INVALID_DEVIATION");
    }
    return this.transition(followerIntentId, "FILLED", {
      observedDeviationBps,
    });
  }

  /** Active → FAILED; a policy code is recorded only for a policy rejection. */
  markFailed(
    followerIntentId: string,
    policyCode: PolicyCode | null = null,
  ): Promise<CopyOrderLink> {
    if (policyCode !== null && !isPolicyCode(policyCode)) {
      throw new CopyStoreError("INVALID_POLICY_CODE");
    }
    return this.transition(followerIntentId, "FAILED", { policyCode });
  }

  /** Active → DIVERGED. Terminal reconciliation outcomes cannot be overwritten. */
  markDiverged(followerIntentId: string): Promise<CopyOrderLink> {
    return this.transition(followerIntentId, "DIVERGED");
  }

  private async transition(
    followerIntentId: string,
    target: CopyOrderLinkState,
    patch: { policyCode?: PolicyCode | null; observedDeviationBps?: number | null } = {},
  ): Promise<CopyOrderLink> {
    validateId(followerIntentId);
    const client = await this.connection.connect();
    let updated: CopyOrderLink | null = null;
    let previous: CopyOrderLinkState | null = null;
    let didTransition = false;
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const selected = await client.query<DbLink>(
        `SELECT id, leader_event_id, follower_intent_id, execution_quality_intent_id,
          state, policy_code, observed_deviation_bps, follower_notional, created_at, updated_at
        FROM copy_order_links WHERE follower_intent_id = $1 FOR UPDATE`,
        [followerIntentId],
      );
      const currentRow = selected.rows[0];
      if (!currentRow) throw new CopyStoreError("LINK_NOT_FOUND");
      const current = mapRow(currentRow);
      previous = current.state;

      // Identical retries are true no-ops. A stale SENT after PARTIAL also
      // returns the already-forward state without touching timestamps or audit.
      if (current.state === target || (target === "SENT" && current.state === "PARTIAL")) {
        updated = current;
        await client.query("COMMIT");
      } else {
        if (TERMINAL_STATES.includes(current.state)) {
          throw new CopyStoreError("TERMINAL_STATE", "Terminaler Copy-Link-Zustand darf nicht überschrieben werden.");
        }
        if (!ALLOWED_TRANSITIONS[current.state].includes(target)) {
          throw new CopyStoreError("ILLEGAL_TRANSITION", `${current.state} → ${target} ist nicht erlaubt.`);
        }

        const policyCode = target === "FAILED" ? (patch.policyCode ?? null) : null;
        const observedDeviation =
          target === "FILLED" && patch.observedDeviationBps !== undefined
            ? patch.observedDeviationBps
            : current.observedDeviationBps;
        const result = await client.query<DbLink>(
          `UPDATE copy_order_links
          SET state = $2, policy_code = $3, observed_deviation_bps = $4, updated_at = now()
          WHERE id = $1
          RETURNING id, leader_event_id, follower_intent_id, execution_quality_intent_id,
            state, policy_code, observed_deviation_bps, follower_notional, created_at, updated_at`,
          [current.id, target, policyCode, observedDeviation],
        );
        updated = mapRow(result.rows[0]);
        didTransition = true;
        await client.query("COMMIT");
      }
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      telemetry.copy.transitions.inc({
        from: metricState(previous),
        to: metricLabel(target),
        result: "failed",
      });
      throw error;
    } finally {
      client.release();
    }

    if (!updated) throw new CopyStoreError("CORRUPT_ROW");
    telemetry.copy.transitions.inc({
      from: metricState(previous),
      to: metricLabel(target),
      result: didTransition ? "transitioned" : "noop",
    });
    if (didTransition) {
      await this.auditTransition(
        updated,
        previous,
        target,
        target === "FAILED" ? (patch.policyCode ?? null) : null,
        target === "FILLED" ? (patch.observedDeviationBps ?? updated.observedDeviationBps) : null,
      );
    }
    return updated;
  }

  private async auditTransition(
    link: CopyOrderLink,
    from: CopyOrderLinkState | null,
    to: CopyOrderLinkState,
    policyCode: PolicyCode | null,
    observedDeviationBps: number | null,
  ): Promise<void> {
    const level = to === "DIVERGED" ? "CRITICAL" : to === "FAILED" ? "WARN" : "INFO";
    try {
      const outcome = await this.auditWriter({
        event: "COPY_ORDER_LINK_TRANSITION",
        level,
        auditClass: "security",
        detail: {
          copyOrderLinkId: link.id,
          from: from ?? "NONE",
          to,
          policyCode,
          observedDeviationBps,
        },
      });
      const durable =
        typeof outcome === "object" && outcome !== null &&
        "durable" in outcome && (outcome as { durable?: unknown }).durable === true;
      telemetry.copy.auditWrites.inc({ result: durable ? "durable" : "degraded" });
    } catch {
      // The durable mutation has already committed; audit failures remain
      // visible through the bounded counter and must not invite a state rewind.
      telemetry.copy.auditWrites.inc({ result: "failed" });
    }
  }
}

/** Default PostgreSQL-backed entry points. Injection is available via `CopyStore`. */
export const copyStore = new CopyStore();

export function createIntent(input: CreateCopyIntentInput): Promise<CopyOrderLink> {
  return copyStore.createIntent(input);
}
export function markSent(followerIntentId: string): Promise<CopyOrderLink> {
  return copyStore.markSent(followerIntentId);
}
export function markPartial(followerIntentId: string): Promise<CopyOrderLink> {
  return copyStore.markPartial(followerIntentId);
}
export function markFilled(
  followerIntentId: string,
  observedDeviationBps?: number | null,
): Promise<CopyOrderLink> {
  return copyStore.markFilled(followerIntentId, observedDeviationBps);
}
export function markFailed(
  followerIntentId: string,
  policyCode: PolicyCode | null = null,
): Promise<CopyOrderLink> {
  return copyStore.markFailed(followerIntentId, policyCode);
}
export function markDiverged(followerIntentId: string): Promise<CopyOrderLink> {
  return copyStore.markDiverged(followerIntentId);
}
