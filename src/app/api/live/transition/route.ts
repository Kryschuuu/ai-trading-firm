/**
 * `POST /api/live/transition` — Übergang der Live-Gate-State-Machine (Task 11,
 * gehärtet ASA-02).
 *
 * EINZIGER HTTP-Weg, den Gate-Zustand zu ändern (kein UI-/Prompt-Bypass):
 *   Body: { venue, to, reason?, confirm?, approvedBy?, approvalId? }
 *     - to: Zielzustand aus der 9-Zustände-Matrix (nur legale Übergänge)
 *     - reason: Pflicht (min 8 Zeichen) für LIVE_PENDING/HUMAN_APPROVED/LIVE_ENABLED
 *     - confirm: true Pflicht für das Human-Gate und LIVE_ENABLED
 *     - approvedBy: nur noch Anzeigelabel (ASA-02: autorisiert NICHTS mehr)
 *     - approvalId: Token aus Schritt 1 (`FOUR_EYES_PENDING`) für Schritt 2
 *
 * ASA-02: Die Route reicht den serverseitig verifizierten Principal-Fingerprint
 * (`resolveAuth(req).principal`) an den Service weiter. Bei aktivem
 * `LIVE_GATE_FOUR_EYES` gilt ein 2-Request-/2-Principal-Verfahren: Der erste
 * Request liefert 409 `FOUR_EYES_PENDING` inkl. `approvalId`/`expiresAt`, der
 * zweite MUSS von einem ANDEREN authentifizierten Principal kommen. Im
 * `local-open`-Modus sind Live-Freigaben fail-closed (403).
 *
 * Sicherheit: Permission `live.gate` (Admin exklusiv), CSRF (x-csrf-token),
 * Rate-Limit (Credential-Limiter 5/min/IP). Jede Entscheidung (auch Deny)
 * landet in der hash-verketteten Live-Gate-Audit-Kette.
 */
import { actorAuditId, requirePermission, resolveAuth } from "@/auth";
import type { Principal } from "@/auth";
import { checkCredentialRateLimit, checkCsrfGuard } from "@/brokers/control-plane/guard";
import { readJsonBody } from "@/brokers/control-plane/http";
import { getLiveGateService } from "@/live-gate";
import { LiveGateError, liveGateErrorStatus } from "@/live-gate";
import { publicErrorMessage } from "@/lib/secrets";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  // Auth (live.gate) → CSRF → Rate-Limit (5/min/IP — derselbe Limiter wie
  // Credentials: Gate-Operationen sind genauso sensibel).
  const auth = resolveAuth(req);
  const denied = requirePermission(req, "live.gate") ?? checkCsrfGuard(req) ?? checkCredentialRateLimit(req);
  if (denied) return denied;

  try {
    const body = (await readJsonBody(req)) as Record<string, unknown>;
    const service = getLiveGateService();
    // Permission-Guard ist durchgelaufen ⇒ Auflösung ist erfolgreich.
    const principal: Principal | null = auth.ok ? auth.principal : null;
    const result = await service.transition({
      venue: typeof body.venue === "string" ? body.venue : "",
      to: typeof body.to === "string" ? body.to : "",
      actor: principal ? actorAuditId(principal) : "unknown",
      reason: typeof body.reason === "string" ? body.reason : undefined,
      confirm: body.confirm === true,
      approvedBy: typeof body.approvedBy === "string" ? body.approvedBy : undefined,
      principalId: principal?.id,
      principalDistinct: principal?.distinct ?? false,
      approvalId: typeof body.approvalId === "string" ? body.approvalId : undefined,
    });
    return Response.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof LiveGateError) {
      const status = liveGateErrorStatus(err.code);
      return Response.json(
        {
          ok: false,
          error: err.code,
          message: status >= 500 ? publicErrorMessage(err) : err.message,
          // ASA-02: approvalId/expiresAt der Erstfreigabe für Schritt 2.
          ...(err.details ?? {}),
        },
        { status, headers: { "Cache-Control": "private, no-store" } }
      );
    }
    return Response.json(
      {
        ok: false,
        error: "LIVE_GATE_TRANSITION_FAILED",
        message: publicErrorMessage(err, "Transition fehlgeschlagen"),
      },
      { status: 500 }
    );
  }
}
