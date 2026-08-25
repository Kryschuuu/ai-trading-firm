import { NextResponse } from "next/server";
import { db } from "@/db";
import { missions } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { guardWrite } from "@/lib/apiAuth";
import { LIMIT_CEILINGS } from "@/lib/riskGuard";
import {
  MISSION_SYMBOLS,
  isUuid,
  validateMissionInput,
  type MissionInput,
} from "@/lib/workshop";
import { logAudit } from "@/lib/engine";
import { publicErrorMessage } from "@/lib/secrets";

export const dynamic = "force-dynamic";

/**
 * Workshop: Missionen ohne Terminal anlegen und bearbeiten (Handbuch 5.1–5.3).
 *
 *   GET  /api/firm/missions           → Liste + verfügbare Symbole + Grenzen
 *   POST /api/firm/missions           → anlegen
 *   PUT  /api/firm/missions           → bearbeiten ({ id, ...felder })
 *
 * Validierung läuft über validateMissionInput (geteilt mit Tests); Budgets
 * werden gegen LIMIT_CEILINGS geprüft — dieselben Code-Grenzen, gegen die
 * riskGuard zur Laufzeit klemmt. Jede Änderung landet im audit_log.
 */
export async function GET() {
  try {
    const rows = await db.select().from(missions).orderBy(desc(missions.createdAt));
    return NextResponse.json({
      ok: true,
      missions: rows,
      symbols: MISSION_SYMBOLS,
      limits: {
        riskBudget: LIMIT_CEILINGS.maxRiskPerTrade,
        maxPositionPct: LIMIT_CEILINGS.maxPositionPct,
      },
    });
  } catch (e) {
    // DB-Ausfall als sauberen API-Fehler melden (Connection-Strings werden redaktiert).
    return NextResponse.json(
      { ok: false, error: `Datenbank nicht lesbar: ${publicErrorMessage(e)}` },
      { status: 503 }
    );
  }
}

function parseBody(raw: unknown): { id?: string; payload?: Record<string, unknown> } {
  if (!raw || typeof raw !== "object") return {};
  const body = raw as Record<string, unknown>;
  return {
    id: typeof body.id === "string" ? body.id.trim() : undefined,
    payload: body,
  };
}

async function writeAudit(
  event: string,
  missionId: string | null,
  detail: Record<string, unknown>
) {
  try {
    await logAudit(event, "INFO", detail, missionId ?? undefined);
  } catch {
    // Audit-Fehler darf den Workshop-Schreibvorgang nicht reißen —
    // die Mutation selbst ist bereits sicher validiert.
  }
}

export async function POST(req: Request) {
  const denied = guardWrite(req);
  if (denied) return denied;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Ungültiges JSON im Request-Body." }, { status: 400 });
  }

  const validated = validateMissionInput(raw);
  if (!validated.ok) {
    return NextResponse.json({ ok: false, error: validated.error }, { status: 400 });
  }
  const m: MissionInput = validated.value;

  try {
    const inserted = await db
      .insert(missions)
      .values({
        title: m.title,
        objective: m.objective,
        symbol: m.symbol,
        riskBudget: String(m.riskBudget),
        maxPositionPct: String(m.maxPositionPct),
        status: m.status,
      })
      .returning();

    await writeAudit("MISSION_CREATED", inserted[0]?.id ?? null, {
      title: m.title,
      symbol: m.symbol,
      riskBudget: m.riskBudget,
      maxPositionPct: m.maxPositionPct,
      via: "workshop-ui",
    });

    return NextResponse.json({ ok: true, mission: inserted[0], warnings: validated.warnings }, { status: 201 });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `Mission nicht angelegt: ${publicErrorMessage(e)}` },
      { status: 503 }
    );
  }
}

export async function PUT(req: Request) {
  const denied = guardWrite(req);
  if (denied) return denied;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Ungültiges JSON im Request-Body." }, { status: 400 });
  }

  const { id, payload } = parseBody(raw);
  if (!id || !isUuid(id)) {
    return NextResponse.json({ ok: false, error: "id der Mission fehlt oder ist keine UUID." }, { status: 400 });
  }

  const validated = validateMissionInput(payload);
  if (!validated.ok) {
    return NextResponse.json({ ok: false, error: validated.error }, { status: 400 });
  }
  const m: MissionInput = validated.value;

  try {
    const existing = (await db.select().from(missions).where(eq(missions.id, id)))[0];
    if (!existing) {
      return NextResponse.json({ ok: false, error: "Mission nicht gefunden." }, { status: 404 });
    }

    const updated = await db
      .update(missions)
      .set({
        title: m.title,
        objective: m.objective,
        symbol: m.symbol,
        riskBudget: String(m.riskBudget),
        maxPositionPct: String(m.maxPositionPct),
        status: m.status,
        updatedAt: new Date(),
      })
      .where(eq(missions.id, id))
      .returning();

    await writeAudit("MISSION_UPDATED", id, {
      title: m.title,
      symbol: m.symbol,
      riskBudget: m.riskBudget,
      maxPositionPct: m.maxPositionPct,
      via: "workshop-ui",
    });

    return NextResponse.json({ ok: true, mission: updated[0], warnings: validated.warnings });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `Mission nicht aktualisiert: ${publicErrorMessage(e)}` },
      { status: 503 }
    );
  }
}
