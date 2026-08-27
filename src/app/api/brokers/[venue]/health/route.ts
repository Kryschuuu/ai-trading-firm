/**
 * `GET /api/brokers/{venue}/health` — Health-Check eines einzelnen Brokers
 * (Task 02).
 *
 * READ-ONLY: Der Endpunkt liest nur. Echte Remote-Checks (read-only Public
 * Endpunkte, credential-frei) erfolgen NUR wenn der Betreiber explizit
 * `BROKER_HEALTHCHECK_REMOTE=true` gesetzt hat — Default ist `false` (OFF),
 * dann bleibt der Check vollständig lokal (Stubs: `offline` + Grund,
 * PAPER: `online`).
 *
 * Antworten:
 *   200 `{ ok: true, venue, health, capabilities, executionModes,
 *          remoteHealthCheck: { enabled, flag } }`
 *   404 `{ ok: false, error: "UNKNOWN_VENUE", message }`
 *   500 `{ ok: false, error: "INTERNAL_ERROR", message }` (redigiert)
 *
 * Route-Parameter (Next.js 15+: Promise).
 */
import { publicErrorMessage } from "@/lib/secrets";
import {
  BROKER_VENUE_IDS,
  type BrokerHealth,
} from "@/contracts/broker";
import { availableExecutionModes } from "@/brokers/capabilities";
import { createAdapter, normalizeVenue } from "@/brokers/factory";
import {
  REMOTE_HEALTHCHECK_FLAG,
  remoteHealthCheckEnabled,
} from "@/brokers/health";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ venue: string }> };

/** Handler für `GET /api/brokers/{venue}/health`. */
export async function GET(_req: Request, ctx: RouteContext): Promise<Response> {
  try {
    const raw = await ctx.params;
    const venue = normalizeVenue(decodeURIComponent(raw.venue ?? "").trim());
    if (!venue) {
      const safe = String(raw.venue ?? "").slice(0, 40);
      return Response.json(
        {
          ok: false,
          error: "UNKNOWN_VENUE",
          message: `Unbekanntes Venue: "${safe}" (erlaubt: ${BROKER_VENUE_IDS.join(", ")})`,
        },
        { status: 404 }
      );
    }

    const remote = remoteHealthCheckEnabled();
    const adapter = createAdapter(venue, "paper");

    let health: BrokerHealth;
    try {
      health = await adapter.healthCheck({ remote });
    } catch (e) {
      health = {
        status: "offline",
        latencyMs: 0,
        details: { error: publicErrorMessage(e, "Health-Check fehlgeschlagen") },
      };
    }

    return Response.json({
      ok: true,
      venue,
      health,
      capabilities: adapter.capabilities,
      executionModes: availableExecutionModes(venue),
      remoteHealthCheck: { enabled: remote, flag: REMOTE_HEALTHCHECK_FLAG },
    });
  } catch (e) {
    return Response.json(
      { ok: false, error: "INTERNAL_ERROR", message: publicErrorMessage(e) },
      { status: 500 }
    );
  }
}
