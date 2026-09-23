/**
 * Live-Order-Gate der Strategy-Lifecycle (RMA-P1-05) — reine Entscheidung.
 *
 * Wird VOR dem Broker-/Risk-Gate für Live-Orders herangezogen (zusätzlich,
 * nie statt, der bestehenden Gates). Modus `off` = Allow (Default),
 * `monitor` = bewerten + Audit, aber Allow, `enforce` = fail-closed Deny,
 * wenn die Strategieversion nicht autorisiert ist oder der Zustand Live
 * nicht erlaubt.
 *
 * Race-Conditions: Die Entscheidung ist funktional — der Service liest den
 * Zustand FOR UPDATE / mit `state_seq`-Optimismus und der Orderpfad hält den
 * frischen Check dicht am Submit (siehe `service.authorizeLiveOrder`).
 */
import {
  LIVE_CAPABLE_STATES,
  isStrategyLifecycleState,
  type StrategyLifecycleState,
} from "./states";
import {
  lifecycleEnforce,
  lifecycleGatesActive,
  strategyLifecycleConfig,
  type StrategyLifecycleMode,
} from "./config";
import { evidenceAgeStatus, DEFAULT_PROMOTION_POLICY } from "./policies";

export type LifecycleGateCode =
  | "ALLOWED"
  | "LIFECYCLE_DISABLED"
  | "LIFECYCLE_MONITOR_ALLOW"
  | "STRATEGY_REQUIRED"
  | "STRATEGY_UNKNOWN"
  | "STATE_NOT_FOUND"
  | "STATE_NOT_LIVE"
  | "STATE_PAUSED"
  | "EVIDENCE_STALE"
  | "COOLDOWN_ACTIVE"
  | "LIFECYCLE_ERROR";

export interface LifecycleGateInput {
  readonly mode: StrategyLifecycleMode;
  readonly strategyKey: string | null;
  readonly strategyVersion: number | null;
  /** Persistierter Zustand — null = nicht gefunden/fail-closed. */
  readonly state: {
    readonly state: string;
    readonly riskScale: number | null;
    readonly cooldownUntilMs: number | null;
    readonly lastEvidenceAvailableAtMs: number | null;
    readonly stateSeq: number;
  } | null;
  readonly nowMs: number;
  /** Optionaler Config-Override (z. B. Policy-Alter-Grenze). */
  readonly evidenceMaxAgeMs?: number;
}

export interface LifecycleGateDecision {
  readonly allowed: boolean;
  readonly code: LifecycleGateCode;
  readonly reason: string;
  readonly mode: StrategyLifecycleMode;
  readonly strategyKey: string | null;
  readonly strategyVersion: number | null;
  readonly lifecycleState: StrategyLifecycleState | null;
  readonly riskScale: number | null;
  readonly policyVersion: string;
  /** true = im enforce Pfad tatsächlich blockiert (für Metriken/Audit). */
  readonly blocked: boolean;
}

/**
 * Pure Entscheidung — kein I/O. Reihenfolge (fail-closed, erste Verletzung
 * gewinnt): Modus → Strategie-Referenz → Zustand → Live-Fähigkeit →
 * Cooldown → Evidenz-Frische.
 */
export function evaluateLifecycleOrderGate(input: LifecycleGateInput): LifecycleGateDecision {
  const base = {
    mode: input.mode,
    strategyKey: input.strategyKey,
    strategyVersion: input.strategyVersion,
    lifecycleState: null as StrategyLifecycleState | null,
    riskScale: null as number | null,
    policyVersion: DEFAULT_PROMOTION_POLICY.version,
    blocked: false,
  };

  if (!lifecycleGatesActive(input.mode)) {
    return {
      ...base,
      allowed: true,
      code: "LIFECYCLE_DISABLED",
      reason: "STRATEGY_LIFECYCLE_MODE=off — Lifecycle-Gate deaktiviert (Default, kompatibel).",
    };
  }

  if (!input.strategyKey || input.strategyVersion === null || input.strategyVersion === undefined) {
    const deny = lifecycleEnforce(input.mode);
    return {
      ...base,
      allowed: !deny,
      code: "STRATEGY_REQUIRED",
      blocked: deny,
      reason: deny
        ? "STRATEGY_REQUIRED: Live-Order ohne autorisierte Strategieversion — fail-closed abgelehnt."
        : "STRATEGY_REQUIRED: Live-Order ohne Strategieversion (monitor: würden blockieren).",
    };
  }

  if (!input.state) {
    const deny = lifecycleEnforce(input.mode);
    return {
      ...base,
      allowed: !deny,
      code: "STATE_NOT_FOUND",
      blocked: deny,
      reason: deny
        ? "STATE_NOT_FOUND: kein Lifecycle-Zustand für diese Strategieversion — fail-closed."
        : "STATE_NOT_FOUND: kein Lifecycle-Zustand (monitor: würden blockieren).",
    };
  }

  if (!isStrategyLifecycleState(input.state.state)) {
    const deny = lifecycleEnforce(input.mode);
    return {
      ...base,
      allowed: !deny,
      code: "STRATEGY_UNKNOWN",
      blocked: deny,
      reason: `STRATEGY_UNKNOWN: unbekannter Zustand "${String(input.state.state).slice(0, 32)}".`,
    };
  }

  const lifecycleState = input.state.state;
  const riskScale =
    input.state.riskScale !== null && Number.isFinite(input.state.riskScale)
      ? Math.min(Math.max(input.state.riskScale, 0), 1)
      : null;

  const withState = {
    ...base,
    lifecycleState,
    riskScale,
  };

  // Cooldown nach Degradation/Pause: kein Live-Einstieg, bevor er abgelaufen.
  const cooldownUntil = input.state.cooldownUntilMs;
  if (
    cooldownUntil !== null &&
    Number.isFinite(cooldownUntil) &&
    input.nowMs < cooldownUntil
  ) {
    const deny = lifecycleEnforce(input.mode);
    return {
      ...withState,
      allowed: !deny,
      code: "COOLDOWN_ACTIVE",
      blocked: deny,
      reason: `COOLDOWN_ACTIVE: Recovery-Cooldown bis ${new Date(cooldownUntil).toISOString()} — keine Live-Promotion.`,
    };
  }

  if (lifecycleState === "PAUSED" || lifecycleState === "DEGRADED") {
    const deny = lifecycleEnforce(input.mode);
    return {
      ...withState,
      allowed: !deny,
      code: "STATE_PAUSED",
      blocked: deny,
      reason: `STATE_PAUSED: Zustand ${lifecycleState} erlaubt keine Live-Einstiege.`,
    };
  }

  if (!LIVE_CAPABLE_STATES.includes(lifecycleState)) {
    const deny = lifecycleEnforce(input.mode);
    return {
      ...withState,
      allowed: !deny,
      code: "STATE_NOT_LIVE",
      blocked: deny,
      reason: `STATE_NOT_LIVE: Zustand ${lifecycleState} ist kein autorisierter Live-Zustand.`,
    };
  }

  // Evidenz-Frische der letzten Zustands-Evidenz
  const maxAge = input.evidenceMaxAgeMs ?? DEFAULT_PROMOTION_POLICY.backtestEvidenceMaxAgeMs;
  const ageStatus = evidenceAgeStatus(
    input.state.lastEvidenceAvailableAtMs,
    maxAge,
    input.nowMs
  );
  if (ageStatus !== "PASS") {
    const deny = lifecycleEnforce(input.mode);
    return {
      ...withState,
      allowed: !deny,
      code: "EVIDENCE_STALE",
      blocked: deny,
      reason: `EVIDENCE_STALE: letzte Evidenz ${ageStatus.toLowerCase()} — fail-closed.`,
    };
  }

  if (riskScale !== null && riskScale <= 0) {
    const deny = lifecycleEnforce(input.mode);
    return {
      ...withState,
      allowed: !deny,
      code: "STATE_NOT_LIVE",
      blocked: deny,
      reason: "RISK_SCALE_ZERO: Lifecycle-Risikofaktor 0 blockiert neue Einstiege.",
    };
  }

  if (input.mode === "monitor") {
    return {
      ...withState,
      allowed: true,
      code: "LIFECYCLE_MONITOR_ALLOW",
      reason: `MONITOR: Zustand ${lifecycleState} autorisiert Live (Beobachtungsmodus, kein Block).`,
    };
  }

  return {
    ...withState,
    allowed: true,
    code: "ALLOWED",
    reason: `LIVE_ORDER_LIFECYCLE_OK: ${input.strategyKey}@v${input.strategyVersion} in ${lifecycleState}.`,
  };
}

/** Default-Leser der Mode-Flag (Env). */
export function currentLifecycleMode(
  env: Record<string, string | undefined> = process.env
): StrategyLifecycleMode {
  return strategyLifecycleConfig(env).mode;
}
