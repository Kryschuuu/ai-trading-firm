/**
 * Client-Anbindung des Live-Trading-Gates (Task 11).
 *
 * Das Frontend kennt NUR diese REST-Contract (Decoupling — die UI kann den
 * Gate-Zustand NUR lesen bzw. über die admin-guarded, CSRF-geschützten
 * Mutations-Endpunkte bedienen; es gibt keinen UI-Bypass für den Enforcer):
 *   GET  /api/live/state
 *   POST /api/live/transition   (Permission live.gate = Admin)
 *   POST /api/live/kill         (Permission live.gate = Admin + Phrase "KILL")
 *
 * Regeln wie in controlPlane.ts: Mutating-Requests senden den CSRF-Header
 * (Seit W1 v1.36.23 aus der Session-Cookie, kein Token im Client-Speicher);
 * Responses enthalten niemals Secrets (der Gate-Zustand ist status-only).
 */
import { csrfHeaderValue } from "@/lib/browserSession";

export type LiveGateStateId =
  | "DISCONNECTED"
  | "CONNECTED"
  | "MARKET_DATA_OK"
  | "ACCOUNT_READ_OK"
  | "ORDER_TEST_OK"
  | "PAPER_APPROVED"
  | "LIVE_PENDING"
  | "HUMAN_APPROVED"
  | "LIVE_ENABLED";

export interface LiveGateVenueSnapshotDto {
  venue: string;
  liveAvailable: boolean;
  state: LiveGateStateId;
  updatedAt: string | null;
  updatedBy: string | null;
  livePendingAt: string | null;
  cooldownMs: number;
  cooldownRemainingMs: number;
  cooldownElapsed: boolean;
  fourEyesRequired: boolean;
  pendingApproval: { approvedBy: string; at: string } | null;
  killed: { scope: string; at: string; actor: string; reason: string } | null;
  killSwitchActive: boolean;
  flags: {
    venueEnabled: boolean;
    platformLive: boolean;
    venueLiveFlag: boolean;
    requireHumanApproval: boolean;
  };
  suite: { valid: boolean; runId: string | null; source: string | null };
  controlPlaneActive: boolean | null;
  liveOrderAllowed: boolean;
  denyCodeIfAny: string | null;
  history: { transitions: number; denials: number; kills: number; lastTransitionAt: string | null };
}

export interface LiveGateOverviewDto {
  ok: true;
  policyVersion: string;
  config: {
    dir: string;
    cooldownMs: number;
    fourEyes: boolean;
    paperMinOrders: number;
    suiteMaxAgeMs: number;
  };
  killSwitch: {
    active: boolean;
    scopes: string[];
    entries: { scope: string; at: string; actor: string; reason: string }[];
  };
  suite: { valid: boolean; runId: string | null; source: string | null; reason: string };
  venues: LiveGateVenueSnapshotDto[];
  audit: {
    head: { seq: number; hash: string } | null;
    integrity: { ok: boolean; entries: number; firstBrokenSeq: number | null; problem: string | null };
    recent: {
      seq: number;
      ts: string;
      actor: string;
      venue: string;
      from: string | null;
      to: string | null;
      action: string;
      result: string;
      reason: string;
      hash: string;
    }[];
  };
}

export interface LiveGateApiResult<T> {
  data: T | null;
  error: string;
  status: number;
}

type ApiError = { ok?: boolean; error?: string; message?: string; hint?: string };

async function request<T>(
  url: string,
  method: "GET" | "POST",
  body?: unknown
): Promise<LiveGateApiResult<T>> {
  const headers = new Headers();
  if (method === "POST") {
    // W1 (v1.36.23): Kein Token mehr aus localStorage — Session-Cookie wird
    // automatisch mitgesendet; Double-Submit-CSRF aus firm_csrf.
    headers.set("x-csrf-token", csrfHeaderValue());
    if (body !== undefined) headers.set("content-type", "application/json");
  }
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
    });
  } catch {
    return { data: null, error: "Netzwerkfehler — Server nicht erreichbar.", status: 0 };
  }
  if (res.status === 401 || res.status === 403) {
    const err = (await res.json().catch(() => ({}))) as ApiError;
    return {
      data: null,
      error: err.message ?? err.hint ?? err.error ?? "Nicht berechtigt (Admin-Token nötig).",
      status: res.status,
    };
  }
  const json = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const err = (json as ApiError) ?? {};
    return {
      data: null,
      error: err.message ?? err.error ?? `HTTP ${res.status}`,
      status: res.status,
    };
  }
  return { data: json as T, error: "", status: res.status };
}

/** GET /api/live/state — Zustand aller Venues + Kill + Suite + Audit-Kopf. */
export function fetchLiveGateState(): Promise<LiveGateApiResult<LiveGateOverviewDto>> {
  return request<LiveGateOverviewDto>("/api/live/state", "GET");
}

/** POST /api/live/transition — Matrix-Übergang (Admin, reason/confirm Pflichtfelder je Ziel). */
export function postLiveGateTransition(input: {
  venue: string;
  to: string;
  reason?: string;
  confirm?: boolean;
  approvedBy?: string;
}): Promise<LiveGateApiResult<{ ok: true; venue: string; from: string; to: string }>> {
  return request("/api/live/transition", "POST", input);
}

/** POST /api/live/kill — Kill-Switch (Admin, Phrase "KILL" serverseitig geprüft). */
export function postLiveGateKill(input: {
  venue?: string;
  scope?: string;
  reason: string;
  confirm: string;
}): Promise<LiveGateApiResult<{ ok: true; scope: string }>> {
  return request("/api/live/kill", "POST", input);
}
