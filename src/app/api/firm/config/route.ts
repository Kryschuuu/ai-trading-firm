import { NextResponse } from "next/server";
import { effectiveConfigView, refreshRuntimeLimits, setConfigValue } from "@/lib/riskConfigService";
import { guardWrite } from "@/lib/apiAuth";

export const dynamic = "force-dynamic";

/** Effektive Limits + das Code-Fenster, in dem sie änderbar sind. */
export async function GET() {
  await refreshRuntimeLimits(true);
  return NextResponse.json({
    ok: true,
    config: effectiveConfigView(),
    note:
      "Werte sind zur Laufzeit änderbar, werden aber vom Code (LIMIT_CEILINGS in riskGuard.ts) geklemmt. requireStopLoss ist absichtlich gesperrt.",
  });
}

/**
 * Ändert einen Konfigurationswert: { key: "maxPositionPct", value: 0.3 }.
 * Jede Änderung wird validiert, geklemmt und ins Audit-Log geschrieben.
 */
export async function PUT(req: Request) {
  const denied = guardWrite(req);
  if (denied) return denied;
  let body: { key?: string; value?: unknown };
  try {
    body = (await req.json()) as { key?: string; value?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: "Ungültiges JSON" }, { status: 400 });
  }
  if (!body.key) {
    return NextResponse.json({ ok: false, error: "key fehlt" }, { status: 400 });
  }
  const num = typeof body.value === "boolean" ? (body.value ? 1 : 0) : Number(body.value);
  const result = await setConfigValue(body.key, num);
  if (!result.ok) {
    return NextResponse.json(result, { status: 400 });
  }
  return NextResponse.json({ ok: true, key: body.key, effective: result.effective });
}
