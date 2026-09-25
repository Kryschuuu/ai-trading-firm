/**
 * `GET|PUT /api/ops/toggles` — Laufzeit-Schalter des Betriebs (UI-Bedienung).
 *
 * Abgedeckte Schalter (Allowlist, `src/lib/runtimeFlags.ts`):
 *   - `broker.healthcheck.remote` — Broker-Remote-Checks (Default AUS)
 *   - `provider.<id>.enabled`     — LLM-Provider freigeben/sperren
 *     (u. a. `provider.opencode.enabled` für die OpenCode-Zen-Free-Modelle)
 *
 * Semantik: `{ "value": true|false }` setzt eine explizite Operator-Entscheidung
 * (persistiert in `data/runtime/flags.json`), `{ "value": null }` löscht sie —
 * dann gilt wieder der Env-Default (`BROKER_HEALTHCHECK_REMOTE`,
 * `ROUTING_DISABLED_PROVIDERS`).
 *
 * SICHERHEIT (Regel 2 + 4):
 *   - `GET` verlangt `firm.read` (Betriebszustand ist strategie-sensitiv).
 *   - `PUT` ist eine Policy-Änderung ⇒ **nur Admin** (`checkAdminGuard()`)
 *     + CSRF-Header (`checkCsrfGuard()`), timing-safe.
 *   - Jede Änderung wird auditiert (`RUNTIME_FLAG_CHANGED`, Klasse `security`).
 *     Der Actor kommt ausschließlich aus der authentifizierten Principal.
 *   - Es werden ausschließlich Bool-Werte gespeichert — keine Freitexte,
 *     keine Secrets, keine URLs.
 *
 * Antwort 200:
 *   `{ ok: true, key, value, flags: RuntimeFlagView[], file, error }`
 */
import { requirePermission, actorAuditId } from "@/auth";
import { checkAdminGuard, checkCsrfGuard } from "@/brokers/control-plane/guard";
import { REMOTE_HEALTHCHECK_SPEC } from "@/brokers/health";
import { publicErrorMessage } from "@/lib/secrets";
import { writeAuditRecord } from "@/lib/auditSink";
import {
  readRuntimeFlags,
  resolveFlagsFile,
  setRuntimeFlag,
  runtimeFlagView,
  clearRuntimeFlag,
  type RuntimeFlagSpec,
  type RuntimeFlagView,
} from "@/lib/runtimeFlags";
import { PROVIDER_IDS, providerToggleSpecs } from "@/routing";

export const dynamic = "force-dynamic";

/**
 * Allowlist: Schalter, die über diese Route änderbar sind. Bewusst als
 * unexportierte Route-Interna — die Export-Fläche einer `route.ts` bleibt
 * auf die HTTP-Handler beschränkt.
 */
function toggleSpecs(): RuntimeFlagSpec[] {
  return [REMOTE_HEALTHCHECK_SPEC, ...providerToggleSpecs()];
}

function findSpec(key: string): RuntimeFlagSpec | undefined {
  return toggleSpecs().find((spec) => spec.key === key);
}

function allViews(env: Record<string, string | undefined>): RuntimeFlagView[] {
  return toggleSpecs().map((spec) => runtimeFlagView(spec, env));
}

export async function GET(req: Request): Promise<Response> {
  const denied = requirePermission(req, "firm.read");
  if (denied) return denied;
  try {
    const { flags, error, file } = readRuntimeFlags();
    return Response.json(
      {
        ok: true,
        flags: allViews(process.env),
        set: flags,
        file,
        error,
      },
      { headers: { "Cache-Control": "private, no-store" } }
    );
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

  let body: { key?: unknown; value?: unknown };
  try {
    body = (await req.json()) as { key?: unknown; value?: unknown };
  } catch {
    return Response.json({ ok: false, error: "INVALID_BODY" }, { status: 400 });
  }

  const key = typeof body.key === "string" ? body.key.trim() : "";
  const spec = findSpec(key);
  if (!spec) {
    return Response.json(
      {
        ok: false,
        error: "UNKNOWN_FLAG",
        message: `Unbekannter Schalter "${key.slice(0, 64)}". Erlaubt: ${toggleSpecs()
          .map((s) => s.key)
          .join(", ")}`,
      },
      { status: 422 }
    );
  }
  if (!(typeof body.value === "boolean" || body.value === null)) {
    return Response.json(
      { ok: false, error: "INVALID_VALUE", message: "value muss true, false oder null sein." },
      { status: 400 }
    );
  }

  const actor = actorAuditId(req);
  const value = body.value as boolean | null;
  const result =
    value === null
      ? clearRuntimeFlag(spec.key, process.env)
      : setRuntimeFlag(spec, value, { by: actor });

  if (!result.ok) {
    return Response.json(
      { ok: false, error: result.error, message: publicErrorMessage(result.error) },
      { status: 500 }
    );
  }

  const view = runtimeFlagView(spec, process.env);
  // Audit ist Klasse `security`: ein vergessener Schalter ist ein
  // Sicherheitsereignis, kein Telemetrie-Rauschen.
  const outcome = await writeAuditRecord({
    event: "RUNTIME_FLAG_CHANGED",
    level: value === null ? "INFO" : "WARN",
    auditClass: "security",
    detail: {
      actor,
      key: spec.key,
      value: value === null ? null : String(view.effective),
      cleared: value === null,
      source: view.source,
      envVar: spec.envVar ?? null,
    },
  });

  return Response.json({
    ok: true,
    key: spec.key,
    value: view.effective,
    flags: allViews(process.env),
    file: resolveFlagsFile(),
    auditDurable: outcome.durable,
    providers: PROVIDER_IDS,
  });
}
