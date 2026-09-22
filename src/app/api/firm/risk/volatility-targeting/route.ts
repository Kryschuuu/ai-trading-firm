import { NextResponse } from "next/server";
import {
  getVolatilityTargetingStatus,
  updateVolatilityTargeting,
} from "@/lib/volatilityTargeting";
import { guardWrite } from "@/lib/apiAuth";
import { publicErrorMessage } from "@/lib/secrets";

export const dynamic = "force-dynamic";

/**
 * Observability-Endpunkt des Portfolio-Volatility-Targetings (RMA-P5-01,
 * v1.67.0) — gedacht für Agenten und Monitoring-Systeme.
 *
 * Antwort (GET):
 *   mode                   off | monitor | active (effektiv, Env × vtp.enabled)
 *   active                 true nur wenn mode = active (Faktor wirkt)
 *   timeframe              Forecast-Timeframe (z. B. "1h")
 *   targetAnnualizedVol    konfiguriertes Ziel (dezimal, 0.30 = 30 % p. a.)
 *   forecast               letzter Forecast:
 *                          status (OK|FALLBACK|NO_EXPOSURE), reasonCode,
 *                          reason, forecastAnnualizedVol (null ≠ 0),
 *                          coverage, observations, eventTime, regularization
 *   rawMultiplier          letzter roher Faktor (null bei Fallback)
 *   appliedMultiplier      letzter angewendeter Faktor (1 = neutral, ≤ 1)
 *   prevMultiplier         Faktor des Schritts zuvor
 *   realizedAnnualizedVol  realisierte Portfolio-Volatilität (null = n/v)
 *   targetError            realisiert − Ziel (null = n/v)
 *   lastUpdate / lastError ISO-Zeitstempel + letzter Fehler
 *   stale                  true wenn letzte Bewertung > 10 min alt
 *   config / bounds        aktive Konfiguration + erlaubtes Fenster
 *
 * Dauerhafte Historie: Tabelle `volatility_targeting_snapshots`
 * (append-only, idempotent) + Audit-Log-Events `RISK_VOL_TARGETING`.
 */
export async function GET() {
  const status = getVolatilityTargetingStatus();
  return NextResponse.json({
    ok: true,
    volatilityTargeting: status,
    hint:
      status == null
        ? "Noch keine Bewertung erfolgt — der Monitor-Tick (5 min) oder ein POST hier starten sie."
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
    const status = await updateVolatilityTargeting({ force: body.force !== false });
    return NextResponse.json({ ok: true, volatilityTargeting: status });
  } catch (e) {
    return NextResponse.json({ ok: false, error: publicErrorMessage(e) }, { status: 500 });
  }
}
