/**
 * Token → Actor (Task 10, Phase 1; Modus-Entscheidung seit C1 v1.36.13).
 *
 * Reihenfolge der Treffer: Admin-Token, Operator-Token, Viewer-Token.
 * Kein konfiguriertes Token ⇒ nur dann lokaler Offen-Betrieb als Admin
 * (`local-open`), wenn der Auth-Modus das hergibt: ausserhalb der Produktion
 * als Dev-Default, in Produktion ausschliesslich mit explizitem
 * `AUTH_MODE=local-open` (siehe `src/auth/authMode.ts`). Sonst ist die
 * Auflösung zu — nie implizit offen.
 *
 * Statuscodes bleiben kompatibel zur Control Plane (Task 08):
 *   - FIRM_ADMIN_TOKEN gesetzt, kein Treffer → 403 FORBIDDEN
 *   - nur FIRM_API_TOKEN / FIRM_VIEWER_TOKEN, kein Treffer → 401 UNAUTHORIZED
 *   - authentifiziert ohne Permission → 403 FORBIDDEN
 *   - kein Token, Modus token-required → 401 UNAUTHORIZED (AUTH_NOT_CONFIGURED)
 */
import { tokenEquals } from "@/lib/tokenCompare";
import { readSession, sessionActor } from "@/lib/authSession";
import {
  ADMIN_TOKEN_FLAG,
  OPERATOR_TOKEN_FLAG,
  VIEWER_TOKEN_FLAG,
  resolveAuthMode,
} from "./authMode";
import { buildActor } from "./permissions";
import type {
  Actor,
  AuthResolution,
  Permission,
} from "./types";

export {
  ADMIN_TOKEN_FLAG,
  OPERATOR_TOKEN_FLAG,
  VIEWER_TOKEN_FLAG,
  adminTokenConfigured,
  anyTokenConfigured,
} from "./authMode";

export const ADMIN_HEADER = "x-admin-token";
export const OPERATOR_HEADER = "x-firm-token";
export const VIEWER_HEADER = "x-viewer-token";

function presentedTokens(req: Request): {
  admin: string;
  firm: string;
  viewer: string;
  bearer: string;
} {
  const auth = req.headers.get("authorization") ?? "";
  const bearer = /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, "").trim() : "";
  return {
    admin: req.headers.get(ADMIN_HEADER) ?? "",
    firm: req.headers.get(OPERATOR_HEADER) ?? "",
    viewer: req.headers.get(VIEWER_HEADER) ?? "",
    bearer,
  };
}

function matchesAny(expected: string, candidates: readonly string[]): boolean {
  if (!expected) return false;
  return candidates.some((got) => got.length > 0 && tokenEquals(got, expected));
}

/**
 * Löst den Akteur auf. Wirft nie. Liefert immer eine Resolution.
 * `env` ist injizierbar (Tests).
 */
export function resolveAuth(
  req: Request,
  env: Record<string, string | undefined> = process.env
): AuthResolution {
  const adminTok = env[ADMIN_TOKEN_FLAG] ?? "";
  const operatorTok = env[OPERATOR_TOKEN_FLAG] ?? "";
  const viewerTok = env[VIEWER_TOKEN_FLAG] ?? "";
  const presented = presentedTokens(req);

  if (adminTok && matchesAny(adminTok, [presented.admin, presented.firm, presented.bearer])) {
    return { ok: true, actor: buildActor("admin", "admin-token", env) };
  }
  if (operatorTok && matchesAny(operatorTok, [presented.firm, presented.bearer, presented.admin])) {
    return { ok: true, actor: buildActor("operator", "api-token", env) };
  }
  if (viewerTok && matchesAny(viewerTok, [presented.viewer, presented.firm, presented.bearer])) {
    return { ok: true, actor: buildActor("viewer", "viewer-token", env) };
  }

  // SEC-01: Die Session bindet ein aktuelles Credential, keine gespeicherten
  // Rechte. Header und Session teilen dieselbe serverseitige Rollenprojektion.
  // Header schlagen weiterhin Session (curl/CLI bleibt identisch).
  const session = readSession(req, env);
  const actor = session ? sessionActor(session, env) : null;
  if (actor) {
    return { ok: true, actor };
  }

  if (!adminTok && !operatorTok && !viewerTok) {
    // C1 (v1.36.13): Offen-Betrieb ist an den Modus gebunden, nicht an das
    // Fehlen von Tokens. Produktion ohne Token ⇒ zu (und Boot-Guard wirft).
    if (resolveAuthMode(env).mode === "local-open") {
      return { ok: true, actor: buildActor("admin", "local-open", env) };
    }
    return {
      ok: false,
      status: 401,
      error: "UNAUTHORIZED",
      hint: "Authentifizierung ist nicht konfiguriert (AUTH_MODE=token-required, kein Token gesetzt). FIRM_ADMIN_TOKEN/FIRM_API_TOKEN setzen; lokal-offener Betrieb nur ausserhalb der Produktion mit AUTH_MODE=local-open.",
    };
  }

  if (adminTok) {
    return {
      ok: false,
      status: 403,
      error: "FORBIDDEN",
      hint: "Credential-/Connection-Operationen sind nur fuer die Admin-Rolle erlaubt (x-admin-token).",
    };
  }
  return {
    ok: false,
    status: 401,
    error: "UNAUTHORIZED",
    hint: "Fehlender/falscher x-firm-token Header.",
  };
}

/** Convenience: Actor oder `null` (unauthentifiziert). */
export function resolveActor(
  req: Request,
  env: Record<string, string | undefined> = process.env
): Actor | null {
  const resolution = resolveAuth(req, env);
  return resolution.ok ? resolution.actor : null;
}

export function denialResponse(failure: Extract<AuthResolution, { ok: false }>): Response {
  return Response.json(
    { ok: false, error: failure.error, hint: failure.hint },
    { status: failure.status }
  );
}

function forbidden(hint: string): Response {
  return Response.json({ ok: false, error: "FORBIDDEN", hint }, { status: 403 });
}

/**
 * Permission-Guard. `null` = erlaubt, sonst 401/403-Response.
 * Drop-in für `checkAdminGuard` / künftige Firm-Routen.
 */
export function requirePermission(
  req: Request,
  permission: Permission,
  env: Record<string, string | undefined> = process.env
): Response | null {
  const resolution = resolveAuth(req, env);
  if (!resolution.ok) return denialResponse(resolution);
  // Task 11: live.gate ist eine normale Admin-Permission (Matrix). Die
  // harte Live-Sperre selbst liegt IM ENFORCER (State-Machine + Flags +
  // Suite) — nicht in der Permission-Schicht. Defense in Depth bleibt:
  // buildActor streicht live.gate aus jeder Nicht-Admin-Rolle.
  if (!resolution.actor.permissions.includes(permission)) {
    return forbidden(`Permission "${permission}" ist fuer Rolle ${resolution.actor.role} nicht erteilt.`);
  }
  return null;
}

/** Audit-ID nach erfolgreichem Guard (Fallback admin = local-open). */
export function actorAuditId(req: Request): "admin" | "operator" | "viewer" {
  return resolveActor(req)?.auditId ?? "admin";
}
