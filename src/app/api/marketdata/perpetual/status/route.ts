/**
 * `GET /api/marketdata/perpetual/status` (RMA-P2-02, v1.54.0) — read-only.
 *
 * Betriebsbild der Perp-Daten: Gates, Venue-Capabilities (warum liefert eine
 * Venue keine Liquidationen?), Grenzen, Abdeckung je Reihe, Wasserstände,
 * letzte Läufe und der Quality-Report-Kopf. Identische Daten wie
 * `npm run perp:sync -- --status` — ein Lesepfad, zwei Zugänge.
 *
 * Antwort 200:
 * ```json
 * {
 *   "ok": true,
 *   "status": {
 *     "enabled": false, "syncEnabled": false,
 *     "availabilityPolicy": "ingested", "qualityMode": "log",
 *     "venues": [{ "venue": "BITUNIX", "adapterReady": false,
 *                  "skippedReason": "SYNC_DISABLED",
 *                  "capabilities": { "funding": { "supported": true, … },
 *                                    "openInterest": { "supported": false,
 *                                      "reason": "NO_PUBLIC_ENDPOINT", … } } }],
 *     "store": { "status": "ready", "dbConfigured": true },
 *     "coverage": [{ "venue": "BITUNIX", "kind": "funding", "rows": 2160, … }],
 *     "quality": { "mode": "log", "writtenAt": null, "totals": null }
 *   }
 * }
 * ```
 * Erreichbarkeit der Ablage ist hier **Teil der Antwort**
 * (`store.status = "unavailable"` + `message`), kein 500: die Route ist die
 * Diagnose, nicht der Datenpfad. Der as-of-Datenpfad (`/series`) wirft dagegen
 * 503, statt leer zu antworten.
 */
import { publicErrorMessage } from "@/lib/secrets";
import { getPerpDataService } from "@/perpdata/service";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const status = await getPerpDataService().status();
    return Response.json({ ok: true, status }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    return Response.json(
      {
        ok: false,
        error: "perp:status_unavailable",
        message: publicErrorMessage(e),
        hint: "Service-Diagnose fehlgeschlagen — DATABASE_URL und Universe-Registry prüfen.",
      },
      { status: 500, headers: { "Cache-Control": "private, no-store" } }
    );
  }
}
