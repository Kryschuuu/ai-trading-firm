import { NextResponse } from "next/server";
import { db } from "@/db";
import { missions } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { guardWrite } from "@/lib/apiAuth";
import { LIMIT_CEILINGS } from "@/lib/riskGuard";
import {
  MISSION_SCOPES,
  MISSION_SCOPE_LABELS,
  MISSION_SEGMENT_IDS,
  MISSION_SYMBOLS,
  MISSION_TEMPLATES,
  applyMissionTemplate,
  isUuid,
  missionSegmentDto,
  missionTemplateDto,
  validateMissionInput,
  type MissionInput,
} from "@/lib/workshop";
import { MISSION_SEGMENTS } from "@/lib/missionTemplates";
import { segmentCandidateCounts } from "@/lib/missionUniverse";
import { logAudit } from "@/lib/engine";
import { publicErrorMessage } from "@/lib/secrets";

export const dynamic = "force-dynamic";

/**
 * Workshop: Missionen ohne Terminal anlegen und bearbeiten (Handbuch 5.1–5.4).
 *
 *   GET  /api/firm/missions           → Liste + Symbole + Grenzen + Segmente + Vorlagen
 *   POST /api/firm/missions           → anlegen (auch direkt aus einer Vorlage)
 *   PUT  /api/firm/missions           → bearbeiten ({ id, ...felder })
 *
 * Validierung läuft über validateMissionInput (geteilt mit Tests); Budgets
 * werden gegen LIMIT_CEILINGS geprüft — dieselben Code-Grenzen, gegen die
 * riskGuard zur Laufzeit klemmt. Jede Änderung landet im audit_log.
 *
 * Seit v1.35.0 liefert GET zusätzlich die Bausteine des Missions-Baukastens:
 *   * `scopes`     — Missions-Typen (Einzel-Symbol | Markt-Scan),
 *   * `segments`   — Marktsegmente inklusive aktueller Kandidatenzahl,
 *   * `templates`  — wiederverwendbare Vorlagen (14 davon werden geseedet).
 * Damit zeigt die UI nie eine Auswahl, die der Server nicht kennt.
 */
export async function GET() {
  try {
    const rows = await db.select().from(missions).orderBy(desc(missions.createdAt));
    // Kandidatenzahl je Segment — rein informativ, darf den GET nie reißen.
    let segmentCounts: Record<string, number> = {};
    try {
      segmentCounts = segmentCandidateCounts();
    } catch {
      segmentCounts = {};
    }
    return NextResponse.json({
      ok: true,
      missions: rows,
      symbols: MISSION_SYMBOLS,
      limits: {
        riskBudget: LIMIT_CEILINGS.maxRiskPerTrade,
        maxPositionPct: LIMIT_CEILINGS.maxPositionPct,
      },
      scopes: MISSION_SCOPES.map((id) => ({ id, label: MISSION_SCOPE_LABELS[id] })),
      segments: MISSION_SEGMENTS.map((s) => ({
        ...missionSegmentDto(s),
        /** Aktuell gefundene Instrumente — 0 heißt „Daten fehlen“, nicht „keine Chance“. */
        instrumentCount: segmentCounts[s.id] ?? 0,
      })),
      segmentIds: MISSION_SEGMENT_IDS,
      templates: MISSION_TEMPLATES.map(missionTemplateDto),
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

/**
 * Gemeinsamer Schreibpfad für POST und PUT:
 * Vorlage anwenden → validieren → Spaltenwerte bauen.
 */
function prepareMission(raw: unknown):
  | { ok: true; value: MissionInput; warnings: string[] }
  | { ok: false; error: string } {
  // 1) Vorlage: leere Felder ergänzen (bewusste Eingaben gewinnen immer).
  const { payload, templateId, warnings } = applyMissionTemplate(raw);
  // 2) Validierung: identisch für Formular, curl und Vorlagen-API.
  const validated = validateMissionInput(payload);
  if (!validated.ok) return { ok: false, error: validated.error };
  const all = [...warnings, ...validated.warnings];
  if (templateId) {
    all.push(`Vorlage „${templateId}“ übernommen — Titel, Ziel, Missions-Typ und Budgets waren vorausgefüllt.`);
  }
  return { ok: true, value: validated.value, warnings: all };
}

/** DB-Spaltenwerte aus dem validierten Input (numeric als String, wie Drizzle es erwartet). */
function toColumns(m: MissionInput) {
  return {
    title: m.title,
    objective: m.objective,
    symbol: m.symbol,
    scope: m.scope,
    segment: m.segment,
    templateId: m.templateId,
    riskBudget: String(m.riskBudget),
    maxPositionPct: String(m.maxPositionPct),
    status: m.status,
  };
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

  const prepared = prepareMission(raw);
  if (!prepared.ok) {
    return NextResponse.json({ ok: false, error: prepared.error }, { status: 400 });
  }
  const m: MissionInput = prepared.value;

  try {
    const inserted = await db
      .insert(missions)
      .values(toColumns(m))
      .returning();

    await writeAudit("MISSION_CREATED", inserted[0]?.id ?? null, {
      title: m.title,
      scope: m.scope,
      symbol: m.symbol,
      segment: m.segment,
      templateId: m.templateId,
      riskBudget: m.riskBudget,
      maxPositionPct: m.maxPositionPct,
      via: "workshop-ui",
    });

    return NextResponse.json(
      { ok: true, mission: inserted[0], warnings: prepared.warnings },
      { status: 201 }
    );
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

  const prepared = prepareMission(raw);
  if (!prepared.ok) {
    return NextResponse.json({ ok: false, error: prepared.error }, { status: 400 });
  }
  const m: MissionInput = prepared.value;
  void payload;

  try {
    const existing = (await db.select().from(missions).where(eq(missions.id, id)))[0];
    if (!existing) {
      return NextResponse.json({ ok: false, error: "Mission nicht gefunden." }, { status: 404 });
    }

    const updated = await db
      .update(missions)
      .set({ ...toColumns(m), updatedAt: new Date() })
      .where(eq(missions.id, id))
      .returning();

    await writeAudit("MISSION_UPDATED", id, {
      title: m.title,
      scope: m.scope,
      symbol: m.symbol,
      segment: m.segment,
      templateId: m.templateId,
      riskBudget: m.riskBudget,
      maxPositionPct: m.maxPositionPct,
      via: "workshop-ui",
    });

    return NextResponse.json({
      ok: true,
      mission: updated[0],
      warnings: prepared.warnings,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `Mission nicht aktualisiert: ${publicErrorMessage(e)}` },
      { status: 503 }
    );
  }
}
