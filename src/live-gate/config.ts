/**
 * Live-Gate-Konfiguration (Task 11) — alle Defaults SICHER (fail-closed).
 *
 * Die zentrale Live-Trading-State-Machine (src/live-gate/states.ts) und der
 * Enforcer (src/live-gate/enforcer.ts) lesen NUR diese Konfiguration und die
 * persistierten State-Files — niemals UI-Flags oder Agenten-Aussagen.
 *
 * Env-Flags (alle nur restriktiv übersteuerbar):
 *   LIVE_GATE_DATA_DIR             Ablageverzeichnis (Default data/live-gate)
 *   LIVE_GATE_COOLDOWN_MS          Cooldown LIVE_PENDING → HUMAN_APPROVED
 *                                  (Default 24 h, 0 = aus, max 30 d)
 *   LIVE_GATE_FOUR_EYES            "true" → zweiter, anderer Approver nötig
 *   LIVE_GATE_PAPER_MIN_ORDERS     Mindestzahl fehlerfreier Paper-Orders
 *                                  für PAPER_APPROVED (Default 50)
 *   LIVE_GATE_SUITE_MAX_AGE_MS     Max-Alter des Security-Suite-Stamps
 *                                  (Default 7 Tage, 0 = unbegrenzt)
 *
 * WICHTIG: Dieser Task SCHALTET NICHTS EIN. Nach dem Merge gilt weiter:
 * LIVE_TRADING_ENABLED=false, {VENUE}_LIVE_ENABLED=false, kein State-File
 * (=> DISCONNECTED), kein Suite-Stamp im Betrieb => jede Live-Order denied.
 */
import { envInt } from "@/lib/env";

export type LiveGateEnv = Record<string, string | undefined>;

/** Version der Gate-Policy — steht in jedem Audit-Eintrag. */
export const LIVE_GATE_POLICY_VERSION = "live-gate-policy/1";

export const LIVE_GATE_DATA_DIR_FLAG = "LIVE_GATE_DATA_DIR";
export const LIVE_GATE_DATA_DIR_DEFAULT = "data/live-gate";

export const LIVE_GATE_COOLDOWN_FLAG = "LIVE_GATE_COOLDOWN_MS";
export const LIVE_GATE_COOLDOWN_DEFAULT_MS = 24 * 60 * 60 * 1000; // 24 h
export const LIVE_GATE_COOLDOWN_MIN_MS = 0;
export const LIVE_GATE_COOLDOWN_MAX_MS = 30 * 24 * 60 * 60 * 1000; // 30 d

export const LIVE_GATE_FOUR_EYES_FLAG = "LIVE_GATE_FOUR_EYES";

export const LIVE_GATE_PAPER_MIN_ORDERS_FLAG = "LIVE_GATE_PAPER_MIN_ORDERS";
export const LIVE_GATE_PAPER_MIN_ORDERS_DEFAULT = 50;
export const LIVE_GATE_PAPER_MIN_ORDERS_MIN = 1;
export const LIVE_GATE_PAPER_MIN_ORDERS_MAX = 1_000_000;

export const LIVE_GATE_SUITE_MAX_AGE_FLAG = "LIVE_GATE_SUITE_MAX_AGE_MS";
export const LIVE_GATE_SUITE_MAX_AGE_DEFAULT_MS = 7 * 24 * 60 * 60 * 1000; // 7 Tage
export const LIVE_GATE_SUITE_MAX_AGE_MIN_MS = 0;
export const LIVE_GATE_SUITE_MAX_AGE_MAX_MS = 365 * 24 * 60 * 60 * 1000;

export interface LiveGateConfig {
  dir: string;
  cooldownMs: number;
  fourEyes: boolean;
  paperMinOrders: number;
  suiteMaxAgeMs: number;
}

/** Effektives Ablageverzeichnis der Machine (Tests/Deploy übersteuern). */
export function liveGateDataDir(env: LiveGateEnv = process.env): string {
  const raw = env[LIVE_GATE_DATA_DIR_FLAG]?.trim();
  return raw && raw.length > 0 ? raw : LIVE_GATE_DATA_DIR_DEFAULT;
}

/** Effektive Gate-Konfiguration (alles fail-closed verifiziert). */
export function liveGateConfig(env: LiveGateEnv = process.env): LiveGateConfig {
  return {
    dir: liveGateDataDir(env),
    cooldownMs: envInt(
      LIVE_GATE_COOLDOWN_FLAG,
      LIVE_GATE_COOLDOWN_DEFAULT_MS,
      LIVE_GATE_COOLDOWN_MIN_MS,
      LIVE_GATE_COOLDOWN_MAX_MS,
      env
    ),
    fourEyes: env[LIVE_GATE_FOUR_EYES_FLAG] === "true",
    paperMinOrders: envInt(
      LIVE_GATE_PAPER_MIN_ORDERS_FLAG,
      LIVE_GATE_PAPER_MIN_ORDERS_DEFAULT,
      LIVE_GATE_PAPER_MIN_ORDERS_MIN,
      LIVE_GATE_PAPER_MIN_ORDERS_MAX,
      env
    ),
    suiteMaxAgeMs: envInt(
      LIVE_GATE_SUITE_MAX_AGE_FLAG,
      LIVE_GATE_SUITE_MAX_AGE_DEFAULT_MS,
      LIVE_GATE_SUITE_MAX_AGE_MIN_MS,
      LIVE_GATE_SUITE_MAX_AGE_MAX_MS,
      env
    ),
  };
}

// ── Venue-Flag-Mapping (generisch, venue-agnostisch) ─────────────────────────
//
// PAPER hat KEINE Env-Flags (interner Simulator, nie live); alle echten Venues
// folgen dem Muster {VENUE}_ENABLED / {VENUE}_LIVE_ENABLED (SSoT: task-07).

/** Venue-Adapter-Flag, z. B. BITUNIX_ENABLED. */
export function venueEnabledFlagName(venue: string): string {
  return `${venue.toUpperCase()}_ENABLED`;
}

/** Venue-Live-Flag, z. B. BITUNIX_LIVE_ENABLED. */
export function venueLiveFlagName(venue: string): string {
  return `${venue.toUpperCase()}_LIVE_ENABLED`;
}

function envFlagTrue(env: LiveGateEnv, name: string): boolean {
  return env[name] === "true";
}

/** Ist der Venue-Adapter freigeschaltet (PAPER: immer, ohne Netz). */
export function venueEnabledFromEnv(venue: string, env: LiveGateEnv): boolean {
  if (venue.toUpperCase() === "PAPER") return true;
  return envFlagTrue(env, venueEnabledFlagName(venue));
}

/** Venue-Live-Flag (allein wirkungslos — der Enforcer verlangt mehr). */
export function venueLiveFlagFromEnv(venue: string, env: LiveGateEnv): boolean {
  if (venue.toUpperCase() === "PAPER") return false; // PAPER kann nie live sein.
  return envFlagTrue(env, venueLiveFlagName(venue));
}

/** Plattform-Live-Flag LIVE_TRADING_ENABLED (allein wirkungslos). */
export function platformLiveFromEnv(env: LiveGateEnv): boolean {
  return envFlagTrue(env, "LIVE_TRADING_ENABLED");
}

/**
 * REQUIRE_HUMAN_APPROVAL: nur exakt "false" hebt die Human-Gate-Teilbedingung
 * auf (identisch zu task-07). Die State-Machine verlangt den Schritt
 * LIVE_PENDING → HUMAN_APPROVED STRUKTURELL (kein Matrix-Sprung) — dieses Flag
 * steuert nur die Alternativ-Klausel im Enforcer.
 */
export function humanApprovalRequired(env: LiveGateEnv): boolean {
  return env.REQUIRE_HUMAN_APPROVAL !== "false";
}
