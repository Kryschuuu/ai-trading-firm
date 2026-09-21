/**
 * Walk-Forward-Validierung für die regelbasierte Backtesting-Engine
 * (GAP-01, v1.51.0).
 *
 * Rollierende In-Sample-/Out-of-Sample-Fenster über den Backtest-Zeitraum:
 *   - OOS-Segmente kacheln den Zeitraum lückenlos und überlappungsfrei
 *     (Schrittweite = OOS-Länge, jüngstes Fenster endet an `to`).
 *   - Jedes OOS-Segment wird von einem direkt davor liegenden IS-Fenster
 *     fester Länge begleitet (IS-Fenster dürfen überlappen — Standard).
 *   - Jedes Fenster ist ein EIGENSTÄNDIGER Evaluations-Lauf (keine
 *     fensterübergreifenden Positionen): IS/OOS trennt hier
 *     EVALUATIONS-Fenster (Robustheit), KEINE Parameterschätzung.
 *
 * Bewusst NICHT Teil dieses Moduls (dokumentierte Grenze, siehe
 * docs/BACKTESTING.md): Parameter-Optimierung auf IS mit OOS-Verifikation.
 * Die replayten Regeln sind statisch — IS vs. OOS zeigt, ob eine Regel über
 * die Zeit stabil trägt oder nur auf einem Abschnitt „passt“
 * (Anti-Overfitting-Ausweis statt Optimierung).
 *
 * Determinismus: rein + injizierbare Zeit (`nowMs`, Muster
 * `src/cycle/clock.ts`) — gleiche (Kerzen, Regel, Fenster, Kosten) ⇒
 * byte-identisches `metricsJson` (Test: `tests/backtest.engine.test.ts`).
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
  /** Effektiver Zeitraum nach maxSpanDays-Deckel (jüngste Daten gewinnen). */
  effectiveFrom: number;
  effectiveTo: number;
  /** true, wenn der Zeitraum am Deckel gekappt wurde. */
  truncated: boolean;
}

/**
 * Berechnet das rollierende Fensterlayout — rein, ohne Kerzen/IO.
 *
 * Layout (klassisch, vorwärts-rollierend): Fenster 0 startet am
 * Zeitraum-Anfang mit IS=[from, from+is), OOS=[from+is, from+is+oos);
 * jedes weitere Fenster rückt um EINE OOS-Länge vor. Nur VOLLSTÄNDIGE
 * Fenster (IS+OOS komplett innerhalb [from, to]) werden gelegt — ein
 * angebrochenes Restfenster wird verworfen (kein „fast voll“).
 *
 * Fail-closed: Passt nicht einmal EIN vollständiges Fenster in den
 * Zeitraum, ist `windows` leer — der Runner wirft dann
 * `walkforward:insufficient-span` statt zu raten.
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

/**
 * Kompakte Fenster-Kennzahlen (persistiert in `windowsJson`).
 *
 * Zwei PnL-Sichten (RMA-P1-04, v1.52.0):
 *   - `pnl`    = Equity-Sicht der Engine (`metrics.totalReturn`): Mark-to-
 *     Market am letzten Snapshot des Fensters, d. h. VOR den erzwungenen
 *     `END_OF_DATA`-Schließungen (deren Gebühren/Slippage fehlen hier).
 *   - `netPnl` = Trade-Ledger-Sicht: Summe der realisierten Netto-PnL aller
 *     Trades des Fensters (inkl. `END_OF_DATA`-Schlusskosten). Diese Summe
 *     wird exakt aus den `backtest_trades`-Zeilen reproduziert.
 *   `pnl − netPnl` ist damit genau der Kostenanteil der Schlussglattstellung
 *   (kein Fehler, dokumentierte Differenz; siehe docs/BACKTESTING.md §5).
 */
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
  /** Summe der Trade-Netto-PnL (Trade-Ledger, 4 Nachkommastellen). */
  netPnl: number;
  /** Summe der Slippage-Kosten (Kontowährung, 2 Nachkommastellen wie `fees`). */
  slippage: number;
  /** sha256 über die kanonische Trade-Liste (Lookahead-/Drift-Nachweis). */
  tradeHash: string;
}

export interface WalkForwardWindowReport {
  index: number;
  is: WindowEvalSummary;
  oos: WindowEvalSummary;
}

/** Aggregierte OOS-/IS-Kennzahlen über alle Fenster (persistiert). */
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
  /** Summe der Trade-Netto-PnL über alle Fenster (Trade-Ledger-Sicht). */
  netPnl: number;
  /** Summe der Slippage-Kosten über alle Fenster. */
  slippage: number;
}

/** Segment eines Walk-Forward-Fensters. */
export type WalkForwardSegment = "IS" | "OOS";

/**
 * Ein Trade des Walk-Forward-Laufs mit seiner Fenster-Zuordnung
 * (RMA-P1-04): identisch zum Engine-Trade-Log plus `windowIndex`/`segment`.
 * Die Liste im Report ist kanonisch geordnet (Fenster ↑, IS vor OOS, darin
 * Engine-Schließreihenfolge) — dieselbe Ordnung wie `backtest_trades.seq`.
 */
export interface WalkForwardTradeRecord {
  windowIndex: number;
  segment: WalkForwardSegment;
  trade: BacktestTradeLog;
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
    /**
     * Symbol, wie es in der Regel STEHT (PAPER-kanonisch, z. B. „BTC/USDT“).
     * Das Replay läuft gegen `instrumentId` (Store-ID, z. B.
     * „BITUNIX:BTCUSDT“) — Bedingung/Action/Fenster sind venue-agnostisch,
     * beide IDs stehen im Report (Nachvollziehbarkeit, kein stiller Tausch).
     */
    ruleSymbol: string;
  };
  walkforward: WalkForwardConfig & { windowCount: number; truncated: boolean };
  costProfile: {
    executionModel: string;
    makerFee: number;
    takerFee: number;
    spreadBpsFallback: number | null;
    fundingRatePctPer8h: number;
    simulatorSeed: number;
  };
  windows: WalkForwardWindowReport[];
  aggregateOos: WalkForwardAggregate;
  aggregateIs: WalkForwardAggregate;
  codeVersion: string;
  /** Erstellungszeitpunkt (injiziert — Tests nutzen eine feste Clock). */
  createdAt: string;
  /**
   * Vollständige, kanonisch geordnete Trade-Liste des Laufs (RMA-P1-04).
   * Quelle der `backtest_trades`-Zeilen; wird NICHT in `params_json`/
   * `metrics_json`/`windows_json` kopiert (explizites Mapping in
   * `toBacktestRunInsert`), landet aber im JSON-Artefakt der CLI.
   */
  trades: WalkForwardTradeRecord[];
}

export interface RunWalkForwardInput {
  instrumentId: string;
  timeframe: SupportedTimeframe;
  candles: CandleLike[];
  strategies: BacktestStrategyItem[];
  /** Regel-Referenz für `paramsJson` (Identität des Laufs). */
  ruleRef: WalkForwardReport["ruleRef"];
  /** Engine-Optionen (Walk-Forward erzwingt `executionModel: "paper"`). */
  engineConfig?: BacktestEngineOptions;
  walkforward?: Partial<WalkForwardConfig>;
  /** Injizierbare Zeit in ms (Default: Date.now — nur CLI/Prod). */
  nowMs?: number;
}

/** sha256 über die kanonische Trade-Liste (stabile Key-Reihung). */
export function hashTrades(
  trades: ReadonlyArray<BacktestTradeLog | Record<string, unknown>>
): string {
  return createHash("sha256").update(stableStringify(trades)).digest("hex");
}

/**
 * Summe der Trade-Netto-PnL eines Evaluations-Laufs — auf 4 Nachkommastellen
 * gerundet, weil jeder Summand bereits mit dieser Skala aus der Engine kommt
 * (`portfolio.closePosition`). Dieselbe Summe wird beim Ledger-Abgleich aus
 * den persistierten Zeilen gebildet (`src/backtest/tradeLedger.ts`).
 */
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

/**
 * Aggregiert Fensterläufe — alle Verhältnisse werden aus Summen NEU
 * berechnet (kein Mittel über Raten — das wäre mathematisch falsch).
 *
 * Sharpe/Sortino/MaxDD über die VERKETTETE OOS-/IS-Equity-Renditenreihe
 * (Anfangskapital je Fenster identisch ⇒ Renditen sind vergleichbar;
 * dokumentierte Näherung, kein fiktiver Kontoverlauf).
 */
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
 * Führt den Walk-Forward-Lauf aus: je Fenster ein IS- und ein OOS-
 * Evaluations-Lauf durch die Multi-Asset-Engine (Paper-Ausführung).
 *
 * Zeitmaske: Jeder Fensterlauf sieht NUR Kerzen seines Fensters
 * (`from`/`to`-Clip der Engine) — OOS-Kerzen sind für den IS-Lauf
 * strukturell unerreichbar (Test: `tests/backtest.engine.test.ts`).
 */
export function runWalkForward(input: RunWalkForwardInput): WalkForwardReport {
  const wf = { ...loadWalkForwardConfig(), ...input.walkforward };
  const from = input.candles.length > 0 ? input.candles[0].time : NaN;
  const to = input.candles.length > 0 ? input.candles[input.candles.length - 1].time : NaN;
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    throw new WalkForwardError(
      "walkforward:no-candles",
      "walkforward:no-candles — Walk-Forward braucht mindestens 2 Kerzen mit aufsteigender Zeit."
    );
  }

  const layout = computeWalkForwardWindows(from, to, wf);
  if (layout.windows.length === 0) {
    throw new WalkForwardError(
      "walkforward:insufficient-span",
      `walkforward:insufficient-span — Zeitraum ${Math.round((to - from) / 86_400_000)}d trägt kein vollständiges IS(${wf.isDays}d)+OOS(${wf.oosDays}d)-Fenster.`
    );
  }

  const candlesBySymbol = new Map<string, CandleLike[]>([[input.instrumentId, input.candles]]);
  const windowReports: WalkForwardWindowReport[] = [];
  const isEvals: Array<{ summary: WindowEvalSummary; result: MultiAssetBacktestResult }> = [];
  const oosEvals: Array<{ summary: WindowEvalSummary; result: MultiAssetBacktestResult }> = [];
  // Kanonische Trade-Liste (RMA-P1-04): Fenster ↑, IS vor OOS, darin die
  // Schließreihenfolge der Engine — identisch zu `backtest_trades.seq`.
  const trades: WalkForwardTradeRecord[] = [];
  const executionQuality: Batch[] = [];
  const captureHash = digest({candles:input.candles,rule:input.ruleRef,config:input.engineConfig ?? null,version:APP_VERSION,timeframe:input.timeframe,layout});

  for (const w of layout.windows) {
    // Walk-Forward läuft IMMER auf dem Paper-Ausführungspfad — kein
    // Legacy-Kostenmodell in vergleichbar persistierten Runs.
    const baseConfig: BacktestEngineOptions = { ...input.engineConfig, executionModel: "paper" };
    const isResult = runMultiAssetBacktest({
      candlesBySymbol,
      strategies: input.strategies,
      config: { ...baseConfig, from: w.isFrom, to: w.isTo },
    });
    const oosResult = runMultiAssetBacktest({
      candlesBySymbol,
      strategies: input.strategies,
      config: { ...baseConfig, from: w.oosFrom, to: w.oosTo },
    });
    for (const [segment,result] of [["IS",isResult],["OOS",oosResult]] as const) {
      const scope = digest([captureHash,w,segment]);
      executionQuality.push(...(result.executionQuality ?? []).map(b=>scopeReplay(b,scope,input.nowMs ?? Date.now())));
    }
    const isSummary = summarizeEval(isResult, w.isFrom, w.isTo);
    const oosSummary = summarizeEval(oosResult, w.oosFrom, w.oosTo);
    windowReports.push({ index: w.index, is: isSummary, oos: oosSummary });
    isEvals.push({ summary: isSummary, result: isResult });
    oosEvals.push({ summary: oosSummary, result: oosResult });
    for (const trade of isResult.trades) trades.push({ windowIndex: w.index, segment: "IS", trade });
    for (const trade of oosResult.trades) trades.push({ windowIndex: w.index, segment: "OOS", trade });
  }

  const enginePaper = input.engineConfig?.paper;
  const nowMs = input.nowMs ?? Date.now();
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
    costProfile: {
      executionModel: "paper",
      makerFee: enginePaper?.makerFee ?? input.engineConfig?.feeModel?.makerFee ?? 0.0002,
      takerFee: enginePaper?.takerFee ?? input.engineConfig?.feeModel?.takerFee ?? 0.0006,
      spreadBpsFallback: enginePaper?.spreadBpsFallback ?? enginePaper?.simulator?.syntheticSpreadBps ?? null,
      fundingRatePctPer8h: enginePaper?.fundingRatePctPer8h ?? 0,
      simulatorSeed: enginePaper?.simulator?.seed ?? 0,
    },
    windows: windowReports,
    aggregateOos: aggregateWindowEvals(oosEvals),
    aggregateIs: aggregateWindowEvals(isEvals),
    codeVersion: APP_VERSION,
    createdAt: new Date(nowMs).toISOString(),
    trades,
  };
}
