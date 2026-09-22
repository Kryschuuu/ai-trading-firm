import { NextResponse } from "next/server";
import {
  getDrawdownScalingStatus,
  updateDrawdownScaling,
} from "@/lib/drawdownScaling";
import { guardWrite } from "@/lib/apiAuth";
import { publicErrorMessage } from "@/lib/secrets";

export const dynamic = "force-dynamic";

/**
 * Observability-Endpunkt des hysteretischen Drawdown-Risk-Scalings
 * (RMA-P5-04, v1.68.0) — gedacht für Agenten und Monitoring-Systeme.
 *
 * Antwort (GET):
 *   mode                 off | monitor | active (effektiv, Env × dsp.enabled)
 *   active               true nur wenn mode = active (Faktor und PAUSE wirken)
 *   paused               true = neue Einstiege blockiert (Stufe PAUSE)
 *   stage                NORMAL | SOFT | DEEP | PAUSE
 *   status               BOOTSTRAP | OK | CONSERVATIVE (letzte Bewertung)
 *   reasonCode/reason    geschlossener Grund-Code + Begründung
 *   equity               beobachtete (reconcile) Equity (null = unbekannt)
 *   hwm                  cashflow-bereinigter High-Water-Mark (persistiert)
 *   drawdownPct          Drawdown ∈ [0,1] (null = unbekannt — nie still 0)
 *   appliedFactor        angewendeter Faktor (1 = neutral, hart ≤ 1)
 *   prevFactor           Faktor des Schritts zuvor
 *   targetFactor         Kurvenwert vor der Hysterese (null bei fail-closed)
 *   cashflow             { detected, cumulative, verification } je Bewertung
 *   policyVersion        `ddp1:<sha256>` — Policyänderung ⇒ neue Version
 *   lastTransition       BOOTSTRAP | NONE | DEGRADE | RECOVER
 *   lastUpdate/lastError ISO-Zeitstempel + letzter Fehler
 *   stale                true wenn letzte Bewertung > 15 min alt
 *   reconciliation       Gate (Zeitpunkt + clean)
 *   config/bounds        aktive Policy + erlaubtes Fenster
 *   riskBudget           Basis vs. wirksames maxRiskPerTrade (volle Kaskade)
 *
 * Dauerhafte Historie: Tabelle `drawdown_scaling_snapshots` (append-only,
 * idempotent) + Audit-Log-Events `RISK_DRAWDOWN_SCALING`.
 */
export async function GET() {
  const status = getDrawdownScalingStatus();
  return NextResponse.json({
    ok: true,
    drawdownScaling: status,
    hint:
      status == null
        ? "Noch keine Bewertung erfolgt — der Monitor-Tick (60 s) oder ein POST hier starten sie."
        : "POST mit {force:true} erzwingt eine sofortige Neubewertung.",
  });
}

/**
 * Sofortige Neubewertung (z. B. nach Schwellwert-Änderung).
 * Schreibend → Token + Rate-Limit wie die anderen mutierenden Endpunkte.
 */
export async function POST(req: Request) {
  const denied = guardWrite(req);
  if (denied) return denied;
  try {
    const body = (await req.json().catch(() => ({}))) as { force?: boolean };
    const status = await updateDrawdownScaling({ force: body.force !== false });
    return NextResponse.json({ ok: true, drawdownScaling: status });
  } catch (e) {
    return NextResponse.json({ ok: false, error: publicErrorMessage(e) }, { status: 500 });
  }
}
