/**
 * Live-Gate-Integration des Bitunix-Adapters (Task 07 + Task 11).
 *
 * Seit Task 11 delegiert dieser Modul an den ZENTRALEN Enforcer
 * (src/live-gate/enforcer.ts — Single Point of Enforcement). Eine Live-Order
 * wäre nur möglich, wenn ALLES gilt:
 *   1. BITUNIX_ENABLED=true
 *   2. BITUNIX_LIVE_ENABLED=true
 *   3. LIVE_TRADING_ENABLED=true
 *   4. Kill-Switch nicht aktiv (Memory + Failsafe-Datei)
 *   5. Live-Gate-State-Machine: LIVE_ENABLED (persistiert, 8 Übergänge
 *      inkl. Human-Gate mit Cooldown/4-Augen)
 *   6. Security-Suite security-live-gate bestanden (persistierter CI-Stamp)
 *   7. Control-Plane-Venue-State aktiv
 *   8. (REQUIRE_HUMAN_APPROVAL=false ODER State >= HUMAN_APPROVED)
 *
 * Der Default-Zustand nach Task 11 verweigert weiterhin JEDE Live-Order
 * (State DISCONNECTED, Flags false, kein Suite-Stamp) — fail-safe.
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
import {
  assertLiveOrderAllowed as enforceCentral,
  evaluateLiveOrder,
} from "@/live-gate/enforcer";

export interface LiveGateSnapshot {
  bitunixEnabled: boolean;
  bitunixLiveEnabled: boolean;
  liveTradingEnabled: boolean;
  requireHumanApproval: boolean;
  /** Seit Task 11: der zentrale Enforcer ist aktiv. */
  liveGateServiceEnabled: true;
  /** Würden die Flags allein genügen? (Enforcer verlangt zusätzlich State etc.) */
  flagsWouldAllow: boolean;
  /** Vollständige Enforcer-Entscheidung (read-only, ohne Audit). */
  decision: {
    allowed: boolean;
    code: string;
    reason: string;
    state: string | null;
  };
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
  const decision = evaluateLiveOrder("BITUNIX", { env, audit: false });
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
 * Zentrale Live-Order-Durchsetzung für Bitunix (Task 11): delegiert an den
 * Enforcer. Wirft bei JEDEM Deny `LiveTradingGateError` (mit konkretem Grund);
 * erlaubt nur bei bestandener Gesamtprüfung (State-Machine + Flags + Suite +
 * Control Plane + kein Kill).
 */
export function assertLiveOrderAllowed(
  venue = "BITUNIX",
  env: EnvLike = process.env
): void {
  enforceCentral(venue, { env });
}

/**
 * Prüft, ob der Adapter überhaupt Netz/Market-Data nutzen darf.
 */
export function assertBitunixEnabled(env: EnvLike = process.env): void {
  if (!bitunixEnabled(env)) {
    throw new BitunixDisabledError();
  }
}
