/**
 * Live-Gate für den Bitunix-Adapter (Task 07).
 *
 * Eine Live-Order wäre NUR möglich, wenn ALLE gelten:
 *   1. BITUNIX_ENABLED=true
 *   2. BITUNIX_LIVE_ENABLED=true
 *   3. LIVE_TRADING_ENABLED=true
 *   4. REQUIRE_HUMAN_APPROVAL=false
 *   5. Live-Gate-Service meldet Zustand LIVE_ENABLED
 *
 * Punkt 5 existiert in diesem Task nicht.
 * TODO(task-11): LiveGateService.enforce() — State-Machine + Hard-Gates.
 *
 * Der Live-Pfad wirft deshalb IMMER `LiveTradingGateError`. Es gibt keinen
 * stillen Fallback auf Paper.
 */
import { LiveTradingGateError } from "../../contracts/broker";
import {
  type EnvLike,
  bitunixEnabled,
  bitunixLiveEnabled,
  humanApprovalRequired,
  liveTradingEnabled,
} from "./config";
import { BitunixDisabledError } from "./errors";

export interface LiveGateSnapshot {
  bitunixEnabled: boolean;
  bitunixLiveEnabled: boolean;
  liveTradingEnabled: boolean;
  requireHumanApproval: boolean;
  /** Immer false, solange task-11 den Enforcer nicht liefert. */
  liveGateServiceEnabled: false;
  flagsWouldAllow: boolean;
}

export function snapshotLiveGate(env: EnvLike = process.env): LiveGateSnapshot {
  const flags = {
    bitunixEnabled: bitunixEnabled(env),
    bitunixLiveEnabled: bitunixLiveEnabled(env),
    liveTradingEnabled: liveTradingEnabled(env),
    requireHumanApproval: humanApprovalRequired(env),
  };
  const flagsWouldAllow =
    flags.bitunixEnabled &&
    flags.bitunixLiveEnabled &&
    flags.liveTradingEnabled &&
    !flags.requireHumanApproval;
  return {
    ...flags,
    liveGateServiceEnabled: false,
    flagsWouldAllow,
  };
}

/**
 * TODO(task-11): Diese Funktion an den Live-Gate-Service anbinden.
 * Bis dahin: IMMER throw LiveTradingGateError — auch wenn alle Flags passen.
 */
export function assertLiveOrderAllowed(venue = "BITUNIX", env: EnvLike = process.env): never {
  const snap = snapshotLiveGate(env);
  const why = snap.flagsWouldAllow
    ? "Flags wären vollständig, aber der Live-Gate-Service (State-Machine) existiert noch nicht (TODO(task-11))."
    : "Gate-Flags sind unvollständig (BITUNIX_ENABLED, BITUNIX_LIVE_ENABLED, LIVE_TRADING_ENABLED, REQUIRE_HUMAN_APPROVAL=false).";
  throw new LiveTradingGateError(venue, why);
}

/**
 * Prüft, ob der Adapter überhaupt Netz/Market-Data nutzen darf.
 */
export function assertBitunixEnabled(env: EnvLike = process.env): void {
  if (!bitunixEnabled(env)) {
    throw new BitunixDisabledError();
  }
}
