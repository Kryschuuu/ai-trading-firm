/**
 * Persistenz der Execution-Workflows (RMA-P4-02).
 *
 * Zwei Implementierungen derselben Schnittstelle:
 *   - `InMemoryExecutionStore` — deterministisch, für Unit-Tests und den
 *     Paper-Simulationspfad ohne Datenbank.
 *   - `PostgresExecutionStore` — `pg.Pool`-basiert gegen die Tabellen
 *     `execution_workflows`, `execution_workflow_events`, `execution_workflow_fills`
 *     (Migration `drizzle/2026-09-22_post_only_fallback.sql`).
 *
 * Idempotenz/Optimistic Locking:
 *   - `create` ist idempotent über `workflowKey` (`ON CONFLICT DO NOTHING` +
 *     Rückgabe der bestehenden Zeile) — Retries erzeugen keinen zweiten
 *     Workflow und damit keine zweite Order.
 *   - Jede Mutation vergleicht die erwartete `version` atomar; ein Konflikt
 *     wirft `ExecutionStoreConflict` (der Aufrufer lädt neu und entscheidet
 *     erneut, statt blind zu überschreiben).
 *   - Fills sind idempotent über `(workflow_id, fill_id)`; die Mengenwahrheit
 *     ist IMMER `SUM(fills.qty)` aus der Fill-Tabelle, nie ein inkrementelles
 *     Gegenfeld.
 *
 * Zeitsemantik je Event: `eventTime` (Ereignis), `availableAt` (Bekanntheit),
 * `computedAt` (Persistenz) mit `eventTime <= availableAt <= computedAt`.
 */
import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { BrokerVenueId, ExecutionMode } from "../contracts/broker";
import type { ExecutionPolicyInput } from "./policy";
import {
  assertTransition,
  isExecutionState,
  type ExecutionWorkflowState,
} from "./stateMachine";

export const WORKFLOW_KEY_RE = /^eow1:[0-9a-f]{64}$/;
export const WORKFLOW_EVENT_ID_RE = /^eoe1:[0-9a-f]{64}$/;

export class ExecutionStoreError extends Error {
  readonly code: string;
  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "ExecutionStoreError";
    this.code = code;
  }
}

export class ExecutionStoreConflict extends ExecutionStoreError {
  constructor(detail: string) {
    super("EXECUTION_STORE_CONFLICT", detail);
    this.name = "ExecutionStoreConflict";
  }
}

export interface WorkflowFillRecord {
  fillId: string;
  orderId: string;
  qty: number;
  price: number;
  feeQuote: number | null;
  eventTime: number;
  availableAt: number;
}

export interface WorkflowEventRecord {
  seq: number;
  eventId: string;
  fromState: ExecutionWorkflowState | null;
  toState: ExecutionWorkflowState;
  reason: string;
  policyVersion: string;
  orderId: string | null;
  clientOrderId: string | null;
  filledQtyDelta: number | null;
  filledQtyTotal: number | null;
  feeDelta: number | null;
  quoteMid: number | null;
  spreadBps: number | null;
  eventTime: number;
  availableAt: number;
  computedAt: number;
  detail: Record<string, unknown>;
}

export interface WorkflowRecord {
  id: string;
  workflowKey: string;
  venue: BrokerVenueId;
  mode: ExecutionMode;
  symbol: string;
  side: "LONG" | "SHORT";
  targetQty: number;
  filledQty: number;
  feeQuoteTotal: number | null;
  state: ExecutionWorkflowState;
  version: number;
  policyVersion: string;
  policy: ExecutionPolicyInput;
  attempt: number;
  repricesUsed: number;
  cancelAttempts: number;
  clientOrderBase: string;
  /** Stop-Loss-Intent des Trading-Signals (unveränderlich; Gates für Reprice/Fallback). */
  hasStopLoss: boolean;
  activeOrderId: string | null;
  activeClientOrderId: string | null;
  fallbackOrderId: string | null;
  fallbackClientOrderId: string | null;
  limitPrice: number | null;
  submittedAt: number | null;
  ackAt: number | null;
  cancelRequestedAt: number | null;
  cancelConfirmedAt: number | null;
  errorCode: string | null;
  reason: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateWorkflowInput {
  workflowKey: string;
  venue: BrokerVenueId;
  mode: ExecutionMode;
  symbol: string;
  side: "LONG" | "SHORT";
  targetQty: number;
  policy: ExecutionPolicyInput;
  policyVersion: string;
  clientOrderBase: string;
  hasStopLoss: boolean;
  limitPrice: number | null;
  now: number;
}

export interface WorkflowPatch {
  state?: ExecutionWorkflowState;
  attempt?: number;
  repricesUsed?: number;
  cancelAttempts?: number;
  activeOrderId?: string | null;
  activeClientOrderId?: string | null;
  fallbackOrderId?: string | null;
  fallbackClientOrderId?: string | null;
  limitPrice?: number | null;
  submittedAt?: number | null;
  ackAt?: number | null;
  cancelRequestedAt?: number | null;
  cancelConfirmedAt?: number | null;
  errorCode?: string | null;
  reason?: string | null;
}

export interface WorkflowEventInput {
  toState: ExecutionWorkflowState;
  reason: string;
  orderId?: string | null;
  clientOrderId?: string | null;
  filledQtyDelta?: number | null;
  feeDelta?: number | null;
  quoteMid?: number | null;
  spreadBps?: number | null;
  eventTime: number;
  availableAt: number;
  computedAt: number;
  detail?: Record<string, unknown>;
}

export interface WorkflowMutation {
  patch: WorkflowPatch;
  event: WorkflowEventInput;
  newFills?: WorkflowFillRecord[];
}

/** Deterministischer Workflow-Key über die fachliche Identität. */
/**
 * Idempotenz-Key eines Workflows. Die Policy ist bewusst NICHT Teil des Keys:
 * derselbe Key + andere Policy ⇒ POLICY_MISMATCH (fail-closed), statt still
 * einen zweiten Workflow zu erzeugen oder die Policy zu wechseln („ein Key,
 * eine Policy“).
 */
export function buildWorkflowKey(parts: {
  venue: string;
  mode: string;
  symbol: string;
  side: string;
  targetQty: number;
  seed: string;
}): string {
  const canonical = JSON.stringify([
    parts.venue,
    parts.mode,
    parts.symbol,
    parts.side,
    parts.targetQty,
    parts.seed,
  ]);
  return `eow1:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

export function buildWorkflowEventId(parts: {
  workflowId: string;
  seq: number;
  toState: string;
  reason: string;
  orderId: string | null;
  eventTime: number;
}): string {
  const canonical = JSON.stringify([
    parts.workflowId,
    parts.seq,
    parts.toState,
    parts.reason,
    parts.orderId ?? "",
    parts.eventTime,
  ]);
  return `eoe1:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

/** Deterministische Client-Order-Basis (venue-tauglich, ≤ 24 Zeichen). */
export function buildClientOrderBase(workflowKey: string): string {
  const digest = createHash("sha256").update(workflowKey, "utf8").digest("hex").slice(0, 12).toUpperCase();
  return `EOW${digest}`;
}

export function limitAttemptClientOrderId(base: string, attempt: number): string {
  return `${base}L${attempt}`.slice(0, 32);
}

export function fallbackClientOrderId(base: string): string {
  return `${base}F`.slice(0, 32);
}

export interface ExecutionStore {
  create(input: CreateWorkflowInput): Promise<{ record: WorkflowRecord; created: boolean }>;
  loadByKey(workflowKey: string): Promise<WorkflowRecord | null>;
  loadById(id: string): Promise<WorkflowRecord | null>;
  listOpen(limit?: number): Promise<WorkflowRecord[]>;
  listEvents(workflowId: string): Promise<WorkflowEventRecord[]>;
  listFills(workflowId: string): Promise<WorkflowFillRecord[]>;
  mutate(id: string, expectedVersion: number, mutation: WorkflowMutation): Promise<WorkflowRecord>;
}

// ── In-Memory-Implementierung ────────────────────────────────────────────────

function sumFillQty(fills: readonly WorkflowFillRecord[]): number {
  return fills.reduce((s, f) => s + f.qty, 0);
}

function sumFillFees(fills: readonly WorkflowFillRecord[]): number | null {
  let total = 0;
  for (const f of fills) {
    if (f.feeQuote === null || f.feeQuote === undefined) return null;
    total += f.feeQuote;
  }
  return total;
}

export class InMemoryExecutionStore implements ExecutionStore {
  private readonly byId = new Map<string, WorkflowRecord>();
  private readonly byKey = new Map<string, string>();
  private readonly events = new Map<string, WorkflowEventRecord[]>();
  private readonly fills = new Map<string, Map<string, WorkflowFillRecord>>();
  private seq = 1;

  async create(input: CreateWorkflowInput): Promise<{ record: WorkflowRecord; created: boolean }> {
    const existingId = this.byKey.get(input.workflowKey);
    if (existingId) {
      const existing = this.byId.get(existingId);
      if (existing) return { record: { ...existing }, created: false };
    }
    const id = `wf-mem-${this.seq++}-${input.workflowKey.slice(5, 13)}`;
    const record: WorkflowRecord = {
      id,
      workflowKey: input.workflowKey,
      venue: input.venue,
      mode: input.mode,
      symbol: input.symbol,
      side: input.side,
      targetQty: input.targetQty,
      filledQty: 0,
      feeQuoteTotal: null,
      state: "NEW",
      version: 1,
      policyVersion: input.policyVersion,
      policy: { ...input.policy },
      attempt: 0,
      repricesUsed: 0,
      cancelAttempts: 0,
      clientOrderBase: input.clientOrderBase,
      hasStopLoss: input.hasStopLoss,
      activeOrderId: null,
      activeClientOrderId: null,
      fallbackOrderId: null,
      fallbackClientOrderId: null,
      limitPrice: input.limitPrice,
      submittedAt: null,
      ackAt: null,
      cancelRequestedAt: null,
      cancelConfirmedAt: null,
      errorCode: null,
      reason: null,
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.byId.set(id, record);
    this.byKey.set(input.workflowKey, id);
    this.events.set(id, []);
    this.fills.set(id, new Map());
    return { record: { ...record }, created: true };
  }

  async loadByKey(workflowKey: string): Promise<WorkflowRecord | null> {
    const id = this.byKey.get(workflowKey);
    if (!id) return null;
    const r = this.byId.get(id);
    return r ? { ...r } : null;
  }

  async loadById(id: string): Promise<WorkflowRecord | null> {
    const r = this.byId.get(id);
    return r ? { ...r } : null;
  }

  async listOpen(limit = 100): Promise<WorkflowRecord[]> {
    const out: WorkflowRecord[] = [];
    for (const r of this.byId.values()) {
      if (r.state !== "DONE" && r.state !== "FAILED") {
        out.push({ ...r });
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  async listEvents(workflowId: string): Promise<WorkflowEventRecord[]> {
    return (this.events.get(workflowId) ?? []).map((e) => ({ ...e, detail: { ...e.detail } }));
  }

  async listFills(workflowId: string): Promise<WorkflowFillRecord[]> {
    return [...(this.fills.get(workflowId) ?? new Map()).values()].map((f) => ({ ...f }));
  }

  async mutate(id: string, expectedVersion: number, mutation: WorkflowMutation): Promise<WorkflowRecord> {
    const current = this.byId.get(id);
    if (!current) throw new ExecutionStoreError("EXECUTION_WORKFLOW_NOT_FOUND", `Workflow ${id} unbekannt`);
    if (current.version !== expectedVersion) {
      throw new ExecutionStoreConflict(`Version ${expectedVersion} erwartet, ${current.version} gefunden`);
    }
    const toState = mutation.patch.state ?? current.state;
    if (toState !== current.state) assertTransition(current.state, toState);
    const fillMap = this.fills.get(id);
    if (!fillMap) throw new ExecutionStoreError("EXECUTION_STORE_CORRUPT", `Fills für ${id} fehlen`);
    // Atomar: erst hypothetische Summen prüfen, DANN einfügen. Ein Throw darf
    // keinen Teilzustand hinterlassen (sonst wäre die FAILED-Transition danach
    // selbst blockiert).
    const fresh = (mutation.newFills ?? []).filter((f) => !fillMap.has(f.fillId));
    const allFills = [...fillMap.values(), ...fresh];
    const filledQty = sumFillQty(allFills);
    if (filledQty > current.targetQty + 1e-9) {
      throw new ExecutionStoreError("OVERFILL_DETECTED", `Fills (${filledQty}) über Ziel (${current.targetQty})`);
    }
    for (const f of fresh) fillMap.set(f.fillId, { ...f });
    const next: WorkflowRecord = {
      ...current,
      ...withoutUndefined(mutation.patch),
      filledQty,
      feeQuoteTotal: allFills.length === 0 ? null : sumFillFees(allFills),
      state: toState,
      version: current.version + 1,
      updatedAt: mutation.event.computedAt,
    };
    this.byId.set(id, next);
    const list = this.events.get(id);
    if (!list) throw new ExecutionStoreError("EXECUTION_STORE_CORRUPT", `Events für ${id} fehlen`);
    const seq = list.length + 1;
    list.push({
      seq,
      eventId: buildWorkflowEventId({
        workflowId: id,
        seq,
        toState: mutation.event.toState,
        reason: mutation.event.reason,
        orderId: mutation.event.orderId ?? null,
        eventTime: mutation.event.eventTime,
      }),
      fromState: toState === current.state ? current.state : current.state,
      toState: mutation.event.toState,
      reason: mutation.event.reason,
      policyVersion: current.policyVersion,
      orderId: mutation.event.orderId ?? null,
      clientOrderId: mutation.event.clientOrderId ?? null,
      filledQtyDelta: mutation.event.filledQtyDelta ?? null,
      filledQtyTotal: filledQty,
      feeDelta: mutation.event.feeDelta ?? null,
      quoteMid: mutation.event.quoteMid ?? null,
      spreadBps: mutation.event.spreadBps ?? null,
      eventTime: mutation.event.eventTime,
      availableAt: mutation.event.availableAt,
      computedAt: mutation.event.computedAt,
      detail: { ...(mutation.event.detail ?? {}) },
    });
    return { ...next };
  }
}

function withoutUndefined<T extends object>(patch: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

// ── Postgres-Implementierung ─────────────────────────────────────────────────

function toMs(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  const n = Number(value);
  if (!Number.isFinite(n)) throw new ExecutionStoreError("EXECUTION_STORE_DECODE", "Zeitstempel ungültig");
  return n;
}

function toNum(value: unknown, field: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new ExecutionStoreError("EXECUTION_STORE_DECODE", `${field} ungültig`);
  return n;
}

function toNumOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toStrOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

function toMsOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return toMs(value);
}

function decodeWorkflowRow(row: Record<string, unknown>): WorkflowRecord {
  const state = row.state;
  if (!isExecutionState(state)) throw new ExecutionStoreError("EXECUTION_STORE_DECODE", "state ungültig");
  const policy = row.policy_json as ExecutionPolicyInput;
  return {
    id: String(row.id),
    workflowKey: String(row.workflow_key),
    venue: String(row.venue) as BrokerVenueId,
    mode: String(row.mode) as ExecutionMode,
    symbol: String(row.symbol),
    side: String(row.side) as "LONG" | "SHORT",
    targetQty: toNum(row.target_qty, "target_qty"),
    filledQty: toNum(row.filled_qty, "filled_qty"),
    feeQuoteTotal: toNumOrNull(row.fee_quote_total),
    state,
    version: toNum(row.version, "version"),
    policyVersion: String(row.policy_version),
    policy,
    attempt: toNum(row.attempt, "attempt"),
    repricesUsed: toNum(row.reprices_used, "reprices_used"),
    cancelAttempts: toNum(row.cancel_attempts, "cancel_attempts"),
    clientOrderBase: String(row.client_order_base),
    hasStopLoss: row.has_stop_loss === true,
    activeOrderId: toStrOrNull(row.active_order_id),
    activeClientOrderId: toStrOrNull(row.active_client_order_id),
    fallbackOrderId: toStrOrNull(row.fallback_order_id),
    fallbackClientOrderId: toStrOrNull(row.fallback_client_order_id),
    limitPrice: toNumOrNull(row.limit_price),
    submittedAt: toMsOrNull(row.submitted_at),
    ackAt: toMsOrNull(row.ack_at),
    cancelRequestedAt: toMsOrNull(row.cancel_requested_at),
    cancelConfirmedAt: toMsOrNull(row.cancel_confirmed_at),
    errorCode: toStrOrNull(row.error_code),
    reason: toStrOrNull(row.reason),
    createdAt: toMs(row.created_at),
    updatedAt: toMs(row.updated_at),
  };
}

export class PostgresExecutionStore implements ExecutionStore {
  constructor(private readonly connection: Pool) {}

  async create(input: CreateWorkflowInput): Promise<{ record: WorkflowRecord; created: boolean }> {
    const client = await this.connection.connect();
    try {
      const inserted = await client.query(
        `INSERT INTO execution_workflows
          (workflow_key, venue, mode, symbol, side, target_qty, policy_version, policy_json,
           client_order_base, has_stop_loss, limit_price, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)
         ON CONFLICT (workflow_key) DO NOTHING
         RETURNING *`,
        [
          input.workflowKey,
          input.venue,
          input.mode,
          input.symbol,
          input.side,
          String(input.targetQty),
          input.policyVersion,
          JSON.stringify(input.policy),
          input.clientOrderBase,
          input.hasStopLoss,
          input.limitPrice === null ? null : String(input.limitPrice),
          new Date(input.now),
        ]
      );
      if ((inserted.rowCount ?? 0) > 0) {
        return { record: decodeWorkflowRow(inserted.rows[0] as Record<string, unknown>), created: true };
      }
      const existing = await client.query("SELECT * FROM execution_workflows WHERE workflow_key = $1", [input.workflowKey]);
      if (!existing.rows[0]) throw new ExecutionStoreError("EXECUTION_STORE_CONFLICT", "Workflow-Key-Konflikt ohne Zeile");
      return { record: decodeWorkflowRow(existing.rows[0] as Record<string, unknown>), created: false };
    } finally {
      client.release();
    }
  }

  async loadByKey(workflowKey: string): Promise<WorkflowRecord | null> {
    const res = await this.connection.query("SELECT * FROM execution_workflows WHERE workflow_key = $1", [workflowKey]);
    if (!res.rows[0]) return null;
    return decodeWorkflowRow(res.rows[0] as Record<string, unknown>);
  }

  async loadById(id: string): Promise<WorkflowRecord | null> {
    const res = await this.connection.query("SELECT * FROM execution_workflows WHERE id = $1", [id]);
    if (!res.rows[0]) return null;
    return decodeWorkflowRow(res.rows[0] as Record<string, unknown>);
  }

  async listOpen(limit = 100): Promise<WorkflowRecord[]> {
    const res = await this.connection.query(
      `SELECT * FROM execution_workflows
        WHERE state NOT IN ('DONE','FAILED')
        ORDER BY updated_at ASC LIMIT $1`,
      [Math.max(1, Math.min(1000, Math.trunc(limit)))]
    );
    return res.rows.map((r) => decodeWorkflowRow(r as Record<string, unknown>));
  }

  async listEvents(workflowId: string): Promise<WorkflowEventRecord[]> {
    const res = await this.connection.query(
      `SELECT * FROM execution_workflow_events WHERE workflow_id = $1 ORDER BY seq ASC LIMIT 10000`,
      [workflowId]
    );
    return res.rows.map((r) => {
      const row = r as Record<string, unknown>;
      const toState = row.to_state;
      if (!isExecutionState(toState)) throw new ExecutionStoreError("EXECUTION_STORE_DECODE", "event state ungültig");
      const fromRaw = row.from_state;
      return {
        seq: toNum(row.seq, "seq"),
        eventId: String(row.event_id),
        fromState: fromRaw === null || fromRaw === undefined ? null : (String(fromRaw) as ExecutionWorkflowState),
        toState,
        reason: String(row.reason),
        policyVersion: String(row.policy_version),
        orderId: toStrOrNull(row.order_id),
        clientOrderId: toStrOrNull(row.client_order_id),
        filledQtyDelta: toNumOrNull(row.filled_qty_delta),
        filledQtyTotal: toNumOrNull(row.filled_qty_total),
        feeDelta: toNumOrNull(row.fee_delta),
        quoteMid: toNumOrNull(row.quote_mid),
        spreadBps: toNumOrNull(row.spread_bps),
        eventTime: toMs(row.event_time),
        availableAt: toMs(row.available_at),
        computedAt: toMs(row.computed_at),
        detail: (row.detail as Record<string, unknown>) ?? {},
      };
    });
  }

  async listFills(workflowId: string): Promise<WorkflowFillRecord[]> {
    const res = await this.connection.query(
      `SELECT fill_id, order_id, qty, price, fee_quote, event_time, available_at
         FROM execution_workflow_fills WHERE workflow_id = $1 ORDER BY event_time ASC, fill_id ASC LIMIT 10000`,
      [workflowId]
    );
    return res.rows.map((r) => {
      const row = r as Record<string, unknown>;
      return {
        fillId: String(row.fill_id),
        orderId: String(row.order_id),
        qty: toNum(row.qty, "qty"),
        price: toNum(row.price, "price"),
        feeQuote: toNumOrNull(row.fee_quote),
        eventTime: toMs(row.event_time),
        availableAt: toMs(row.available_at),
      };
    });
  }

  async mutate(id: string, expectedVersion: number, mutation: WorkflowMutation): Promise<WorkflowRecord> {
    const client = await this.connection.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout = '10s'");
      const locked = await client.query("SELECT * FROM execution_workflows WHERE id = $1 FOR UPDATE", [id]);
      if (!locked.rows[0]) {
        await client.query("ROLLBACK");
        throw new ExecutionStoreError("EXECUTION_WORKFLOW_NOT_FOUND", `Workflow ${id} unbekannt`);
      }
      const current = decodeWorkflowRow(locked.rows[0] as Record<string, unknown>);
      if (current.version !== expectedVersion) {
        await client.query("ROLLBACK");
        throw new ExecutionStoreConflict(`Version ${expectedVersion} erwartet, ${current.version} gefunden`);
      }
      const toState = mutation.patch.state ?? current.state;
      if (toState !== current.state) assertTransition(current.state, toState);
      await this.insertFills(client, id, mutation.newFills ?? []);
      const totals = await client.query(
        `SELECT COALESCE(SUM(qty), 0) AS filled,
                BOOL_OR(fee_quote IS NULL) AS fee_unknown,
                COALESCE(SUM(fee_quote), 0) AS fees
           FROM execution_workflow_fills WHERE workflow_id = $1`,
        [id]
      );
      const filledQty = Number(totals.rows[0]?.filled ?? 0);
      const feeUnknown = totals.rows[0]?.fee_unknown === true;
      const feeTotal = feeUnknown ? null : Number(totals.rows[0]?.fees ?? 0);
      if (filledQty > current.targetQty + 1e-9) {
        await client.query("ROLLBACK");
        throw new ExecutionStoreError("OVERFILL_DETECTED", `Fills (${filledQty}) über Ziel (${current.targetQty})`);
      }
      const seqRes = await client.query(
        "SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM execution_workflow_events WHERE workflow_id = $1",
        [id]
      );
      const seq = Number(seqRes.rows[0]?.next_seq ?? 1);
      const eventId = buildWorkflowEventId({
        workflowId: id,
        seq,
        toState: mutation.event.toState,
        reason: mutation.event.reason,
        orderId: mutation.event.orderId ?? null,
        eventTime: mutation.event.eventTime,
      });
      const updated = await client.query(
        `UPDATE execution_workflows SET
           state = $2, version = version + 1,
           attempt = $3, reprices_used = $4, cancel_attempts = $5,
           active_order_id = $6, active_client_order_id = $7,
           fallback_order_id = $8, fallback_client_order_id = $9,
           limit_price = $10, submitted_at = $11, ack_at = $12,
           cancel_requested_at = $13, cancel_confirmed_at = $14,
           error_code = $15, reason = $16,
           filled_qty = $17, fee_quote_total = $18,
           updated_at = $19
         WHERE id = $1 AND version = $20
         RETURNING *`,
        [
          id,
          toState,
          mutation.patch.attempt ?? current.attempt,
          mutation.patch.repricesUsed ?? current.repricesUsed,
          mutation.patch.cancelAttempts ?? current.cancelAttempts,
          mutation.patch.activeOrderId !== undefined ? mutation.patch.activeOrderId : current.activeOrderId,
          mutation.patch.activeClientOrderId !== undefined ? mutation.patch.activeClientOrderId : current.activeClientOrderId,
          mutation.patch.fallbackOrderId !== undefined ? mutation.patch.fallbackOrderId : current.fallbackOrderId,
          mutation.patch.fallbackClientOrderId !== undefined ? mutation.patch.fallbackClientOrderId : current.fallbackClientOrderId,
          mutation.patch.limitPrice !== undefined ? (mutation.patch.limitPrice === null ? null : String(mutation.patch.limitPrice)) : (current.limitPrice === null ? null : String(current.limitPrice)),
          msOrNull(mutation.patch.submittedAt !== undefined ? mutation.patch.submittedAt : current.submittedAt),
          msOrNull(mutation.patch.ackAt !== undefined ? mutation.patch.ackAt : current.ackAt),
          msOrNull(mutation.patch.cancelRequestedAt !== undefined ? mutation.patch.cancelRequestedAt : current.cancelRequestedAt),
          msOrNull(mutation.patch.cancelConfirmedAt !== undefined ? mutation.patch.cancelConfirmedAt : current.cancelConfirmedAt),
          mutation.patch.errorCode !== undefined ? mutation.patch.errorCode : current.errorCode,
          mutation.patch.reason !== undefined ? mutation.patch.reason : current.reason,
          String(filledQty),
          feeTotal === null ? null : String(feeTotal),
          new Date(mutation.event.computedAt),
          expectedVersion,
        ]
      );
      if ((updated.rowCount ?? 0) === 0) {
        await client.query("ROLLBACK");
        throw new ExecutionStoreConflict("Optimistic-Lock-Konflikt beim Workflow-Update");
      }
      await client.query(
        `INSERT INTO execution_workflow_events
          (workflow_id, seq, event_id, from_state, to_state, reason, policy_version,
           order_id, client_order_id, filled_qty_delta, filled_qty_total, fee_delta,
           quote_mid, spread_bps, event_time, available_at, computed_at, detail)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [
          id,
          seq,
          eventId,
          current.state,
          mutation.event.toState,
          mutation.event.reason,
          current.policyVersion,
          mutation.event.orderId ?? null,
          mutation.event.clientOrderId ?? null,
          mutation.event.filledQtyDelta ?? null,
          String(filledQty),
          mutation.event.feeDelta ?? null,
          mutation.event.quoteMid ?? null,
          mutation.event.spreadBps ?? null,
          new Date(mutation.event.eventTime),
          new Date(mutation.event.availableAt),
          new Date(mutation.event.computedAt),
          JSON.stringify(mutation.event.detail ?? {}),
        ]
      );
      await client.query("COMMIT");
      return decodeWorkflowRow(updated.rows[0] as Record<string, unknown>);
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Rollback-Fehler nach bereits fehlgeschlagener Transaktion sind
        // Betriebsrauschen — der Originalfehler trägt die Information.
      }
      throw e;
    } finally {
      client.release();
    }
  }

  private async insertFills(client: PoolClient, workflowId: string, fills: WorkflowFillRecord[]): Promise<void> {
    for (const f of fills) {
      await client.query(
        `INSERT INTO execution_workflow_fills
          (workflow_id, fill_id, order_id, qty, price, fee_quote, event_time, available_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (workflow_id, fill_id) DO NOTHING`,
        [
          workflowId,
          f.fillId,
          f.orderId,
          String(f.qty),
          String(f.price),
          f.feeQuote === null ? null : String(f.feeQuote),
          new Date(f.eventTime),
          new Date(f.availableAt),
        ]
      );
    }
  }
}

function msOrNull(ms: number | null): Date | null {
  if (ms === null || ms === undefined) return null;
  return new Date(ms);
}
