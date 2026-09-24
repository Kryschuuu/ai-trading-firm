/**
 * Kostenbewusster Regel-Backtest für `POST /api/firm/rules/[id]/backtest`
 * (VBF-P1-01).
 *
 * Zwei Pfade, beide explizit:
 *   - `paper` (Default): `runRuleSetBacktest` mit `executionModel: "paper"`.
 *     Kerzen kommen nur aus dem HistoricalStore. Die Store-ID
 *     (`VENUE:native`) ist nicht das Regel-Symbol. Fehlt eine eindeutige
 *     Reihe, ist das ein Fehler — kein stiller Yahoo-Call.
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
  type HistoricalCandleEntry,
  type HistoricalStore,
  type StoreQuery,
  type SupportedTimeframe,
} from "@/lib/marketdata/historicalStore";
import {
  backtestRule,
  type BacktestResult,
  type CandleLike,
  type RuleSpec,
} from "@/lib/ruleEngine";
import { isValidInstrumentId, tryNormalizeVenueSymbol } from "@/symbols/normalize";

export const RULE_BACKTEST_MIN_BARS = 100;
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
  /** PAPER-kanonisches Regel-Symbol. Nicht die Store-ID. */
  ruleSymbol: string;
  /** null im Referenzpfad: dort gibt es keine Store-Reihe. */
  instrumentId: string | null;
  /** Gesetzte Store-ID passt kanonisch nicht zum Regel-Symbol. Kein stiller Tausch. */
  seriesWarning: string | null;
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
  /** null, wenn der Client keine Store-ID geschickt hat. */
  instrumentId: string | null;
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
  const instrumentId = parseOptionalInstrumentId(record.instrumentId);
  if (!instrumentId.ok) return instrumentId;
  return {
    ok: true,
    value: {
      model,
      limit: Math.trunc(limit),
      startingEquity: equityRaw,
      interval,
      instrumentId: instrumentId.value,
    },
  };
}

const MAX_AMBIGUOUS_IDS = 5;

/**
 * Store-ID aus dem Request. Leer ist erlaubt (Auflösung über das Regel-Symbol).
 * Gesetzt muss die ID `isValidInstrumentId` bestehen — keine Pfade, kein Raten.
 */
export function parseOptionalInstrumentId(
  raw: unknown,
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false, error: "instrumentId muss ein String sein." };
  const trimmed = raw.normalize("NFKC").trim();
  if (trimmed.length === 0) return { ok: true, value: null };
  const id = trimmed.toUpperCase();
  if (
    id.length > 64 ||
    id.includes("..") ||
    id.includes("\\") ||
    /[\u0000-\u001f]/.test(id) ||
    !isValidInstrumentId(id)
  ) {
    return {
      ok: false,
      error: "instrumentId muss die Form VENUE:SYMBOL haben (z. B. BITUNIX:BTCUSDT).",
    };
  }
  return { ok: true, value: id };
}

/** Kanonische Form einer Store-ID, oder null wenn die ID nicht normalisierbar ist. */
export function canonicalOfStoreId(id: string): string | null {
  const idx = id.indexOf(":");
  if (idx <= 0 || id.indexOf(":", idx + 1) >= 0) return null;
  const norm = tryNormalizeVenueSymbol(id.slice(0, idx), id.slice(idx + 1));
  return norm.ok ? norm.value.canonical : null;
}

function visibleBars(count: number, limit: number): number {
  if (limit > 0) return Math.min(count, limit);
  return count;
}

/**
 * Welche Store-Reihe der Paper-Pfad lesen darf.
 *
 * 1. Gesetzte `instrumentId`: nur diese Reihe. Kein Fallback auf das Regel-Symbol.
 * 2. Sonst eine Reihe, die exakt unter `ruleSymbol` liegt und genug Bars hat.
 * 3. Sonst genau eine Reihe, deren kanonisches Symbol `ruleSymbol` ist.
 *    Mehrere ausreichende Reihen sind 422 — es wird keine Venue geraten.
 */
export function resolvePaperInstrumentId(args: {
  entries: readonly Pick<HistoricalCandleEntry, "instrumentId" | "timeframe">[];
  ruleSymbol: string;
  timeframe: string;
  limit: number;
  instrumentId: string | null;
}): { ok: true; instrumentId: string } | { ok: false; status: 422; error: string } {
  const counts = new Map<string, number>();
  for (const entry of args.entries) {
    if (entry.timeframe !== args.timeframe) continue;
    counts.set(entry.instrumentId, (counts.get(entry.instrumentId) ?? 0) + 1);
  }
  const enough = (id: string): boolean =>
    visibleBars(counts.get(id) ?? 0, args.limit) >= RULE_BACKTEST_MIN_BARS;

  if (args.instrumentId) {
    if (!enough(args.instrumentId)) {
      return {
        ok: false,
        status: 422,
        error: historyTooShortMessage(
          args.instrumentId,
          args.timeframe,
          visibleBars(counts.get(args.instrumentId) ?? 0, args.limit),
        ),
      };
    }
    return { ok: true, instrumentId: args.instrumentId };
  }

  if (enough(args.ruleSymbol)) return { ok: true, instrumentId: args.ruleSymbol };

  const matches = [...counts.keys()]
    .filter((id) => id !== args.ruleSymbol && canonicalOfStoreId(id) === args.ruleSymbol && enough(id))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (matches.length === 1) return { ok: true, instrumentId: matches[0] };
  if (matches.length > 1) {
    const shown = matches.slice(0, MAX_AMBIGUOUS_IDS);
    const extra = matches.length - shown.length;
    return {
      ok: false,
      status: 422,
      error:
        `Mehrere Store-Reihen passen zum Regel-Symbol ${args.ruleSymbol} im Timeframe ${args.timeframe}: ` +
        `${shown.join(", ")}${extra > 0 ? ` (+${extra})` : ""}. ` +
        "instrumentId setzen (Form VENUE:SYMBOL, z. B. BITUNIX:BTCUSDT). " +
        "Es wird keine Reihe geraten und keine Kursquelle nachgeladen.",
    };
  }
  return {
    ok: false,
    status: 422,
    error: historyTooShortMessage(
      args.ruleSymbol,
      args.timeframe,
      visibleBars(counts.get(args.ruleSymbol) ?? 0, args.limit),
    ),
  };
}

function seriesWarning(ruleSymbol: string, instrumentId: string): string | null {
  if (instrumentId === ruleSymbol || canonicalOfStoreId(instrumentId) === ruleSymbol) return null;
  return (
    `Store-ID ${instrumentId} ist nicht das Regel-Symbol ${ruleSymbol}. ` +
    "Die Messung benutzt nur die genannte Store-Reihe; die Regel bleibt beim gespeicherten Symbol."
  );
}

/**
 * `runRuleSetBacktest` fragt den Store mit `rule.symbol`. Liegt die Reihe unter
 * einer anderen ID, liefert diese Sicht genau diese Reihe — ohne die Engine
 * und ohne andere Symbole anzufassen.
 */
function storeAliasedTo(
  store: Pick<HistoricalStore, "query">,
  ruleSymbol: string,
  instrumentId: string,
): Pick<HistoricalStore, "query"> {
  if (ruleSymbol === instrumentId) return store;
  return {
    query(q: StoreQuery) {
      return store.query({
        ...q,
        instrumentId: q.instrumentId === ruleSymbol ? instrumentId : q.instrumentId,
      });
    },
  };
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
    "Historie synchronisieren. Die Store-ID hat die Form VENUE:SYMBOL (z. B. BITUNIX:BTCUSDT) " +
    "und ist nicht dasselbe wie das PAPER-kanonische Regel-Symbol."
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
      ruleSymbol: spec.symbol,
      instrumentId: null,
      seriesWarning: null,
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
        ruleSymbol: spec.symbol,
        instrumentId: null,
        seriesWarning: null,
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
  const resolved = resolvePaperInstrumentId({
    entries: args.store.readAll(),
    ruleSymbol: spec.symbol,
    timeframe,
    limit: request.limit,
    instrumentId: request.instrumentId,
  });
  if (!resolved.ok) return resolved;
  const entries = args.store.query({
    instrumentId: resolved.instrumentId,
    timeframe,
    limit: request.limit,
  });
  if (entries.length < RULE_BACKTEST_MIN_BARS) {
    return {
      ok: false,
      status: 422,
      error: historyTooShortMessage(resolved.instrumentId, timeframe, entries.length),
    };
  }
  const warning = seriesWarning(spec.symbol, resolved.instrumentId);
  const paper: MultiAssetBacktestResult = runRuleSetBacktest([spec], storeAliasedTo(args.store, spec.symbol, resolved.instrumentId), {
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
    ruleSymbol: spec.symbol,
    instrumentId: resolved.instrumentId,
    seriesWarning: warning,
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
      ruleSymbol: spec.symbol,
      instrumentId: resolved.instrumentId,
      seriesWarning: warning,
      result: { executionModel: "paper", stats, equityCurve, trades },
    },
  };
}
