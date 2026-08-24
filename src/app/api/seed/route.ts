import { NextResponse } from "next/server";
import { ensureSeeded, checkSchema } from "@/lib/seed";
import { killSwitch } from "@/lib/riskGuard";
import { checkApiToken } from "@/lib/apiAuth";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const denied = checkApiToken(req);
  if (denied) return denied;
  const schema = await checkSchema();
  if (!schema.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: `Tabellen fehlen: ${schema.missingTables.join(", ")}. Bitte "npx drizzle-kit push" ausführen.`,
        missingTables: schema.missingTables,
        fix: "npx drizzle-kit push",
      },
      { status: 503 }
    );
  }

  const result = await ensureSeeded();
  return NextResponse.json({
    ok: result.ok,
    seeded: result.ok,
    error: result.reason,
    killSwitchArmed: killSwitch.isArmed(),
  });
}
