/**
 * Walk-Forward-Validierung für die regelbasierte Backtesting-Engine
 * (GAP-01, v1.51.0; Train-Select-Freeze-Test RMA-P1-02, v1.60.0).
 *
 * Rollierende In-Sample-/Out-of-Sample-Fenster über den Backtest-Zeitraum:
 *   - OOS-Segmente kacheln den Zeitraum lückenlos und überlappungsfrei
 *     (Schrittweite = OOS-Länge, jüngstes Fenster endet an `to`).
 *   - Jedes OOS-Segment wird von einem direkt davor liegenden IS-Fenster
 *     fester Länge begleitet (IS-Fenster dürfen überlappen — Standard).
 *   - Train-Select-Freeze-Test: Jedes Fenster selektiert ausschließlich anhand
 *     von IS-Daten eine Kandidatenkonfiguration, friert diese mit vollständiger
 *     Provenance ein und evaluiert genau diese Konfiguration auf OOS.
 *   - Unabhängiger Holdout: Nach allen Fenstern kann ein unangetasteter
 *     Holdout-Zeitraum auf dem selektierten Modell ausgewertet werden.
 *
 * Determinismus: rein + injizierbare Zeit (`nowMs`, Muster
 * `src/cycle/clock.ts`) — gleiche (Kerzen, Kandidaten, Fenster, Kosten) ⇒
 * byte-identisches `metricsJson` + `freezeHash`.
 */

import { scopeReplay } from "../executionQuality/backtest";
import { digest, type Batch } from "../executionQuality/model";
import { createHash } from "node:crypto";
import { envNumber } from "../lib/env";
import { APP_VERSION } from "../lib/version";
import {
  maxDrawdown,
  profitFactor,
  sharpeRatio,
  sortinoRatio,
} from "../portfolio/metrics";
import { stableStringify } from "../lib/ruleEngine";
import { runMultiAssetBacktest } from "./engine";
import type {
  BacktestEngineOptions,
  BacktestMetrics,
  BacktestStrategyItem,
  BacktestTradeLog,
  MultiAssetBacktestResult,
} from "./types";
import {
  emptyReplayCoverage,
  type EventReplayCoverage,
  type EventReplayDataManifest,
  type ReplayDegradedReason,
  type ResolvedEventReplayConfig,
  type TradeReplayDetail,
} from "./replayEvents";
import type { CandleLike } from "../lib/ruleEngine";
import type { SupportedTimeframe } from "../lib/marketdata/historicalStore";

/** Env-Namen der Walk-Forward-Fenster (zentral, für Doku/Tests). */
export const WF_ENV = {
  IS_WINDOW_DAYS: "WF_IS_WINDOW_DAYS",
  OOS_WINDOW_DAYS: "WF_OOS_WINDOW_DAYS",
  MAX_SPAN_DAYS: "WF_MAX_SPAN_DAYS",
} as const;

/** Bounds der Walk-Forward-Fenster (Clamp + Warnung, siehe envNumber). */
export const WF_BOUNDS = {
  /** IS-Fenster in Tagen: 2 Wochen … 2 Jahre. */
  isDays: { min: 14, max: 720 },
  /** OOS-Fenster in Tagen: 1 Woche … 6 Monate. */
  oosDays: { min: 7, max: 180 },
  /**
   * Maximaler Backtest-Zeitraum in Tagen (Anti-Overfitting-Deckel:
   * begrenzt implizit die Fensteranzahl). Default 2 Jahre.
   */
  maxSpanDays: { min: 30, max: 3650 },
  /** Obergrenze für Kandidaten-Suchräume (Vermeidung von Kombinationsexplosionen). */
  maxCandidates: { min: 1, max: 100 },
} as const;

/** Sichere Defaults: 90/30 Tage, maximal 2 Jahre Zeitraum. */
export const WF_DEFAULTS = {
  isDays: 90,
  oosDays: 30,
  maxSpanDays: 730,
} as const;

export interface WalkForwardConfig {
  isDays: number;
  oosDays: number;
  maxSpanDays: number;
}

/** Ein Kandidat für Train-Select-Freeze (RMA-P1-02). */
export interface WalkForwardCandidate {
  /** Stabile, eindeutige ID (1..64 Zeichen, z. B. "cand-1", "rsi_30_70"). */
  id: string;
  /** Name des Kandidaten. */
  name?: string;
  /** Strategie-/Regel-Version. */
  strategyVersion?: string;
  /** Serialisierbare Parameter-Konfiguration. */
  config: Record<string, unknown>;
  /** Strategie-Elemente (Regeln oder Setups). */
  strategies: BacktestStrategyItem[];
}

/** Unterstützte Zielmetriken für die IS-Selektion. */
export type SelectorTargetMetric =
  | "sharpeRatio"
  | "sortinoRatio"
  | "netPnl"
  | "totalReturn"
  | "winRate"
  | "profitFactor"
  | "calmarRatio"
  | "expectancy";

/** Harte Mindestgates für die Kandidatenselektion auf IS. */
export interface SelectorGates {
  minTrades?: number;
  minWinRate?: number;
  minSharpeRatio?: number;
  minProfitFactor?: number;
  maxDrawdownPct?: number;
}

/** Konfiguration der Kandidatenselektion auf IS. */
export interface WalkForwardSelectorConfig {
  targetMetric?: SelectorTargetMetric;
  gates?: SelectorGates;
  failClosed?: boolean;
}

/** Zeile der vollständigen Score-Tabelle pro Fenster. */
export interface CandidateScoreRow {
  candidateId: string;
  candidateName?: string;
  config: Record<string, unknown>;
  score: number;
  passedGates: boolean;
  rejectionReason?: string | null;
  metrics: {
    trades: number;
    winRate: number;
    netPnl: number;
    pnl: number;
    sharpeRatio: number;
    sortinoRatio: number;
    profitFactor: number | null;
    maxDrawdownPct: number;
  };
}

/** Unveränderliches Freeze-Artefakt pro Fenster. */
export interface FreezeArtifact {
  windowIndex: number;
  isFrom: number;
  isTo: number;
  oosFrom: number;
  oosTo: number;
  selectedCandidateId: string;
  selectedCandidate: WalkForwardCandidate;
  scoreTable: CandidateScoreRow[];
  dataManifest: {
    candlesHash: string;
    candleCount: number;
    from: number;
    to: number;
  };
  candidateHash: string;
  configHash: string;
  codeVersion: string;
  seed: number;
  cutoffs: {
    isFrom: number;
    isTo: number;
    oosFrom: number;
    oosTo: number;
    embargoMs?: number;
    purgeMs?: number;
  };
  /** sha256 über alle Bestandteile des Freeze-Artefakts. */
  freezeHash: string;
}

/** Finaler Holdout-Konfiguration. */
export interface HoldoutConfig {
  holdoutDays: number;
  embargoHours?: number;
}

/** Report einer Holdout-Auswertung. */
export interface HoldoutReport {
  from: number;
  to: number;
  candidateId: string;
  candidate: WalkForwardCandidate;
  summary: WindowEvalSummary;
  trades: BacktestTradeLog[];
  replay?: MultiAssetBacktestResult["replay"];
}

/** Kerze mit optionaler Verfügbarkeits- und Horizont-Information für Leakage-Tests. */
export interface CandleWithHorizon extends CandleLike {
  availableAt?: number;
  labelHorizonEnd?: number;
}

/** Lädt die Walk-Forward-Konfiguration aus Env (Bounds-Clamp mit Warnung). */
export function loadWalkForwardConfig(
  env: Record<string, string | undefined> = process.env
): WalkForwardConfig {
  return {
    isDays: envNumber(
      WF_ENV.IS_WINDOW_DAYS, WF_DEFAULTS.isDays,
      WF_BOUNDS.isDays.min, WF_BOUNDS.isDays.max, env
    ),
    oosDays: envNumber(
      WF_ENV.OOS_WINDOW_DAYS, WF_DEFAULTS.oosDays,
      WF_BOUNDS.oosDays.min, WF_BOUNDS.oosDays.max, env
    ),
    maxSpanDays: envNumber(
      WF_ENV.MAX_SPAN_DAYS, WF_DEFAULTS.maxSpanDays,
      WF_BOUNDS.maxSpanDays.min, WF_BOUNDS.maxSpanDays.max, env
    ),
  };
}

/** Validiert und normalisiert Kandidaten (RMA-P1-02). */
export function validateCandidates(candidates: unknown): WalkForwardCandidate[] {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new WalkForwardError(
      "walkforward:invalid-candidates",
      "walkforward:invalid-candidates — candidates muss ein nicht-leeres Array sein."
    );
  }
  if (candidates.length > WF_BOUNDS.maxCandidates.max) {
    throw new WalkForwardError(
      "walkforward:unbounded-candidate-space",
      `walkforward:unbounded-candidate-space — Kandidatenanzahl ${candidates.length} überschreitet das Limit von ${WF_BOUNDS.maxCandidates.max}.`
    );
  }

  const seenIds = new Set<string>();
  const validated: WalkForwardCandidate[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const raw = candidates[i] as Partial<WalkForwardCandidate>;
    if (!raw || typeof raw !== "object") {
      throw new WalkForwardError(
        "walkforward:invalid-candidates",
        `walkforward:invalid-candidates — Kandidat [${i}] ist kein gültiges Objekt.`
      );
    }

    if (typeof raw.id !== "string" || raw.id.trim() === "" || !/^[A-Za-z0-9_.:-]+$/.test(raw.id.trim())) {
      throw new WalkForwardError(
        "walkforward:invalid-candidates",
        `walkforward:invalid-candidates — Kandidat [${i}] hat eine ungültige ID "${String(raw.id)}".`
      );
    }
    const id = raw.id.trim();
    if (seenIds.has(id)) {
      throw new WalkForwardError(
        "walkforward:duplicate-candidate-id",
        `walkforward:duplicate-candidate-id — Doppelte Kandidaten-ID "${id}".`
      );
    }
    seenIds.add(id);

    if (!Array.isArray(raw.strategies) || raw.strategies.length === 0) {
      throw new WalkForwardError(
        "walkforward:invalid-candidates",
        `walkforward:invalid-candidates — Kandidat "${id}" hat keine Strategien.`
      );
    }

    const config = raw.config && typeof raw.config === "object" ? raw.config : {};
    for (const [k, v] of Object.entries(config)) {
      if (typeof v === "number" && !Number.isFinite(v)) {
        throw new WalkForwardError(
          "walkforward:invalid-candidate-config",
          `walkforward:invalid-candidate-config — Kandidat "${id}" enthält nicht-endliche Zahl in Config [${k}]: ${v}.`
        );
      }
    }

    validated.push({
      id,
      name: raw.name ? String(raw.name) : id,
      strategyVersion: raw.strategyVersion ? String(raw.strategyVersion) : undefined,
      config: JSON.parse(stableStringify(config)),
      strategies: raw.strategies,
    });
  }

  return validated;
}

/** Extrahiert die Zielmetrik aus Metriken und Evaluation-Summary. */
export function extractTargetMetric(
  metrics: BacktestMetrics,
  summary: WindowEvalSummary,
  targetMetric: SelectorTargetMetric = "sharpeRatio"
): number {
  switch (targetMetric) {
    case "sharpeRatio":
      return summary.sharpeRatio;
    case "sortinoRatio":
      return summary.sortinoRatio;
    case "netPnl":
      return summary.netPnl;
    case "totalReturn":
      return summary.pnl;
    case "winRate":
      return summary.winRate;
    case "profitFactor":
      return summary.profitFactor ?? 0;
    case "calmarRatio":
      return metrics.calmarRatio ?? 0;
    case "expectancy":
      return metrics.expectancy ?? 0;
    default:
      return summary.sharpeRatio;
  }
}

/** Prüft harte Mindestgates auf IS. */
export function evaluateGates(
  summary: WindowEvalSummary,
  gates?: SelectorGates
): { passed: boolean; reason?: string } {
  if (!gates) return { passed: true };

  if (gates.minTrades !== undefined && summary.trades < gates.minTrades) {
    return { passed: false, reason: `minTrades: ${summary.trades} < ${gates.minTrades}` };
  }
  if (gates.minWinRate !== undefined && summary.winRate < gates.minWinRate) {
    return { passed: false, reason: `minWinRate: ${summary.winRate}% < ${gates.minWinRate}%` };
  }
  if (gates.minSharpeRatio !== undefined && summary.sharpeRatio < gates.minSharpeRatio) {
    return { passed: false, reason: `minSharpeRatio: ${summary.sharpeRatio} < ${gates.minSharpeRatio}` };
  }
  if (gates.minProfitFactor !== undefined) {
    if (summary.profitFactor === null || summary.profitFactor < gates.minProfitFactor) {
      return { passed: false, reason: `minProfitFactor: ${summary.profitFactor ?? "null"} < ${gates.minProfitFactor}` };
    }
  }
  if (gates.maxDrawdownPct !== undefined && summary.maxDrawdownPct > gates.maxDrawdownPct) {
    return { passed: false, reason: `maxDrawdownPct: ${summary.maxDrawdownPct}% > ${gates.maxDrawdownPct}%` };
  }

  return { passed: true };
}

/** Filtert Kerzen as-of-sicher und purged horizonüberlappende Daten (RMA-P1-02). */
export function filterCandlesWithLeakageProtection(
  candles: CandleLike[],
  from: number,
  to: number,
  opts?: { purgeMs?: number; strict?: boolean }
): CandleLike[] {
  const purgeMs = opts?.purgeMs ?? 0;
  const effectiveTo = to - purgeMs;
  const result: CandleLike[] = [];

  for (const c of candles) {
    if (c.time < from || c.time >= effectiveTo) continue;

    const candle = c as CandleWithHorizon;
    if (candle.availableAt !== undefined && candle.availableAt > to) {
      if (opts?.strict) {
        throw new WalkForwardError(
          "walkforward:leakage-detected",
          `walkforward:leakage-detected — Kerze t=${c.time} hat availableAt=${candle.availableAt} > Cutoff ${to}.`
        );
      }
      continue;
    }

    if (candle.labelHorizonEnd !== undefined && candle.labelHorizonEnd > to) {
      if (opts?.strict) {
        throw new WalkForwardError(
          "walkforward:leakage-detected",
          `walkforward:leakage-detected — Kerze t=${c.time} hat labelHorizonEnd=${candle.labelHorizonEnd} > Cutoff ${to}.`
        );
      }
      continue;
    }

    result.push(c);
  }

  return result;
}

/** Erstellt das unveränderliche Freeze-Artefakt pro Fenster. */
export function createFreezeArtifact(params: {
  windowIndex: number;
  isFrom: number;
  isTo: number;
  oosFrom: number;
  oosTo: number;
  selectedCandidate: WalkForwardCandidate;
  scoreTable: CandidateScoreRow[];
  candles: CandleLike[];
  selectorConfig?: WalkForwardSelectorConfig;
  engineConfig?: BacktestEngineOptions;
  seed?: number;
  embargoMs?: number;
  purgeMs?: number;
}): FreezeArtifact {
  const {
    windowIndex,
    isFrom,
    isTo,
    oosFrom,
    oosTo,
    selectedCandidate,
    scoreTable,
    candles,
    selectorConfig,
    engineConfig,
    seed = 1,
    embargoMs,
    purgeMs,
  } = params;

  const isCandles = candles.filter((c) => c.time >= isFrom && c.time < isTo);
  const candlesHash = createHash("sha256").update(stableStringify(isCandles)).digest("hex");
  const dataManifest = {
    candlesHash,
    candleCount: isCandles.length,
    from: isFrom,
    to: isTo,
  };

  const candidateHash = createHash("sha256")
    .update(stableStringify(scoreTable.map((s) => ({ id: s.candidateId, config: s.config }))))
    .digest("hex");

  const configHash = createHash("sha256")
    .update(stableStringify({ selectorConfig: selectorConfig ?? null, engineConfig: engineConfig ?? null }))
    .digest("hex");

  const cutoffs = {
    isFrom,
    isTo,
    oosFrom,
    oosTo,
    ...(embargoMs ? { embargoMs } : {}),
    ...(purgeMs ? { purgeMs } : {}),
  };

  const preHashObj = {
    windowIndex,
    selectedCandidateId: selectedCandidate.id,
    selectedCandidateConfig: selectedCandidate.config,
    scoreTable,
    dataManifest,
    candidateHash,
    configHash,
    codeVersion: APP_VERSION,
    seed,
    cutoffs,
  };

  const freezeHash = createHash("sha256").update(stableStringify(preHashObj)).digest("hex");

  return {
    windowIndex,
    isFrom,
    isTo,
    oosFrom,
    oosTo,
    selectedCandidateId: selectedCandidate.id,
    selectedCandidate,
    scoreTable,
    dataManifest,
    candidateHash,
    configHash,
    codeVersion: APP_VERSION,
    seed,
    cutoffs,
    freezeHash,
  };
}

/** Ein IS/OOS-Fensterpaar (Halboffen: [from, to), OOS kachelt lückenlos). */
export interface WalkForwardWindow {
  index: number;
  isFrom: number;
  isTo: number;
  oosFrom: number;
  oosTo: number;
}

export interface WalkForwardLayout {
  windows: WalkForwardWindow[];
  effectiveFrom: number;
  effectiveTo: number;
  truncated: boolean;
}

/**
 * Berechnet das rollierende Fensterlayout — rein, ohne Kerzen/IO.
 */
export function computeWalkForwardWindows(
  from: number,
  to: number,
  config: WalkForwardConfig
): WalkForwardLayout {
  const DAY = 86_400_000;
  const isMs = Math.round(config.isDays * DAY);
  const oosMs = Math.round(config.oosDays * DAY);
  const maxSpanMs = Math.round(config.maxSpanDays * DAY);

  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || isMs <= 0 || oosMs <= 0) {
    return { windows: [], effectiveFrom: from, effectiveTo: to, truncated: false };
  }

  let effectiveFrom = from;
  let truncated = false;
  if (maxSpanMs > 0 && to - from > maxSpanMs) {
    effectiveFrom = to - maxSpanMs;
    truncated = true;
  }

  const windows: WalkForwardWindow[] = [];
  let cursor = effectiveFrom;
  let index = 0;
  while (cursor + isMs + oosMs <= to) {
    windows.push({
      index,
      isFrom: cursor,
      isTo: cursor + isMs,
      oosFrom: cursor + isMs,
      oosTo: cursor + isMs + oosMs,
    });
    cursor += oosMs;
    index++;
  }
  return { windows, effectiveFrom, effectiveTo: to, truncated };
}

/** Maschinenlesbarer Fehler des Walk-Forward-Laufs (Muster R6). */
export class WalkForwardError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "WalkForwardError";
  }
}

/** Kompakte Fenster-Kennzahlen. */
export interface WindowEvalSummary {
  from: number;
  to: number;
  bars: number;
  trades: number;
  wins: number;
  winRate: number;
  pnl: number;
  profitFactor: number | null;
  maxDrawdownPct: number;
  sharpeRatio: number;
  sortinoRatio: number;
  fees: number;
  funding: number;
  netPnl: number;
  slippage: number;
  tradeHash: string;
}

export interface WalkForwardWindowReport {
  index: number;
  is: WindowEvalSummary;
  oos: WindowEvalSummary;
}

/** Aggregierte OOS-/IS-Kennzahlen über alle Fenster. */
export interface WalkForwardAggregate {
  windows: number;
  bars: number;
  trades: number;
  wins: number;
  winRate: number;
  pnl: number;
  profitFactor: number | null;
  maxDrawdownPct: number;
  sharpeRatio: number;
  sortinoRatio: number;
  fees: number;
  funding: number;
  netPnl: number;
  slippage: number;
}

/** Segment eines Walk-Forward-Fensters. */
export type WalkForwardSegment = "IS" | "OOS";

export interface WalkForwardTradeRecord {
  windowIndex: number;
  segment: WalkForwardSegment;
  trade: BacktestTradeLog;
  replay?: TradeReplayDetail;
}

export interface WalkForwardReplayEvidence {
  config: ResolvedEventReplayConfig;
  manifest: EventReplayDataManifest;
  coverage: EventReplayCoverage;
  degradedReasons: ReplayDegradedReason[];
}

export interface WalkForwardReport {
  executionQuality?: Batch[];
  kind: "walk-forward";
  instrumentId: string;
  timeframe: SupportedTimeframe;
  from: number;
  to: number;
  ruleRef: {
    ruleId: string | null;
    ruleKey: string | null;
    name: string;
    signature: string;
    ruleSymbol: string;
  };
  walkforward: WalkForwardConfig & { windowCount: number; truncated: boolean };
  selection?: {
    targetMetric: SelectorTargetMetric;
    gates?: SelectorGates;
    candidatesCount: number;
    candidateHash: string;
  };
  freezeArtifacts?: FreezeArtifact[];
  holdout?: HoldoutReport | null;
  costProfile: {
    executionModel: string;
    makerFee: number;
    takerFee: number;
    spreadBpsFallback: number | null;
    fundingRatePctPer8h: number;
    simulatorSeed: number;
    frictionModelVersion?: string | null;
  };
  replayEvidence?: WalkForwardReplayEvidence;
  windows: WalkForwardWindowReport[];
  aggregateOos: WalkForwardAggregate;
  aggregateIs: WalkForwardAggregate;
  codeVersion: string;
  createdAt: string;
  trades: WalkForwardTradeRecord[];
}

export interface RunWalkForwardInput {
  instrumentId: string;
  timeframe: SupportedTimeframe;
  candles: CandleLike[];
  strategies?: BacktestStrategyItem[];
  candidates?: WalkForwardCandidate[];
  selector?: WalkForwardSelectorConfig;
  holdout?: HoldoutConfig;
  embargoHours?: number;
  purgeHours?: number;
  ruleRef: WalkForwardReport["ruleRef"];
  engineConfig?: BacktestEngineOptions;
  walkforward?: Partial<WalkForwardConfig>;
  nowMs?: number;
}

/** sha256 über die kanonische Trade-Liste (stabile Key-Reihung). */
export function hashTrades(
  trades: ReadonlyArray<BacktestTradeLog | Record<string, unknown>>
): string {
  return createHash("sha256").update(stableStringify(trades)).digest("hex");
}

export function sumTradeNetPnl(trades: ReadonlyArray<Pick<BacktestTradeLog, "pnl">>): number {
  let sum = 0;
  for (const t of trades) sum += t.pnl;
  return Number(sum.toFixed(4));
}

function summarizeEval(result: MultiAssetBacktestResult, from: number, to: number): WindowEvalSummary {
  const m = result.metrics;
  return {
    from,
    to,
    bars: result.barsProcessed,
    trades: m.totalTrades,
    wins: m.winningTrades,
    winRate: m.winRate,
    pnl: m.totalReturn,
    profitFactor: m.profitFactor,
    maxDrawdownPct: m.maxDrawdownPct,
    sharpeRatio: m.sharpeRatio,
    sortinoRatio: m.sortinoRatio,
    fees: m.totalFeesPaid,
    funding: m.totalFundingPaid,
    netPnl: sumTradeNetPnl(result.trades),
    slippage: m.totalSlippagePaid,
    tradeHash: hashTrades(result.trades),
  };
}

export function aggregateWindowEvals(
  evals: Array<{ summary: WindowEvalSummary; result: MultiAssetBacktestResult }>
): WalkForwardAggregate {
  const empty: WalkForwardAggregate = {
    windows: 0, bars: 0, trades: 0, wins: 0, winRate: 0, pnl: 0,
    profitFactor: null, maxDrawdownPct: 0, sharpeRatio: 0, sortinoRatio: 0,
    fees: 0, funding: 0, netPnl: 0, slippage: 0,
  };
  if (evals.length === 0) return empty;

  let bars = 0;
  let trades = 0;
  let wins = 0;
  let pnl = 0;
  let fees = 0;
  let funding = 0;
  let netPnl = 0;
  let slippage = 0;
  const logReturns: number[] = [];
  const equityLevels: number[] = [];

  for (const { summary, result } of evals) {
    bars += summary.bars;
    trades += summary.trades;
    wins += summary.wins;
    pnl += summary.pnl;
    fees += summary.fees;
    funding += summary.funding;
    netPnl += summary.netPnl;
    slippage += summary.slippage;
    const curve = result.equityCurve;
    for (let i = 1; i < curve.length; i++) {
      const prev = curve[i - 1].equity;
      const curr = curve[i].equity;
      if (prev > 0 && curr > 0) logReturns.push(Math.log(curr / prev));
    }
    for (const p of curve) equityLevels.push(p.equity);
  }

  const pf = trades > 0 ? profitFactor(evals.flatMap((e) => e.result.trades.map((t) => t.pnl))) : { value: null, grossProfit: 0, grossLoss: 0 };
  const sharpe = logReturns.length >= 2 ? sharpeRatio(logReturns, { annualization: 365 * 24 }) : { perPeriod: 0, annualized: 0 };
  const sortino = logReturns.length >= 2 ? sortinoRatio(logReturns, { annualization: 365 * 24 }) : { perPeriod: 0, annualized: 0 };
  const mdd = equityLevels.length > 0 ? maxDrawdown(equityLevels) : { value: 0, durationPeriods: 0 };

  return {
    windows: evals.length,
    bars,
    trades,
    wins,
    winRate: trades > 0 ? Number(((wins / trades) * 100).toFixed(2)) : 0,
    pnl: Number(pnl.toFixed(2)),
    profitFactor: pf.value !== null && Number.isFinite(pf.value) ? Number(pf.value.toFixed(2)) : null,
    maxDrawdownPct: Number((mdd.value * 100).toFixed(2)),
    sharpeRatio: Number((sharpe.annualized ?? 0).toFixed(2)),
    sortinoRatio: Number((sortino.annualized ?? 0).toFixed(2)),
    fees: Number(fees.toFixed(2)),
    funding: Number(funding.toFixed(8)),
    netPnl: Number(netPnl.toFixed(4)),
    slippage: Number(slippage.toFixed(2)),
  };
}

/**
 * Führt den echten Train-Select-Freeze-Test Walk-Forward-Lauf aus (RMA-P1-02).
 */
export function runWalkForward(input: RunWalkForwardInput): WalkForwardReport {
  const wf = { ...loadWalkForwardConfig(), ...input.walkforward };
  const totalFrom = input.candles.length > 0 ? input.candles[0].time : NaN;
  const totalTo = input.candles.length > 0 ? input.candles[input.candles.length - 1].time : NaN;
  if (!Number.isFinite(totalFrom) || !Number.isFinite(totalTo) || totalTo <= totalFrom) {
    throw new WalkForwardError(
      "walkforward:no-candles",
      "walkforward:no-candles — Walk-Forward braucht mindestens 2 Kerzen mit aufsteigender Zeit."
    );
  }

  // Kandidaten ermitteln & validieren
  let candidateList: WalkForwardCandidate[];
  if (input.candidates && input.candidates.length > 0) {
    candidateList = validateCandidates(input.candidates);
  } else {
    candidateList = [
      {
        id: input.ruleRef.ruleId ?? "cand-default",
        name: input.ruleRef.name,
        strategyVersion: input.ruleRef.signature,
        config: { ruleSymbol: input.ruleRef.ruleSymbol },
        strategies: input.strategies ?? [],
      },
    ];
  }

  const targetMetric = input.selector?.targetMetric ?? "sharpeRatio";
  const failClosedSelector = input.selector?.failClosed !== false;

  // Embargo & Purge Parameter (in Millisekunden)
  const embargoMs = Math.round((input.embargoHours ?? 0) * 3600_000);
  const purgeMs = Math.round((input.purgeHours ?? 0) * 3600_000);

  // Holdout-Bereich ermitteln
  let wfTo = totalTo;
  let holdoutFrom = totalTo;
  let holdoutTo = totalTo;
  if (input.holdout && input.holdout.holdoutDays > 0) {
    const holdoutMs = Math.round(input.holdout.holdoutDays * 86_400_000);
    const holdoutEmbargoMs = Math.round((input.holdout.embargoHours ?? 0) * 3600_000);
    holdoutTo = totalTo;
    holdoutFrom = totalTo - holdoutMs;
    wfTo = holdoutFrom - holdoutEmbargoMs;
    if (wfTo <= totalFrom) {
      throw new WalkForwardError(
        "walkforward:insufficient-span",
        `walkforward:insufficient-span — Zeitraum ist nach Abzug des Holdouts (${input.holdout.holdoutDays}d) zu kurz.`
      );
    }
  }

  const layout = computeWalkForwardWindows(totalFrom, wfTo, wf);
  if (layout.windows.length === 0) {
    throw new WalkForwardError(
      "walkforward:insufficient-span",
      `walkforward:insufficient-span — Zeitraum ${Math.round((wfTo - totalFrom) / 86_400_000)}d trägt kein vollständiges IS(${wf.isDays}d)+OOS(${wf.oosDays}d)-Fenster.`
    );
  }

  const executionModel: "paper" | "event_replay" =
    input.engineConfig?.executionModel === "event_replay" ? "event_replay" : "paper";
  const baseConfig: BacktestEngineOptions = { ...input.engineConfig, executionModel };

  const windowReports: WalkForwardWindowReport[] = [];
  const freezeArtifacts: FreezeArtifact[] = [];
  const isEvals: Array<{ summary: WindowEvalSummary; result: MultiAssetBacktestResult }> = [];
  const oosEvals: Array<{ summary: WindowEvalSummary; result: MultiAssetBacktestResult }> = [];
  const trades: WalkForwardTradeRecord[] = [];
  const executionQuality: Batch[] = [];

  const evidenceBox: { current: WalkForwardReplayEvidence | null } = { current: null };
  const mergeReplayEvidence = (result: MultiAssetBacktestResult): void => {
    const summary = result.replay;
    if (!summary) return;
    if (evidenceBox.current === null) {
      evidenceBox.current = {
        config: summary.config,
        manifest: summary.manifest,
        coverage: emptyReplayCoverage(),
        degradedReasons: [],
      };
    }
    const cov = evidenceBox.current.coverage;
    for (const key of Object.keys(cov) as Array<keyof EventReplayCoverage>) {
      cov[key] += summary.coverage[key];
    }
    evidenceBox.current.degradedReasons = Array.from(
      new Set([...evidenceBox.current.degradedReasons, ...summary.degradedReasons])
    ).sort();
  };

  const captureHash = digest({
    candles: input.candles,
    rule: input.ruleRef,
    config: input.engineConfig ?? null,
    version: APP_VERSION,
    timeframe: input.timeframe,
    layout,
  });

  // Letzter selektierter Kandidat für Holdout
  let lastSelectedCandidate: WalkForwardCandidate = candidateList[0];

  for (const w of layout.windows) {
    // 1. IS-Selektion
    const isCandles = filterCandlesWithLeakageProtection(input.candles, w.isFrom, w.isTo, {
      purgeMs,
      strict: true,
    });
    const candlesBySymbolIs = new Map<string, CandleLike[]>([[input.instrumentId, isCandles]]);

    const scoreTable: CandidateScoreRow[] = [];
    const candidateEvalMap = new Map<string, { summary: WindowEvalSummary; result: MultiAssetBacktestResult }>();

    for (const cand of candidateList) {
      const isResult = runMultiAssetBacktest({
        candlesBySymbol: candlesBySymbolIs,
        strategies: cand.strategies,
        config: { ...baseConfig, from: w.isFrom, to: w.isTo },
      });
      const isSummary = summarizeEval(isResult, w.isFrom, w.isTo);
      const gateRes = evaluateGates(isSummary, input.selector?.gates);
      const score = extractTargetMetric(isResult.metrics, isSummary, targetMetric);

      candidateEvalMap.set(cand.id, { summary: isSummary, result: isResult });

      scoreTable.push({
        candidateId: cand.id,
        candidateName: cand.name,
        config: cand.config,
        score,
        passedGates: gateRes.passed,
        rejectionReason: gateRes.reason ?? null,
        metrics: {
          trades: isSummary.trades,
          winRate: isSummary.winRate,
          netPnl: isSummary.netPnl,
          pnl: isSummary.pnl,
          sharpeRatio: isSummary.sharpeRatio,
          sortinoRatio: isSummary.sortinoRatio,
          profitFactor: isSummary.profitFactor,
          maxDrawdownPct: isSummary.maxDrawdownPct,
        },
      });
    }

    // Deterministisches Sortieren mit Tie-Breaker:
    // 1. Gate bestanden (true > false)
    // 2. Score (descending)
    // 3. Net PnL (descending)
    // 4. Trades (descending)
    // 5. Max Drawdown % (ascending)
    // 6. Candidate ID (lexikographisch aufsteigend)
    scoreTable.sort((a, b) => {
      if (a.passedGates !== b.passedGates) return a.passedGates ? -1 : 1;
      if (a.score !== b.score) return b.score - a.score;
      if (a.metrics.netPnl !== b.metrics.netPnl) return b.metrics.netPnl - a.metrics.netPnl;
      if (a.metrics.trades !== b.metrics.trades) return b.metrics.trades - a.metrics.trades;
      if (a.metrics.maxDrawdownPct !== b.metrics.maxDrawdownPct) return a.metrics.maxDrawdownPct - b.metrics.maxDrawdownPct;
      return a.candidateId.localeCompare(b.candidateId);
    });

    const winningRow = scoreTable[0];
    if (!winningRow.passedGates && failClosedSelector) {
      throw new WalkForwardError(
        "walkforward:no-candidate-passed-gates",
        `walkforward:no-candidate-passed-gates — Kein Kandidat hat im IS-Fenster [${new Date(w.isFrom).toISOString()}, ${new Date(w.isTo).toISOString()}] die harten Mindestgates erfüllt.`
      );
    }

    const winningCandidate = candidateList.find((c) => c.id === winningRow.candidateId)!;
    lastSelectedCandidate = winningCandidate;

    const winningIsEval = candidateEvalMap.get(winningCandidate.id)!;
    isEvals.push(winningIsEval);
    mergeReplayEvidence(winningIsEval.result);

    // Freeze-Artefakt erzeugen
    const freezeArtifact = createFreezeArtifact({
      windowIndex: w.index,
      isFrom: w.isFrom,
      isTo: w.isTo,
      oosFrom: w.oosFrom,
      oosTo: w.oosTo,
      selectedCandidate: winningCandidate,
      scoreTable,
      candles: input.candles,
      selectorConfig: input.selector,
      engineConfig: input.engineConfig,
      seed: input.engineConfig?.paper?.simulator?.seed ?? input.engineConfig?.replay?.seed ?? 1,
      embargoMs,
      purgeMs,
    });
    freezeArtifacts.push(freezeArtifact);

    // 2. OOS-Evaluation NUR mit dem selektierten Kandidaten
    const oosCandles = filterCandlesWithLeakageProtection(input.candles, w.oosFrom, w.oosTo, {
      purgeMs: 0,
      strict: false,
    });
    const candlesBySymbolOos = new Map<string, CandleLike[]>([[input.instrumentId, oosCandles]]);

    const oosResult = runMultiAssetBacktest({
      candlesBySymbol: candlesBySymbolOos,
      strategies: winningCandidate.strategies,
      config: { ...baseConfig, from: w.oosFrom, to: w.oosTo },
    });

    for (const [segment, result] of [["IS", winningIsEval.result], ["OOS", oosResult]] as const) {
      const scope = digest([captureHash, w, segment]);
      executionQuality.push(...(result.executionQuality ?? []).map((b) => scopeReplay(b, scope, input.nowMs ?? Date.now())));
    }

    const oosSummary = summarizeEval(oosResult, w.oosFrom, w.oosTo);
    windowReports.push({ index: w.index, is: winningIsEval.summary, oos: oosSummary });
    oosEvals.push({ summary: oosSummary, result: oosResult });
    mergeReplayEvidence(oosResult);

    for (const trade of winningIsEval.result.trades) {
      const detail = winningIsEval.result.replay?.tradeDetails[trade.id];
      trades.push({ windowIndex: w.index, segment: "IS", trade, ...(detail ? { replay: detail } : {}) });
    }
    for (const trade of oosResult.trades) {
      const detail = oosResult.replay?.tradeDetails[trade.id];
      trades.push({ windowIndex: w.index, segment: "OOS", trade, ...(detail ? { replay: detail } : {}) });
    }
  }

  // 3. Finaler Holdout (erst NACH allen IS/OOS-Entscheidungen)
  let holdoutReport: HoldoutReport | null = null;
  if (input.holdout && input.holdout.holdoutDays > 0 && holdoutFrom < holdoutTo) {
    const holdoutCandles = filterCandlesWithLeakageProtection(input.candles, holdoutFrom, holdoutTo, {
      purgeMs: 0,
      strict: false,
    });
    const candlesBySymbolHoldout = new Map<string, CandleLike[]>([[input.instrumentId, holdoutCandles]]);

    const holdoutResult = runMultiAssetBacktest({
      candlesBySymbol: candlesBySymbolHoldout,
      strategies: lastSelectedCandidate.strategies,
      config: { ...baseConfig, from: holdoutFrom, to: holdoutTo },
    });

    const holdoutSummary = summarizeEval(holdoutResult, holdoutFrom, holdoutTo);
    mergeReplayEvidence(holdoutResult);

    holdoutReport = {
      from: holdoutFrom,
      to: holdoutTo,
      candidateId: lastSelectedCandidate.id,
      candidate: lastSelectedCandidate,
      summary: holdoutSummary,
      trades: holdoutResult.trades,
      ...(holdoutResult.replay ? { replay: holdoutResult.replay } : {}),
    };
  }

  const candidateHash = createHash("sha256")
    .update(stableStringify(candidateList.map((c) => ({ id: c.id, config: c.config }))))
    .digest("hex");

  const enginePaper = input.engineConfig?.paper;
  const engineReplay = input.engineConfig?.replay;
  const nowMs = input.nowMs ?? Date.now();
  const evidence: WalkForwardReplayEvidence | null = evidenceBox.current;

  return {
    executionQuality,
    kind: "walk-forward",
    instrumentId: input.instrumentId,
    timeframe: input.timeframe,
    from: layout.effectiveFrom,
    to: layout.effectiveTo,
    ruleRef: input.ruleRef,
    walkforward: {
      isDays: wf.isDays,
      oosDays: wf.oosDays,
      maxSpanDays: wf.maxSpanDays,
      windowCount: layout.windows.length,
      truncated: layout.truncated,
    },
    selection: {
      targetMetric,
      gates: input.selector?.gates,
      candidatesCount: candidateList.length,
      candidateHash,
    },
    freezeArtifacts,
    ...(holdoutReport ? { holdout: holdoutReport } : {}),
    costProfile: {
      executionModel,
      makerFee: enginePaper?.makerFee ?? engineReplay?.makerFee ?? input.engineConfig?.feeModel?.makerFee ?? 0.0002,
      takerFee: enginePaper?.takerFee ?? engineReplay?.takerFee ?? input.engineConfig?.feeModel?.takerFee ?? 0.0006,
      spreadBpsFallback:
        executionModel === "event_replay"
          ? evidence?.config.spreadBpsFallback ?? engineReplay?.spreadBpsFallback ?? null
          : enginePaper?.spreadBpsFallback ?? enginePaper?.simulator?.syntheticSpreadBps ?? null,
      fundingRatePctPer8h: enginePaper?.fundingRatePctPer8h ?? 0,
      simulatorSeed:
        executionModel === "event_replay"
          ? evidence?.config.seed ?? engineReplay?.seed ?? 1
          : enginePaper?.simulator?.seed ?? 0,
      frictionModelVersion: evidence?.config.frictionModelVersion ?? null,
    },
    ...(evidence ? { replayEvidence: evidence } : {}),
    windows: windowReports,
    aggregateOos: aggregateWindowEvals(oosEvals),
    aggregateIs: aggregateWindowEvals(isEvals),
    codeVersion: APP_VERSION,
    createdAt: new Date(nowMs).toISOString(),
    trades,
  };
}
