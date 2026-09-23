/**
 * Strategy-Lifecycle (RMA-P1-05, v1.73.0) — öffentlicher Einstieg.
 *
 *   states:    kanonische State-Machine (9 Zustände, erlaubte Kanten, Rollen)
 *   policies:  versionierte Promotion-Gates (Backtest/Paper, fail-closed)
 *   drift:     Backtest↔Paper↔Live-Drift (Segmente, Toleranzen, Confidence)
 *   evidence:  immutable Evidence-Referenzen (Hash + Idempotency)
 *   service:   Persistenz, atomare Transitions, Degradation, Order-Gate-DB-Pfad
 *   orderGate: pure Live-Order-Entscheidung (off | monitor | enforce)
 *   config:    Feature-Flags `STRATEGY_LIFECYCLE_*`
 */
export {
  STRATEGY_LIFECYCLE_STATES,
  LIFECYCLE_TRANSITIONS,
  LIFECYCLE_EVIDENCE_KINDS,
  LIFECYCLE_ROLES,
  LIVE_CAPABLE_STATES,
  BLOCKED_ORDER_STATES,
  LifecycleTransitionError,
  allowedTargets,
  canTransition,
  isStrategyLifecycleState,
  roleAllowed,
  triggerAllowed,
  transitionDef,
  type LifecycleEvidenceKind,
  type LifecycleErrorCode,
  type LifecycleRole,
  type LifecycleTrigger,
  type LifecycleTransitionDef,
  type StrategyLifecycleState,
} from "./states";

export {
  DEFAULT_PROMOTION_POLICY,
  PROMOTION_POLICY_BOUNDS,
  evidenceAgeStatus,
  evaluateBacktestGate,
  evaluatePaperGate,
  resolvePromotionPolicy,
  type BacktestEvidenceInput,
  type GateCheck,
  type GateCheckStatus,
  type GateEvaluation,
  type PaperEvidenceInput,
  type PromotionPolicy,
} from "./policies";

export {
  DEFAULT_DRIFT_POLICY,
  DRIFT_METRIC_SPECS,
  DRIFT_SEGMENTS,
  evaluateDrift,
  metricWindow,
  type DriftEvaluation,
  type DriftMetricSpec,
  type DriftPolicy,
  type DriftSegment,
  type DriftVerdict,
  type MetricDriftResult,
  type MetricPair,
  type MetricWindow,
  type SegmentDriftResult,
} from "./drift";

export {
  canonicalJson,
  evidenceContentHash,
  evidenceIdempotencyKey,
  normalizeStrategyKey,
  normalizeStrategyVersion,
  transitionKey,
  type EvidenceInput,
  type EvidenceProvenance,
  type EvidenceRef,
} from "./evidence";

export {
  STRATEGY_LIFECYCLE_BOUNDS,
  STRATEGY_LIFECYCLE_COOLDOWN_FLAG,
  STRATEGY_LIFECYCLE_DEFAULTS,
  STRATEGY_LIFECYCLE_MIN_FACTOR_FLAG,
  STRATEGY_LIFECYCLE_MODES,
  STRATEGY_LIFECYCLE_MODE_FLAG,
  lifecycleEnforce,
  lifecycleGatesActive,
  strategyLifecycleConfig,
  type StrategyLifecycleConfig,
  type StrategyLifecycleMode,
} from "./config";

export {
  currentLifecycleMode,
  evaluateLifecycleOrderGate,
  type LifecycleGateCode,
  type LifecycleGateDecision,
  type LifecycleGateInput,
} from "./orderGate";

export {
  DEFAULT_DRIFT_POLICY as SERVICE_DEFAULT_DRIFT_POLICY,
  authorizeLiveOrder,
  checkAndDegrade,
  ensureLifecycleDraft,
  evaluatePromotionGate,
  getLifecycleState,
  getLifecycleStatus,
  listEvidence,
  listLifecycleStates,
  listTransitions,
  recordEvidence,
  refreshLifecycleRiskFromStates,
  requestTransition,
  targetRiskScaleFor,
  type AuthorizeLiveOrderRequest,
  type DriftCheckRequest,
  type DriftCheckResult,
  type LifecycleActor,
  type LifecycleDbLike,
  type LifecycleStatusDto,
  type PromotionGateInput,
  type PromotionGateResult,
  type RecordEvidenceRequest,
  type StateRow,
  type EvidenceRow,
  type TransitionOutcome,
  type TransitionRequest,
  type TransitionRow,
} from "./service";
