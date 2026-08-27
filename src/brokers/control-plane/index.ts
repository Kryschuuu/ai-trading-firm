/**
 * Broker Control Plane (Task 08) — oeffentlicher Einstiegspunkt.
 *
 *   secretStore: AES-256-GCM-Store (AAD = Venue-ID), Storage-Backends,
 *                KMS-Hook, Task-07-Bridge (createVenueBackedNamedStore)
 *   service:     Credential-Manager (save/delete/status/test/discover),
 *                Zustandsmaschine (6 Ebenen), Audit, status-only-Vertrag
 *   states:      Zustandsmaschinen-Light (off/pending/active/error)
 *   probe:       Read-only Permission-Probe (PAPER real, sonst Mock-Adapter)
 *   guard:       Admin-RBAC (TODO task-10), CSRF, Credential-Rate-Limit
 *   audit:       Ring + best-effort audit_log (BROKER_CONTROL_PLANE)
 *   http:        Fehler-Mapping auf den { ok, error, message }-Contract
 */
export {
  AesGcmSecretStore,
  EnvKmsClient,
  AwsKmsClient,
  DbSecretStorage,
  FileSecretStorage,
  MemorySecretStorage,
  SecretStoreError,
  assertValidCredential,
  assertValidVenueId,
  createAesGcmSecretStore,
  createVenueBackedNamedStore,
  deriveStoreKey,
  getControlPlaneSecretStore,
  openEnvelope,
  sealEnvelope,
  setControlPlaneSecretStoreForTests,
  zeroize,
  type CredentialPayload,
  type KmsClient,
  type SecretStorage,
  type VenueSecretStore,
} from "./secretStore";
export {
  ControlPlaneService,
  getControlPlaneService,
  resetControlPlaneForTests,
  type ControlPlaneOptions,
  type DeleteResultDto,
  type DiscoverResultDto,
  type LayerStatusDto,
  type SaveResultDto,
  type StatusDto,
  type TestResultDto,
} from "./service";
export {
  CONTROL_LAYER_IDS,
  StateTransitionError,
  applyAction,
  createInitialControlState,
  readGateState,
  type ControlAction,
  type ControlLayer,
  type ControlLayerId,
  type LayerStateValue,
  type ProbeOutcome,
  type VenueControlState,
} from "./states";
export { MockVenueApiClient, disposeCredential, probePermissions } from "./probe";
export {
  checkAdminGuard,
  checkCredentialRateLimit,
  checkCsrfGuard,
  guardCredentialEndpoint,
  resetCredentialRateLimiterForTests,
  tokenEqualsSafe,
} from "./guard";
export {
  controlPlaneAuditRing,
  readControlPlaneAudit,
  recordControlPlaneEvent,
  clearControlPlaneAuditForTests,
  type ControlPlaneAction,
  type ControlPlaneAuditEntry,
} from "./audit";
export { mapControlPlaneError, readJsonBody } from "./http";
export {
  ADMIN_HEADER,
  ADMIN_TOKEN_FLAG,
  CSRF_HEADER,
  CSRF_LOCAL_VALUE,
  CREDENTIAL_RATE_LIMIT_DEFAULT,
  CREDENTIAL_RATE_LIMIT_FLAG,
  LIVE_GATE_LOCKED_REASON,
  SECRET_BACKEND_FLAG,
  SECRET_STORE_KEY_FLAG,
  credentialRateLimitMax,
} from "./config";
