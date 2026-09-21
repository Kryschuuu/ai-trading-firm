/**
 * Train-select-freeze contracts for production Walk-Forward runs.
 *
 * The selector deliberately accepts IS summaries only. OOS and holdout values
 * have no type-level or runtime path into this module. Candidate and freeze
 * inputs are bounded, JSON-serializable and hashed canonically so a persisted
 * freeze can be audited without trusting process memory.
 */

import { createHash } from "node:crypto";
import { stableStringify, type CandleLike } from "../lib/ruleEngine";
import { APP_VERSION } from "../lib/version";
import type { BacktestEngineOptions, BacktestStrategyItem } from "./types";
import type { WalkForwardWindow, WindowEvalSummary } from "./walkforward";

export const WALK_FORWARD_TRAINING_VERSION = "wf-train-select-freeze-1" as const;
export const WALK_FORWARD_MAX_CANDIDATES = 64;
export const WALK_FORWARD_MAX_STRATEGIES_PER_CANDIDATE = 8;
export const WALK_FORWARD_MAX_CONFIG_KEYS = 32;
export const WALK_FORWARD_MAX_SCORE_ROWS = WALK_FORWARD_MAX_CANDIDATES;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CONFIG_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const SENSITIVE_KEY_PATTERN = /(secret|token|password|credential|api[_-]?key|private[_-]?key)/i;

export type CandidateConfigValue = string | number | boolean | null;
export type CandidateConfig = Readonly<Record<string, CandidateConfigValue>>;

/**
 * One bounded, executable strategy candidate. `strategies` contains only
 * sanitized rule/setup data; it never contains a callback or executable code.
 */
export interface WalkForwardCandidate {
  id: string;
  strategyVersion: string;
  config: CandidateConfig;
  strategies: readonly BacktestStrategyItem[];
}

export type WalkForwardSelectionMetric =
  | "netPnl"
  | "pnl"
  | "sharpeRatio"
  | "sortinoRatio"
  | "profitFactor"
  | "winRate";

export type WalkForwardTieBreak =
  | "score"
  | "netPnl"
  | "pnl"
  | "profitFactor"
  | "sharpeRatio"
  | "sortinoRatio"
  | "maxDrawdownPct"
  | "trades"
  | "winRate"
  | "candidateId";

export const DEFAULT_WALK_FORWARD_SELECTION = {
  metric: "netPnl" as WalkForwardSelectionMetric,
  minTrades: 1,
  minWinRatePct: null as number | null,
  minProfitFactor: null as number | null,
  maxDrawdownPct: null as number | null,
  tieBreak: ["score", "maxDrawdownPct", "profitFactor", "sharpeRatio", "candidateId"] as readonly WalkForwardTieBreak[],
};

export interface WalkForwardSelectionConfig {
  metric: WalkForwardSelectionMetric;
  minTrades: number;
  minWinRatePct?: number | null;
  minProfitFactor?: number | null;
  maxDrawdownPct?: number | null;
  tieBreak?: readonly WalkForwardTieBreak[];
}

export interface SelectionCandidateInput {
  candidate: WalkForwardCandidate;
  /** This summary is an IS-only result. OOS/holdout is intentionally absent. */
  is: WindowEvalSummary;
}

export interface WalkForwardScoreRow {
  candidateId: string;
  strategyVersion: string;
  score: number | null;
  eligible: boolean;
  rejectionReasons: readonly string[];
  metrics: {
    trades: number;
    winRate: number;
    profitFactor: number | null;
    netPnl: number;
    pnl: number;
    sharpeRatio: number;
    sortinoRatio: number;
    maxDrawdownPct: number;
  };
}

export interface WalkForwardSelectionDecision {
  selectedCandidateId: string;
  selectedScore: number;
  scoreTable: readonly WalkForwardScoreRow[];
  metric: WalkForwardSelectionMetric;
  tieBreak: readonly WalkForwardTieBreak[];
}

export interface WalkForwardCandleProvenance {
  /** Market/event time of the candle. */
  eventTime: number;
  /** Earliest time at which this candle may be consumed by a replay. */
  availableAt: number;
  /** Time at which this normalized input was computed/materialized. */
  computedAt: number;
}

export interface WalkForwardDataManifest {
  schemaVersion: "wf-data-1";
  instrumentId: string;
  timeframe: string;
  availabilityPolicy: "explicit" | "bar_close";
  eventTimeField: "candle.time";
  availableAtField: "provenance.availableAt";
  computedAtField: "provenance.computedAt";
  candleCount: number;
  firstEventTime: number;
  lastEventTime: number;
  candlesHash: string;
  provenanceHash: string;
}

export interface WalkForwardLeakagePolicy {
  /** Number of trailing IS bars excluded because their label can cross OOS. */
  purgeBars: number;
  /** Number of leading OOS bars excluded after a purge/embargo boundary. */
  embargoBars: number;
  /** Optional label horizon used for the audit explanation. */
  labelHorizonBars: number;
}

export interface WalkForwardFreezeArtifact {
  schemaVersion: "wf-freeze-1";
  phase: "window" | "final-decision";
  windowIndex: number | null;
  selectedCandidateId: string;
  selection: WalkForwardSelectionDecision;
  candidateManifest: readonly {
    id: string;
    strategyVersion: string;
    config: CandidateConfig;
  }[];
  candidatesHash: string;
  dataManifest: WalkForwardDataManifest;
  codeHash: string;
  configHash: string;
  seed: number;
  cutoffs: {
    isFrom: number | null;
    isTo: number | null;
    oosFrom: number | null;
    oosTo: number | null;
    selectionIsTo: number | null;
    oosEvaluationFrom: number | null;
  };
  leakage: WalkForwardLeakagePolicy;
  freezeHash: string;
}

export interface WalkForwardTrainingReport {
  mode: "train-select-freeze-test";
  selector: WalkForwardSelectionConfig;
  seed: number;
  candidatesHash: string;
  codeHash: string;
  configHash: string;
  candidates: readonly WalkForwardCandidate[];
  freezes: readonly WalkForwardFreezeArtifact[];
  finalDecision: WalkForwardFreezeArtifact;
  holdout?: {
    selectedCandidateId: string;
    from: number;
    to: number;
    dataManifest: WalkForwardDataManifest;
    summary: WindowEvalSummary;
  };
}

export class WalkForwardTrainingError extends Error {
  constructor(
    public readonly code:
      | "training:invalid-candidates"
      | "training:invalid-selection"
      | "training:no-eligible-candidate"
      | "training:invalid-data",
    message: string
  ) {
    super(message);
    this.name = "WalkForwardTrainingError";
  }
}

function assertPlainSerializable(value: unknown, path: string, depth = 0): void {
  if (depth > 12) throw new WalkForwardTrainingError("training:invalid-candidates", `${path} ist zu tief verschachtelt.`);
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    if (value.length > 2_048) throw new WalkForwardTrainingError("training:invalid-candidates", `${path} ist zu lang.`);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Math.abs(value) > 1_000_000_000) {
      throw new WalkForwardTrainingError("training:invalid-candidates", `${path} enthält eine ungültige oder unbounded Zahl.`);
    }
    return;
  }
  if (typeof value !== "object") {
    throw new WalkForwardTrainingError("training:invalid-candidates", `${path} ist nicht JSON-serialisierbar.`);
  }
  if (Array.isArray(value)) {
    if (value.length > 256) throw new WalkForwardTrainingError("training:invalid-candidates", `${path} ist zu groß.`);
    value.forEach((item, index) => assertPlainSerializable(item, `${path}[${index}]`, depth + 1));
    return;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length > 128) throw new WalkForwardTrainingError("training:invalid-candidates", `${path} enthält zu viele Felder.`);
  for (const key of keys) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      throw new WalkForwardTrainingError("training:invalid-candidates", `${path} enthält einen unzulässigen Schlüssel.`);
    }
    assertPlainSerializable(record[key], `${path}.${key}`, depth + 1);
  }
}

function checkId(value: unknown, field: string): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new WalkForwardTrainingError("training:invalid-candidates", `${field} muss ein bounded ID-String sein.`);
  }
  return value;
}

function cloneStrategy(strategy: BacktestStrategyItem): BacktestStrategyItem {
  try {
    return structuredClone(strategy);
  } catch {
    throw new WalkForwardTrainingError("training:invalid-candidates", "Strategie ist nicht serialisierbar.");
  }
}

/** Validates and canonicalizes a bounded candidate list. */
export function validateWalkForwardCandidates(
  candidates: readonly WalkForwardCandidate[]
): readonly WalkForwardCandidate[] {
  if (!Array.isArray(candidates) || candidates.length < 1 || candidates.length > WALK_FORWARD_MAX_CANDIDATES) {
    throw new WalkForwardTrainingError(
      "training:invalid-candidates",
      `Kandidatenraum muss 1..${WALK_FORWARD_MAX_CANDIDATES} Einträge enthalten.`
    );
  }
  const seen = new Set<string>();
  const seenDefinitions = new Set<string>();
  const normalized: WalkForwardCandidate[] = [];
  for (const [index, candidate] of candidates.entries()) {
    if (!candidate || typeof candidate !== "object") {
      throw new WalkForwardTrainingError("training:invalid-candidates", `candidates[${index}] muss ein Objekt sein.`);
    }
    const id = checkId(candidate.id, `candidates[${index}].id`);
    const strategyVersion = checkId(candidate?.strategyVersion, `candidates[${index}].strategyVersion`);
    if (seen.has(id)) throw new WalkForwardTrainingError("training:invalid-candidates", `Doppelte Kandidaten-ID ${id}.`);
    seen.add(id);
    if (!candidate.config || typeof candidate.config !== "object" || Array.isArray(candidate.config)) {
      throw new WalkForwardTrainingError("training:invalid-candidates", `${id}: config muss ein Objekt sein.`);
    }
    const configKeys = Object.keys(candidate.config).sort();
    if (configKeys.length > WALK_FORWARD_MAX_CONFIG_KEYS) {
      throw new WalkForwardTrainingError("training:invalid-candidates", `${id}: config überschreitet ${WALK_FORWARD_MAX_CONFIG_KEYS} Schlüssel.`);
    }
    const config: Record<string, CandidateConfigValue> = {};
    for (const key of configKeys) {
      if (!CONFIG_KEY_PATTERN.test(key) || SENSITIVE_KEY_PATTERN.test(key)) {
        throw new WalkForwardTrainingError("training:invalid-candidates", `${id}: unzulässiger config-Schlüssel.`);
      }
      const value = candidate.config[key];
      if (!(value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number")) {
        throw new WalkForwardTrainingError("training:invalid-candidates", `${id}: config.${key} ist nicht skalar.`);
      }
      assertPlainSerializable(value, `${id}.config.${key}`);
      if (typeof value === "string" && value.length > 256) {
        throw new WalkForwardTrainingError("training:invalid-candidates", `${id}: config.${key} ist zu lang.`);
      }
      config[key] = value;
    }
    if (!Array.isArray(candidate.strategies) || candidate.strategies.length < 1 || candidate.strategies.length > WALK_FORWARD_MAX_STRATEGIES_PER_CANDIDATE) {
      throw new WalkForwardTrainingError("training:invalid-candidates", `${id}: strategies muss 1..${WALK_FORWARD_MAX_STRATEGIES_PER_CANDIDATE} Einträge enthalten.`);
    }
    for (const strategy of candidate.strategies) {
      assertPlainSerializable(strategy, `${id}.strategy`);
      cloneStrategy(strategy);
    }
    const definitionKey = stableStringify({ strategyVersion, config, strategies: candidate.strategies });
    if (seenDefinitions.has(definitionKey)) {
      throw new WalkForwardTrainingError("training:invalid-candidates", `${id}: doppelte Kandidatendefinition.`);
    }
    seenDefinitions.add(definitionKey);
    normalized.push({ id, strategyVersion, config, strategies: candidate.strategies.map(cloneStrategy) });
  }
  return normalized.sort((a, b) => a.id.localeCompare(b.id));
}

export function hashWalkForwardCandidates(candidates: readonly WalkForwardCandidate[]): string {
  const normalized = validateWalkForwardCandidates(candidates);
  return createHash("sha256").update(stableStringify(normalized)).digest("hex");
}

function metricValue(summary: WindowEvalSummary, metric: WalkForwardSelectionMetric): number | null {
  const raw = summary[metric];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

function normalizeSelection(config?: Partial<WalkForwardSelectionConfig>): WalkForwardSelectionConfig {
  const merged: WalkForwardSelectionConfig = {
    metric: config?.metric ?? DEFAULT_WALK_FORWARD_SELECTION.metric,
    minTrades: config?.minTrades ?? DEFAULT_WALK_FORWARD_SELECTION.minTrades,
    minWinRatePct: config?.minWinRatePct ?? DEFAULT_WALK_FORWARD_SELECTION.minWinRatePct,
    minProfitFactor: config?.minProfitFactor ?? DEFAULT_WALK_FORWARD_SELECTION.minProfitFactor,
    maxDrawdownPct: config?.maxDrawdownPct ?? DEFAULT_WALK_FORWARD_SELECTION.maxDrawdownPct,
    tieBreak: config?.tieBreak ?? DEFAULT_WALK_FORWARD_SELECTION.tieBreak,
  };
  const metrics: readonly WalkForwardSelectionMetric[] = ["netPnl", "pnl", "sharpeRatio", "sortinoRatio", "profitFactor", "winRate"];
  if (!metrics.includes(merged.metric)) throw new WalkForwardTrainingError("training:invalid-selection", "Unbekannte Selector-Metrik.");
  if (!Number.isInteger(merged.minTrades) || merged.minTrades < 0 || merged.minTrades > 100_000) {
    throw new WalkForwardTrainingError("training:invalid-selection", "minTrades muss zwischen 0 und 100000 liegen.");
  }
  for (const [name, value, min, max] of [
    ["minWinRatePct", merged.minWinRatePct, 0, 100],
    ["minProfitFactor", merged.minProfitFactor, 0, 1_000_000],
    ["maxDrawdownPct", merged.maxDrawdownPct, 0, 100],
  ] as const) {
    if (value !== null && value !== undefined && (!Number.isFinite(value) || value < min || value > max)) {
      throw new WalkForwardTrainingError("training:invalid-selection", `${name} liegt außerhalb seiner Bounds.`);
    }
  }
  const allowed: readonly WalkForwardTieBreak[] = ["score", "netPnl", "pnl", "profitFactor", "sharpeRatio", "sortinoRatio", "maxDrawdownPct", "trades", "winRate", "candidateId"];
  const tieBreak = merged.tieBreak ?? DEFAULT_WALK_FORWARD_SELECTION.tieBreak;
  if (!Array.isArray(tieBreak) || tieBreak.length > allowed.length || tieBreak.some((value) => !allowed.includes(value))) {
    throw new WalkForwardTrainingError("training:invalid-selection", "Ungültige Tie-Break-Reihenfolge.");
  }
  const unique: WalkForwardTieBreak[] = [...new Set(tieBreak)];
  if (!unique.includes("candidateId")) unique.push("candidateId");
  return {
    metric: merged.metric,
    minTrades: merged.minTrades,
    minWinRatePct: merged.minWinRatePct,
    minProfitFactor: merged.minProfitFactor,
    maxDrawdownPct: merged.maxDrawdownPct,
    tieBreak: unique,
  };
}

function rowMetric(row: WalkForwardScoreRow, key: WalkForwardTieBreak): number | string | null {
  if (key === "score") return row.score;
  if (key === "candidateId") return row.candidateId;
  if (key === "trades") return row.metrics.trades;
  return row.metrics[key];
}

function compareRows(a: WalkForwardScoreRow, b: WalkForwardScoreRow, tieBreak: readonly WalkForwardTieBreak[]): number {
  for (const key of tieBreak) {
    const av = rowMetric(a, key);
    const bv = rowMetric(b, key);
    if (key === "candidateId") return String(av).localeCompare(String(bv));
    const an = typeof av === "number" && Number.isFinite(av) ? av : Number.NEGATIVE_INFINITY;
    const bn = typeof bv === "number" && Number.isFinite(bv) ? bv : Number.NEGATIVE_INFINITY;
    if (key === "maxDrawdownPct") {
      if (an !== bn) return an - bn;
    } else if (an !== bn) {
      return bn - an;
    }
  }
  return a.candidateId.localeCompare(b.candidateId);
}

/**
 * Selects from IS score rows only. The returned table is ID-sorted and the
 * comparator always ends in candidateId, so input order cannot affect it.
 */
export function selectWalkForwardCandidate(
  evaluations: readonly SelectionCandidateInput[],
  config?: Partial<WalkForwardSelectionConfig>
): WalkForwardSelectionDecision {
  const selection = normalizeSelection(config);
  if (evaluations.length < 1 || evaluations.length > WALK_FORWARD_MAX_SCORE_ROWS) {
    throw new WalkForwardTrainingError("training:no-eligible-candidate", "Keine bounded IS-Kandidatenbewertung vorhanden.");
  }
  const seen = new Set<string>();
  const rows: WalkForwardScoreRow[] = evaluations.map(({ candidate, is }) => {
    if (seen.has(candidate.id)) throw new WalkForwardTrainingError("training:invalid-candidates", `Doppelte IS-Bewertung ${candidate.id}.`);
    seen.add(candidate.id);
    const reasons: string[] = [];
    const score = metricValue(is, selection.metric);
    if (score === null) reasons.push("TARGET_UNAVAILABLE");
    if (is.trades < selection.minTrades) reasons.push("MIN_TRADES");
    if (selection.minWinRatePct !== null && selection.minWinRatePct !== undefined && (!Number.isFinite(is.winRate) || is.winRate < selection.minWinRatePct)) reasons.push("MIN_WIN_RATE");
    if (selection.minProfitFactor !== null && selection.minProfitFactor !== undefined && (is.profitFactor === null || is.profitFactor < selection.minProfitFactor)) reasons.push("MIN_PROFIT_FACTOR");
    if (selection.maxDrawdownPct !== null && selection.maxDrawdownPct !== undefined && (!Number.isFinite(is.maxDrawdownPct) || is.maxDrawdownPct > selection.maxDrawdownPct)) reasons.push("MAX_DRAWDOWN");
    return {
      candidateId: candidate.id,
      strategyVersion: candidate.strategyVersion,
      score,
      eligible: reasons.length === 0,
      rejectionReasons: reasons,
      metrics: {
        trades: is.trades,
        winRate: is.winRate,
        profitFactor: is.profitFactor,
        netPnl: is.netPnl,
        pnl: is.pnl,
        sharpeRatio: is.sharpeRatio,
        sortinoRatio: is.sortinoRatio,
        maxDrawdownPct: is.maxDrawdownPct,
      },
    };
  }).sort((a, b) => a.candidateId.localeCompare(b.candidateId));
  const eligible = rows.filter((row) => row.eligible && row.score !== null);
  if (eligible.length === 0) throw new WalkForwardTrainingError("training:no-eligible-candidate", "Kein Kandidat erfüllt die harten IS-Gates.");
  const tieBreak = selection.tieBreak ?? DEFAULT_WALK_FORWARD_SELECTION.tieBreak;
  const winner = [...eligible].sort((a, b) => compareRows(a, b, tieBreak))[0];
  if (!winner || winner.score === null) throw new WalkForwardTrainingError("training:no-eligible-candidate", "Selector lieferte keinen gültigen Kandidaten.");
  return { selectedCandidateId: winner.candidateId, selectedScore: winner.score, scoreTable: rows, metric: selection.metric, tieBreak };
}

export function buildWalkForwardDataManifest(
  instrumentId: string,
  timeframe: string,
  candles: readonly CandleLike[],
  provenance: readonly WalkForwardCandleProvenance[] | undefined
): WalkForwardDataManifest {
  if (candles.length < 2) throw new WalkForwardTrainingError("training:invalid-data", "Data-Manifest benötigt mindestens zwei Kerzen.");
  const rows = candles.map((candle, index) => {
    if (![candle.time, candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite)) {
      throw new WalkForwardTrainingError("training:invalid-data", `Kerze ${index} enthält keinen vollständigen endlichen OHLCV-Satz.`);
    }
    const p = provenance?.[index] ?? { eventTime: candle.time, availableAt: candle.time, computedAt: candle.time };
    if (![p.eventTime, p.availableAt, p.computedAt].every(Number.isFinite) || p.eventTime !== candle.time || p.availableAt < p.eventTime || p.computedAt < p.availableAt) {
      throw new WalkForwardTrainingError("training:invalid-data", `Zeit-Provenienz der Kerze ${index} ist ungültig (event/available/computed).`);
    }
    // The current candle engine has event-time bars, not a delayed feature
    // queue. Refuse a later availability time rather than silently letting a
    // bar influence its own event or an earlier feature snapshot.
    if (p.availableAt > p.eventTime) {
      throw new WalkForwardTrainingError("training:invalid-data", `Kerze ${index} ist am event_time noch nicht verfügbar; delayed as-of inputs must be materialized before training.`);
    }
    return { candle, provenance: p };
  });
  if (provenance && provenance.length !== candles.length) {
    throw new WalkForwardTrainingError("training:invalid-data", "Candle-Provenienz muss exakt gleich lang wie die Kerzenreihe sein.");
  }
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].candle.time <= rows[i - 1].candle.time) throw new WalkForwardTrainingError("training:invalid-data", "Kerzen müssen strikt nach event_time aufsteigend sortiert und dedupliziert sein.");
  }
  const candlePayload = rows.map(({ candle }) => candle);
  const provenancePayload = rows.map(({ provenance: p }) => p);
  return {
    schemaVersion: "wf-data-1",
    instrumentId,
    timeframe,
    availabilityPolicy: provenance ? "explicit" : "bar_close",
    eventTimeField: "candle.time",
    availableAtField: "provenance.availableAt",
    computedAtField: "provenance.computedAt",
    candleCount: rows.length,
    firstEventTime: rows[0].candle.time,
    lastEventTime: rows[rows.length - 1].candle.time,
    candlesHash: createHash("sha256").update(stableStringify(candlePayload)).digest("hex"),
    provenanceHash: createHash("sha256").update(stableStringify(provenancePayload)).digest("hex"),
  };
}

export function hashWalkForwardConfig(
  config: BacktestEngineOptions,
  selection: WalkForwardSelectionConfig,
  leakage: WalkForwardLeakagePolicy
): string {
  let serialized: string;
  try {
    serialized = stableStringify(JSON.parse(JSON.stringify({ config, selection, leakage })) as unknown);
  } catch {
    throw new WalkForwardTrainingError("training:invalid-candidates", "Engine-/Selector-Konfiguration ist nicht serialisierbar.");
  }
  return createHash("sha256").update(serialized).digest("hex");
}

function candidateManifest(candidates: readonly WalkForwardCandidate[]): WalkForwardFreezeArtifact["candidateManifest"] {
  return candidates.map(({ id, strategyVersion, config }) => ({ id, strategyVersion, config }));
}

function hashPayload(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Creates the immutable, persisted selection record for one window/final decision. */
export function createWalkForwardFreezeArtifact(input: {
  phase: "window" | "final-decision";
  window: WalkForwardWindow | null;
  selection: WalkForwardSelectionDecision;
  candidates: readonly WalkForwardCandidate[];
  dataManifest: WalkForwardDataManifest;
  configHash: string;
  seed: number;
  leakage: WalkForwardLeakagePolicy;
  selectionIsTo?: number | null;
  oosEvaluationFrom?: number | null;
}): WalkForwardFreezeArtifact {
  const candidatesHash = hashWalkForwardCandidates(input.candidates);
  const codeHash = hashPayload({ trainingVersion: WALK_FORWARD_TRAINING_VERSION, appVersion: APP_VERSION });
  const cutoffs = {
    isFrom: input.window?.isFrom ?? null,
    isTo: input.window?.isTo ?? null,
    oosFrom: input.window?.oosFrom ?? null,
    oosTo: input.window?.oosTo ?? null,
    selectionIsTo: input.selectionIsTo ?? input.window?.isTo ?? null,
    oosEvaluationFrom: input.oosEvaluationFrom ?? input.window?.oosFrom ?? null,
  };
  const unsigned = {
    schemaVersion: "wf-freeze-1" as const,
    phase: input.phase,
    windowIndex: input.window?.index ?? null,
    selectedCandidateId: input.selection.selectedCandidateId,
    selection: input.selection,
    candidateManifest: candidateManifest(input.candidates),
    candidatesHash,
    dataManifest: input.dataManifest,
    codeHash,
    configHash: input.configHash,
    seed: input.seed,
    cutoffs,
    leakage: input.leakage,
  };
  const freezeHash = hashPayload(unsigned);
  return deepFreeze({ ...unsigned, freezeHash });
}

export function aggregateSelectionSummary(summaries: readonly WindowEvalSummary[]): WindowEvalSummary {
  if (summaries.length === 0) throw new WalkForwardTrainingError("training:no-eligible-candidate", "Keine IS-Summaries für die Gesamtentscheidung.");
  const finiteAverage = (values: readonly number[]): number => {
    const valid = values.filter(Number.isFinite);
    return valid.length === 0 ? Number.NaN : valid.reduce((sum, value) => sum + value, 0) / valid.length;
  };
  const trades = summaries.reduce((sum, value) => sum + value.trades, 0);
  const wins = summaries.reduce((sum, value) => sum + value.wins, 0);
  return {
    from: Math.min(...summaries.map((s) => s.from)),
    to: Math.max(...summaries.map((s) => s.to)),
    bars: summaries.reduce((sum, value) => sum + value.bars, 0),
    trades,
    wins,
    winRate: trades > 0 ? Number(((wins / trades) * 100).toFixed(2)) : 0,
    pnl: Number(summaries.reduce((sum, value) => sum + value.pnl, 0).toFixed(2)),
    profitFactor: finiteAverage(summaries.filter((s) => s.profitFactor !== null).map((s) => s.profitFactor as number)),
    maxDrawdownPct: Math.max(...summaries.map((s) => s.maxDrawdownPct)),
    sharpeRatio: finiteAverage(summaries.map((s) => s.sharpeRatio)),
    sortinoRatio: finiteAverage(summaries.map((s) => s.sortinoRatio)),
    fees: Number(summaries.reduce((sum, value) => sum + value.fees, 0).toFixed(2)),
    funding: Number(summaries.reduce((sum, value) => sum + value.funding, 0).toFixed(8)),
    netPnl: Number(summaries.reduce((sum, value) => sum + value.netPnl, 0).toFixed(4)),
    slippage: Number(summaries.reduce((sum, value) => sum + value.slippage, 0).toFixed(2)),
    tradeHash: hashPayload(summaries.map((s) => s.tradeHash)),
  };
}

export function trainingDefaults(
  config: Partial<WalkForwardSelectionConfig> | undefined,
  engineConfig: BacktestEngineOptions,
  leakage: WalkForwardLeakagePolicy
): { selection: WalkForwardSelectionConfig; configHash: string } {
  const selection = normalizeSelection(config);
  return { selection, configHash: hashWalkForwardConfig(engineConfig, selection, leakage) };
}

/** Exposed for tests/API validation without allowing OOS data into the selector. */
export function normalizeWalkForwardSelection(config?: Partial<WalkForwardSelectionConfig>): WalkForwardSelectionConfig {
  return normalizeSelection(config);
}

/** Avoid unused import drift when this module is consumed independently. */
export type { BacktestEngineOptions };
