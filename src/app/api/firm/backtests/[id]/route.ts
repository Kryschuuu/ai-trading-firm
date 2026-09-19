import { NextResponse } from "next/server";
import { requirePermission } from "@/auth";
import { getBacktestRun, validateRunId } from "@/backtest/runStore";

export const dynamic = "force-dynamic";

/**
 * EINEN Walk-Forward-Run lesen (GAP-01, v1.51.0).
 *
 * Liefert die vollständige Run-Zeile (`paramsJson`, `metricsJson`,
 * `windowsJson`) per UUID. SEC-02-Muster: `firm.read` erforderlich,
 * no-store, reines Lesen (kein POST-Endpunkt — Runs entstehen via CLI).
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

  try {
    const run = await getBacktestRun(checked.id);
    if (!run) {
      return NextResponse.json(
        { ok: false, error: "BACKTEST_RUN_NOT_FOUND" },
        { status: 404, headers: { "Cache-Control": "private, no-store" } }
      );
    }
    return NextResponse.json(
      { ok: true, run },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: "BACKTEST_RUNS_UNAVAILABLE",
        message: e instanceof Error ? e.message : String(e),
        hint: "PostgreSQL prüfen oder `npx drizzle-kit push` ausführen (backtest_runs).",
      },
      { status: 503 }
    );
  }
}
