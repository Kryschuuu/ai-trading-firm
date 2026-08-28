/**
 * `GET /api/live/state` — Zustand der Live-Trading-State-Machine (Task 11).
 *
 * Read-only: Zustand je Venue (9 Gate-States), Flags, Cooldown-Restzeit,
 * Suite-Stamp, Kill-Switch-Status, Audit-Kettenkopf + Integrität + letzte
 * Einträge. KEINE Mutation, kein Token erforderlich (konsistent mit den
 * übrigen GET-Status-Endpoints; Mutations-Routen sind admin-guarded).
 *
 * Diese Route SCHALTET KEIN LIVE EIN — reine Projektion der Machine.
 */
import { getLiveGateService } from "@/live-gate";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const service = getLiveGateService();
    return Response.json(service.overview(), { status: 200 });
  } catch (err) {
    return Response.json(
      {
        ok: false,
        error: "LIVE_GATE_UNAVAILABLE",
        message: `Live-Gate-Zustand nicht lesbar: ${(err as Error).message}`,
      },
      { status: 500 }
    );
  }
}
