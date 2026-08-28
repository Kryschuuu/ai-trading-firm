/**
 * Live-Trading-Gate (Task 11) — öffentlicher Einstieg.
 *
 *   states:     9 Zustände, 8 legale Übergänge (kanonische Matrix)
 *   service:    LiveGateService — transition/disable/kill/clearKill/history
 *   enforcer:   Single Point of Enforcement (assertLiveOrderAllowed)
 *   checks:     TransitionCheck + BrokerGatePort (venue-agnostisch)
 *   store:      atomare Per-Venue-State-Files + Crash-Recovery
 *   audit:      append-only NDJSON + Hash-Kette
 *   suite:      Security-Suite-Stamp (CI-Kennung)
 *   killFile:   persistente Failsafe-Sperrdatei des Kill-Switches
 *
 * WICHTIG: Dieses Modul SCHALTET KEIN LIVE EIN. Es implementiert nur den
 * ordnungsgemäßen, auditierbaren Weg (Menschen + Checks + CI). Nach dem Merge
 * dieses Tasks bleibt Live OFF (kein State-File, Flags false, kein Suite-Stamp).
 */
export {
  LIVE_GATE_STATES,
  LIVE_GATE_TRANSITIONS,
  LEGAL_ADVANCE_KEYS,
  LIVE_GATE_ERROR_CODES,
  LiveGateError,
  isLegalAdvance,
  isLiveGateState,
  liveGateErrorStatus,
  liveGateStateRank,
  transitionDef,
  type LiveGateCheckId,
  type LiveGateErrorCode,
  type LiveGateState,
  type LiveGateTransitionDef,
} from "./states";

export {
  LIVE_GATE_POLICY_VERSION,
  liveGateConfig,
  liveGateDataDir,
  humanApprovalRequired,
  platformLiveFromEnv,
  venueEnabledFlagName,
  venueEnabledFromEnv,
  venueLiveFlagFromEnv,
  venueLiveFlagName,
  type LiveGateConfig,
  type LiveGateEnv,
} from "./config";

export {
  AUDIT_FILE_NAME,
  AUDIT_GENESIS_HASH,
  AUDIT_FIELDS,
  LiveGateAudit,
  computeAuditHash,
  verifyAuditChain,
  type AuditChainHead,
  type AuditChainVerification,
  type LiveGateAuditAction,
  type LiveGateAuditEntry,
  type LiveGateAuditInput,
  type LiveGateAuditResult,
} from "./audit";

export {
  SCHEMA_VERSION,
  LiveGateStore,
  atomicWriteFile,
  createInitialVenueRecord,
  type LiveGateKillMarker,
  type LiveGatePendingTransition,
  type LiveGateVenueRecord,
} from "./store";

export {
  NO_PAPER_STATS_REASON,
  NO_TEST_ORDER_REASON,
  TRANSITION_CHECKS,
  createDefaultGatePort,
  registerGatePort,
  resetGatePortsForTests,
  resolveGatePort,
  setGatePortForTests,
  type BrokerGatePort,
  type PortPaperStats,
  type PortProbeResult,
  type TransitionCheck,
  type TransitionCheckContext,
  type TransitionCheckOutcome,
} from "./checks";

export {
  KILL_FILE_NAME,
  appendKillEntry,
  clearKillEntries,
  isKilledInFile,
  killFilePath,
  readKillFile,
  type KillFileEntry,
} from "./killFile";

export {
  SUITE_FILE_NAME,
  readSuiteStamp,
  suiteStampFile,
  validateSuiteStamp,
  writeSuiteStamp,
  type SecuritySuiteStamp,
  type SuiteStampValidation,
} from "./suite";

export {
  KILL_CLEAR_CONFIRM_PHRASE,
  KILL_CONFIRM_PHRASE,
  LiveGateService,
  type LiveGateCheckReport,
  type LiveGateKillResult,
  type LiveGateOverview,
  type LiveGateTransitionInput,
  type LiveGateTransitionResult,
  type LiveGateVenueSnapshot,
} from "./service";

export {
  LiveGateRuntime,
  getLiveGateRuntime,
  resetLiveGateRuntimesForTests,
} from "./runtime";

export {
  assertLiveOrderAllowed,
  evaluateLiveOrder,
  setVenueReadinessProvider,
  venueReadinessProviderRegistered,
  type EvaluateLiveOrderOptions,
  type LiveOrderDecision,
  type LiveOrderDenyCode,
  type VenueReadinessProvider,
} from "./enforcer";

export {
  controlPlaneReadinessProvider,
  registerControlPlaneBridge,
} from "./controlPlaneBridge";

// ── Betrieb-Singleton + Bridge-Registrierung ─────────────────────────────────

import { LiveGateService } from "./service";
import { getLiveGateRuntime, resetLiveGateRuntimesForTests } from "./runtime";
import { registerControlPlaneBridge } from "./controlPlaneBridge";

const G = globalThis as typeof globalThis & {
  __liveGateService?: LiveGateService;
};

/** Der Live-Gate-Service des Prozesses (Default-Dir aus der Env). */
export function getLiveGateService(): LiveGateService {
  if (!G.__liveGateService) {
    G.__liveGateService = new LiveGateService(getLiveGateRuntime(), process.env);
    registerControlPlaneBridge();
  }
  return G.__liveGateService;
}

/** Nur Tests: Service-Singleton + Runtimes + Gate-Ports zurücksetzen. */
export function resetLiveGateForTests(): void {
  G.__liveGateService = undefined;
  resetLiveGateRuntimesForTests();
}
