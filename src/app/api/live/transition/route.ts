/**
 * `POST /api/live/transition` — Übergang der Live-Gate-State-Machine (Task 11).
 *
 * EINZIGER HTTP-Weg, den Gate-Zustand zu ändern (kein UI-/Prompt-Bypass):
 *   Body: { venue, to, reason?, confirm?, approvedBy? }
 *     - to: Zielzustand aus der 9-Zustände-Matrix (nur legale Übergänge)
 *     - reason: Pflicht (min 8 Zeichen) für LIVE_PENDING/HUMAN_APPROVED/LIVE_ENABLED
 *     - confirm: true Pflicht für das Human-Gate und LIVE_ENABLED
 *     - approvedBy: benannter Approver (Pflicht im Human-Gate, 4-Augen-verglichen)
 *
 * Sicherheit: Permission `live.gate` (Admin exklusiv), CSRF (x-csrf-token),
 * Rate-Limit (Credential-Limiter 5/min/IP). Jede Entscheidung (auch Deny)
 * landet in der hash-verketteten Live-Gate-Audit-Kette.
 *
 * Fehler: { ok:false, error, message } — 401/403 (Auth), 403 (CSRF),
 * 422 (Validierung), 409 (Matrix/Cooldown/Checks/Flags), 429 (Rate-Limit).
 */
import { actorAuditId, requirePermission } from "@/auth";
import { checkCredentialRateLimit, checkCsrfGuard } from "@/brokers/control-plane/guard";
import { readJsonBody } from "@/brokers/control-plane/http";
import { getLiveGateService } from "@/live-gate";
import { LiveGateError, liveGateErrorStatus } from "@/live-gate";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  // Auth (live.gate) → CSRF → Rate-Limit (5/min/IP — derselbe Limiter wie
  // Credentials: Gate-Operationen sind genauso sensibel).
  const denied = requirePermission(req, "live.gate") ?? checkCsrfGuard(req) ?? checkCredentialRateLimit(req);
  if (denied) return denied;

  try {
    const body = (await readJsonBody(req)) as Record<string, unknown>;
    const service = getLiveGateService();
    const result = await service.transition({
      venue: typeof body.venue === "string" ? body.venue : "",
      to: typeof body.to === "string" ? body.to : "",
      actor: actorAuditId(req),
      reason: typeof body.reason === "string" ? body.reason : undefined,
      confirm: body.confirm === true,
      approvedBy: typeof body.approvedBy === "string" ? body.approvedBy : undefined,
    });
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
        error: "LIVE_GATE_TRANSITION_FAILED",
        message: `Transition fehlgeschlagen: ${(err as Error).message}`,
      },
      { status: 500 }
    );
  }
}
