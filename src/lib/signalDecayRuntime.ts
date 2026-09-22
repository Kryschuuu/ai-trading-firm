/**
 * Laufzeitpfad der versionierten Signal-Decay-Exits (RMA-P5-05, v1.69.0).
 *
 * Verdrahtet die reine Bewertung (`src/lib/signalDecay.ts`) mit Persistenz:
 * unveränderlicher Entry-Snapshot, Bestätigungszustand über Neustarts,
 * idempotente Event-Zeilen und der Monitor-only-Counterfactual-Rollup.
 *
 * Fehlende Spalten/Tabelle (Migration noch nicht angewendet) werden laut
 * gemeldet und fail-closed behandelt: kein Signal-Exit, der Preis-Exit-Pfad
 * des Monitors läuft weiter.
 */

import type { Pool } from "pg";
import { getPool } from "../db";
import { telemetry } from "./telemetry";
import { writeAuditRecord } from "./auditSink";
import {
  applyRiskConfigNumbers,
  buildMarketSignal,
  classKey,
  loadSignalDecayConfig,
  markToMarketPnl,
  policyVersionOf,
  signalDecayEventId,
  signalHash,
  summarizeSignalDecay,
  unavailableSignal,
  validateSignalSnapshot,
  type CandleLike,
  type SignalDecayAudit,
  type SignalDecayConfig,
  type SignalDecayEvaluation,
  type SignalDecayEventView,
  type SignalDecayInput,
  type SignalDecayRollup,
  type SignalSnapshot,
  type StrategyClassKey,
} from "./signalDecay";

export type SignalDecayState = {
  streak: number;
  lastKey: string | null;
  policyVersion: string | null;
  entrySignal: SignalSnapshot | null;
  strategyClass: StrategyClassKey;
};

export type SignalDecayEventInsert = {
  eventId: string;
  positionId: string;
  strategyClass: StrategyClassKey;
  mode: "monitor" | "active";
  outcome: string;
  policyVersion: string;
  policyReason: string;
  entryStrength: number | null;
  currentStrength: number | null;
  entryConfidence: number | null;
  currentConfidence: number | null;
  entryDirection: string | null;
  currentDirection: string | null;
  coverage: number | null;
  semanticsVersion: string | null;
  featureVersion: string | null;
  modelVersion: string | null;
  configVersion: string | null;
  migrationId: string | null;
  confirmStreak: number;
  confirmationRequired: number;
  counterfactualPnl: number | null;
  asOf: Date;
  availableAt: Date | null;
  calculatedAsOf: Date | null;
  computedAt: Date;
  entrySignalHash: string | null;
  observationKey: string | null;
};

export interface SignalDecayStore {
  readState(positionId: string): Promise<SignalDecayState | null>;
  compareAndSetState(
    positionId: string,
    next: { streak: number; lastKey: string | null; policyVersion: string },
    expected: { lastKey: string | null; policyVersion: string | null },
  ): Promise<"updated" | "conflict" | "missing">;
  insertEvent(event: SignalDecayEventInsert): Promise<"written" | "duplicate">;
  listEvents(): Promise<SignalDecayEventView[]>;
  listCloses(): Promise<{ positionId: string; realizedPnl: number | null }[]>;
}

const PERSISTED_OUTCOMES = new Set([
  "MISSING_ENTRY",
  "MISSING_CURRENT",
  "STALE",
  "INCOMPATIBLE",
  "INVALID",
  "FUTURE",
  "LOW_COVERAGE",
  "MIN_HOLD",
  "HOLD",
  "CONFIRMING",
  "WOULD_EXIT",
  "EXIT",
  "SUPPRESSED_KILL_SWITCH",
]);

function num(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseEntry(value: unknown): SignalSnapshot | null {
  if (value == null) return null;
  const parsed = validateSignalSnapshot(value);
  return parsed.ok ? parsed.snapshot : null;
}

export function createMemorySignalDecayStore(
  seed: Record<string, SignalDecayState> = {},
): SignalDecayStore & { states: Map<string, SignalDecayState>; events: SignalDecayEventInsert[] } {
  const states = new Map<string, SignalDecayState>(Object.entries(seed));
  const events: SignalDecayEventInsert[] = [];
  const closes: { positionId: string; realizedPnl: number | null }[] = [];
  return {
    states,
    events,
    async readState(positionId) {
      return states.get(positionId) ?? null;
    },
    async compareAndSetState(positionId, next, expected) {
      const current = states.get(positionId);
      if (!current) return "missing";
      if (current.lastKey !== expected.lastKey || current.policyVersion !== expected.policyVersion) return "conflict";
      states.set(positionId, { ...current, streak: next.streak, lastKey: next.lastKey, policyVersion: next.policyVersion });
      return "updated";
    },
    async insertEvent(event) {
      if (events.some((e) => e.eventId === event.eventId)) return "duplicate";
      events.push(event);
      return "written";
    },
    async listEvents() {
      return events.map((e) => ({
        positionId: e.positionId,
        outcome: e.outcome,
        asOfMs: e.asOf.getTime(),
        counterfactualPnl: e.counterfactualPnl,
        compatible: e.outcome === "HOLD" || e.outcome === "CONFIRMING" || e.outcome === "MIN_HOLD" || e.outcome === "WOULD_EXIT" || e.outcome === "EXIT" || e.outcome === "SUPPRESSED_KILL_SWITCH",
      }));
    },
    async listCloses() {
      return closes;
    },
  };
}

type Queryable = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
};

export function createPgSignalDecayStore(pool: Queryable = getPool()): SignalDecayStore {
  return {
    async readState(positionId) {
      const res = await pool.query(
        `SELECT entry_signal, signal_decay_streak, signal_decay_last_key, signal_decay_policy_version, strategy_class
         FROM positions WHERE id = $1`,
        [positionId],
      );
      const row = res.rows[0];
      if (!row) return null;
      return {
        streak: Number(row.signal_decay_streak ?? 0) || 0,
        lastKey: typeof row.signal_decay_last_key === "string" ? row.signal_decay_last_key : null,
        policyVersion: typeof row.signal_decay_policy_version === "string" ? row.signal_decay_policy_version : null,
        entrySignal: parseEntry(row.entry_signal),
        strategyClass: classKey(row.strategy_class),
      };
    },
    async compareAndSetState(positionId, next, expected) {
      const res = await pool.query(
        `UPDATE positions
         SET signal_decay_streak = $2,
             signal_decay_last_key = $3,
             signal_decay_policy_version = $4,
             updated_at = now()
         WHERE id = $1
           AND status = 'OPEN'
           AND signal_decay_last_key IS NOT DISTINCT FROM $5
           AND signal_decay_policy_version IS NOT DISTINCT FROM $6`,
        [positionId, next.streak, next.lastKey, next.policyVersion, expected.lastKey, expected.policyVersion],
      );
      if ((res.rowCount ?? 0) === 1) return "updated";
      const exists = await pool.query(`SELECT 1 FROM positions WHERE id = $1 AND status = 'OPEN'`, [positionId]);
      return exists.rows.length === 0 ? "missing" : "conflict";
    },
    async insertEvent(event) {
      const res = await pool.query(
        `INSERT INTO signal_decay_events (
           event_id, position_id, strategy_class, mode, outcome, policy_version, policy_reason,
           entry_strength, current_strength, entry_confidence, current_confidence,
           entry_direction, current_direction, coverage,
           semantics_version, feature_version, model_version, config_version, migration_id,
           confirm_streak, confirmation_required, counterfactual_pnl,
           as_of, available_at, calculated_as_of, computed_at,
           entry_signal_hash, observation_key
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,
           $8,$9,$10,$11,
           $12,$13,$14,
           $15,$16,$17,$18,$19,
           $20,$21,$22,
           $23,$24,$25,$26,
           $27,$28
         )
         ON CONFLICT (event_id) DO NOTHING`,
        [
          event.eventId,
          event.positionId,
          event.strategyClass,
          event.mode,
          event.outcome,
          event.policyVersion,
          event.policyReason,
          event.entryStrength,
          event.currentStrength,
          event.entryConfidence,
          event.currentConfidence,
          event.entryDirection,
          event.currentDirection,
          event.coverage,
          event.semanticsVersion,
          event.featureVersion,
          event.modelVersion,
          event.configVersion,
          event.migrationId,
          event.confirmStreak,
          event.confirmationRequired,
          event.counterfactualPnl,
          event.asOf,
          event.availableAt,
          event.calculatedAsOf,
          event.computedAt,
          event.entrySignalHash,
          event.observationKey,
        ],
      );
      return (res.rowCount ?? 0) === 1 ? "written" : "duplicate";
    },
    async listEvents() {
      const res = await pool.query(
        `SELECT position_id, outcome, as_of, counterfactual_pnl
         FROM signal_decay_events
         ORDER BY as_of ASC, event_id ASC`,
      );
      return res.rows.map((row) => ({
        positionId: String(row.position_id),
        outcome: String(row.outcome),
        asOfMs: new Date(String(row.as_of)).getTime(),
        counterfactualPnl: num(row.counterfactual_pnl),
        compatible: ["HOLD", "CONFIRMING", "MIN_HOLD", "WOULD_EXIT", "EXIT", "SUPPRESSED_KILL_SWITCH"].includes(String(row.outcome)),
      }));
    },
    async listCloses() {
      const res = await pool.query(
        `SELECT id, realized_pnl FROM positions WHERE status = 'CLOSED' AND realized_pnl IS NOT NULL`,
      );
      return res.rows.map((row) => ({
        positionId: String(row.id),
        realizedPnl: num(row.realized_pnl),
      }));
    },
  };
}

let cachedConfig: { at: number; config: SignalDecayConfig } | null = null;

/** Env-Policy, optional mit numerischen `sdc.*`-Zeilen aus risk_config. Gecacht für 30 s. */
export async function loadRuntimeSignalDecayConfig(
  env: NodeJS.ProcessEnv = process.env,
  pool: Queryable | null = null,
  nowMs = Date.now(),
): Promise<SignalDecayConfig> {
  if (cachedConfig && nowMs - cachedConfig.at < 30_000 && pool == null) return cachedConfig.config;
  let config = loadSignalDecayConfig(env);
  const reader = pool ?? safePool();
  if (reader) {
    try {
      const res = await reader.query(`SELECT key, value FROM risk_config WHERE key LIKE 'sdc.%'`);
      const rows = res.rows
        .map((row) => ({ key: String(row.key), value: num(row.value) }))
        .filter((row): row is { key: string; value: number } => row.value != null);
      config = applyRiskConfigNumbers(config, rows);
    } catch {
      // Tabelle/Spalte fehlt oder DB weg: Env-Policy bleibt (Klassen default-off).
    }
  }
  if (pool == null) cachedConfig = { at: nowMs, config };
  return config;
}

function safePool(): Queryable | null {
  try {
    return getPool();
  } catch {
    return null;
  }
}

export function resetSignalDecayRuntimeForTests(): void {
  cachedConfig = null;
}

export async function persistEntrySignal(args: {
  positionId: string;
  snapshot: SignalSnapshot;
  pool?: Queryable;
}): Promise<"written" | "exists" | "failed"> {
  const pool = args.pool ?? getPool();
  const hash = signalHash(args.snapshot);
  try {
    const res = await pool.query(
      `UPDATE positions
       SET entry_signal = $2::jsonb,
           entry_signal_hash = $3,
           strategy_class = $4
       WHERE id = $1
         AND entry_signal IS NULL`,
      [args.positionId, JSON.stringify(args.snapshot), hash, args.snapshot.strategyClass],
    );
    return (res.rowCount ?? 0) === 1 ? "written" : "exists";
  } catch (e) {
    console.error("[signal-decay] Entry-Snapshot nicht persistiert:", e instanceof Error ? e.message : e);
    return "failed";
  }
}

/**
 * Baut den `decideExit`-Kontext. `null`, wenn der Modus aus ist oder die
 * Klasse nicht aktiviert ist — der Aufrufer lässt den Preis-Exit dann
 * byte-identisch zum bisherigen Pfad.
 */
export function buildSignalDecayInput(args: {
  entry: SignalSnapshot | null;
  current: SignalSnapshot | null;
  openedAtMs: number;
  asOfMs: number;
  side: "LONG" | "SHORT";
  qty: number;
  entryPrice: number;
  markPrice: number;
  strategyClass: StrategyClassKey;
  confirmation: Pick<SignalDecayState, "streak" | "lastKey" | "policyVersion"> | null;
  config: SignalDecayConfig;
  killSwitchArmed: boolean;
}): SignalDecayInput | null {
  if (args.config.mode === "off") return null;
  if (!args.config.classes[args.strategyClass].enabled) return null;
  return {
    entry: args.entry,
    current: args.current,
    openedAtMs: args.openedAtMs,
    asOfMs: args.asOfMs,
    side: args.side,
    qty: args.qty,
    entryPrice: args.entryPrice,
    markPrice: args.markPrice,
    strategyClass: args.strategyClass,
    confirmation: {
      streak: args.confirmation?.streak ?? 0,
      lastObservationKey: args.confirmation?.lastKey ?? null,
      policyVersion: args.confirmation?.policyVersion ?? null,
    },
    mode: args.config.mode,
    config: args.config,
    killSwitchArmed: args.killSwitchArmed,
  };
}

function isoDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t) : null;
}

export function eventFromEvaluation(args: {
  positionId: string;
  evaluation: SignalDecayEvaluation;
  audit: SignalDecayAudit;
  asOfMs: number;
  entrySignalHash: string | null;
  confirmationRequired: number;
}): SignalDecayEventInsert | null {
  if (!PERSISTED_OUTCOMES.has(args.evaluation.reasonCode)) return null;
  if (args.evaluation.duplicate) return null;
  if (args.evaluation.observationKey == null && args.evaluation.reasonCode !== "MISSING_ENTRY" && args.evaluation.reasonCode !== "MISSING_CURRENT" && args.evaluation.reasonCode !== "INVALID" && args.evaluation.reasonCode !== "INCOMPATIBLE" && args.evaluation.reasonCode !== "FUTURE" && args.evaluation.reasonCode !== "STALE" && args.evaluation.reasonCode !== "LOW_COVERAGE") {
    return null;
  }
  const observationKey = args.evaluation.observationKey ?? `gap:${args.evaluation.reasonCode}:${args.asOfMs}`;
  const mode = args.audit.mode === "active" ? "active" : "monitor";
  return {
    eventId: signalDecayEventId(args.positionId, observationKey, args.evaluation.policyVersion),
    positionId: args.positionId,
    strategyClass: args.evaluation.strategyClass,
    mode,
    outcome: args.evaluation.reasonCode,
    policyVersion: args.evaluation.policyVersion,
    policyReason: args.evaluation.reasonCode,
    entryStrength: args.evaluation.entryStrength,
    currentStrength: args.evaluation.reasonCode === "FUTURE" ? null : args.evaluation.currentStrength,
    entryConfidence: args.evaluation.entryConfidence,
    currentConfidence: args.evaluation.reasonCode === "FUTURE" ? null : args.evaluation.currentConfidence,
    entryDirection: args.audit.entryDirection,
    currentDirection: args.audit.currentDirection,
    coverage: args.evaluation.coverage,
    semanticsVersion: args.audit.semanticsVersion,
    featureVersion: args.audit.featureVersion,
    modelVersion: args.audit.modelVersion,
    configVersion: args.audit.configVersion,
    migrationId: args.evaluation.migrationId,
    confirmStreak: args.evaluation.streak,
    confirmationRequired: args.confirmationRequired,
    counterfactualPnl: args.evaluation.counterfactualPnl,
    asOf: new Date(args.asOfMs),
    availableAt: args.evaluation.reasonCode === "FUTURE" ? null : isoDate(args.audit.currentAvailableAt),
    calculatedAsOf: args.evaluation.reasonCode === "FUTURE" ? null : isoDate(args.audit.currentCalculatedAsOf),
    computedAt: new Date(args.asOfMs),
    entrySignalHash: args.entrySignalHash,
    observationKey: args.evaluation.observationKey,
  };
}

export async function commitSignalDecay(args: {
  store?: SignalDecayStore;
  positionId: string;
  evaluation: SignalDecayEvaluation;
  audit: SignalDecayAudit | null;
  expected: { lastKey: string | null; policyVersion: string | null };
  asOfMs: number;
  entrySignalHash: string | null;
  confirmationRequired: number;
}): Promise<{ state: "updated" | "conflict" | "missing" | "skipped"; event: "written" | "duplicate" | "skipped" }> {
  const store = args.store ?? createPgSignalDecayStore();
  let state: "updated" | "conflict" | "missing" | "skipped" = "skipped";
  if (args.evaluation.streakChanged && !args.evaluation.duplicate) {
    state = await store.compareAndSetState(
      args.positionId,
      {
        streak: args.evaluation.streak,
        lastKey: args.evaluation.observationKey,
        policyVersion: args.evaluation.policyVersion,
      },
      args.expected,
    );
    if (state === "conflict") {
      telemetry.signalDecay.events.inc({ result: "conflict", mode: args.audit?.mode ?? "monitor" });
      return { state, event: "skipped" };
    }
  }
  if (!args.audit) return { state, event: "skipped" };
  const event = eventFromEvaluation({
    positionId: args.positionId,
    evaluation: args.evaluation,
    audit: args.audit,
    asOfMs: args.asOfMs,
    entrySignalHash: args.entrySignalHash,
    confirmationRequired: args.confirmationRequired,
  });
  if (!event) return { state, event: "skipped" };
  try {
    const written = await store.insertEvent(event);
    telemetry.signalDecay.events.inc({ result: written, mode: event.mode });
    telemetry.signalDecay.evaluations.inc({
      result: metricResult(args.evaluation.reasonCode),
      mode: event.mode,
      strategy_class: metricClass(args.evaluation.strategyClass),
    });
    return { state, event: written };
  } catch (e) {
    telemetry.signalDecay.events.inc({ result: "failed", mode: event.mode });
    console.error("[signal-decay] Event nicht geschrieben:", e instanceof Error ? e.message : e);
    return { state, event: "skipped" };
  }
}

function metricResult(code: string): string {
  if (code === "EXIT" || code === "WOULD_EXIT") return "would_exit";
  if (code === "HOLD" || code === "CONFIRMING" || code === "MIN_HOLD") return "hold";
  if (code === "SUPPRESSED_KILL_SWITCH") return "suppressed";
  return "skipped";
}

function metricClass(value: string): string {
  if (value === "mean-reversion" || value === "trend" || value === "breakout" || value === "unclassified") return value;
  return "unclassified";
}

export async function readSignalDecayRollup(store: SignalDecayStore = createPgSignalDecayStore()): Promise<SignalDecayRollup> {
  const [events, closes] = await Promise.all([store.listEvents(), store.listCloses()]);
  return summarizeSignalDecay(events, closes);
}

export function captureUnavailable(strategyClass: StrategyClassKey, computedAtMs: number): SignalSnapshot {
  return unavailableSignal({ strategyClass, computedAtMs });
}

/** Live-Kerzenintervall. `time` ist die Open-Zeit; Close gilt erst nach der Dauer. */
export const LIVE_SIGNAL_INTERVAL = "15m";
export const LIVE_SIGNAL_BAR_MS = 15 * 60 * 1000;

/**
 * Entry-Snapshot nur schreiben, wenn der Modus nicht `off` ist und die Klasse
 * aktiviert ist. Sonst kein Write — Altverhalten bleibt. Ein fehlgeschlagener
 * Write lässt die Position mit NULL (MISSING), nie mit einer erfundenen Stärke.
 * Kerzen müssen bereits point-in-time gefiltert werden (`timeBasis`).
 */
export async function persistClosedEntrySignal(args: {
  positionId: string;
  symbol: string;
  strategyClass: string | null | undefined;
  asOfMs: number;
  candles: readonly CandleLike[];
  barDurationMs?: number;
  timeBasis?: "open" | "close";
  pool?: Queryable;
}): Promise<"written" | "exists" | "failed" | "skipped"> {
  const strategyClass = classKey(args.strategyClass);
  let config: SignalDecayConfig;
  try {
    config = await loadRuntimeSignalDecayConfig();
  } catch {
    return "skipped";
  }
  if (config.mode === "off" || !config.classes[strategyClass].enabled) return "skipped";
  const snapshot = buildMarketSignal({
    candles: args.candles,
    asOfMs: args.asOfMs,
    barDurationMs: args.barDurationMs ?? LIVE_SIGNAL_BAR_MS,
    timeBasis: args.timeBasis ?? "open",
    strategyClass,
    computedAtMs: args.asOfMs,
  });
  const result = await persistEntrySignal({ positionId: args.positionId, snapshot, pool: args.pool });
  if (result === "written") {
    await writeAuditRecord({
      event: "SIGNAL_DECAY_CAPTURED",
      level: "INFO",
      auditClass: "telemetry",
      detail: {
        symbol: args.symbol,
        strategyClass,
        direction: snapshot.direction,
        strength: snapshot.strength,
        confidence: snapshot.confidence,
        coverage: snapshot.coverage,
        semanticsVersion: snapshot.semanticsVersion,
        featureVersion: snapshot.featureVersion,
        modelVersion: snapshot.modelVersion,
        configVersion: snapshot.configVersion,
        calculatedAsOf: snapshot.calculatedAsOf,
        availableAt: snapshot.availableAt,
        hash: signalHash(snapshot),
      },
    });
  }
  return result;
}

/** Baut den optionalen decideExit-Kontext. null = Preis-Pfad unverändert. */
export function signalInputForPosition(args: {
  entry: unknown;
  current: SignalSnapshot | null;
  openedAtMs: number;
  asOfMs: number;
  side: "LONG" | "SHORT";
  qty: number;
  entryPrice: number;
  markPrice: number;
  strategyClass: unknown;
  streak: number;
  lastKey: string | null;
  policyVersion: string | null;
  config: SignalDecayConfig;
  killSwitchArmed: boolean;
}): SignalDecayInput | null {
  const entry = args.entry == null ? null : (args.entry as SignalSnapshot);
  return buildSignalDecayInput({
    entry,
    current: args.current,
    openedAtMs: args.openedAtMs,
    asOfMs: args.asOfMs,
    side: args.side,
    qty: args.qty,
    entryPrice: args.entryPrice,
    markPrice: args.markPrice,
    strategyClass: classKey(args.strategyClass),
    confirmation: {
      streak: args.streak,
      lastKey: args.lastKey,
      policyVersion: args.policyVersion,
    },
    config: args.config,
    killSwitchArmed: args.killSwitchArmed,
  });
}

export { markToMarketPnl, policyVersionOf };
