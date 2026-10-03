/**
 * Copy-Policy-Engine (STX-07-02) — pure, fail-closed pre-submit decision.
 *
 * Spread is deliberately an EXPECTED cost input (`RuleSnapshot.spreadPct` or
 * the scanner's raw relative `spread`) and is checked before submission. A
 * realized fill deviation is execution-quality evidence, not a cancellation
 * signal; this evaluator has no post-fill input or broker side effect.
 */
import { loadCopyPolicyConfig } from "./config";
import type { FollowerOrderIntent, TradeAction } from "./types";

export interface CopyPolicy {
  maxNotionalPerEvent: number;
  /** Cumulative follower notional already used during the current day. */
  maxNotionalPerDay: number;
  /** Maximum expected spread, expressed in basis points. */
  maxSlippageBps: number;
  maxOpenPositions: number;
  /** Fraction of start-of-day equity: 0.02 means 2%. */
  maxLossPerDayPct: number;
  maxLeverage: number;
  /** Kill-Switch, independent of every other policy value. */
  halted: boolean;
}

/**
 * Ablehnungsgründe. Die ersten acht sind Pre-Submit-Policy-Entscheidungen und
 * dürfen als `copy_order_links.policy_code` persistiert werden (die
 * DB-CHECK-Constraint enumeriert genau diese Menge).
 *
 * `NO_BASELINE` (07-03) ist ein **Leader-Zustands-Gate**: ohne
 * Baseline-Snapshot des Leaders gibt es keinen Copy — und **keine** Zeile in
 * `copy_order_links`. Ein Leader-Zustand ohne belastbare Evidenz darf keinen
 * Seiteneffekt haben; ein "No-Op mit Seiteneffekt" wäre genau der Fehler, den
 * die Baseline verhindern soll.
 */
export type PolicyCode =
  | "HALTED"
  | "MAX_EVENT_NOTIONAL"
  | "MAX_DAY_NOTIONAL"
  | "MAX_SLIPPAGE"
  | "MAX_POSITIONS"
  | "MAX_DAILY_LOSS"
  | "MAX_LEVERAGE"
  | "NO_MAPPING"
  | "NO_BASELINE";

export type PolicyDecision =
  | { allowed: true }
  | { allowed: false; code: PolicyCode; detail: string };

/** Minimal input facts needed to decide before a follower order is submitted. */
export interface CopyPolicyContext {
  /** Nullable until the 07-01 mapping has completed. */
  readonly followerInstrumentId: string | null;
  /** Cumulative notional before this intent, in the follower account currency. */
  readonly dayNotional: number;
  readonly openPositions: number;
  /** Equity at the start of the current day and current marked equity. */
  readonly equityAtDayStart: number;
  readonly currentEquity: number;
  /** Effective leverage to be used for this intent; spot/no-margin is 1. */
  readonly effectiveLeverage: number | null;
  /** RuleSnapshot convention: 0.04 means 0.04 percent = 4 bp. */
  readonly ruleSnapshot?: { readonly spreadPct: number | null } | null;
  /** Scanner convention: raw relative spread, e.g. 0.0004 = 4 bp. */
  readonly scannerSpread?: number | null;
}

const ACTIONS: readonly TradeAction[] = ["OPEN", "INCREASE", "DECREASE", "CLOSE"];
const SAFE_INSTRUMENT_ID = /^[A-Za-z0-9_.:/-]{1,128}$/;

function denied(code: PolicyCode, detail: string): PolicyDecision {
  return { allowed: false, code, detail };
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function expectedSpreadBps(context: CopyPolicyContext): number | null {
  const observations: number[] = [];

  if (context.ruleSnapshot !== undefined && context.ruleSnapshot !== null) {
    const spreadPct = context.ruleSnapshot.spreadPct;
    if (spreadPct !== null) {
      if (!finiteNonNegative(spreadPct)) return null;
      observations.push(spreadPct * 100);
    }
  }

  if (context.scannerSpread !== undefined && context.scannerSpread !== null) {
    if (!finiteNonNegative(context.scannerSpread)) return null;
    observations.push(context.scannerSpread * 10_000);
  }

  if (observations.length === 0) return null;
  const conservative = Math.max(...observations);
  return Number.isFinite(conservative) ? conservative : null;
}

/**
 * Evaluate one follower intent against a validated, versioned CopyPolicy.
 *
 * Any malformed policy/context or unexpected runtime error returns `HALTED`;
 * callers never receive an optimistic allow because evaluation failed.
 */
export function evaluatePolicy(
  intent: FollowerOrderIntent,
  policy: CopyPolicy,
  context: CopyPolicyContext,
): PolicyDecision {
  try {
    // The kill switch is a veto before all other policy fields are inspected.
    if ((policy as CopyPolicy | null)?.halted === true) {
      return denied("HALTED", "Copy-Policy-Kill-Switch ist aktiv.");
    }

    // Validates the loaded JSON body and enforces the immutable risk ceilings.
    const validatedPolicy = loadCopyPolicyConfig(policy).policy;
    if (validatedPolicy.halted) {
      return denied("HALTED", "Copy-Policy-Kill-Switch ist aktiv.");
    }

    if (!intent || typeof intent !== "object" || !context || typeof context !== "object") {
      return denied("HALTED", "Intent oder Policy-Kontext ist nicht verfügbar.");
    }
    if (!ACTIONS.includes(intent.action)) {
      return denied("HALTED", "Unbekannte Handlungsabsicht.");
    }

    const instrumentId = context.followerInstrumentId;
    if (typeof instrumentId !== "string" || !SAFE_INSTRUMENT_ID.test(instrumentId.trim())) {
      return denied("NO_MAPPING", "Follower-Instrument ist noch nicht sicher zugeordnet.");
    }

    if (!finiteNonNegative(intent.notional) || intent.notional > 1e15) {
      return denied("HALTED", "Follower-Notional ist ungültig.");
    }
    if (!finiteNonNegative(context.dayNotional) || context.dayNotional > 1e15) {
      return denied("HALTED", "Kumuliertes Tages-Notional ist nicht belastbar.");
    }
    if (
      typeof context.openPositions !== "number" ||
      !Number.isSafeInteger(context.openPositions) ||
      context.openPositions < 0
    ) {
      return denied("HALTED", "Anzahl offener Positionen ist nicht belastbar.");
    }
    if (
      typeof context.equityAtDayStart !== "number" ||
      !Number.isFinite(context.equityAtDayStart) ||
      context.equityAtDayStart <= 0 ||
      typeof context.currentEquity !== "number" ||
      !Number.isFinite(context.currentEquity)
    ) {
      return denied("HALTED", "Equity-Stand für die Tagesverlustprüfung fehlt.");
    }
    if (
      typeof context.effectiveLeverage !== "number" ||
      !Number.isFinite(context.effectiveLeverage) ||
      context.effectiveLeverage < 1
    ) {
      return denied("HALTED", "Effektiver Hebel ist nicht belastbar.");
    }

    if (intent.notional > validatedPolicy.maxNotionalPerEvent) {
      return denied("MAX_EVENT_NOTIONAL", "Follower-Notional pro Ereignis überschreitet das Copy-Limit.");
    }
    if (context.dayNotional + intent.notional > validatedPolicy.maxNotionalPerDay) {
      return denied("MAX_DAY_NOTIONAL", "Kumuliertes Tages-Notional würde das Copy-Limit überschreiten.");
    }

    const spreadBps = expectedSpreadBps(context);
    if (spreadBps === null || spreadBps > validatedPolicy.maxSlippageBps) {
      return denied(
        "MAX_SLIPPAGE",
        "Erwarteter Spread fehlt oder überschreitet das Pre-Submit-Limit.",
      );
    }

    if (intent.action === "OPEN" && context.openPositions >= validatedPolicy.maxOpenPositions) {
      return denied("MAX_POSITIONS", "Maximale Anzahl offener Follower-Positionen ist erreicht.");
    }

    const dailyLossPct = Math.max(
      0,
      (context.equityAtDayStart - context.currentEquity) / context.equityAtDayStart,
    );
    if (!Number.isFinite(dailyLossPct) || dailyLossPct >= validatedPolicy.maxLossPerDayPct) {
      return denied("MAX_DAILY_LOSS", "Tagesverlust relativ zum Start-Equity erreicht das Copy-Limit.");
    }

    if (context.effectiveLeverage > validatedPolicy.maxLeverage) {
      return denied("MAX_LEVERAGE", "Effektiver Hebel überschreitet das Copy-Limit.");
    }

    return { allowed: true };
  } catch {
    // Includes policy validation failures and unexpected evaluator exceptions.
    return denied("HALTED", "Policy-Auswertung fehlgeschlagen; fail-closed blockiert.");
  }
}
