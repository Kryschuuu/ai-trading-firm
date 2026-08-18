import { NextResponse } from "next/server";
import { db } from "@/db";
import { killSwitches, missions } from "@/db/schema";
import { eq } from "drizzle-orm";
import { killSwitch } from "@/lib/riskGuard";
import { flattenAll, invalidateBrokerCache, logAudit } from "@/lib/engine";

export const dynamic = "force-dynamic";

/**
 * Not-Halt der gesamten Firma.
 *   { "arm": true,  "flatten": true }  → Kill-Switch ziehen und alles glattstellen
 *   { "arm": false }                   → entschärfen, Missionen wieder aktivierbar
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    arm?: boolean;
    reason?: string;
    flatten?: boolean;
  };
  const arm = body.arm === true;
  const reason = body.reason ?? (arm ? "MANUAL_OPERATOR" : "OPERATOR_DISARM");

  if (arm) {
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

  killSwitch.disarm();
  await db.insert(killSwitches).values({ reason, triggeredBy: "OPERATOR", armed: false });
  // Gestoppte Missionen wieder in den Wartezustand versetzen.
  await db
    .update(missions)
    .set({ status: "PENDING", updatedAt: new Date() })
    .where(eq(missions.status, "KILLED"));
  invalidateBrokerCache();
  await logAudit("KILL_SWITCH_DISARMED", "WARN", { reason });

  return NextResponse.json({ ok: true, killSwitchArmed: false });
}
