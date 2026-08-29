/**
 * RBAC-Kern (Task 10) — öffentlicher Einstieg.
 *
 *   permissions: Rollenmatrix, live.gate nie gewährt
 *   resolve:     Token → Actor, requirePermission
 *   ops:         Operations-Center-Katalog + RBAC-Projektion (GET /api/ops)
 */
export {
  PERMISSIONS,
  ROLES,
  ACTOR_SOURCES,
  toPublicActor,
  type Actor,
  type ActorSource,
  type AuthFailure,
  type AuthResolution,
  type AuthSuccess,
  type Permission,
  type PublicActor,
  type Role,
} from "./types";
export {
  ROLE_PERMISSIONS,
  hasPermission,
  liveGateGranted,
  permissionsForRole,
} from "./permissions";
export {
  ADMIN_HEADER,
  ADMIN_TOKEN_FLAG,
  OPERATOR_HEADER,
  OPERATOR_TOKEN_FLAG,
  VIEWER_HEADER,
  VIEWER_TOKEN_FLAG,
  adminTokenConfigured,
  anyTokenConfigured,
  actorAuditId,
  denialResponse,
  requirePermission,
  resolveActor,
  resolveAuth,
} from "./resolve";
export {
  OPS_SECTIONS,
  OPS_SECTION_BY_ID,
  aggregateLiveGateStatus,
  buildOpsPayload,
  summarizeSections,
  type OpsSectionDefinition,
} from "./ops";

export {
  OPS_SECTION_IDS,
  OPS_SECTION_STATUSES,
  isOpsSectionId,
  type OpsHealth,
  type OpsItem,
  type OpsMetric,
  type OpsPayload,
  type OpsSection,
  type OpsSectionData,
  type OpsSectionId,
  type OpsSectionStatus,
  type OpsTone,
} from "@/ops/types";
