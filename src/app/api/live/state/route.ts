import { privateNoStore } from "@/lib/apiAuth";
import { requirePermission } from "@/auth";
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
import { readAuthoritativeKillSwitch } from "@/lib/killSwitchDb";
import { publicErrorMessage } from "@/lib/secrets";

export const dynamic = "force-dynamic";

export async function GET(req: Request = new Request("http://localhost/api")): Promise<Response> {
  return privateNoStore(await (async () => {
  const denied = requirePermission(req, "firm.read");
  if (denied) return denied;

  try {
    await readAuthoritativeKillSwitch();
    const service = getLiveGateService();
    return Response.json(service.overview(), {
      status: 200,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (err) {
    return Response.json(
      {
        ok: false,
        error: "LIVE_GATE_UNAVAILABLE",
        message: publicErrorMessage(err, "Live-Gate-Zustand nicht lesbar"),
      },
      { status: 500, headers: { "Cache-Control": "private, no-store" } }
    );
  }

  })());
}
