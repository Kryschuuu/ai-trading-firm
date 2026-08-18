import { NextResponse } from "next/server";
import { ensureSeeded } from "@/lib/seed";
import { killSwitch } from "@/lib/riskGuard";

export const dynamic = "force-dynamic";

export async function POST() {
  await ensureSeeded();
  return NextResponse.json({
    ok: true,
    seeded: true,
    killSwitchArmed: killSwitch.isArmed(),
  });
}
