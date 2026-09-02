/**
 * Broker-Layer (Task 02) — öffentlicher Einstiegspunkt des Capability-Modells.
 *
 *   factory:       getBroker(venue, mode), createAdapter, paperBrokerLedger
 *   capabilities:  VENUE_CAPABILITIES (SSoT), Gating-Table
 *   audit:         Factory-Audit (ring + best-effort audit_log)
 *   health:        Remote-Check-Flag (Default OFF) + read-only Checks
 *   paper/stubs:   die Adapter
 *
 * Contracts (Interfaces + Fehlerklassen) liegen in src/contracts/broker.ts.
 */
export {
  createAdapter,
  getBroker,
  normalizeVenue,
  paperBrokerLedger,
} from "./factory";
export {
  REQUIRED_CAPABILITY_BY_MODE,
  VENUE_CAPABILITIES,
  availableExecutionModes,
} from "./capabilities";
export {
  factoryAuditRing,
  recordBrokerFactoryCall,
  readBrokerFactoryAudit,
  type BrokerFactoryAuditEntry,
} from "./audit";
export {
  REMOTE_HEALTHCHECK_FLAG,
  REMOTE_HEALTH_TIMEOUT_MS,
  remoteHealthCheckEnabled,
  runRemoteHealthCheck,
  type RemoteCheckResult,
} from "./health";
export { PaperBrokerAdapter } from "./paper";
export { StubBrokerAdapter, type StubVenueId } from "./stubs";
export { BitunixBrokerAdapter } from "./bitunix";
export { AlpacaBrokerAdapter } from "./alpaca";
