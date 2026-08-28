/**
 * KANONISCHE Live-Trading-State-Machine (Task 11) — Zustände + Übergangsmatrix.
 *
 * 9 Zustände, exakt 8 legale Vorwärts-Übergänge:
 *
 *   DISCONNECTED → CONNECTED → MARKET_DATA_OK → ACCOUNT_READ_OK → ORDER_TEST_OK
 *   → PAPER_APPROVED → LIVE_PENDING → HUMAN_APPROVED → LIVE_ENABLED
 *
 * Kein Übergang außer diesen 8 ist als `advance` erlaubt — insbesondere keine
 * Sprünge (z. B. LIVE_PENDING → LIVE_ENABLED) und keine Rückwärtssprünge.
 * Explizite Downgrade-Aktionen (getrennt von der Matrix, immer auditiert):
 *   - disable: jeder Zustand außer DISCONNECTED → DISCONNECTED (Admin-Aktion)
 *   - kill:    JEDER Zustand → DISCONNECTED + persistente Sperre (Kill-Switch)
 *
 * Die Bedingungen je Übergang (TransitionCheck-Interface) leben in checks.ts,
 * die Human-Gate-Policy (Cooldown, 4-Augen, Begründungspflicht) im Service.
 *
 * WICHTIG: Dieses Modul implementiert nur den WEG, Live freizuschalten.
 * Es schaltet nichts ein: Der Enforcer (enforcer.ts) verweigert weiter jede
 * Live-Order, bis die komplette Machine + Flags + Suite + Control Plane
 * erfüllt sind — und das NUR durch menschliche Admin-Aktionen.
 */
import { BrokerError } from "@/contracts/broker";

/** Die 9 kanonischen Zustände (Reihenfolge = Rang, aufsteigend). */
export const LIVE_GATE_STATES = [
  "DISCONNECTED",
  "CONNECTED",
  "MARKET_DATA_OK",
  "ACCOUNT_READ_OK",
  "ORDER_TEST_OK",
  "PAPER_APPROVED",
  "LIVE_PENDING",
  "HUMAN_APPROVED",
  "LIVE_ENABLED",
] as const;

export type LiveGateState = (typeof LIVE_GATE_STATES)[number];

/** Check-IDs der automatisch verifizierbaren Übergangs-Bedingungen. */
export type LiveGateCheckId =
  | "connectivity"
  | "marketData"
  | "accountRead"
  | "orderTest"
  | "paperCriteria";

export interface LiveGateTransitionDef {
  from: LiveGateState;
  to: LiveGateState;
  /** Automatischer Check (null = reine Admin-/Policy-Aktion). */
  check: LiveGateCheckId | null;
}

/**
 * DIE Übergangsmatrix (Tabelle im Code, Doku: docs/LIVE_TRADING.md).
 * Genau 8 Einträge — mehr existieren nicht und dürfen nie ergänzt werden,
 * ohne POLICY_VERSION und Doku zu erhöhen.
 */
export const LIVE_GATE_TRANSITIONS: readonly LiveGateTransitionDef[] = [
  { from: "DISCONNECTED", to: "CONNECTED", check: "connectivity" },
  { from: "CONNECTED", to: "MARKET_DATA_OK", check: "marketData" },
  { from: "MARKET_DATA_OK", to: "ACCOUNT_READ_OK", check: "accountRead" },
  { from: "ACCOUNT_READ_OK", to: "ORDER_TEST_OK", check: "orderTest" },
  { from: "ORDER_TEST_OK", to: "PAPER_APPROVED", check: "paperCriteria" },
  { from: "PAPER_APPROVED", to: "LIVE_PENDING", check: null },
  { from: "LIVE_PENDING", to: "HUMAN_APPROVED", check: null },
  { from: "HUMAN_APPROVED", to: "LIVE_ENABLED", check: null },
] as const;

/** Alle 8 legalen Advance-Keys "FROM->TO" (Matrix-Tests, Red-Team). */
export const LEGAL_ADVANCE_KEYS: ReadonlySet<string> = new Set(
  LIVE_GATE_TRANSITIONS.map((t) => `${t.from}->${t.to}`)
);

export function isLiveGateState(value: unknown): value is LiveGateState {
  return (
    typeof value === "string" &&
    (LIVE_GATE_STATES as readonly string[]).includes(value)
  );
}

/** Rang des Zustands (0=DISCONNECTED … 8=LIVE_ENABLED); unbekannt → -1. */
export function liveGateStateRank(state: string): number {
  return (LIVE_GATE_STATES as readonly string[]).indexOf(state);
}

/** Ist `from → to` ein legaler Vorwärts-Übergang der Matrix? */
export function isLegalAdvance(
  from: unknown,
  to: unknown
): { legal: boolean; key: string } {
  const key =
    isLiveGateState(from) && isLiveGateState(to) ? `${from}->${to}` : String(from) + "->" + String(to);
  return { legal: LEGAL_ADVANCE_KEYS.has(key), key };
}

/** Matrix-Definition für einen legalen Übergang (sonst null). */
export function transitionDef(
  from: LiveGateState,
  to: LiveGateState
): LiveGateTransitionDef | null {
  return LIVE_GATE_TRANSITIONS.find((t) => t.from === from && t.to === to) ?? null;
}

// ── Fehlerklasse ─────────────────────────────────────────────────────────────

/** Missbrauch/Policy-Verstoß der State-Machine → 409/422 mit klarem Code. */
export const LIVE_GATE_ERROR_CODES = [
  "UNKNOWN_VENUE",
  "UNKNOWN_STATE",
  "ILLEGAL_TRANSITION",
  "CHECK_FAILED",
  "REASON_REQUIRED",
  "CONFIRM_REQUIRED",
  "APPROVER_REQUIRED",
  "COOLDOWN_ACTIVE",
  "FOUR_EYES_PENDING",
  "FOUR_EYES_SAME_APPROVER",
  "KILL_SWITCH_ACTIVE",
  "FLAGS_MISSING",
  "SECURITY_SUITE_INVALID",
  "CONTROL_PLANE_INACTIVE",
  "VENUE_NOT_LIVE_CAPABLE",
  "STATE_WRITE_FAILED",
] as const;

export type LiveGateErrorCode = (typeof LIVE_GATE_ERROR_CODES)[number];

export class LiveGateError extends BrokerError {
  constructor(code: LiveGateErrorCode, message: string) {
    super(code, message);
    this.name = "LiveGateError";
  }
}

/** HTTP-Status-Mapping der Gate-Fehler (API-Routen). */
export function liveGateErrorStatus(code: string): number {
  switch (code) {
    case "UNKNOWN_VENUE":
    case "UNKNOWN_STATE":
    case "REASON_REQUIRED":
    case "CONFIRM_REQUIRED":
    case "APPROVER_REQUIRED":
      return 422;
    default:
      return 409;
  }
}
