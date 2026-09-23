/**
 * Persistenz des TWAP-Schedulers (RMA-P4-03).
 *
 * Parents und Slices sind mutable (Lease, Cursor, Fill-Stand). Events und
 * Evaluations sind append-only. Die Kind-Identität (`etc1:`) hängt nur am
 * Slice-Index, nicht an der noch änderbaren Pending-Menge. Ein Submit-Claim
 * ist ein atomares Compare-and-Set: zwei Worker können denselben Slice nicht
 * beide claimen.
 *
 * Zeitstempel sind Epoch-Millisekunden. Numerische Spalten kommen aus Postgres
 * als String und werden beim Lesen in Zahlen gewandelt; `null` bleibt `null`
 * (unbekannt ≠ 0).
 */
import { randomUUID } from "node:crypto";
import type { BrokerVenueId, ExecutionMode } from "../../contracts/broker";
import { TwapError } from "./errors";
import type { TwapPolicyInput } from "./policy";
import { parseTwapPolicy } from "./policy";
import type { TwapParentStatus, TwapSliceStatus } from "./reconcile";

export interface TwapParentRecord {
  id: string;
  parentKey: string;
  venue: BrokerVenueId;
  mode: ExecutionMode;
  symbol: string;
  side: "LONG" | "SHORT";
  targetQty: number;
  filledQty: number;
  unscheduledQty: number | null;
  startAt: number;
  deadlineAt: number;
  sliceIntervalMs: number;
  policyVersion: string;
  policy: TwapPolicyInput;
  jitterSeed: string | null;
  status: TwapParentStatus;
  reason: string | null;
  cursorIndex: number;
  planVersion: number;
  leaseOwner: string | null;
  leaseToken: string | null;
  leaseUntil: number | null;
  version: number;
  limitPrice: number | null;
  arrivalMid: number | null;
  arrivalEventTime: number | null;
  arrivalAvailableAt: number | null;
  hasStopLoss: boolean;
  scope: string;
  quoteCurrency: string;
  quantityStep: number;
  priceStep: number;
  minQuantity: number;
  createdAt: number;
  updatedAt: number;
}

export interface TwapSliceRecord {
  id: string;
  parentId: string;
  sliceIndex: number;
  childKey: string;
  planVersion: number;
  targetQty: number;
  filledQty: number;
  scheduledAt: number;
  status: TwapSliceStatus;
  submitClaim: string | null;
  claimedAt: number | null;
  qtyFrozen: boolean;
  workflowKey: string | null;
  workflowId: string | null;
  limitPrice: number | null;
  skipReason: string | null;
  depthQty: number | null;
  impactBps: number | null;
  participationCap: number | null;
  version: number;
  submittedAt: number | null;
  completedAt: number | null;
}

export interface TwapEventRecord {
  id: string;
  parentId: string;
  sliceId: string | null;
  seq: number;
  eventId: string;
  kind: string;
  reason: string;
  fromStatus: string | null;
  toStatus: string | null;
  detail: Record<string, unknown>;
  eventTime: number;
  availableAt: number;
  computedAt: number;
  policyVersion: string;
}

export interface TwapEvaluationRecord {
  id: string;
  parentId: string;
  evalKey: string;
  asOf: number;
  computedAt: number;
  completion: number | null;
  durationMs: number | null;
  coverage: number | null;
  twapShortfallBps: number | null;
  immediateShortfallBps: number | null;
  shortfallVsImmediateBps: number | null;
  arrivalPrice: number | null;
  twapVwap: number | null;
  immediateVwap: number | null;
  filledQty: number;
  targetQty: number;
  reason: string;
  detail: Record<string, unknown>;
}

export interface CreateParentInput {
  parentKey: string;
  venue: BrokerVenueId;
  mode: ExecutionMode;
  symbol: string;
  side: "LONG" | "SHORT";
  targetQty: number;
  startAt: number;
  deadlineAt: number;
  sliceIntervalMs: number;
  policyVersion: string;
  policy: TwapPolicyInput;
  jitterSeed: string | null;
  limitPrice: number | null;
  hasStopLoss: boolean;
  scope: string;
  quoteCurrency: string;
  quantityStep: number;
  priceStep: number;
  minQuantity: number;
  now: number;
}

export interface ParentPatch {
  status?: TwapParentStatus;
  reason?: string | null;
  filledQty?: number;
  unscheduledQty?: number | null;
  cursorIndex?: number;
  planVersion?: number;
  arrivalMid?: number | null;
  arrivalEventTime?: number | null;
  arrivalAvailableAt?: number | null;
}

export interface NewSliceInput {
  sliceIndex: number;
  childKey: string;
  planVersion: number;
  targetQty: number;
  scheduledAt: number;
}

export interface SlicePatch {
  status?: TwapSliceStatus;
  targetQty?: number;
  filledQty?: number;
  scheduledAt?: number;
  planVersion?: number;
  submitClaim?: string | null;
  claimedAt?: number | null;
  qtyFrozen?: boolean;
  workflowKey?: string | null;
  workflowId?: string | null;
  limitPrice?: number | null;
  skipReason?: string | null;
  depthQty?: number | null;
  impactBps?: number | null;
  participationCap?: number | null;
  submittedAt?: number | null;
  completedAt?: number | null;
}

export interface NewEventInput {
  parentId: string;
  sliceId?: string | null;
  eventId: string;
  kind: string;
  reason: string;
  fromStatus?: string | null;
  toStatus?: string | null;
  detail?: Record<string, unknown>;
  eventTime: number;
  availableAt: number;
  computedAt: number;
  policyVersion: string;
}

export interface NewEvaluationInput {
  parentId: string;
  evalKey: string;
  asOf: number;
  computedAt: number;
  completion: number | null;
  durationMs: number | null;
  coverage: number | null;
  twapShortfallBps: number | null;
  immediateShortfallBps: number | null;
  shortfallVsImmediateBps: number | null;
  arrivalPrice: number | null;
  twapVwap: number | null;
  immediateVwap: number | null;
  filledQty: number;
  targetQty: number;
  reason: string;
  detail?: Record<string, unknown>;
}

export interface TwapQueryable {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

export interface TwapStore {
  createParent(input: CreateParentInput): Promise<{ record: TwapParentRecord; created: boolean }>;
  loadParent(id: string): Promise<TwapParentRecord | null>;
  loadParentByKey(key: string): Promise<TwapParentRecord | null>;
  listActionable(limit: number): Promise<TwapParentRecord[]>;
  acquireLease(id: string, version: number, worker: string, token: string, now: number, until: number): Promise<TwapParentRecord | null>;
  releaseLease(id: string, worker: string, token: string): Promise<boolean>;
  updateParent(id: string, version: number, patch: ParentPatch, now: number): Promise<TwapParentRecord>;
  insertSlices(parentId: string, slices: NewSliceInput[]): Promise<TwapSliceRecord[]>;
  listSlices(parentId: string): Promise<TwapSliceRecord[]>;
  claimSlice(id: string, version: number, worker: string, now: number, stealBefore: number): Promise<TwapSliceRecord | null>;
  updateSlice(id: string, version: number, patch: SlicePatch): Promise<TwapSliceRecord>;
  appendEvent(event: NewEventInput): Promise<TwapEventRecord>;
  listEvents(parentId: string, limit: number): Promise<TwapEventRecord[]>;
  saveEvaluation(row: NewEvaluationInput): Promise<{ inserted: boolean }>;
  latestEvaluation(parentId: string): Promise<TwapEvaluationRecord | null>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class InMemoryTwapStore implements TwapStore {
  private readonly parents = new Map<string, TwapParentRecord>();
  private readonly byKey = new Map<string, string>();
  private readonly slices = new Map<string, TwapSliceRecord>();
  private readonly events: TwapEventRecord[] = [];
  private readonly evals: TwapEvaluationRecord[] = [];
  private seq = new Map<string, number>();

  async createParent(input: CreateParentInput): Promise<{ record: TwapParentRecord; created: boolean }> {
    const existingId = this.byKey.get(input.parentKey);
    if (existingId) {
      const existing = this.parents.get(existingId)!;
      if (existing.policyVersion !== input.policyVersion) {
        throw new TwapError("POLICY_MISMATCH", "ein Parent-Key, eine Policy");
      }
      return { record: clone(existing), created: false };
    }
    const now = input.now;
    const record: TwapParentRecord = {
      id: randomUUID(),
      parentKey: input.parentKey,
      venue: input.venue,
      mode: input.mode,
      symbol: input.symbol,
      side: input.side,
      targetQty: input.targetQty,
      filledQty: 0,
      unscheduledQty: null,
      startAt: input.startAt,
      deadlineAt: input.deadlineAt,
      sliceIntervalMs: input.sliceIntervalMs,
      policyVersion: input.policyVersion,
      policy: { ...input.policy },
      jitterSeed: input.jitterSeed,
      status: "PLANNED",
      reason: null,
      cursorIndex: 0,
      planVersion: 0,
      leaseOwner: null,
      leaseToken: null,
      leaseUntil: null,
      version: 1,
      limitPrice: input.limitPrice,
      arrivalMid: null,
      arrivalEventTime: null,
      arrivalAvailableAt: null,
      hasStopLoss: input.hasStopLoss,
      scope: input.scope,
      quoteCurrency: input.quoteCurrency,
      quantityStep: input.quantityStep,
      priceStep: input.priceStep,
      minQuantity: input.minQuantity,
      createdAt: now,
      updatedAt: now,
    };
    this.parents.set(record.id, record);
    this.byKey.set(record.parentKey, record.id);
    return { record: clone(record), created: true };
  }

  async loadParent(id: string): Promise<TwapParentRecord | null> {
    const row = this.parents.get(id);
    return row ? clone(row) : null;
  }

  async loadParentByKey(key: string): Promise<TwapParentRecord | null> {
    const id = this.byKey.get(key);
    return id ? this.loadParent(id) : null;
  }

  async listActionable(limit: number): Promise<TwapParentRecord[]> {
    return [...this.parents.values()]
      .filter((p) => p.status === "PLANNED" || p.status === "RUNNING" || p.status === "PAUSED")
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, limit)
      .map(clone);
  }

  async acquireLease(id: string, version: number, worker: string, token: string, now: number, until: number): Promise<TwapParentRecord | null> {
    const row = this.parents.get(id);
    if (!row || row.version !== version) return null;
    if (row.status !== "PLANNED" && row.status !== "RUNNING" && row.status !== "PAUSED") return null;
    if (row.leaseUntil !== null && row.leaseUntil > now && row.leaseOwner !== worker) return null;
    row.leaseOwner = worker;
    row.leaseToken = token;
    row.leaseUntil = until;
    row.version += 1;
    row.updatedAt = now;
    return clone(row);
  }

  async releaseLease(id: string, worker: string, token: string): Promise<boolean> {
    const row = this.parents.get(id);
    if (!row || row.leaseOwner !== worker || row.leaseToken !== token) return false;
    row.leaseOwner = null;
    row.leaseToken = null;
    row.leaseUntil = null;
    row.version += 1;
    return true;
  }

  async updateParent(id: string, version: number, patch: ParentPatch, now: number): Promise<TwapParentRecord> {
    const row = this.parents.get(id);
    if (!row || row.version !== version) throw new TwapError("STORE_CONFLICT", `parent ${id} version ${version}`);
    Object.assign(row, patch, { version: row.version + 1, updatedAt: now });
    return clone(row);
  }

  async insertSlices(parentId: string, slices: NewSliceInput[]): Promise<TwapSliceRecord[]> {
    if (!this.parents.has(parentId)) throw new TwapError("PARENT_NOT_FOUND", parentId);
    const out: TwapSliceRecord[] = [];
    for (const s of slices) {
      if ([...this.slices.values()].some((e) => e.childKey === s.childKey || (e.parentId === parentId && e.sliceIndex === s.sliceIndex))) {
        throw new TwapError("SLICE_CONFLICT", `slice ${s.sliceIndex} existiert bereits`);
      }
      const row: TwapSliceRecord = {
        id: randomUUID(),
        parentId,
        sliceIndex: s.sliceIndex,
        childKey: s.childKey,
        planVersion: s.planVersion,
        targetQty: s.targetQty,
        filledQty: 0,
        scheduledAt: s.scheduledAt,
        status: "PENDING",
        submitClaim: null,
        claimedAt: null,
        qtyFrozen: false,
        workflowKey: null,
        workflowId: null,
        limitPrice: null,
        skipReason: null,
        depthQty: null,
        impactBps: null,
        participationCap: null,
        version: 1,
        submittedAt: null,
        completedAt: null,
      };
      this.slices.set(row.id, row);
      out.push(clone(row));
    }
    return out;
  }

  async listSlices(parentId: string): Promise<TwapSliceRecord[]> {
    return [...this.slices.values()].filter((s) => s.parentId === parentId).sort((a, b) => a.sliceIndex - b.sliceIndex).map(clone);
  }

  async claimSlice(id: string, version: number, worker: string, now: number, stealBefore: number): Promise<TwapSliceRecord | null> {
    const row = this.slices.get(id);
    if (!row || row.version !== version || row.status !== "PENDING") return null;
    if (row.submitClaim && row.submitClaim !== worker) {
      if ((row.claimedAt ?? 0) > stealBefore) return null;
    }
    row.submitClaim = worker;
    row.claimedAt = now;
    row.version += 1;
    return clone(row);
  }

  async updateSlice(id: string, version: number, patch: SlicePatch): Promise<TwapSliceRecord> {
    const row = this.slices.get(id);
    if (!row || row.version !== version) throw new TwapError("STORE_CONFLICT", `slice ${id} version ${version}`);
    Object.assign(row, patch, { version: row.version + 1 });
    return clone(row);
  }

  async appendEvent(event: NewEventInput): Promise<TwapEventRecord> {
    const seq = (this.seq.get(event.parentId) ?? 0) + 1;
    this.seq.set(event.parentId, seq);
    const row: TwapEventRecord = {
      id: randomUUID(),
      parentId: event.parentId,
      sliceId: event.sliceId ?? null,
      seq,
      eventId: event.eventId,
      kind: event.kind,
      reason: event.reason,
      fromStatus: event.fromStatus ?? null,
      toStatus: event.toStatus ?? null,
      detail: event.detail ?? {},
      eventTime: event.eventTime,
      availableAt: event.availableAt,
      computedAt: event.computedAt,
      policyVersion: event.policyVersion,
    };
    this.events.push(row);
    return clone(row);
  }

  async listEvents(parentId: string, limit: number): Promise<TwapEventRecord[]> {
    return this.events.filter((e) => e.parentId === parentId).slice(0, limit).map(clone);
  }

  async saveEvaluation(row: NewEvaluationInput): Promise<{ inserted: boolean }> {
    if (this.evals.some((e) => e.evalKey === row.evalKey)) return { inserted: false };
    this.evals.push({
      id: randomUUID(),
      parentId: row.parentId,
      evalKey: row.evalKey,
      asOf: row.asOf,
      computedAt: row.computedAt,
      completion: row.completion,
      durationMs: row.durationMs,
      coverage: row.coverage,
      twapShortfallBps: row.twapShortfallBps,
      immediateShortfallBps: row.immediateShortfallBps,
      shortfallVsImmediateBps: row.shortfallVsImmediateBps,
      arrivalPrice: row.arrivalPrice,
      twapVwap: row.twapVwap,
      immediateVwap: row.immediateVwap,
      filledQty: row.filledQty,
      targetQty: row.targetQty,
      reason: row.reason,
      detail: row.detail ?? {},
    });
    return { inserted: true };
  }

  async latestEvaluation(parentId: string): Promise<TwapEvaluationRecord | null> {
    const rows = this.evals.filter((e) => e.parentId === parentId);
    return rows.length ? clone(rows[rows.length - 1]!) : null;
  }
}

function num(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) throw new TwapError("STORE_NUMERIC", "ungültige Zahl aus der Datenbank");
  return n;
}

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return num(value);
}

function ts(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  const n = new Date(String(value)).getTime();
  if (!Number.isFinite(n)) throw new TwapError("STORE_TIME", "ungültiger Zeitstempel");
  return n;
}

function tsOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return ts(value);
}

function isSeqConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String(error.code) : "";
  if (code !== "23505") return false;
  const constraint = "constraint" in error ? String(error.constraint) : "";
  return constraint.length === 0 || constraint.includes("seq");
}

function parentFrom(row: Record<string, unknown>): TwapParentRecord {
  const policy = parseTwapPolicy(row.policy_json);
  return {
    id: String(row.id),
    parentKey: String(row.parent_key),
    venue: row.venue as BrokerVenueId,
    mode: row.mode as ExecutionMode,
    symbol: String(row.symbol),
    side: row.side as "LONG" | "SHORT",
    targetQty: num(row.target_qty),
    filledQty: num(row.filled_qty),
    unscheduledQty: numOrNull(row.unscheduled_qty),
    startAt: ts(row.start_at),
    deadlineAt: ts(row.deadline_at),
    sliceIntervalMs: num(row.slice_interval_ms),
    policyVersion: String(row.policy_version),
    policy,
    jitterSeed: row.jitter_seed === null || row.jitter_seed === undefined ? null : String(row.jitter_seed),
    status: row.status as TwapParentStatus,
    reason: row.reason === null || row.reason === undefined ? null : String(row.reason),
    cursorIndex: num(row.cursor_index),
    planVersion: num(row.plan_version),
    leaseOwner: row.lease_owner == null ? null : String(row.lease_owner),
    leaseToken: row.lease_token == null ? null : String(row.lease_token),
    leaseUntil: tsOrNull(row.lease_until),
    version: num(row.version),
    limitPrice: numOrNull(row.limit_price),
    arrivalMid: numOrNull(row.arrival_mid),
    arrivalEventTime: tsOrNull(row.arrival_event_time),
    arrivalAvailableAt: tsOrNull(row.arrival_available_at),
    hasStopLoss: row.has_stop_loss === true,
    scope: String(row.scope),
    quoteCurrency: String(row.quote_currency),
    quantityStep: num(row.quantity_step),
    priceStep: num(row.price_step),
    minQuantity: num(row.min_quantity),
    createdAt: ts(row.created_at),
    updatedAt: ts(row.updated_at),
  };
}

function sliceFrom(row: Record<string, unknown>): TwapSliceRecord {
  return {
    id: String(row.id),
    parentId: String(row.parent_id),
    sliceIndex: num(row.slice_index),
    childKey: String(row.child_key),
    planVersion: num(row.plan_version),
    targetQty: num(row.target_qty),
    filledQty: num(row.filled_qty),
    scheduledAt: ts(row.scheduled_at),
    status: row.status as TwapSliceStatus,
    submitClaim: row.submit_claim == null ? null : String(row.submit_claim),
    claimedAt: tsOrNull(row.claimed_at),
    qtyFrozen: row.qty_frozen === true,
    workflowKey: row.workflow_key == null ? null : String(row.workflow_key),
    workflowId: row.workflow_id == null ? null : String(row.workflow_id),
    limitPrice: numOrNull(row.limit_price),
    skipReason: row.skip_reason == null ? null : String(row.skip_reason),
    depthQty: numOrNull(row.depth_qty),
    impactBps: numOrNull(row.impact_bps),
    participationCap: numOrNull(row.participation_cap),
    version: num(row.version),
    submittedAt: tsOrNull(row.submitted_at),
    completedAt: tsOrNull(row.completed_at),
  };
}

const PARENT_COLS = `id, parent_key, venue, mode, symbol, side, target_qty, filled_qty, unscheduled_qty,
  start_at, deadline_at, slice_interval_ms, policy_version, policy_json, jitter_seed, status, reason,
  cursor_index, plan_version, lease_owner, lease_token, lease_until, version, limit_price, arrival_mid,
  arrival_event_time, arrival_available_at, has_stop_loss, scope, quote_currency, quantity_step, price_step,
  min_quantity, created_at, updated_at`;

export class PostgresTwapStore implements TwapStore {
  constructor(private readonly db: TwapQueryable) {}

  async createParent(input: CreateParentInput): Promise<{ record: TwapParentRecord; created: boolean }> {
    const inserted = await this.db.query(
      `INSERT INTO execution_twap_parents (
         parent_key, venue, mode, symbol, side, target_qty, start_at, deadline_at, slice_interval_ms,
         policy_version, policy_json, jitter_seed, limit_price, has_stop_loss, scope, quote_currency,
         quantity_step, price_step, min_quantity, created_at, updated_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,to_timestamp($7/1000.0),to_timestamp($8/1000.0),$9,
         $10,$11::jsonb,$12,$13,$14,$15,$16,$17,$18,$19,to_timestamp($20/1000.0),to_timestamp($20/1000.0)
       )
       ON CONFLICT (parent_key) DO NOTHING
       RETURNING ${PARENT_COLS}`,
      [
        input.parentKey, input.venue, input.mode, input.symbol, input.side, input.targetQty,
        input.startAt, input.deadlineAt, input.sliceIntervalMs, input.policyVersion,
        JSON.stringify(input.policy), input.jitterSeed, input.limitPrice, input.hasStopLoss,
        input.scope, input.quoteCurrency, input.quantityStep, input.priceStep, input.minQuantity, input.now,
      ],
    );
    if (inserted.rows[0]) return { record: parentFrom(inserted.rows[0]), created: true };
    const existing = await this.loadParentByKey(input.parentKey);
    if (!existing) throw new TwapError("STORE_CONFLICT", "parent insert verloren");
    if (existing.policyVersion !== input.policyVersion) throw new TwapError("POLICY_MISMATCH", "ein Parent-Key, eine Policy");
    return { record: existing, created: false };
  }

  async loadParent(id: string): Promise<TwapParentRecord | null> {
    const res = await this.db.query(`SELECT ${PARENT_COLS} FROM execution_twap_parents WHERE id = $1`, [id]);
    return res.rows[0] ? parentFrom(res.rows[0]) : null;
  }

  async loadParentByKey(key: string): Promise<TwapParentRecord | null> {
    const res = await this.db.query(`SELECT ${PARENT_COLS} FROM execution_twap_parents WHERE parent_key = $1`, [key]);
    return res.rows[0] ? parentFrom(res.rows[0]) : null;
  }

  async listActionable(limit: number): Promise<TwapParentRecord[]> {
    const res = await this.db.query(
      `SELECT ${PARENT_COLS} FROM execution_twap_parents
       WHERE status IN ('PLANNED','RUNNING','PAUSED')
       ORDER BY created_at ASC LIMIT $1`,
      [limit],
    );
    return res.rows.map(parentFrom);
  }

  async acquireLease(id: string, version: number, worker: string, token: string, now: number, until: number): Promise<TwapParentRecord | null> {
    const res = await this.db.query(
      `UPDATE execution_twap_parents
       SET lease_owner = $3, lease_token = $4, lease_until = to_timestamp($6/1000.0),
           version = version + 1, updated_at = to_timestamp($5/1000.0)
       WHERE id = $1 AND version = $2
         AND status IN ('PLANNED','RUNNING','PAUSED')
         AND (lease_until IS NULL OR lease_until <= to_timestamp($5/1000.0) OR lease_owner = $3)
       RETURNING ${PARENT_COLS}`,
      [id, version, worker, token, now, until],
    );
    return res.rows[0] ? parentFrom(res.rows[0]) : null;
  }

  async releaseLease(id: string, worker: string, token: string): Promise<boolean> {
    const res = await this.db.query(
      `UPDATE execution_twap_parents
       SET lease_owner = NULL, lease_token = NULL, lease_until = NULL, version = version + 1, updated_at = now()
       WHERE id = $1 AND lease_owner = $2 AND lease_token = $3`,
      [id, worker, token],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async updateParent(id: string, version: number, patch: ParentPatch, now: number): Promise<TwapParentRecord> {
    const current = await this.loadParent(id);
    if (!current || current.version !== version) throw new TwapError("STORE_CONFLICT", `parent ${id}`);
    const next = { ...current, ...patch };
    const res = await this.db.query(
      `UPDATE execution_twap_parents SET
         status = $3, reason = $4, filled_qty = $5, unscheduled_qty = $6, cursor_index = $7, plan_version = $8,
         arrival_mid = $9, arrival_event_time = $10, arrival_available_at = $11,
         version = version + 1, updated_at = to_timestamp($12/1000.0)
       WHERE id = $1 AND version = $2
       RETURNING ${PARENT_COLS}`,
      [
        id, version, next.status, next.reason, next.filledQty, next.unscheduledQty, next.cursorIndex, next.planVersion,
        next.arrivalMid,
        next.arrivalEventTime === null ? null : new Date(next.arrivalEventTime),
        next.arrivalAvailableAt === null ? null : new Date(next.arrivalAvailableAt),
        now,
      ],
    );
    if (!res.rows[0]) throw new TwapError("STORE_CONFLICT", `parent ${id}`);
    return parentFrom(res.rows[0]);
  }

  async insertSlices(parentId: string, slices: NewSliceInput[]): Promise<TwapSliceRecord[]> {
    const out: TwapSliceRecord[] = [];
    for (const s of slices) {
      const res = await this.db.query(
        `INSERT INTO execution_twap_slices (parent_id, slice_index, child_key, plan_version, target_qty, scheduled_at)
         VALUES ($1,$2,$3,$4,$5,to_timestamp($6/1000.0))
         RETURNING *`,
        [parentId, s.sliceIndex, s.childKey, s.planVersion, s.targetQty, s.scheduledAt],
      );
      if (!res.rows[0]) throw new TwapError("SLICE_CONFLICT", s.childKey);
      out.push(sliceFrom(res.rows[0]));
    }
    return out;
  }

  async listSlices(parentId: string): Promise<TwapSliceRecord[]> {
    const res = await this.db.query(
      `SELECT * FROM execution_twap_slices WHERE parent_id = $1 ORDER BY slice_index ASC`,
      [parentId],
    );
    return res.rows.map(sliceFrom);
  }

  async claimSlice(id: string, version: number, worker: string, now: number, stealBefore: number): Promise<TwapSliceRecord | null> {
    const res = await this.db.query(
      `UPDATE execution_twap_slices
       SET submit_claim = $3, claimed_at = to_timestamp($4/1000.0), version = version + 1
       WHERE id = $1 AND version = $2 AND status = 'PENDING'
         AND (submit_claim IS NULL OR submit_claim = $3 OR claimed_at IS NULL OR claimed_at <= to_timestamp($5/1000.0))
       RETURNING *`,
      [id, version, worker, now, stealBefore],
    );
    return res.rows[0] ? sliceFrom(res.rows[0]) : null;
  }

  async updateSlice(id: string, version: number, patch: SlicePatch): Promise<TwapSliceRecord> {
    const current = await this.db.query(`SELECT * FROM execution_twap_slices WHERE id = $1`, [id]);
    if (!current.rows[0]) throw new TwapError("SLICE_NOT_FOUND", id);
    const row = sliceFrom(current.rows[0]);
    if (row.version !== version) throw new TwapError("STORE_CONFLICT", `slice ${id}`);
    const next = { ...row, ...patch };
    const res = await this.db.query(
      `UPDATE execution_twap_slices SET
         status = $3, target_qty = $4, filled_qty = $5, scheduled_at = to_timestamp($6/1000.0), plan_version = $7,
         submit_claim = $8, claimed_at = $9, qty_frozen = $10, workflow_key = $11, workflow_id = $12,
         limit_price = $13, skip_reason = $14, depth_qty = $15, impact_bps = $16, participation_cap = $17,
         submitted_at = $18, completed_at = $19, version = version + 1
       WHERE id = $1 AND version = $2
       RETURNING *`,
      [
        id, version, next.status, next.targetQty, next.filledQty, next.scheduledAt, next.planVersion,
        next.submitClaim, next.claimedAt === null ? null : new Date(next.claimedAt), next.qtyFrozen,
        next.workflowKey, next.workflowId, next.limitPrice, next.skipReason, next.depthQty, next.impactBps,
        next.participationCap, next.submittedAt === null ? null : new Date(next.submittedAt),
        next.completedAt === null ? null : new Date(next.completedAt),
      ],
    );
    if (!res.rows[0]) throw new TwapError("STORE_CONFLICT", `slice ${id}`);
    return sliceFrom(res.rows[0]);
  }

  async appendEvent(event: NewEventInput): Promise<TwapEventRecord> {
    try {
      return await this.insertEvent(event);
    } catch (e) {
      if (!isSeqConflict(e)) throw e;
      return this.insertEvent(event);
    }
  }

  private async insertEvent(event: NewEventInput): Promise<TwapEventRecord> {
    const res = await this.db.query(
      `INSERT INTO execution_twap_events (
         parent_id, slice_id, seq, event_id, kind, reason, from_status, to_status, detail,
         event_time, available_at, computed_at, policy_version
       )
       SELECT $1, $2, COALESCE((SELECT MAX(seq) FROM execution_twap_events WHERE parent_id = $1), 0) + 1,
              $3, $4, $5, $6, $7, $8::jsonb,
              to_timestamp($9/1000.0), to_timestamp($10/1000.0), to_timestamp($11/1000.0), $12
       RETURNING *`,
      [
        event.parentId, event.sliceId ?? null, event.eventId, event.kind, event.reason,
        event.fromStatus ?? null, event.toStatus ?? null, JSON.stringify(event.detail ?? {}),
        event.eventTime, event.availableAt, event.computedAt, event.policyVersion,
      ],
    );
    const row = res.rows[0];
    if (!row) throw new TwapError("EVENT_INSERT_FAILED", event.eventId);
    return {
      id: String(row.id),
      parentId: String(row.parent_id),
      sliceId: row.slice_id == null ? null : String(row.slice_id),
      seq: num(row.seq),
      eventId: String(row.event_id),
      kind: String(row.kind),
      reason: String(row.reason),
      fromStatus: row.from_status == null ? null : String(row.from_status),
      toStatus: row.to_status == null ? null : String(row.to_status),
      detail: (row.detail ?? {}) as Record<string, unknown>,
      eventTime: ts(row.event_time),
      availableAt: ts(row.available_at),
      computedAt: ts(row.computed_at),
      policyVersion: String(row.policy_version),
    };
  }

  async listEvents(parentId: string, limit: number): Promise<TwapEventRecord[]> {
    const res = await this.db.query(
      `SELECT * FROM execution_twap_events WHERE parent_id = $1 ORDER BY seq ASC LIMIT $2`,
      [parentId, limit],
    );
    return res.rows.map((row) => ({
      id: String(row.id),
      parentId: String(row.parent_id),
      sliceId: row.slice_id == null ? null : String(row.slice_id),
      seq: num(row.seq),
      eventId: String(row.event_id),
      kind: String(row.kind),
      reason: String(row.reason),
      fromStatus: row.from_status == null ? null : String(row.from_status),
      toStatus: row.to_status == null ? null : String(row.to_status),
      detail: (row.detail ?? {}) as Record<string, unknown>,
      eventTime: ts(row.event_time),
      availableAt: ts(row.available_at),
      computedAt: ts(row.computed_at),
      policyVersion: String(row.policy_version),
    }));
  }

  async saveEvaluation(row: NewEvaluationInput): Promise<{ inserted: boolean }> {
    const res = await this.db.query(
      `INSERT INTO execution_twap_evaluations (
         parent_id, eval_key, as_of, computed_at, completion, duration_ms, coverage,
         twap_shortfall_bps, immediate_shortfall_bps, shortfall_vs_immediate_bps,
         arrival_price, twap_vwap, immediate_vwap, filled_qty, target_qty, reason, detail
       ) VALUES (
         $1,$2,to_timestamp($3/1000.0),to_timestamp($4/1000.0),$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb
       )
       ON CONFLICT (eval_key) DO NOTHING
       RETURNING id`,
      [
        row.parentId, row.evalKey, row.asOf, row.computedAt, row.completion, row.durationMs, row.coverage,
        row.twapShortfallBps, row.immediateShortfallBps, row.shortfallVsImmediateBps, row.arrivalPrice,
        row.twapVwap, row.immediateVwap, row.filledQty, row.targetQty, row.reason, JSON.stringify(row.detail ?? {}),
      ],
    );
    return { inserted: (res.rowCount ?? 0) > 0 };
  }

  async latestEvaluation(parentId: string): Promise<TwapEvaluationRecord | null> {
    const res = await this.db.query(
      `SELECT * FROM execution_twap_evaluations WHERE parent_id = $1 ORDER BY computed_at DESC, id DESC LIMIT 1`,
      [parentId],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      id: String(row.id),
      parentId: String(row.parent_id),
      evalKey: String(row.eval_key),
      asOf: ts(row.as_of),
      computedAt: ts(row.computed_at),
      completion: numOrNull(row.completion),
      durationMs: numOrNull(row.duration_ms),
      coverage: numOrNull(row.coverage),
      twapShortfallBps: numOrNull(row.twap_shortfall_bps),
      immediateShortfallBps: numOrNull(row.immediate_shortfall_bps),
      shortfallVsImmediateBps: numOrNull(row.shortfall_vs_immediate_bps),
      arrivalPrice: numOrNull(row.arrival_price),
      twapVwap: numOrNull(row.twap_vwap),
      immediateVwap: numOrNull(row.immediate_vwap),
      filledQty: num(row.filled_qty),
      targetQty: num(row.target_qty),
      reason: String(row.reason),
      detail: (row.detail ?? {}) as Record<string, unknown>,
    };
  }
}
