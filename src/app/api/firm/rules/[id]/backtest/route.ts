/**
 * API-Route `POST /api/firm/rules/[id]/backtest` — Regel-Backtest ausführen.
 *
 * Teil der Firm-API (Next.js App Router). Zusätzlich guardWrite (API-Guard).
 * Auth-Modell und RBAC: docs/security/README.md.
 *
 * Default seit v0.2.0: Paper-Fill über den HistoricalStore
 * (`executionModel: "paper"`). `model: "reference"` behält den gebührenfreien
 * `backtestRule`-Pfad. Der Engine-Default bleibt `"legacy"`.
 */

import { NextResponse } from "next/server";
import { getRule, rowToSpec, saveBacktest } from "@/lib/ruleService";
import { executeRuleBacktest, parseRuleBacktestBody } from "@/lib/ruleBacktest";
import { HistoricalStore } from "@/lib/marketdata/historicalStore";
import { historyDir } from "@/lib/marketdata/config";
import { getCandles } from "@/lib/marketData";
import { MarketDataFetchError } from "@/lib/marketDataErrors";
import { guardWrite } from "@/lib/apiAuth";
import { publicErrorMessage } from "@/lib/secrets";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Deterministischer Backtest einer Regel. Der Default bucht Paper-Kosten
 * aus Store-Kerzen. Fehlende Historie ist 422, kein stiller Yahoo-Call.
 * `model=reference` bleibt der gebührenfreie Vergleich und darf Kerzen
 * live laden — der Fehler ist dann 503, nicht eine erfundene Reihe.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = guardWrite(req);
  if (denied) return denied;
  try {
    const { id } = await params;
    const rule = await getRule(id);
    if (!rule) {
      return NextResponse.json({ ok: false, error: "Regel nicht gefunden" }, { status: 404 });
    }

    const parsed = parseRuleBacktestBody(await req.json().catch(() => ({})));
    if (!parsed.ok) {
      return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
    }

    const spec = rowToSpec(rule);
    const run = await executeRuleBacktest({
      spec,
      request: parsed.value,
      store: new HistoricalStore(historyDir()),
      loadReferenceCandles: (symbol, interval, limit) => getCandles(symbol, interval, limit),
    });
    if (!run.ok) {
      return NextResponse.json({ ok: false, error: run.error }, { status: run.status });
    }

    await saveBacktest(rule.id, run.persist);
    return NextResponse.json({
      ...run.body,
      rule: { id: rule.id, name: rule.name, version: rule.version, symbol: rule.symbol, status: rule.status },
    });
  } catch (e) {
    if (e instanceof MarketDataFetchError) {
      return NextResponse.json(
        { ok: false, error: "MARKET_DATA_UNAVAILABLE", reason: e.reason, ...e.toJSON() },
        { status: 503 },
      );
    }
    return NextResponse.json({ ok: false, error: publicErrorMessage(e) }, { status: 500 });
  }
}
