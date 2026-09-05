/**
 * RBAC-Kern (Task 10, Phase 1; Sessions seit W1 v1.36.23).
 *
 * Identität kommt aus Token-Headern (`x-admin-token` / `x-firm-token` /
 * `x-viewer-token` / Bearer), aus einer signierten Session-Cookie
 * (`firm_session`, `source="api-session"`, W1) oder, wenn kein Token
 * konfiguriert ist, aus dem lokalen Offen-Betrieb (Single-User, Dienst
 * lauscht auf 127.0.0.1).
 *
 * `live.gate` steht im Katalog, wird aber keiner Rolle gewährt — Live
 * bleibt bis Task 11 `LiveTradingGateError`.
 */

export const ROLES = ["viewer", "operator", "admin"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  "firm.read",
  "ops.view",
  "broker.status",
  "routing.read",
  "firm.write",
  "firm.kill",
  "firm.config",
  "broker.test",
  "broker.credentials",
  "routing.modes.write",
  "live.gate",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ACTOR_SOURCES = [
  "local-open",
  "admin-token",
  "api-token",
  "viewer-token",
  "api-session",
] as const;
export type ActorSource = (typeof ACTOR_SOURCES)[number];

/**
 * Aufgelöster Akteur. Enthält niemals Token-Werte.
 * `auditId` ist die kurze ID für Control-Plane-/Audit-Felder
 * (`admin` | `operator` | `viewer`) — local-open mappt auf `admin`,
 * damit bestehende Control-Plane-Tests (`actor === "admin"`) halten.
 */
export type Actor = {
  role: Role;
  /** Rolle nach Single-Admin-Elevation (Operator ohne FIRM_ADMIN_TOKEN → admin). */
  effectiveRole: Role;
  source: ActorSource;
  elevated: boolean;
  auditId: "admin" | "operator" | "viewer";
  permissions: readonly Permission[];
};

export type AuthFailure = {
  ok: false;
  status: 401 | 403;
  error: "UNAUTHORIZED" | "FORBIDDEN";
  hint: string;
};

export type AuthSuccess = {
  ok: true;
  actor: Actor;
};

export type AuthResolution = AuthSuccess | AuthFailure;

export type PublicActor = {
  role: Role;
  effectiveRole: Role;
  source: ActorSource;
  elevated: boolean;
  permissions: readonly Permission[];
};

export function toPublicActor(actor: Actor): PublicActor {
  return {
    role: actor.role,
    effectiveRole: actor.effectiveRole,
    source: actor.source,
    elevated: actor.elevated,
    permissions: actor.permissions,
  };
}
