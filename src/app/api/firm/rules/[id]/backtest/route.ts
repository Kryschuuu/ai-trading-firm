import { NextResponse } from "next/server";
import { getRule, rowToSpec, saveBacktest } from "@/lib/ruleService";
import { backtestRule } from "@/lib/ruleEngine";
import { getCandles, sanitizeInterval } from "@/lib/marketData";
import { guardWrite } from "@/lib/apiAuth";
import { publicErrorMessage } from "@/lib/secrets";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Deterministischer Backtest einer Regel gegen historische Kerzen (KEIN LLM).
 *
 * Signal am Kerzenschluss, Einstieg zum Schlusskurs, Stop/Take-Profit über
 * Folgekerzen (Stop bei Gleichzeitigkeit zuerst). Das Ergebnis wird in
 * `rule_backtests` gespeichert und im Antwortobjekt zurückgegeben — die
 * Entscheidung „live gehen oder nicht“ trifft das Review-Gate, nie die Regel.
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

    const body = (await req.json().catch(() => ({}))) as {
      interval?: string;
      limit?: number;
      startingEquity?: number;
      warmup?: number;
    };
    const spec = rowToSpec(rule);
    const interval = sanitizeInterval(body.interval, spec.window.timeframe);
    const limit = Math.min(Math.max(Number(body.limit ?? 300) || 300, 60), 1000);

    const candles = await getCandles(spec.symbol, interval, limit);
    if (candles.length < 40) {
      return NextResponse.json(
        { ok: false, error: `Zu wenige historische Kerzen für ${spec.symbol} (${candles.length})` },
        { status: 422 }
      );
    }

    const result = backtestRule(spec, candles, {
      startingEquity: Number(body.startingEquity ?? 10_000),
      warmup: Number(body.warmup ?? 30),
    });
    await saveBacktest(rule.id, result);

    return NextResponse.json({
      ok: true,
      rule: { id: rule.id, name: rule.name, version: rule.version, symbol: rule.symbol },
      interval,
      candles: candles.length,
      result,
      note:
        "Papier-Referenz-Backtest: Signal am Kerzenschluss, Stop-Vorrang bei Gleichzeitigkeit. " +
        "Keine Anlageberatung; vor Live-Aktivierung Peer-Review (siehe HANDBUCH Kap. 18).",
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: publicErrorMessage(e) }, { status: 500 });
  }
}
