import { NextResponse } from "next/server";
import { db } from "@/db";
import { killSwitches, missions } from "@/db/schema";
import { eq } from "drizzle-orm";
import { killSwitch } from "@/lib/riskGuard";
import { flattenAll, invalidateBrokerCache, logAudit } from "@/lib/engine";
import { guardWrite } from "@/lib/apiAuth";
import { actorAuditId, requirePermission } from "@/auth";
import { checkCsrfGuard } from "@/brokers/control-plane/guard";
import { consumeDisarmNonce } from "@/lib/disarmChallenge";

export const dynamic = "force-dynamic";

/** Antwort auf fehlerhafte Disarm-Versuche (403, kein Disarm). */
function disarmDenied(error: string, hint: string): Response {
  return Response.json({ ok: false, error, hint }, { status: 403 });
}

/**
 * Not-Halt der gesamten Firma.
 *
 *   { "arm": true,  "flatten": true }  → Kill-Switch ziehen und alles glattstellen
 *   { "arm": false, "nonce": "…" }     → entschärfen (Befund C3, v1.36.15)
 *
 * C3 (Guard-Split): **Arm** geht wie bisher durch `guardWrite(req)`
 * (Operator-Token reicht — Scharfschalten in den sicheren Zustand ist keine
 * Eskalation). **Disarm** (Rückkehr aus dem sicheren Zustand) verlangt:
 *   1. ADMIN-Permission  `live.gate`  (`requirePermission`)
 *   2. CSRF-Header       `x-csrf-token` (`checkCsrfGuard`)
 *   3. gültiger Nonce    aus `GET /api/firm/kill/challenge` — existiert,
 *      nicht abgelaufen (<= 60 s) und single-use (nicht wiederverwendet)
 * Erst danach wird disarmed und ein CRITICAL-Audit mit Actor + Nonce geschrieben.
 * Ein gestohlenes Operator-Token kann damit den Not-Halt NICHT mehr still aufheben.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    arm?: boolean;
    reason?: string;
    flatten?: boolean;
    nonce?: string;
  };
  const arm = body.arm === true;

  if (arm) {
    // Arm: unverändert Operator-tauglich (guardWrite).
    const denied = guardWrite(req);
    if (denied) return denied;
    const reason = body.reason ?? "MANUAL_OPERATOR";
    killSwitch.pull(reason);
    await db.insert(killSwitches).values({ reason, triggeredBy: "OPERATOR", armed: true });
    await logAudit("KILL_SWITCH", "CRITICAL", { reason, flatten: body.flatten === true });

    let closed = 0;
    if (body.flatten) {
      const fills = await flattenAll(reason);
      closed = fills.length;
    }
    return NextResponse.json({ ok: true, killSwitchArmed: true, closedPositions: closed });
  }

  // ── Disarm (C3): ADMIN + CSRF + Nonce ───────────────────────────────────
  const denied = requirePermission(req, "live.gate") ?? checkCsrfGuard(req);
  if (denied) return denied;

  const nonce = typeof body.nonce === "string" ? body.nonce.trim() : "";
  const consume = consumeDisarmNonce(nonce);
  if (consume === "missing")
    return disarmDenied(
      "NONCE_REQUIRED",
      "Disarm erfordert einen Nonce aus GET /api/firm/kill/challenge."
    );
  if (consume === "expired")
    return disarmDenied("NONCE_EXPIRED", "Disarm-Nonce abgelaufen (max. 60 s). Bitte neuen holen.");
  if (consume === "reused")
    return disarmDenied("NONCE_REUSED", "Disarm-Nonce wurde bereits verwendet (single-use).");

  const reason = body.reason ?? "OPERATOR_DISARM";
  const actor = actorAuditId(req);
  killSwitch.disarm();
  await db.insert(killSwitches).values({ reason, triggeredBy: "OPERATOR", armed: false });
  // Gestoppte Missionen wieder in den Wartezustand versetzen.
  await db
    .update(missions)
    .set({ status: "PENDING", updatedAt: new Date() })
    .where(eq(missions.status, "KILLED"));
  invalidateBrokerCache();
  await logAudit("KILL_SWITCH_DISARMED", "CRITICAL", { reason, actor, nonceId: nonce });

  return NextResponse.json({ ok: true, killSwitchArmed: false });
}
