import { NextResponse } from "next/server";
import { tick } from "@/lib/monitor";
import { checkApiToken } from "@/lib/apiAuth";

export const dynamic = "force-dynamic";

/**
 * Manueller Monitor-Zyklus (wird normalerweise vom Scheduler getrieben):
 * Kurse aktualisieren, SL/TP prüfen, Tageslimit prüfen, optional Marktscan.
 */
export async function POST(req: Request) {
  const denied = checkApiToken(req);
  if (denied) return denied;
  try {
    const result = await tick();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}

export async function GET(req: Request) {
  return POST(req);
}
