/**
 * Broker Control Plane (Task 08) — oeffentlicher Einstiegspunkt.
 *
 *   secretStore: AES-256-GCM-Store (AAD = Venue-ID), Storage-Backends,
 *                KMS-Hook, Task-07-Bridge (createVenueBackedNamedStore)
 *   service:     Credential-Manager (save/delete/status/test/discover),
 *                Zustandsmaschine (6 Ebenen), Audit, status-only-Vertrag
 *   states:      Zustandsmaschinen-Light (off/pending/active/error)
 *   stateStore:  Persistenz des Zustands (`venue_control_state`, C4) —
 *                Map ist nur Cache, Neustart zeigt letzten Zustand
 *   probe:       Read-only Permission-Probe (PAPER real, sonst Mock-Adapter)
 *   guard:       RBAC (src/auth, Task 10), CSRF, Credential-Rate-Limit
 *                (Identitaet + global + Backoff, C2/v1.36.14)
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
  isEnvCredentialFallbackAllowed,
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
  clearControlPlaneStateCacheForTests,
  getControlPlaneService,
  loadVenueControlState,
  readVenueControlStatePublic,
  resetControlPlaneForTests,
  warmControlPlaneStateCache,
  type ControlPlaneOptions,
  type DeleteResultDto,
  type DiscoverResultDto,
  type LayerStatusDto,
  type SaveResultDto,
  type StatusDto,
  type TestResultDto,
} from "./service";
export {
  CONTROL_STATE_BACKEND_FLAG,
  DbControlStateRepository,
  MemoryControlStateRepository,
  fromPersistedRow,
  getControlStateRepository,
  resolveControlStateRepository,
  setControlStateRepositoryForTests,
  toPersistedRow,
  type ControlStateRepository,
  type PersistedControlState,
} from "./stateStore";
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
  checkCredentialBackoff,
  checkCredentialGlobalRateLimit,
  checkCredentialRateLimit,
  checkCsrfGuard,
  credentialBackoffState,
  guardCredentialEndpoint,
  recordCredentialFailure,
  recordCredentialSuccess,
  resetCredentialRateLimiterForTests,
  tokenEqualsSafe,
  type CredentialGlobalLimitOptions,
  type CredentialLimitOptions,
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
  CREDENTIAL_BACKOFF_BASE_MS_FLAG,
  CREDENTIAL_BACKOFF_CONFIG,
  CREDENTIAL_BACKOFF_MAX_MS_FLAG,
  CREDENTIAL_BACKOFF_RESET_MS,
  CREDENTIAL_GLOBAL_RATE_LIMIT_DEFAULT,
  CREDENTIAL_GLOBAL_RATE_LIMIT_FLAG,
  CREDENTIAL_RATE_LIMIT_DEFAULT,
  CREDENTIAL_RATE_LIMIT_FLAG,
  GLOBAL_CREDENTIAL_BUCKET_KEY,
  LIVE_GATE_LOCKED_REASON,
  SECRET_BACKEND_FLAG,
  SECRET_STORE_KEY_FLAG,
  credentialBackoffConfig,
  credentialBackoffMs,
  credentialGlobalRateLimitMax,
  credentialRateLimitMax,
  type CredentialBackoffConfig,
} from "./config";
