import { NextResponse } from "next/server";
import { guardWrite } from "@/lib/apiAuth";
import { publicErrorMessage } from "@/lib/secrets";
import { runMultiAssetBacktest, type BacktestEngineOptions, type BacktestStrategyItem } from "@/backtest";
import { HistoricalStore, isSupportedTimeframe, DEFAULT_ANALYSIS_TIMEFRAME } from "@/lib/marketdata/historicalStore";
import { getRule, rowToSpec } from "@/lib/ruleService";
import type { CandleLike } from "@/lib/ruleEngine";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Multi-Asset Backtest API (Task 02).
 *
 * Führt einen synchronisierten Multi-Asset- und Multi-Strategy-Backtest aus:
 * - Entweder über übergebene Regel-IDs (`ruleIds`), Inline-Regeln (`rules`) oder Inline-Setups (`setups`)
 * - Lädt historische Kerzen aus dem `HistoricalStore` (oder nutzt optional übergebene `candles`)
 * - Liefert vollständige Equity-Kurve, Trade-Logs, Portfolio-Metriken und Symbol-/Strategie-Statistiken.
 */
export async function POST(req: Request) {
  const denied = guardWrite(req);
  if (denied) return denied;

  try {
    const body = (await req.json().catch(() => ({}))) as {
      ruleIds?: string[];
      rules?: any[];
      setups?: any[];
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
        const r = body.rules[i];
        if (r && typeof r === "object" && typeof r.symbol === "string") {
          strategies.push({ type: "rule", spec: r, id: r.id ?? `RULE-INLINE-${i + 1}` });
          symbolSet.add(r.symbol);
        }
      }
    }

    // 3. Inline-Setups hinzufügen
    if (Array.isArray(body.setups)) {
      for (let i = 0; i < body.setups.length; i++) {
        const s = body.setups[i];
        if (s && typeof s === "object" && typeof s.instrumentId === "string") {
          strategies.push({ type: "setup", setup: s, id: s.id ?? `SETUP-INLINE-${i + 1}` });
          symbolSet.add(s.instrumentId);
        }
      }
    }

    if (strategies.length === 0) {
      return NextResponse.json(
        { ok: false, error: "Keine gültigen Regeln oder Setups für den Backtest angegeben." },
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

    // 5. Multi-Asset Backtest ausführen
    const result = runMultiAssetBacktest({
      candlesBySymbol,
      strategies,
      config,
    });

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
