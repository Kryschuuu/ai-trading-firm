import { NextResponse } from "next/server";
import { runMacroCycle, macroCycleStatus } from "@/lib/macroCycle";
import { guardWrite } from "@/lib/apiAuth";
import { publicErrorMessage } from "@/lib/secrets";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Makro-Zyklus (CEO + Research): erzeugt Version um Version das Regelwerk.
 *
 * POST → Zyklus jetzt ausführen (sonst übernimmt das der Scheduler im
 *        MACRO_CYCLE_INTERVAL_MIN-Takt).
 * GET  → Status (busy, letzter Lauf, letztes Ergebnis).
 */
export async function GET() {
  return NextResponse.json({ ok: true, ...macroCycleStatus() });
}

export async function POST(req: Request) {
  const denied = guardWrite(req);
  if (denied) return denied;
  try {
    const body = (await req.json().catch(() => ({}))) as { missionId?: string };
    const result = await runMacroCycle({ missionId: body.missionId });
    return NextResponse.json({ ok: result.ok, cycle: result }, { status: result.ok ? 200 : 422 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: publicErrorMessage(e) }, { status: 500 });
  }
}
