/**
 * API-Route `GET /api/firm/backtests/[id]` — Persistierter Backtest-Run (Lese-API, Detail).
 *
 * Teil der Firm-API (Next.js App Router). Autorisierung: requirePermission("firm.read") — Auth-Modell und RBAC: docs/security/README.md.
 */

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
 * EINEN Walk-Forward-Run lesen (GAP-01, v1.51.0; Trade-Ledger RMA-P1-04,
 * v1.52.0).
 *
 * Liefert die vollständige Run-Zeile (`paramsJson`, `metricsJson`,
 * `windowsJson`) per UUID — additiv ergänzt um
 *   - `ledger`: Status des Trade-Ledgers (`RECONCILED` | `UNAVAILABLE` für
 *     Alt-Runs), `tradeCount` (`null` = nicht persistiert, nie 0),
 *     Idempotency-Key und Abgleich-Evidenz;
 *   - `trades`: die ERSTE Seite der Trade-Zeilen (Keyset-Paging über `seq`,
 *     hartes Limit 500, Default 100) mit `nextCursor`. Dieselben Query-
 *     Parameter wie `GET /api/firm/backtests/[id]/trades`
 *     (`limit`, `cursor`, `segment`, `window`, `symbol`, `side`,
 *     `exitReason`); Folgeseiten holt man über die Trades-Route
 *     (`links.trades`), damit die Run-Zeile nicht je Seite erneut übertragen
 *     wird.
 *
 * SEC-02-Muster: `firm.read` erforderlich, no-store, reines Lesen (kein
 * POST-Endpunkt — Runs entstehen via CLI). Ungültige Query ⇒ 400 vor jedem
 * DB-Zugriff.
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
  const url = new URL(req.url);
  const tradeQuery = tradePageQueryFromUrl(url);
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
    const trades =
      ledger.status === "RECONCILED"
        ? await listBacktestTrades(checked.id, tradeQuery.query)
        : emptyTradePage(tradeQuery.query);
    return NextResponse.json(
      {
        ok: true,
        run,
        ledger,
        trades,
        links: { trades: `/api/firm/backtests/${checked.id}/trades` },
      },
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
