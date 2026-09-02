/**
 * Live-Gate-Integration des Alpaca-Adapters (Task 12 + Task 11).
 *
 * Delegiert an den ZENTRALEN Enforcer (src/live-gate/enforcer.ts — Single
 * Point of Enforcement). Eine Live-Order wäre nur möglich, wenn ALLES gilt:
 *   1. ALPACA_ENABLED=true
 *   2. ALPACA_LIVE_ENABLED=true
 *   3. LIVE_TRADING_ENABLED=true
 *   4. Kill-Switch nicht aktiv (Memory + Failsafe-Datei)
 *   5. Live-Gate-State-Machine: LIVE_ENABLED (persistiert, 8 Übergänge
 *      inkl. Human-Gate mit Cooldown/4-Augen)
 *   6. Security-Suite security-live-gate bestanden (persistierter CI-Stamp)
 *   7. Control-Plane-Venue-State aktiv
 *   8. (REQUIRE_HUMAN_APPROVAL=false ODER State >= HUMAN_APPROVED)
 *
 * Der Default-Zustand verweigert JEDE Live-Order (State DISCONNECTED,
 * Flags false, kein Suite-Stamp) — fail-safe.
 */
import { LiveTradingGateError } from "../../contracts/broker";
import {
  type EnvLike,
  alpacaEnabled,
  alpacaLiveEnabled,
  humanApprovalRequired,
  liveTradingEnabled,
} from "./config";
import { AlpacaDisabledError } from "./errors";
import {
  assertLiveOrderAllowed as enforceCentral,
  evaluateLiveOrder,
} from "@/live-gate/enforcer";

export interface AlpacaLiveGateSnapshot {
  alpacaEnabled: boolean;
  alpacaLiveEnabled: boolean;
  liveTradingEnabled: boolean;
  requireHumanApproval: boolean;
  liveGateServiceEnabled: true;
  flagsWouldAllow: boolean;
  decision: {
    allowed: boolean;
    code: string;
    reason: string;
    state: string | null;
  };
}

export function snapshotAlpacaLiveGate(env: EnvLike = process.env): AlpacaLiveGateSnapshot {
  const flags = {
    alpacaEnabled: alpacaEnabled(env),
    alpacaLiveEnabled: alpacaLiveEnabled(env),
    liveTradingEnabled: liveTradingEnabled(env),
    requireHumanApproval: humanApprovalRequired(env),
  };
  const flagsWouldAllow =
    flags.alpacaEnabled &&
    flags.alpacaLiveEnabled &&
    flags.liveTradingEnabled &&
    !flags.requireHumanApproval;
  const decision = evaluateLiveOrder("ALPACA", { env, audit: false });
  return {
    ...flags,
    liveGateServiceEnabled: true,
    flagsWouldAllow,
    decision: {
      allowed: decision.allowed,
      code: decision.code,
      reason: decision.reason,
      state: decision.state,
    },
  };
}

/**
 * Zentrale Live-Order-Durchsetzung für Alpaca (Task 11): delegiert an den
 * Enforcer. Wirft bei JEDEM Deny `LiveTradingGateError` (mit konkretem Grund);
 * erlaubt nur bei bestandener Gesamtprüfung.
 */
export function assertLiveOrderAllowed(
  venue = "ALPACA",
  env: EnvLike = process.env
): void {
  enforceCentral(venue, { env });
}

/**
 * Prüft, ob der Adapter überhaupt Netz/Market-Data nutzen darf.
 */
export function assertAlpacaEnabled(env: EnvLike = process.env): void {
  if (!alpacaEnabled(env)) {
    throw new AlpacaDisabledError();
  }
}

// Re-export für Tests
export { LiveTradingGateError };
