/**
 * `GET /api/marketdata/status` (Task 03) — read-only.
 *
 * Liefert Status der Market-Data-Schicht: aktiver Paper-Modus, aktive
 * Kursquelle, Cache-TTL, letzter Failover, statisches-Fallback-Flag,
 * Failover-Zähler. Fürs Monitoring/Operations.
 *
 * Antwort 200:
 * ```json
 * {
 *   "ok": true,
 *   "status": {
 *     "paperMode": "broker-market-data", "activeSource": "broker:PAPER",
 *     "cacheTtlMs": 30000, "lastFailover": null,
 *     "staticFallbackEnabled": false, "allowSyntheticFallback": false,
 *     "anomalyMaxJumpPct": 50, "staleAfterMs": 30000, "failoverAuditCount": 0
 *   }
 * }
 * ```
 */
import { publicErrorMessage } from "@/lib/secrets";
import { getProductionMarketDataManager } from "@/lib/marketdata/production";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const manager = getProductionMarketDataManager();
    return Response.json({ ok: true, status: manager.status() });
  } catch (e) {
    return Response.json(
      { ok: false, error: "INTERNAL_ERROR", message: publicErrorMessage(e) },
      { status: 500 }
    );
  }
}
