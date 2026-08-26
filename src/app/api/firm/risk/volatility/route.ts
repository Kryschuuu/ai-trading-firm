import { NextResponse } from "next/server";
import { getAdaptiveRiskStatus, updateAdaptiveRisk } from "@/lib/adaptiveRisk";
import { guardWrite } from "@/lib/apiAuth";
import { publicErrorMessage } from "@/lib/secrets";

export const dynamic = "force-dynamic";

/**
 * Observability-Endpunkt des adaptiven Risk-Limit-Systems — gedacht für
 * Agenten und Monitoring-Systeme (Cron, Health-Checks, Dashboards).
 *
 * Antwort (GET):
 *   regime                     NORMAL | ELEVATED | EXTREME
 *   baseMaxRiskPerTrade        konfiguriertes Basis-Limit (risk_config)
 *   effectiveMaxRiskPerTrade   tatsächlich wirksam (Basis × Faktor)
 *   factor                     aktueller Multiplikator (1 = keine Reduktion)
 *   indicators[]               VIX / ATR / BBW / Return-StdDev:
 *                              value, threshold, available, triggered
 *   events[]                   Ring-Buffer der letzten 50 Trigger-Events
 *                              (wann, warum, welches Limit, welche Trigger)
 *   config / bounds            aktive Schwellwerte + erlaubtes Fenster
 *   lastUpdate / lastChange    ISO-Zeitstempel
 *   stale                      true, wenn die letzte Bewertung > 5 Min alt
 *
 * Dauerhafte Historie: Audit-Log-Events `RISK_ADAPTIVE`
 * (siehe GET /api/firm? → auditLog, bzw. DB-Tabelle audit_log).
 */
export async function GET() {
  const status = getAdaptiveRiskStatus();
  return NextResponse.json({
    ok: true,
    adaptive: status,
    hint:
      status == null
        ? "Noch keine Bewertung erfolgt — der Monitor-Tick (60 s) oder ein POST hier starten sie."
        : "POST mit {force:true} erzwingt eine sofortige Neubewertung.",
  });
}

/**
 * Sofortige Neubewertung (z. B. nach Schwellwert-Änderung oder vor einer
 * kritischen Order). Schreibend → Token + Rate-Limit wie die anderen
 * mutierenden Endpunkte.
 */
export async function POST(req: Request) {
  const denied = guardWrite(req);
  if (denied) return denied;
  try {
    const body = (await req.json().catch(() => ({}))) as { force?: boolean };
    const status = await updateAdaptiveRisk({ force: body.force !== false });
    return NextResponse.json({ ok: true, adaptive: status });
  } catch (e) {
    return NextResponse.json({ ok: false, error: publicErrorMessage(e) }, { status: 500 });
  }
}
