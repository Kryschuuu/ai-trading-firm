/**
 * `POST /api/live/kill` — KILL-SWITCH der Live-Gate-Machine (Task 11).
 *
 * Wirkt aus JEDEM Zustand, sofort: prozesslokale Sperre → persistente
 * Failsafe-Datei → State-Reset auf DISCONNECTED → Audit (hash-verkettet).
 *
 *   Body (ziehen):  { venue? | scope?, reason, confirm: "KILL" }
 *   Body ( cleared): { action: "clear", scope?, reason, confirm: "CLEAR_KILL" }
 *
 * Die Bestätigung ist SERVERSEITIG erzwungen: `confirm` muss exakt die
 * Phrase "KILL" enthalten (der UI-Confirm-Dialog lässt den Operator die
 * Phrase tippen; ein einfaches `confirm:true` reicht bewusst NICHT).
 * Clear entfernt die Sperre — der Zustand bleibt DISCONNECTED, ein
 * kompletter Neudurchlauf (8 Übergänge inkl. Human-Gate) ist erforderlich.
 *
 * Sicherheit: Permission `live.gate`, CSRF, Rate-Limit. CLI-Notfallpfad:
 * `npm run live:kill -- --venue=BITUNIX` (lokal, ohne HTTP).
 */
import { actorAuditId, requirePermission } from "@/auth";
import { checkCredentialRateLimit, checkCsrfGuard } from "@/brokers/control-plane/guard";
import { readJsonBody } from "@/brokers/control-plane/http";
import { getLiveGateService } from "@/live-gate";
import { LiveGateError, liveGateErrorStatus } from "@/live-gate";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const denied = requirePermission(req, "live.gate") ?? checkCsrfGuard(req) ?? checkCredentialRateLimit(req);
  if (denied) return denied;

  try {
    const body = (await readJsonBody(req)) as Record<string, unknown>;
    const service = getLiveGateService();
    const reason = typeof body.reason === "string" ? body.reason : undefined;
    const confirm = typeof body.confirm === "string" ? body.confirm : undefined;
    const scope = typeof body.scope === "string" ? body.scope : undefined;
    const venue = typeof body.venue === "string" ? body.venue : undefined;
    const actor = actorAuditId(req);

    if (body.action === "clear") {
      const result = await service.clearKill({ scope, actor, reason, confirm });
      return Response.json(result, { status: 200 });
    }

    const result = await service.kill({ venue, scope, actor, reason, confirm });
    return Response.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof LiveGateError) {
      return Response.json(
        { ok: false, error: err.code, message: err.message },
        { status: liveGateErrorStatus(err.code) }
      );
    }
    return Response.json(
      {
        ok: false,
        error: "LIVE_GATE_KILL_FAILED",
        message: `Kill-Switch-Aktion fehlgeschlagen: ${(err as Error).message}`,
      },
      { status: 500 }
    );
  }
}
