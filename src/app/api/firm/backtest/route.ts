import { NextResponse } from "next/server";
import { guardWrite } from "@/lib/apiAuth";
import { publicErrorMessage } from "@/lib/secrets";
import {
  runMultiAssetBacktest,
  runWalkForward,
  type BacktestEngineOptions,
  type BacktestStrategyItem,
  type WalkForwardCandidate,
  type WalkForwardSelectionConfig,
  WALK_FORWARD_MAX_CANDIDATES,
} from "@/backtest";
import { HistoricalStore, isSupportedTimeframe, DEFAULT_ANALYSIS_TIMEFRAME } from "@/lib/marketdata/historicalStore";
import { getRule, rowToSpec } from "@/lib/ruleService";
import { sanitizeRuleSpec } from "@/lib/ruleEngine";
import type { CandleLike, RuleSpec } from "@/lib/ruleEngine";
import type { TradeSetupProposal } from "@/cycle/schemas";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Multi-Asset Backtest API (Task 02).
 *
 * Führt einen synchronisierten Multi-Asset- und Multi-Strategy-Backtest aus:
 * - Entweder über übergebene Regel-IDs (`ruleIds`), Inline-Regeln (`rules`) oder Inline-Setups (`setups`)
 * - Lädt historische Kerzen aus dem `HistoricalStore` (oder nutzt optional übergebene `candles`)
 * - Liefert vollständige Equity-Kurve, Trade-Logs, Portfolio-Metriken und Symbol-/Strategie-Statistiken.
 * - Additiv: `walkforward.candidates` aktiviert bounded IS-Selection, Freeze,
 *   OOS und optionalen finalen Holdout; dieser API-Pfad persistiert bewusst
 *   nicht, die CLI ist der atomare Produktions-Writepfad.
 */
export async function POST(req: Request) {
  const denied = guardWrite(req);
  if (denied) return denied;

  try {
    const body = (await req.json().catch(() => ({}))) as {
      ruleIds?: string[];
      rules?: unknown[];
      setups?: unknown[];
      symbols?: string[];
      timeframe?: string;
      from?: number;
      to?: number;
      initialCapital?: number;
      maxOpenPositions?: number;
      maxRiskPerTrade?: number;
      maxPositionPct?: number;
      slippageModel?: "fixed" | "spread_relative" | "none";
      fixedSlippageBps?: number;
      enableShorts?: boolean;
      walkforward?: {
        candidates?: readonly WalkForwardCandidate[];
        selection?: Partial<WalkForwardSelectionConfig>;
        seed?: number;
        purgeBars?: number;
        embargoBars?: number;
        holdoutFrom?: number;
        holdoutTo?: number;
      };
    };

    const timeframe = isSupportedTimeframe(body.timeframe) ? body.timeframe : DEFAULT_ANALYSIS_TIMEFRAME;
    const store = new HistoricalStore();
    const strategies: BacktestStrategyItem[] = [];
    const symbolSet = new Set<string>(body.symbols ?? []);

    // 1. Regeln aus DB laden (wenn ruleIds übergeben)
    if (Array.isArray(body.ruleIds) && body.ruleIds.length > 0) {
      for (const id of body.ruleIds) {
        if (typeof id === "string" && id.trim()) {
          const ruleRow = await getRule(id.trim());
          if (ruleRow) {
            const spec = rowToSpec(ruleRow);
            strategies.push({ type: "rule", spec, id: `RULE-${ruleRow.id}` });
            symbolSet.add(spec.symbol);
          }
        }
      }
    }

    // 2. Inline-Regeln hinzufügen
    if (Array.isArray(body.rules)) {
      for (let i = 0; i < body.rules.length; i++) {
        const raw = body.rules[i];
        if (raw && typeof raw === "object" && !Array.isArray(raw)) {
          const checked = sanitizeRuleSpec(raw as Parameters<typeof sanitizeRuleSpec>[0], "MANUAL");
          if (checked.ok) {
            const spec: RuleSpec = checked.spec;
            const rawRecord = raw as Record<string, unknown>;
            const id = typeof rawRecord.id === "string" ? rawRecord.id : `RULE-INLINE-${i + 1}`;
            strategies.push({ type: "rule", spec, id });
            symbolSet.add(spec.symbol);
          }
        }
      }
    }

    // 3. Inline-Setups hinzufügen. Kein stilles Neutralisieren invalider
    // Werte: nur vollständig endliche Vorschläge werden replayt.
    if (Array.isArray(body.setups)) {
      for (let i = 0; i < body.setups.length; i++) {
        const raw = body.setups[i];
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
        const record = raw as Record<string, unknown>;
        const numeric = (key: string): number | null => typeof record[key] === "number" && Number.isFinite(record[key]) ? record[key] as number : null;
        const instrumentId = typeof record.instrumentId === "string" && record.instrumentId.trim() ? record.instrumentId.trim() : null;
        const side = record.side === "SHORT" ? "SHORT" : record.side === "LONG" ? "LONG" : null;
        const timeframeValue = typeof record.timeframe === "string" ? record.timeframe : null;
        const thesis = typeof record.thesis === "string" ? record.thesis.slice(0, 600) : null;
        const entryPrice = numeric("entryPrice");
        const stopLoss = numeric("stopLoss");
        const takeProfit = numeric("takeProfit");
        const riskScore = numeric("riskScore");
        if (!instrumentId || !side || !timeframeValue || thesis === null || entryPrice === null || stopLoss === null || takeProfit === null || riskScore === null || record.isProposal !== true) continue;
        const setup: TradeSetupProposal = { instrumentId, side, entryPrice, stopLoss, takeProfit, riskScore, timeframe: timeframeValue, thesis, isProposal: true };
        const id = typeof record.id === "string" ? record.id : `SETUP-INLINE-${i + 1}`;
        strategies.push({ type: "setup", setup, id });
        symbolSet.add(instrumentId);
      }
    }

    const trainingRequest = body.walkforward?.candidates;
    if (Array.isArray(trainingRequest) && trainingRequest.length > WALK_FORWARD_MAX_CANDIDATES) {
      return NextResponse.json({ ok: false, error: "Zu viele Walk-Forward-Kandidaten (Maximum 64)." }, { status: 400 });
    }
    if (Array.isArray(trainingRequest)) {
      for (const candidate of trainingRequest) {
        if (!candidate || !Array.isArray(candidate.strategies)) continue;
        for (const strategy of candidate.strategies) {
          if (strategy.type === "rule") symbolSet.add(strategy.spec.symbol);
          if (strategy.type === "setup") symbolSet.add(strategy.setup.instrumentId);
        }
      }
    }
    if (strategies.length === 0 && (!Array.isArray(trainingRequest) || trainingRequest.length === 0)) {
      return NextResponse.json(
        { ok: false, error: "Keine gültigen Regeln, Setups oder Walk-Forward-Kandidaten angegeben." },
        { status: 400 }
      );
    }

    // 4. Kerzen für alle beteiligten Symbole aus dem HistoricalStore laden
    const candlesBySymbol = new Map<string, CandleLike[]>();
    for (const sym of symbolSet) {
      const history = store.query({
        instrumentId: sym,
        timeframe,
        from: body.from,
        to: body.to,
      });

      const candles: CandleLike[] = history.map((h) => ({
        time: h.ts,
        open: h.open,
        high: h.high,
        low: h.low,
        close: h.close,
        volume: h.volume,
      }));

      candlesBySymbol.set(sym, candles);
    }

    const config: BacktestEngineOptions = {
      timeframe,
      from: body.from,
      to: body.to,
      initialCapital: typeof body.initialCapital === "number" && body.initialCapital > 0 ? body.initialCapital : 10_000,
      maxOpenPositions: typeof body.maxOpenPositions === "number" && body.maxOpenPositions > 0 ? body.maxOpenPositions : 5,
      maxRiskPerTrade: typeof body.maxRiskPerTrade === "number" && body.maxRiskPerTrade > 0 ? body.maxRiskPerTrade : 0.02,
      maxPositionPct: typeof body.maxPositionPct === "number" && body.maxPositionPct > 0 ? body.maxPositionPct : 0.25,
      slippageModel: body.slippageModel ?? "fixed",
      fixedSlippageBps: typeof body.fixedSlippageBps === "number" ? body.fixedSlippageBps : 5,
      enableShorts: Boolean(body.enableShorts),
    };

    // 5. Additiver Train-Select-Freeze-Pfad. Er bleibt bewusst auf ein
    // Instrument begrenzt: die Kandidaten enthalten ihre vollständigen,
    // serialisierbaren Strategiedaten; Multi-Asset-Replay bleibt unverändert.
    if (Array.isArray(trainingRequest) && trainingRequest.length > 0) {
      if (symbolSet.size !== 1) {
        return NextResponse.json(
          { ok: false, error: "Walk-Forward-API braucht genau ein Instrument in symbols oder den Kandidatenstrategien." },
          { status: 400 }
        );
      }
      const instrumentId = [...symbolSet][0];
      const candles = candlesBySymbol.get(instrumentId) ?? [];
      if (candles.length < 2) {
        return NextResponse.json({ ok: false, error: "DATA_UNAVAILABLE: zu wenige Kerzen für Walk-Forward." }, { status: 422 });
      }
      const holdoutFrom = body.walkforward?.holdoutFrom;
      const holdoutTo = body.walkforward?.holdoutTo;
      if ((holdoutFrom === undefined) !== (holdoutTo === undefined)) {
        return NextResponse.json({ ok: false, error: "holdoutFrom und holdoutTo müssen gemeinsam gesetzt werden." }, { status: 400 });
      }
      let finalHoldout: { candles: CandleLike[]; from: number; to: number } | undefined;
      if (typeof holdoutFrom === "number" && typeof holdoutTo === "number") {
        if (!Number.isFinite(holdoutFrom) || !Number.isFinite(holdoutTo) || holdoutFrom <= (candles[candles.length - 1]?.time ?? 0) || holdoutTo <= holdoutFrom) {
          return NextResponse.json({ ok: false, error: "Finaler Holdout muss nach dem Walk-Forward-Zeitraum liegen." }, { status: 400 });
        }
        const holdoutHistory = store.query({ instrumentId, timeframe, from: holdoutFrom, to: holdoutTo });
        finalHoldout = {
          candles: holdoutHistory.map((h) => ({ time: h.ts, open: h.open, high: h.high, low: h.low, close: h.close, volume: h.volume })),
          from: holdoutFrom,
          to: holdoutTo,
        };
      }
      const report = runWalkForward({
        instrumentId,
        timeframe,
        candles,
        strategies,
        candidates: trainingRequest,
        selection: body.walkforward?.selection,
        seed: body.walkforward?.seed,
        leakage: { purgeBars: body.walkforward?.purgeBars, embargoBars: body.walkforward?.embargoBars },
        finalHoldout,
        ruleRef: { ruleId: null, ruleKey: null, name: "API train-select-freeze", signature: "api-training", ruleSymbol: instrumentId },
        engineConfig: { ...config, executionModel: "paper" },
      });
      return NextResponse.json({
        ok: true,
        timeframe,
        symbols: report.instrumentId ? [report.instrumentId] : [],
        strategiesCount: trainingRequest.length,
        result: report,
        selection: report.training
          ? { freezes: report.training.freezes, finalDecision: report.training.finalDecision, holdout: report.training.holdout ?? null }
          : null,
      });
    }

    // 6. Bestehender Multi-Asset-Replay-Pfad (unverändert, additiv kompatibel).
    const result = runMultiAssetBacktest({ candlesBySymbol, strategies, config });

    return NextResponse.json({
      ok: true,
      timeframe,
      symbols: result.symbols,
      strategiesCount: strategies.length,
      result,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: publicErrorMessage(e) }, { status: 500 });
  }
}
