/**
 * `GET /api/brokers/coverage` — Broker-Coverage-Übersicht (Operations Center).
 *
 * Trennt bewusst „registrierte Venues" von „tatsächlich abgedeckten Venues":
 * liefert die Headline-Kennzahlen (registriert / volle Discovery / Paper-
 * Market-Data / aktiviertes Live-Trading) sowie die fünf Coverage-Metriken
 * (Discovery / Market Data / Paper / Testnet / Live Execution) und eine
 * Detailtabelle je Venue.
 *
 * SICHERHEIT:
 *   - Rein lesend ⇒ kein API-Token erforderlich (konsistent mit den übrigen
 *     GET-Endpunkten).
 *   - Kein Netzwerk, keine Credentials: reine Projektion aus der Capability-
 *     SSoT + Live-Gate-Enforcer (read-only, audit:false).
 *   - Fehler-Contract: `{ ok:false, error, message }` (message redigiert).
 *
 * Antwort 200:
 * ```json
 * {
 *   "ok": true,
 *   "registeredVenues": 7, "internalVenues": 1, "externalVenues": 6,
 *   "fullDiscoveryVenues": 1, "paperMarketDataVenues": 1, "liveEnabledVenues": 0,
 *   "metrics": [{ "id": "discovery", "label": "Discovery Coverage",
 *                 "covered": 2, "total": 7, "venues": ["PAPER","BITUNIX"] }, …],
 *   "rows": [{ "venue": "PAPER", "label": "…", "internal": true,
 *              "discovery": true, "marketData": true, "paperExecution": true,
 *              "testnetExecution": false, "liveCapable": false,
 *              "liveEnabled": false, "liveReason": "…" }, …]
 * }
 * ```
 */
import { computeBrokerCoverage } from "@/brokers/coverage";
import { publicErrorMessage } from "@/lib/secrets";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const coverage = computeBrokerCoverage();
    return Response.json({ ok: true, ...coverage });
  } catch (e) {
    return Response.json(
      { ok: false, error: "INTERNAL_ERROR", message: publicErrorMessage(e) },
      { status: 500 }
    );
  }
}
