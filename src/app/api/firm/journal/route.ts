/**
 * API-Route `GET /api/firm/journal` — Trade-Journal mit Agenten-Attribution (Lese-API).
 *
 * Teil der Firm-API (Next.js App Router). Autorisierung: requirePermission("firm.read") — Auth-Modell und RBAC: docs/security/README.md.
 */

import { NextResponse } from "next/server";
import { requirePermission } from "@/auth";
import { computeJournalSummary, registrySymbolGroupResolver } from "@/lib/journalAnalytics";

export const dynamic = "force-dynamic";

/**
 * Trade-Journal-Auswertung (GAP-03, v1.43.0).
 *
 * Trefferquote/Erwartungswert je Agent × Regime × Symbolgruppe mit
 * Beta-Prior-Glättung (α=β=2) und Mindest-Stichprobe
 * (JOURNAL_MIN_TRADES, Default 20); darunter "insufficient-sample" und
 * NIEMALS als Faktor. Enthält außerdem die Gewichts-Rückführung im
 * konfigurierten Modus (off = nur Auswertung, monitor = Vorschläge,
 * enforce = wirksame Gewichte).
 *
 * SEC-02: sensibler Dashboard-Read — `firm.read` erforderlich, no-store.
 * Reines Lesen — dieser Endpunkt verändert nichts (auch nicht die
 * journal_agent_weights-Tabelle; Schreibungen laufen nur im Daily-Cycle).
 */
export async function GET(req: Request) {
  const denied = requirePermission(req, "firm.read");
  if (denied) return denied;

  try {
    const journal = await computeJournalSummary({ symbolGroupOf: registrySymbolGroupResolver() });
    return NextResponse.json(
      { ok: true, journal },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: "JOURNAL_UNAVAILABLE",
        message: e instanceof Error ? e.message : String(e),
        hint: "PostgreSQL prüfen oder `npx drizzle-kit push` ausführen (trade_journal).",
      },
      { status: 503 }
    );
  }
}
