import { NextResponse } from "next/server";
import { requirePermission } from "@/auth";
import { validateRunId } from "@/backtest/runStore";
import { listMonteCarloRuns, validateMonteCarloLimit } from "@/backtest/monteCarloStore";
import { telemetry } from "@/lib/telemetry";

export const dynamic = "force-dynamic";

/**
 * Monte-Carlo-Analysen lesen (RMA-P6-02, v1.72.0).
 *
 * Listet persistierte Trade-Resampling-Analysen (`backtest_monte_carlo_runs`),
 * jüngste zuerst, optional gefiltert nach Quell-Run. Query:
 *   - `?run=<uuid>`  — nur Analysen dieses Walk-Forward-Runs
 *   - `?limit=1..100` (Default 20)
 *
 * Jedes Item ist eine BOUNDED Summary (Quantile, Exceedance-Wahrscheinlich-
 * keiten, Statistik-Hinweise, vollständige Config für Replay) — Rohpfade
 * werden weder gespeichert noch ausgeliefert. Analysen entstehen NUR via CLI
 * (`scripts/run-montecarlo.ts`); es gibt bewusst keinen POST-Endpunkt.
 *
 * SEC-02-Muster: sensibler Research-Read — `firm.read` erforderlich, no-store.
 */
export async function GET(req: Request) {
  const denied = requirePermission(req, "firm.read");
  if (denied) return denied;

  const url = new URL(req.url);
  const limitChecked = validateMonteCarloLimit(url.searchParams.get("limit"));
  if (!limitChecked.ok) {
    return NextResponse.json(
      { ok: false, error: limitChecked.error },
      { status: 400, headers: { "Cache-Control": "private, no-store" } }
    );
  }
  const runRaw = url.searchParams.get("run");
  let sourceRunId: string | undefined;
  if (runRaw !== null && runRaw !== "") {
    const runChecked = validateRunId(runRaw);
    if (!runChecked.ok) {
      return NextResponse.json(
        { ok: false, error: runChecked.error },
        { status: 400, headers: { "Cache-Control": "private, no-store" } }
      );
    }
    sourceRunId = runChecked.id;
  }

  try {
    const analyses = await listMonteCarloRuns({ sourceRunId, limit: limitChecked.limit });
    telemetry.monteCarlo.queries.inc({ result: "ok", route: "list" });
    return NextResponse.json(
      { ok: true, analyses },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  } catch (e) {
    telemetry.monteCarlo.queries.inc({ result: "failed", route: "list" });
    return NextResponse.json(
      {
        ok: false,
        error: "MONTE_CARLO_UNAVAILABLE",
        message: e instanceof Error ? e.message : String(e),
        hint: "PostgreSQL prüfen oder Migration drizzle/2026-09-23_monte_carlo.sql ausführen.",
      },
      { status: 503 }
    );
  }
}
