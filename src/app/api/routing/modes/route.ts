/**
 * `GET|PUT /api/routing/modes` — Routing-Modi je Agent (Task 09).
 *
 * Modi: `manual` (festes Modell, Eskalation möglich) · `automatic`
 * (Router entscheidet frei) · `hybrid` (Router innerhalb der Klassen-Grenzen
 * der Tabelle).
 *
 * SICHERHEIT (Regel 2 + 4):
 *   - `PUT` ist eine Policy-Änderung ⇒ **nur Admin**: `checkAdminGuard()`
 *     (RBAC `routing.modes.write` / `broker.credentials`-äquivalent über
 *     den Admin-Guard, timing-safe) + CSRF (`x-csrf-token`).
 *   - Jede Änderung wird auditiert (`MODEL_ROUTING`, outcome `admin`). Die
 *     Actor-ID kommt ausschließlich aus der authentifizierten Principal (`actorAuditId`).
 *   - `overrides` erlaubt Provider/Modell/Fallback je Agent; ungültige Modelle werden abgewiesen.
 *   - Unbekannte Modi werden mit 422 abgewiesen; gültige Einträge derselben
 *     Anfrage werden trotzdem übernommen (teilweise Anwendung, Fehlerliste).
 *
 * Antworten:
 *   200 `{ ok: true, modes, policyVersion }`
 *   400 `{ ok: false, error: "INVALID_BODY" }`
 *   401/403 Admin-Guard · 422 `{ ok: false, error: "INVALID_MODES", errors }`
 */
import { publicErrorMessage } from "@/lib/secrets";
import { checkAdminGuard, checkCsrfGuard } from "@/brokers/control-plane/guard";
import { actorAuditId } from "@/auth";
import { getModelRouter } from "@/routing";
import { ROUTING_MODES } from "@/routing/types";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const router = getModelRouter();
    return Response.json({
      ok: true,
      modes: router.getModes(),
      effective: Object.fromEntries(
        Object.keys(router.getModes()).map((agent) => [agent, router.effectiveMode(agent)])
      ),
      policyVersion: router.policy.version,
      allowedModes: ROUTING_MODES,
      overrides: router.getOverrides(),
    });
  } catch (e) {
    return Response.json(
      { ok: false, error: "INTERNAL_ERROR", message: publicErrorMessage(e) },
      { status: 500 }
    );
  }
}

export async function PUT(req: Request): Promise<Response> {
  const denied = checkAdminGuard(req) ?? checkCsrfGuard(req);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json(
      { ok: false, error: "INVALID_BODY", hint: "JSON-Body erwartet: { modes: { AGENT: \"hybrid\" } }." },
      { status: 400 }
    );
  }

  const record = (body ?? {}) as Record<string, unknown>;
  const rawModes = record.modes;
  const rawOverrides = record.overrides;
  const patch: Record<string, unknown> =
    rawModes && typeof rawModes === "object" && !Array.isArray(rawModes)
      ? (rawModes as Record<string, unknown>)
      : (rawOverrides === undefined ? record : {});
  const overridePatch: Record<string, unknown> =
    rawOverrides && typeof rawOverrides === "object" && !Array.isArray(rawOverrides)
      ? (rawOverrides as Record<string, unknown>) : {};

  if (Object.keys(patch).length === 0 && Object.keys(overridePatch).length === 0) {
    return Response.json(
      { ok: false, error: "INVALID_BODY", hint: "Mindestens ein Modus oder Provider/Modell-Override erwartet." },
      { status: 400 }
    );
  }

  // Audit actor is always derived from the authenticated principal. Client JSON
  // is deliberately not consulted (including a legacy `actor` field).
  const actor = actorAuditId(req);

  try {
    const router = getModelRouter();
    const result = router.setModes(patch, actor);
    const overrideResult = router.setOverrides(overridePatch, actor);
    if (!result.ok || !overrideResult.ok) {
      return Response.json(
        {
          ok: false,
          error: !result.ok ? "INVALID_MODES" : "INVALID_OVERRIDES",
          errors: [...result.errors, ...overrideResult.errors],
          modes: result.modes,
          overrides: overrideResult.overrides,
          hint: `Erlaubte Modi: ${ROUTING_MODES.join(", ")}; Override: { provider, model, fallbackMode }.`,
        },
        { status: 422 }
      );
    }
    return Response.json({
      ok: true,
      modes: result.modes,
      overrides: overrideResult.overrides,
      audit: [...result.audit, ...overrideResult.audit],
      policyVersion: router.policy.version,
    });
  } catch (e) {
    return Response.json(
      { ok: false, error: "INTERNAL_ERROR", message: publicErrorMessage(e) },
      { status: 500 }
    );
  }
}
