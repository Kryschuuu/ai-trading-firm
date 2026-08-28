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
 *   - Jede Änderung wird auditiert (`MODEL_ROUTING`, outcome `admin`,
 *     from `mode:<alt>` → to `mode:<neu>`, inkl. Actor).
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
  const patch: Record<string, unknown> =
    rawModes && typeof rawModes === "object" && !Array.isArray(rawModes)
      ? (rawModes as Record<string, unknown>)
      : record;

  if (Object.keys(patch).length === 0) {
    return Response.json(
      { ok: false, error: "INVALID_BODY", hint: "Mindestens ein Agenten-Modus erwartet." },
      { status: 400 }
    );
  }

  const actor = typeof record.actor === "string" && record.actor.trim().length > 0
    ? record.actor.trim().slice(0, 64)
    : "admin";

  try {
    const router = getModelRouter();
    const result = router.setModes(patch, actor);
    if (!result.ok) {
      return Response.json(
        {
          ok: false,
          error: "INVALID_MODES",
          errors: result.errors,
          modes: result.modes,
          hint: `Erlaubte Modi: ${ROUTING_MODES.join(", ")}.`,
        },
        { status: 422 }
      );
    }
    return Response.json({
      ok: true,
      modes: result.modes,
      audit: result.audit,
      policyVersion: router.policy.version,
    });
  } catch (e) {
    return Response.json(
      { ok: false, error: "INTERNAL_ERROR", message: publicErrorMessage(e) },
      { status: 500 }
    );
  }
}
