import { NextResponse } from "next/server";
import { tick } from "@/lib/monitor";
import { guardWrite } from "@/lib/apiAuth";
import { publicErrorMessage } from "@/lib/secrets";

export const dynamic = "force-dynamic";

/**
 * Manueller Monitor-Zyklus (wird normalerweise vom Scheduler getrieben):
 * Kurse aktualisieren, SL/TP prüfen, Tageslimit prüfen, optional Marktscan.
 */
export async function POST(req: Request) {
  const denied = guardWrite(req);
  if (denied) return denied;
  try {
    const result = await tick();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    // FIX (v1.5.1): redact secrets from error message (DB connection strings etc.)
    return NextResponse.json(
      { ok: false, error: publicErrorMessage(e) },
      { status: 500 }
    );
  }
}

/**
 * KORRIGIERT (v1.1.0): GET löst KEINEN Tick mehr aus. Der alte Handler hat
 * über die HTTP-VERB-Methode Zustand verändert (Positionen schließen!).
 * Monitoring-Tools, Browser-Prefetches und Link-Checker senden GETs — die
 * dürfen niemals einen Trade/Zyklus auslösen.
 */
export async function GET() {
  return NextResponse.json(
    {
      ok: false,
      error:
        "Nur POST erlaubt — ein Tick kann Positionen schließen und ist deshalb ein schreibender Aufruf.",
    },
    { status: 405 }
  );
}
