/**
 * Kostenbewusster Regel-Backtest für `POST /api/firm/rules/[id]/backtest`
 * (VBF-P1-01).
 *
 * Zwei Pfade, beide explizit:
 *   - `paper` (Default): `runRuleSetBacktest` mit `executionModel: "paper"`.
 *     Kerzen kommen nur aus dem HistoricalStore. Fehlt die Reihe, ist das
 *     ein Fehler — kein stiller Yahoo-Call.
 *   - `reference`: der eingefrorene `backtestRule` ohne Gebühren. Nur für
 *     den Vergleich, nie als Default.
 *
 * `backtestRule` selbst bleibt byte-identisch. Der Engine-Default
 * `executionModel: "legacy"` wird hier nicht angefasst.
 */

import { runRuleSetBacktest } from "@/backtest/engine";
import type { BacktestMetrics, MultiAssetBacktestResult } from "@/backtest/types";
import {
  isSupportedTimeframe,
  type HistoricalStore,
  type SupportedTimeframe,
} from "@/lib/marketdata/historicalStore";
import {
  backtestRule,
  type BacktestResult,
  type CandleLike,
  type RuleSpec,
} from "@/lib/ruleEngine";

export const RULE_BACKTEST_MIN_BARS = 40;
export const RULE_BACKTEST_TRADE_CAP = 200;
export const RULE_BACKTEST_EQUITY_CAP = 120;

export type RuleBacktestModel = "paper" | "reference";

export type RuleBacktestStats = {
  trades: number;
  wins: number;
  losses: number;
  pnl: number;
  pnlPct: number;
  profitFactor: number | null;
  maxDrawdownPct: number;
  exposurePct: number;
  /** null im Referenzpfad: dort wurden keine Kosten gemessen, nicht „0 bezahlt“. */
  totalFeesPaid: number | null;
  totalSlippagePaid: number | null;
  totalFundingPaid: number | null;
};

export type RuleBacktestEquityPoint = { t: number; equity: number };

export type RuleBacktestBody = {
  ok: true;
  executionModel: RuleBacktestModel;
  interval: string;
  candles: number;
  from: string | null;
  to: string | null;
  note: string;
  result: {
    executionModel: RuleBacktestModel;
    stats: RuleBacktestStats;
    equityCurve: RuleBacktestEquityPoint[];
    trades: unknown[];
  };
};

export type RuleBacktestPersistInput = {
  symbol: string;
  timeframe: string;
  trades: number;
  wins: number;
  pnl: number;
  profitFactor: number | null;
  maxDrawdownPct: number;
  from: Date;
  to: Date;
  detail: unknown;
};

export type RuleBacktestRun =
  | { ok: true; body: RuleBacktestBody; persist: RuleBacktestPersistInput }
  | { ok: false; status: 400 | 422; error: string };

export type ParsedRuleBacktestBody = {
  model: RuleBacktestModel;
  limit: number;
  startingEquity: number;
  /** null, wenn der Client kein Intervall geschickt hat. */
  interval: string | null;
};

const PAPER_NOTE =
  "Paper-Fill-Simulator (dieselbe Klasse wie der PaperBroker). Gebühren, Slippage und Funding sind im Netto-PnL enthalten. Kein Trailing, kein Time-Stop, kein Signal-Decay. Kerzen nur aus dem HistoricalStore — fehlende Historie ist ein Fehler, kein Yahoo-Fallback.";

const REFERENCE_NOTE =
  "Referenzpfad ohne Gebühren, Slippage und Funding (backtestRule). Nicht mit einem Paper-Fill vergleichen. Kostenlose Zahlen sind kein erwarteter Live-PnL.";

export function parseRuleBacktestBody(raw: unknown): { ok: true; value: ParsedRuleBacktestBody } | { ok: false; error: string } {
  const body = raw == null ? {} : raw;
  if (typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "JSON-Objekt erforderlich." };
  }
  const record = body as Record<string, unknown>;
  let model: RuleBacktestModel = "paper";
  if (record.model !== undefined) {
    if (record.model !== "paper" && record.model !== "reference") {
      return { ok: false, error: "model muss \"paper\" oder \"reference\" sein." };
    }
    model = record.model;
  }
  let interval: string | null = null;
  if (record.interval !== undefined) {
    if (typeof record.interval !== "string" || record.interval.trim() === "") {
      return { ok: false, error: "interval muss ein Timeframe-String sein." };
    }
    interval = record.interval.trim();
  }
  const limitRaw = record.limit === undefined ? 300 : Number(record.limit);
  const limit = Math.min(1000, Math.max(60, Number.isFinite(limitRaw) ? limitRaw : 300));
  const equityRaw = record.startingEquity === undefined ? 10_000 : Number(record.startingEquity);
  if (!Number.isFinite(equityRaw) || equityRaw <= 0) {
    return { ok: false, error: "startingEquity muss eine positive Zahl sein." };
  }
  return { ok: true, value: { model, limit: Math.trunc(limit), startingEquity: equityRaw, interval } };
}

export function downsampleSeries<T>(points: readonly T[], max: number): T[] {
  if (points.length <= max || max < 2) return [...points];
  const out: T[] = [];
  const last = points.length - 1;
  for (let i = 0; i < max; i++) {
    out.push(points[Math.round((i * last) / (max - 1))]);
  }
  return out;
}

function isoOrNull(ms: number): string | null {
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function paperStats(metrics: BacktestMetrics): RuleBacktestStats {
  return {
    trades: metrics.totalTrades,
    wins: metrics.winningTrades,
    losses: metrics.losingTrades,
    pnl: metrics.totalReturn,
    pnlPct: metrics.totalReturnPct,
    profitFactor: metrics.profitFactor,
    maxDrawdownPct: metrics.maxDrawdownPct,
    exposurePct: metrics.exposureTimePct,
    totalFeesPaid: metrics.totalFeesPaid,
    totalSlippagePaid: metrics.totalSlippagePaid,
    totalFundingPaid: metrics.totalFundingPaid,
  };
}

function referenceStats(result: BacktestResult): RuleBacktestStats {
  return {
    trades: result.stats.trades,
    wins: result.stats.wins,
    losses: result.stats.losses,
    pnl: result.stats.pnl,
    pnlPct: result.stats.pnlPct,
    profitFactor: result.stats.profitFactor,
    maxDrawdownPct: result.stats.maxDrawdownPct,
    exposurePct: result.stats.exposurePct,
    totalFeesPaid: null,
    totalSlippagePaid: null,
    totalFundingPaid: null,
  };
}

function persistOf(
  spec: RuleSpec,
  timeframe: string,
  stats: RuleBacktestStats,
  fromMs: number,
  toMs: number,
  detail: unknown,
): RuleBacktestPersistInput {
  return {
    symbol: spec.symbol,
    timeframe,
    trades: stats.trades,
    wins: stats.wins,
    pnl: stats.pnl,
    profitFactor: stats.profitFactor,
    maxDrawdownPct: stats.maxDrawdownPct,
    from: new Date(fromMs),
    to: new Date(toMs),
    detail,
  };
}

export function historyTooShortMessage(symbol: string, timeframe: string, found: number): string {
  return (
    `Keine ausreichende Historie für ${symbol} im Timeframe ${timeframe} ` +
    `(gefunden: ${found}, nötig: ${RULE_BACKTEST_MIN_BARS}). ` +
    "Der Paper-Pfad liest nur den HistoricalStore und ruft keine Kursquelle nach. " +
    "Historie synchronisieren und prüfen, dass die Store-ID dem Regel-Symbol entspricht."
  );
}

export async function executeRuleBacktest(args: {
  spec: RuleSpec;
  request: ParsedRuleBacktestBody;
  store: HistoricalStore;
  loadReferenceCandles: (symbol: string, interval: string, limit: number) => Promise<CandleLike[]>;
  /** Nur Tests/Aufrufer, die den Simulator festnageln. Default: Engine-Umgebung. */
  paper?: import("@/backtest/paperExecution").PaperBacktestOptions;
}): Promise<RuleBacktestRun> {
  const { spec, request } = args;
  if (request.model === "reference") {
    const interval = request.interval ?? "15m";
    const candles = await args.loadReferenceCandles(spec.symbol, interval, request.limit);
    if (candles.length < RULE_BACKTEST_MIN_BARS) {
      return { ok: false, status: 422, error: `Zu wenige Kerzen für einen Backtest (${candles.length} < ${RULE_BACKTEST_MIN_BARS}).` };
    }
    const result = backtestRule(spec, candles, { startingEquity: request.startingEquity });
    const fromMs = candles[0]?.time ?? Date.now();
    const toMs = candles[candles.length - 1]?.time ?? fromMs;
    const stats = referenceStats(result);
    // backtestRule hat keine Equity-Kurve. Keine erfundene Reihe.
    const equityCurve: RuleBacktestEquityPoint[] = [];
    const trades = result.trades.slice(0, RULE_BACKTEST_TRADE_CAP);
    const detail = {
      executionModel: "reference" as const,
      from: isoOrNull(fromMs),
      to: isoOrNull(toMs),
      note: REFERENCE_NOTE,
      stats,
      equityCurve,
      trades,
    };
    return {
      ok: true,
      persist: persistOf(spec, result.timeframe, stats, fromMs, toMs, detail),
      body: {
        ok: true,
        executionModel: "reference",
        interval,
        candles: candles.length,
        from: isoOrNull(fromMs),
        to: isoOrNull(toMs),
        note: REFERENCE_NOTE,
        result: { executionModel: "reference", stats, equityCurve, trades },
      },
    };
  }

  // Body-`interval` wird auf dem Paper-Pfad ignoriert. Der Timeframe steht
  // in der Regel. Kein zweiter Abruf und kein Yahoo.
  if (!isSupportedTimeframe(spec.window.timeframe)) {
    return { ok: false, status: 422, error: `Timeframe ${spec.window.timeframe} ist kein Historical-Store-Timeframe.` };
  }
  const timeframe: SupportedTimeframe = spec.window.timeframe;
  const entries = args.store.query({
    instrumentId: spec.symbol,
    timeframe,
    limit: request.limit,
  });
  if (entries.length < RULE_BACKTEST_MIN_BARS) {
    return { ok: false, status: 422, error: historyTooShortMessage(spec.symbol, timeframe, entries.length) };
  }
  const paper: MultiAssetBacktestResult = runRuleSetBacktest([spec], args.store, {
    executionModel: "paper",
    timeframe,
    warmupBars: 30,
    initialCapital: request.startingEquity,
    from: entries[0].ts,
    to: entries[entries.length - 1].ts,
    ...(args.paper ? { paper: args.paper } : {}),
  });
  const fromMs = paper.from || entries[0].ts;
  const toMs = paper.to || entries[entries.length - 1].ts;
  const stats = paperStats(paper.metrics);
  const equityCurve = downsampleSeries(
    paper.equityCurve.map((point) => ({ t: point.timestamp, equity: point.equity })),
    RULE_BACKTEST_EQUITY_CAP,
  );
  const trades = paper.trades.slice(0, RULE_BACKTEST_TRADE_CAP).map((trade) => ({
    symbol: trade.symbol,
    side: trade.side,
    entryTime: trade.entryTime,
    exitTime: trade.exitTime,
    entryPrice: trade.entryPrice,
    exitPrice: trade.exitPrice,
    pnl: trade.pnl,
    fees: trade.fees,
    slippage: trade.slippage,
    funding: trade.funding ?? null,
    exitReason: trade.exitReason,
  }));
  const detail = {
    executionModel: "paper" as const,
    from: isoOrNull(fromMs),
    to: isoOrNull(toMs),
    note: PAPER_NOTE,
    stats,
    equityCurve,
    trades,
  };
  return {
    ok: true,
    persist: persistOf(spec, timeframe, stats, fromMs, toMs, detail),
    body: {
      ok: true,
      executionModel: "paper",
      interval: timeframe,
      candles: entries.length,
      from: isoOrNull(fromMs),
      to: isoOrNull(toMs),
      note: PAPER_NOTE,
      result: { executionModel: "paper", stats, equityCurve, trades },
    },
  };
}
