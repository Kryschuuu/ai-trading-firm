/**
 * Permission-Katalog und Rollenmatrix (Task 10, erweitert in Task 11).
 *
 * `live.gate` ist SEIT Task 11 ausschließlich der ADMIN-Rolle gewährt — die
 * Permission erlaubt nur die Bedienung der Live-Gate-State-Machine
 * (Transitions-Anträge, Human-Gate-Bestätigung, Kill). Sie schaltet KEIN Live
 * ein: Der Enforcer verlangt zusätzlich State=ENABLED + Flags + Suite + CI.
 */
import type { Permission, Role } from "./types";

const VIEWER_PERMISSIONS: readonly Permission[] = [
  "firm.read",
  "ops.view",
  "broker.status",
  "routing.read",
];

const OPERATOR_PERMISSIONS: readonly Permission[] = [
  ...VIEWER_PERMISSIONS,
  "firm.write",
  "firm.kill",
  "firm.config",
  "broker.test",
];

const ADMIN_PERMISSIONS: readonly Permission[] = [
  ...OPERATOR_PERMISSIONS,
  "broker.credentials",
  "routing.modes.write",
  // Task 11: Live-Gate-Bedienung NUR für Admin — Human-Gate bleibt
  // strukturell Teil der State-Machine (Cooldown, 4-Augen, Audit).
  "live.gate",
];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  viewer: VIEWER_PERMISSIONS,
  operator: OPERATOR_PERMISSIONS,
  admin: ADMIN_PERMISSIONS,
};

export function permissionsForRole(role: Role): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}

export function hasPermission(
  permissions: readonly Permission[],
  permission: Permission
): boolean {
  return permissions.includes(permission);
}

/** Harte Invariante: keine Rolle, keine Elevation darf Live freigeben. */
export function liveGateGranted(permissions: readonly Permission[]): boolean {
  return permissions.includes("live.gate");
}
