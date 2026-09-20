/**
 * Operator-Auflösungen — versionierte Re-Resolution und VOID
 * (RMA-P3-01, v1.55.0).
 *
 *   POST /api/firm/forecasts/resolutions
 *   {
 *     "forecastId": "<uuid>",
 *     "action": "RE_RESOLVE" | "VOID",
 *     "reason": "DATA_CORRECTION" | "CORPORATE_ACTION" | "TRADING_HALT" |
 *               "INVALID_DATA" | "MISSING_DATA",
 *     "note"?: "<= 500 Zeichen"
 *   }
 *
 * Semantik (append-only, keine stille Mutation):
 *   * `RE_RESOLVE` bewertet den Forecast neu mit der AKTUELLEN Store-Lage
 *     (Verfügbarkeitsgrenze = jetzt). Weicht das Ergebnis ab, entsteht eine
 *     neue Resolution-Version; identisches Ergebnis ⇒ no-op.
 *   * `VOID` hängt eine begründete VOID-Resolution an (z. B. Corporate
 *     Action). Wiederholungen mit identischem Inhalt sind no-ops.
 *
 * Jede Aktion schreibt ein Audit-Event (`FORECAST_RE_RESOLUTION` bzw.
 * `FORECAST_VOID`, Klasse WARN) mit Akteur. Guard: `firm.write`.
 */
import { NextResponse } from "next/server";

import { actorAuditId, requirePermission } from "@/auth";
import { ResolverInputError } from "@/forecasts/resolver";
import { FORECAST_LIMITS } from "@/forecasts/types";
import { metricLabel, telemetry } from "@/lib/telemetry";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

const ACTIONS = ["RE_RESOLVE", "VOID"] as const;
type Action = (typeof ACTIONS)[number];

interface ValidatedBody {
  forecastId: string;
  action: Action;
  reason: string;
  note?: string;
}

function validateBody(raw: unknown): { ok: true; value: ValidatedBody } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "Request-Body muss ein JSON-Objekt sein." };
  }
  const body = raw as Record<string, unknown>;
  if (typeof body.forecastId !== "string" || body.forecastId.trim().length === 0 || body.forecastId.length > 64) {
    return { ok: false, error: "forecastId fehlt oder ist ungültig." };
  }
  if (typeof body.action !== "string" || !(ACTIONS as readonly string[]).includes(body.action)) {
    return { ok: false, error: `action muss eines von ${ACTIONS.join(" | ")} sein.` };
  }
  if (typeof body.reason !== "string" || body.reason.trim().length === 0 || body.reason.length > 64) {
    return { ok: false, error: "reason fehlt oder ist ungültig (geschlossene Liste, siehe docs/FORECASTS.md)." };
  }
  if (body.note !== undefined && (typeof body.note !== "string" || body.note.length > FORECAST_LIMITS.maxOperatorNoteLength)) {
    return { ok: false, error: `note muss ein String mit maximal ${FORECAST_LIMITS.maxOperatorNoteLength} Zeichen sein.` };
  }
  return {
    ok: true,
    value: {
      forecastId: body.forecastId.trim(),
      action: body.action as Action,
      reason: body.reason.trim().toUpperCase(),
      note: typeof body.note === "string" ? body.note : undefined,
    },
  };
}

export async function POST(req: Request) {
  const denied = requirePermission(req, "firm.write");
  if (denied) return denied;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "INVALID_JSON", message: "Ungültiges JSON im Request-Body." }, { status: 400, headers: NO_STORE });
  }
  const validated = validateBody(raw);
  if (!validated.ok) {
    return NextResponse.json({ ok: false, error: "INVALID_BODY", message: validated.error }, { status: 400, headers: NO_STORE });
  }
  const { forecastId, action, reason, note } = validated.value;
  const actorId = actorAuditId(req);

  try {
    const { operatorReResolve, operatorVoid } = await import("@/forecasts/service");
    if (action === "RE_RESOLVE") {
      const result = await operatorReResolve({ forecastId, actorId, reason, note });
      return NextResponse.json(
        {
          ok: true,
          created: result.created,
          resolutionVersion: result.resolutionVersion,
          status: result.status,
          outcomeHash: result.outcomeHash,
          hint: result.created ? "Neue Resolution-Version angehängt (Historie unverändert)." : "Identisches Outcome bereits protokolliert (no-op).",
        },
        { headers: NO_STORE }
      );
    }
    const result = await operatorVoid({ forecastId, actorId, reason, note, voidReason: reason });
    return NextResponse.json(
      {
        ok: true,
        created: result.created,
        resolutionVersion: result.resolutionVersion,
        status: "VOID" as const,
        outcomeHash: result.outcomeHash,
        hint: result.created ? "VOID-Resolution angehängt (Historie unverändert)." : "Identisches VOID bereits protokolliert (no-op).",
      },
      { headers: NO_STORE }
    );
  } catch (e) {
    if (e instanceof ResolverInputError) {
      const status = e.code === "forecast:not-found" ? 404 : 400;
      telemetry.forecasts.resolutions.inc({ result: "invalid", reason: metricLabel(e.code) });
      return NextResponse.json({ ok: false, error: e.code, message: e.message }, { status, headers: NO_STORE });
    }
    telemetry.forecasts.resolutions.inc({ result: "failed", reason: "operator-error" });
    return NextResponse.json(
      {
        ok: false,
        error: "RESOLUTION_FAILED",
        message: e instanceof Error ? e.message : String(e),
        hint: "Datenbank/`DATABASE_URL` prüfen; die bestehende Resolution-Historie bleibt unverändert.",
      },
      { status: 503, headers: NO_STORE }
    );
  }
}
