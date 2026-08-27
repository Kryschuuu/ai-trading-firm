/**
 * `GET /api/brokers` — Broker-Übersicht (Task 02).
 *
 * Liefert für jedes der 7 Venues: id, label/assets, Capabilities (Single
 * Source of Truth = Adapter), projizierte Registry-Flags (paperAvailable/
 * liveAvailable), verfügbare Execution-Modi und den (lokalen) Health-Status.
 *
 * SICHERHEIT:
 *   - Rein lesend ⇒ kein API-Token erforderlich (konsistent mit den übrigen
 *     GET-Endpunkten).
 *   - KEIN Remote-Health-Check: die Remote-Prüfung ist Default OFF
 *     (`BROKER_HEALTHCHECK_REMOTE`) und gehört zum Einzel-Endpunkt
 *     `GET /api/brokers/{venue}/health`.
 *   - Fehler-Contract: `{ ok:false, error, message }` (message redigiert).
 *
 * Antwort 200:
 * ```json
 * {
 *   "ok": true, "count": 7,
 *   "brokers": [{
 *     "id": "PAPER", "label": "Interner Paper-Broker", "assets": "…",
 *     "capabilities": { "discovery": true, … "stopAtVenue": false },
 *     "paperAvailable": true, "liveAvailable": false,
 *     "executionModes": { "backtest": {"available": true}, … },
 *     "health": { "status": "online", "latencyMs": 0, "details": { … } }
 *   }],
 *   "remoteHealthCheck": { "enabled": false, "flag": "BROKER_HEALTHCHECK_REMOTE" }
 * }
 * ```
 */
import { BROKER_REGISTRY } from "@/lib/broker";
import { publicErrorMessage } from "@/lib/secrets";
import { BROKER_VENUE_IDS, type BrokerVenueId } from "@/contracts/broker";
import { availableExecutionModes } from "@/brokers/capabilities";
import { createAdapter } from "@/brokers/factory";
import { REMOTE_HEALTHCHECK_FLAG, remoteHealthCheckEnabled } from "@/brokers/health";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const brokers = await Promise.all(
      BROKER_VENUE_IDS.map(async (id: BrokerVenueId) => {
        const adapter = createAdapter(id, "paper");
        let health: Awaited<ReturnType<typeof adapter.healthCheck>>;
        try {
          health = await adapter.healthCheck();
        } catch (e) {
          // Health-Check darf die Übersicht nie sprengen.
          health = {
            status: "offline" as const,
            latencyMs: 0,
            details: { error: publicErrorMessage(e, "Health-Check fehlgeschlagen") },
          };
        }
        const entry = BROKER_REGISTRY[id];
        return {
          id,
          label: entry.label,
          assets: entry.assets,
          capabilities: adapter.capabilities,
          /** Projektion aus den Adapter-Capabilities (SSoT = Adapter). */
          paperAvailable: entry.paperAvailable,
          liveAvailable: entry.liveAvailable,
          executionModes: availableExecutionModes(id),
          health,
        };
      })
    );

    return Response.json({
      ok: true,
      count: brokers.length,
      brokers,
      remoteHealthCheck: {
        enabled: remoteHealthCheckEnabled(),
        flag: REMOTE_HEALTHCHECK_FLAG,
      },
    });
  } catch (e) {
    return Response.json(
      { ok: false, error: "INTERNAL_ERROR", message: publicErrorMessage(e) },
      { status: 500 }
    );
  }
}
