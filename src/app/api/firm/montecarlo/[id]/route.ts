/**
 * API-Route `GET /api/firm/montecarlo/[id]` — Monte-Carlo-Analyse (Lese-API, Detail).
 *
 * Teil der Firm-API (Next.js App Router). Autorisierung: requirePermission("firm.read") — Auth-Modell und RBAC: docs/security/README.md.
 */

import { NextResponse } from "next/server";
import { requirePermission } from "@/auth";
import { validateRunId } from "@/backtest/runStore";
import { getMonteCarloRun } from "@/backtest/monteCarloStore";
import { telemetry } from "@/lib/telemetry";

export const dynamic = "force-dynamic";

/**
 * EINE Monte-Carlo-Analyse lesen (RMA-P6-02, v1.72.0).
 *
 * Liefert die vollständige Analysenzeile per UUID: Quell-Run, Methode,
 * Segment, Seed (+ PRNG-Algorithmusversion), Scenario, `config` (vollständige,
 * reproduzierbare Konfiguration — damit kann die CLI den Lauf exakt
 * nachstellen: `scripts/run-montecarlo.ts` mit derselben Config/Seed liefert
 * byte-identische Quantile) und `summary` (bounded: Quantile p05/p50/p95,
 * Exceedance-Wahrscheinlichkeiten, MCSE, Statistik-Hinweise, Caveats — keine
 * Rohpfade). `summary.observed` trennt die empirische Beobachtung von den
 * Resampling-Ergebnissen; `summary.stats.scenario`/`stress` kennzeichnet das
 * Kostenstressszenario.
 *
 * SEC-02-Muster: `firm.read` erforderlich, no-store, reines Lesen (kein POST —
 * Analysen entstehen via CLI). Ungültige UUID ⇒ 400 vor jedem DB-Zugriff.
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
    const analysis = await getMonteCarloRun(checked.id);
    if (!analysis) {
      telemetry.monteCarlo.queries.inc({ result: "not_found", route: "detail" });
      return NextResponse.json(
        { ok: false, error: "MONTE_CARLO_NOT_FOUND", message: `Keine Monte-Carlo-Analyse mit ID ${checked.id}.` },
        { status: 404, headers: { "Cache-Control": "private, no-store" } }
      );
    }
    telemetry.monteCarlo.queries.inc({ result: "ok", route: "detail" });
    return NextResponse.json(
      { ok: true, analysis },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  } catch (e) {
    telemetry.monteCarlo.queries.inc({ result: "failed", route: "detail" });
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
