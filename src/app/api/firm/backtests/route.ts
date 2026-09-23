/**
 * API-Route `GET /api/firm/backtests` — Persistierte Backtest-Runs (Lese-API, Liste).
 *
 * Teil der Firm-API (Next.js App Router). Autorisierung: requirePermission("firm.read") — Auth-Modell und RBAC: docs/security/README.md.
 */

import { NextResponse } from "next/server";
import { requirePermission } from "@/auth";
import { listBacktestRuns, validateRunsLimit } from "@/backtest/runStore";

export const dynamic = "force-dynamic";

/**
 * Walk-Forward-Runs lesen (GAP-01, v1.51.0).
 *
 * Listet vergleichbar persistierte Backtest-Runs (`backtest_runs`),
 * jüngste zuerst. Query: `?limit=1..100` (Default 20).
 *
 * SEC-02-Muster: sensibler Dashboard-Read — `firm.read` erforderlich,
 * no-store. Reines Lesen — Runs entstehen NUR via CLI
 * (`scripts/run-backtest.ts`); es gibt bewusst keinen POST-Endpunkt.
 */
export async function GET(req: Request) {
  const denied = requirePermission(req, "firm.read");
  if (denied) return denied;

  const url = new URL(req.url);
  const checked = validateRunsLimit(url.searchParams.get("limit"));
  if (!checked.ok) {
    return NextResponse.json(
      { ok: false, error: checked.error },
      { status: 400, headers: { "Cache-Control": "private, no-store" } }
    );
  }

  try {
    const runs = await listBacktestRuns(checked.limit);
    return NextResponse.json(
      { ok: true, runs },
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
