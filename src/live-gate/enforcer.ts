/**
 * ENFORCEMENT-LAYER (Task 11) — der SINGLE POINT OF ENFORCEMENT für Live-Orders.
 *
 * `assertLiveOrderAllowed(venue)` ist der einzige Torwächter vor jeder Venue-
 * Order-Schnittstelle. Die Broker-Factory (`getBroker(…, "live")`) und der
 * Bitunix-Adapter rufen ihn — Adapter übergeben NIEMALS direkt an die Venue.
 *
 * Eine Live-Order ist NUR erlaubt, wenn ALLE Bedingungen erfüllt sind:
 *   1. Venue bekannt (Whitelist)
 *   2. Adapter-Capability `live` (PAPER kann nie live)
 *   3. KEIN Kill-Switch (prozesslokal + persistente Failsafe-Datei)
 *   4. Machine-State = LIVE_ENABLED (persistierte State-Machine)
 *   5. `{VENUE}_ENABLED=true`
 *   6. LIVE_TRADING_ENABLED=true (Plattform-Flag)
 *   7. `{VENUE}_LIVE_ENABLED=true` (Venue-Live-Flag)
 *   8. REQUIRE_HUMAN_APPROVAL=false ODER State-Rang ≥ HUMAN_APPROVED
 *   9. Security-Suite `security-live-gate` bestanden (persistierter CI-Stamp)
 *  10. Venue-State in der Control Plane aktiv (Readiness-Provider)
 *
 * FAIL-SAFE: Fehlt, ist unklar oder widersprüchlich IRGENDETWAS → DENY + Audit.
 * Der Enforcer liest ausschließlich persistierte Quellen (State-Files, Env-
 * Flags, Suite-Stamp, Kill-Datei) — keine UI-Flags, keine Agenten-Aussagen.
 */
import { LiveTradingGateError, BROKER_VENUE_IDS, type BrokerVenueId } from "@/contracts/broker";
import { VENUE_CAPABILITIES } from "@/brokers/capabilities";
import {
  LIVE_GATE_POLICY_VERSION,
  humanApprovalRequired,
  liveGateConfig,
  platformLiveFromEnv,
  venueEnabledFromEnv,
  venueLiveFlagFromEnv,
  venueLiveFlagName,
  type LiveGateEnv,
} from "./config";
import { getLiveGateRuntime } from "./runtime";
import { readSuiteStamp, validateSuiteStamp } from "./suite";
import { liveGateStateRank } from "./states";

export type LiveOrderDenyCode =
  | "UNKNOWN_VENUE"
  | "VENUE_NOT_LIVE_CAPABLE"
  | "KILL_SWITCH_ACTIVE"
  | "STATE_NOT_LIVE_ENABLED"
  | "VENUE_FLAG_MISSING"
  | "PLATFORM_FLAG_MISSING"
  | "VENUE_LIVE_FLAG_MISSING"
  | "HUMAN_APPROVAL_REQUIRED"
  | "SECURITY_SUITE_INVALID"
  | "CONTROL_PLANE_UNKNOWN"
  | "CONTROL_PLANE_INACTIVE";

export interface LiveOrderDecision {
  venue: string;
  allowed: boolean;
  /** "ALLOWED" oder der konkrete Deny-Code. */
  code: "ALLOWED" | LiveOrderDenyCode;
  reason: string;
  state: string | null;
  flags: {
    venueEnabled: boolean;
    platformLive: boolean;
    venueLiveFlag: boolean;
    requireHumanApproval: boolean;
  };
  suite: { valid: boolean; runId: string | null; source: string | null } | null;
  controlPlaneActive: boolean | null;
  killed: boolean;
  policyVersion: string;
}

export interface EvaluateLiveOrderOptions {
  /** Env für Flags (Adapter reichen ihre Env; Default process.env). */
  env?: LiveGateEnv;
  /** Data-Dir-Override (Default aus Env LIVE_GATE_DATA_DIR). */
  dir?: string;
  /** Service-intern: Policy-Checks ohne State-Bedingung (bei HUMAN_APPROVED). */
  skipStateCheck?: boolean;
  /** Read-only-Auskunft (kein Audit-Eintrag) für Status-Snapshots. */
  audit?: boolean;
  actor?: string;
  now?: number;
}

/**
 * Venue-Readiness der Control Plane (Verbindung aktiv?). Bewusst als
 * Provider registriert (Dependency Inversion) — der Enforcer importiert die
 * Control Plane NICHT (keine zirkuläre Abhängigkeit, venue-agnostisch).
 * Kein Provider registriert → CONTROL_PLANE_UNKNOWN → DENY (fail-safe).
 */
export type VenueReadinessProvider = (venue: string) => { active: boolean } | null;

let venueReadinessProvider: VenueReadinessProvider | null = null;

export function setVenueReadinessProvider(provider: VenueReadinessProvider | null): void {
  venueReadinessProvider = provider;
}

export function venueReadinessProviderRegistered(): boolean {
  return venueReadinessProvider !== null;
}

function normalizeVenueId(raw: string): BrokerVenueId | null {
  const v = raw.trim().toUpperCase();
  return (BROKER_VENUE_IDS as readonly string[]).includes(v) ? (v as BrokerVenueId) : null;
}

function denyReason(code: string, detail: string): string {
  return `LIVE_GATE_LOCKED: ${code} — ${detail} (docs/LIVE_TRADING.md)`;
}

/**
 * Bewertet eine Live-Order-Anfrage VOLLSTÄNDIG (pure Entscheidung + optional
 * Audit). Wirft nie — die Entscheidung steht im Rückgabeobjekt.
 */
export function evaluateLiveOrder(
  venueRaw: string,
  opts: EvaluateLiveOrderOptions = {}
): LiveOrderDecision {
  const env = opts.env ?? (process.env as LiveGateEnv);
  const runtime = getLiveGateRuntime(env);
  const config = liveGateConfig(env);
  const actor = opts.actor ?? "system";

  const base = {
    flags: {
      venueEnabled: false,
      platformLive: platformLiveFromEnv(env),
      venueLiveFlag: false,
      requireHumanApproval: humanApprovalRequired(env),
    },
    suite: null as LiveOrderDecision["suite"],
    controlPlaneActive: null as boolean | null,
    killed: false,
  };

  const finish = (
    allowed: boolean,
    code: "ALLOWED" | LiveOrderDenyCode,
    detail: string,
    venue: string,
    state: string | null,
    extra?: Partial<Pick<LiveOrderDecision, "flags" | "suite" | "controlPlaneActive" | "killed">>
  ): LiveOrderDecision => {
    const decision: LiveOrderDecision = {
      venue,
      allowed,
      code,
      reason: allowed ? `LIVE_ORDER_ALLOWED: ${detail}` : denyReason(code, detail),
      state,
      ...base,
      ...extra,
      policyVersion: LIVE_GATE_POLICY_VERSION,
    };
    if (opts.audit !== false) {
      runtime.audit.append({
        actor,
        venue,
        from: state,
        to: state,
        action: "enforce",
        result: allowed ? "OK" : "DENIED",
        reason: `${code}: ${detail}`,
      });
    }
    return decision;
  };

  // 1) Venue-Whitelist
  const venue = normalizeVenueId(venueRaw);
  if (!venue) {
    return finish(false, "UNKNOWN_VENUE", `Unbekanntes Venue "${String(venueRaw).slice(0, 40)}".`, String(venueRaw).slice(0, 40), null);
  }

  // 2) Capability live (PAPER: false → kann nie live)
  const caps = VENUE_CAPABILITIES[venue];
  if (!caps || caps.live !== true) {
    return finish(false, "VENUE_NOT_LIVE_CAPABLE", `Adapter-Capability live=false für ${venue}.`, venue, null);
  }

  // 3) Kill-Switch (Memory + persistente Failsafe-Datei)
  const kill = runtime.isKilled(venue);
  if (kill) {
    return finish(false, "KILL_SWITCH_ACTIVE", `Kill-Switch aktiv (scope ${kill.scope}, ${kill.at}, actor ${kill.actor}): ${kill.reason}`, venue, null, { killed: true });
  }

  // 4) Machine-State (persistiert; Lese-Fehler → DISCONNECTED → deny)
  const record = runtime.store.read(venue);
  const state = record.state;
  if (!opts.skipStateCheck && state !== "LIVE_ENABLED") {
    return finish(false, "STATE_NOT_LIVE_ENABLED", `Live-Gate-State ist ${state}, nicht LIVE_ENABLED — kompletter Durchlauf der State-Machine erforderlich.`, venue, state);
  }
  if (opts.skipStateCheck && state !== "HUMAN_APPROVED" && state !== "LIVE_ENABLED") {
    return finish(false, "STATE_NOT_LIVE_ENABLED", `Enablement-Voraussetzung verlangt State HUMAN_APPROVED/LIVE_ENABLED, ist aber ${state}.`, venue, state);
  }

  const flags = {
    venueEnabled: venueEnabledFromEnv(venue, env),
    platformLive: platformLiveFromEnv(env),
    venueLiveFlag: venueLiveFlagFromEnv(venue, env),
    requireHumanApproval: humanApprovalRequired(env),
  };

  // 5) Venue-Adapter-Flag
  if (!flags.venueEnabled) {
    return finish(false, "VENUE_FLAG_MISSING", `${venue}_ENABLED ist nicht true.`, venue, state, { flags });
  }
  // 6) Plattform-Live-Flag
  if (!flags.platformLive) {
    return finish(false, "PLATFORM_FLAG_MISSING", "LIVE_TRADING_ENABLED ist nicht true.", venue, state, { flags });
  }
  // 7) Venue-Live-Flag
  if (!flags.venueLiveFlag) {
    return finish(false, "VENUE_LIVE_FLAG_MISSING", `${venueLiveFlagName(venue)} ist nicht true.`, venue, state, { flags });
  }
  // 8) Human-Approval-Klausel: Flag=false ODER State ≥ HUMAN_APPROVED
  if (flags.requireHumanApproval && liveGateStateRank(state) < liveGateStateRank("HUMAN_APPROVED")) {
    return finish(false, "HUMAN_APPROVAL_REQUIRED", "REQUIRE_HUMAN_APPROVAL=true und State-Rang < HUMAN_APPROVED.", venue, state, { flags });
  }

  // 9) Security-Suite-Stamp (persistierte CI-Kennung)
  const stamp = readSuiteStamp(runtime.dir);
  const suiteValidation = validateSuiteStamp(stamp, {
    maxAgeMs: config.suiteMaxAgeMs,
    now: opts.now,
  });
  const suiteInfo = stamp
    ? { valid: suiteValidation.valid, runId: stamp.runId, source: stamp.source as string }
    : { valid: false, runId: null, source: null };
  if (!suiteValidation.valid) {
    return finish(false, "SECURITY_SUITE_INVALID", suiteValidation.reason, venue, state, { flags, suite: suiteInfo });
  }

  // 10) Control-Plane-Venue-State aktiv (Provider; unbekannt → deny)
  if (!venueReadinessProvider) {
    return finish(false, "CONTROL_PLANE_UNKNOWN", "Kein Control-Plane-Readiness-Provider registriert (Integration fehlt) — im Zweifel deny.", venue, state, { flags, suite: suiteInfo });
  }
  let readiness: { active: boolean } | null = null;
  try {
    readiness = venueReadinessProvider(venue);
  } catch {
    readiness = null;
  }
  if (!readiness) {
    return finish(false, "CONTROL_PLANE_UNKNOWN", "Control-Plane-Readiness antwortete nicht — im Zweifel deny.", venue, state, { flags, suite: suiteInfo });
  }
  if (!readiness.active) {
    return finish(false, "CONTROL_PLANE_INACTIVE", "Venue-State in der Control Plane ist nicht aktiv (Verbindung fehlt).", venue, state, { flags, suite: suiteInfo, controlPlaneActive: false });
  }

  return finish(true, "ALLOWED", `Alle Gates bestanden (state ${state}, Flags ok, Suite ${stamp?.runId}, Control Plane aktiv).`, venue, state, {
    flags,
    suite: suiteInfo,
    controlPlaneActive: true,
  });
}

/**
 * DER Torwächter: wirft LiveTradingGateError bei JEDEM Deny (inkl. Audit),
 * erlaubt (return) nur bei bestandener Gesamtprüfung.
 */
export function assertLiveOrderAllowed(
  venue = "BITUNIX",
  opts: EvaluateLiveOrderOptions = {}
): void {
  const decision = evaluateLiveOrder(venue, { ...opts, audit: opts.audit !== false });
  if (!decision.allowed) {
    throw new LiveTradingGateError(decision.venue, decision.reason);
  }
}
