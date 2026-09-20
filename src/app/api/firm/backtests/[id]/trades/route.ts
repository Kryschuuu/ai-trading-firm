import { NextResponse } from "next/server";
import { requirePermission } from "@/auth";
import {
  emptyTradePage,
  getBacktestRun,
  listBacktestTrades,
  runLedgerView,
  tradePageQueryFromUrl,
  validateRunId,
} from "@/backtest/runStore";

export const dynamic = "force-dynamic";

/**
 * Trade-Ledger eines Walk-Forward-Runs, paginiert (RMA-P1-04, v1.52.0).
 *
 * `GET /api/firm/backtests/[id]/trades?limit=1..500&cursor=…&segment=IS|OOS
 *   &window=N&symbol=…&side=LONG|SHORT&exitReason=…`
 *
 * Keyset-Paging über die stabile Sequenz `seq` (Index-Range, kein OFFSET):
 * `nextCursor` ist opak und zeigt auf die Zeile NACH der letzten gelieferten;
 * `null` = letzte Seite. Filter sind geschlossene Mengen bzw. bounded
 * Strings; unbekannte Werte ⇒ 400 (nie stilles Ignorieren). Alt-Runs ohne
 * persistiertes Ledger liefern `ledger.status = "UNAVAILABLE"`,
 * `tradeCount = null` und eine leere Seite — nie „0 Trades“.
 *
 * SEC-02-Muster: `firm.read` erforderlich, no-store, reines Lesen.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = requirePermission(req, "firm.read");
  if (denied) return denied;

  const { id: rawId } = await params;
  const checked = validateRunId(rawId);
  if (!checked.ok) {
    return NextResponse.json(
      { ok: false, error: checked.error },
      { status: 400, headers: { "Cache-Control": "private, no-store" } }
    );
  }
  const tradeQuery = tradePageQueryFromUrl(new URL(req.url));
  if (!tradeQuery.ok) {
    return NextResponse.json(
      { ok: false, error: tradeQuery.error },
      { status: 400, headers: { "Cache-Control": "private, no-store" } }
    );
  }

  try {
    const run = await getBacktestRun(checked.id);
    if (!run) {
      return NextResponse.json(
        { ok: false, error: "BACKTEST_RUN_NOT_FOUND" },
        { status: 404, headers: { "Cache-Control": "private, no-store" } }
      );
    }
    const ledger = runLedgerView(run);
    if (ledger.status !== "RECONCILED") {
      return NextResponse.json(
        {
          ok: true,
          runId: run.id,
          ledger,
          trades: emptyTradePage(tradeQuery.query),
          note: "Run vor v1.52.0 — kein Trade-Ledger persistiert (tradeCount null, nicht 0).",
        },
        { headers: { "Cache-Control": "private, no-store" } }
      );
    }
    const trades = await listBacktestTrades(checked.id, tradeQuery.query);
    return NextResponse.json(
      { ok: true, runId: run.id, ledger, trades },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: "BACKTEST_RUNS_UNAVAILABLE",
        message: e instanceof Error ? e.message : String(e),
        hint: "PostgreSQL prüfen oder `npx drizzle-kit push` ausführen (backtest_runs, backtest_trades).",
      },
      { status: 503 }
    );
  }
}
