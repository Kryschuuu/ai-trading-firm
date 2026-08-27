/**
 * Client-Anbindung der Broker Control Plane (Task 08).
 *
 * Das Frontend kennt NUR den Control-Plane-REST-Contract (Decoupling):
 *   GET  /api/brokers
 *   GET  /api/brokers/{venue}/status
 *   POST|DELETE /api/brokers/{venue}/credentials
 *   POST /api/brokers/{venue}/test
 *   POST /api/brokers/{venue}/discover
 *
 * HARTE REGELN (siehe docs/FRONTEND_CONTROL_PLANE.md):
 *   - Secrets werden NIE im Client gespeichert (kein localStorage/
 *     sessionStorage/IndexedDB fuer Credentials), NIE geloggt, NIE in
 *     URLs uebertragen.
 *   - Antworten sind status-only; es gibt keinen Code, der ein Secret
 *     anzeigen kann.
 *   - Mutierende Requests senden den CSRF-Header `x-csrf-token` (Wert =
 *     Admin-/Operator-Token bzw. "local" im Offen-Betrieb) — exakt das
 *     Server-Pendant zu src/brokers/control-plane/guard.ts.
 */

export type LayerStateValue = "off" | "pending" | "active" | "error";

export interface LayerStatusDto {
  state: LayerStateValue;
  at: string | null;
  detail: string | null;
}

export interface BrokerListEntry {
  id: string;
  label: string;
  assets: string;
  capabilities: {
    discovery: boolean;
    marketData: boolean;
    trading: boolean;
    paper: boolean;
    testnet: boolean;
    live: boolean;
    instrumentTypes: {
      spot: boolean;
      perpetual: boolean;
      future: boolean;
      option: boolean;
    };
    stopAtVenue: boolean;
  };
  paperAvailable: boolean;
  liveAvailable: boolean;
  executionModes: Record<
    string,
    { available: boolean; reason?: string }
  >;
  health: {
    status: "online" | "degraded" | "offline";
    latencyMs: number;
    details: Record<string, unknown>;
  };
}

export interface BrokerStatusDto {
  ok: true;
  venue: string;
  configured: boolean;
  connected: boolean;
  permissions: string[];
  liveEnabled: boolean;
  liveReason: string;
  discovery: {
    state: LayerStateValue;
    count: number;
    lastSync: string | null;
  };
  health: {
    status: string;
    latencyMs: number;
    details: Record<string, unknown>;
  };
  layers: Record<string, LayerStatusDto>;
  updatedAt: string | null;
}

export interface BrokerListResponse {
  ok: boolean;
  count: number;
  brokers: BrokerListEntry[];
  remoteHealthCheck: { enabled: boolean; flag: string };
}

type ApiError = { ok?: boolean; error?: string; message?: string; hint?: string };

export interface ApiResult<T> {
  data: T | null;
  error: string;
  status: number;
  unauthorized: boolean;
}

const CREDENTIAL_HEADERS = ["POST", "DELETE"] as const;

/** CSRF-Wert: Admin-/Operator-Token aus localStorage, sonst Offen-Konstante. */
function csrfValue(): string {
  if (typeof window === "undefined") return "local";
  return window.localStorage.getItem("firmToken")?.trim() || "local";
}

async function request<T>(
  url: string,
  method: "GET" | "POST" | "DELETE",
  body?: unknown
): Promise<ApiResult<T>> {
  const headers = new Headers();
  const token =
    typeof window !== "undefined"
      ? window.localStorage.getItem("firmToken") ?? ""
      : "";
  if (token && (CREDENTIAL_HEADERS as readonly string[]).includes(method)) {
    headers.set("x-firm-token", token);
    headers.set("x-admin-token", token);
  }
  if ((CREDENTIAL_HEADERS as readonly string[]).includes(method)) {
    // CSRF-Guard des Servers: mutierende Endpoints verlangen x-csrf-token.
    headers.set("x-csrf-token", csrfValue());
  }
  if (body !== undefined) headers.set("content-type", "application/json");

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    return {
      data: null,
      error: "Netzwerkfehler — Server nicht erreichbar.",
      status: 0,
      unauthorized: false,
    };
  }

  let json: (T & ApiError) | null = null;
  try {
    json = (await res.json()) as T & ApiError;
  } catch {
    json = null;
  }

  const unauthorized = res.status === 401 || res.status === 403;
  const error =
    !res.ok || json?.ok === false
      ? json?.error?.trim() ||
        json?.message?.trim() ||
        json?.hint?.trim() ||
        `Fehler (HTTP ${res.status})`
      : "";
  return { data: json, error, status: res.status, unauthorized };
}

/** GET /api/brokers — Karten-Basis (Capabilities, Flags, Health). */
export function fetchBrokerList(): Promise<ApiResult<BrokerListResponse>> {
  return request<BrokerListResponse>("/api/brokers", "GET");
}

/** GET /api/brokers/{venue}/status — Status-Objekt (nie Secret-Inhalte). */
export function fetchVenueStatus(venue: string): Promise<ApiResult<BrokerStatusDto>> {
  return request<BrokerStatusDto>(
    `/api/brokers/${encodeURIComponent(venue)}/status`,
    "GET"
  );
}

/** POST /api/brokers/{venue}/credentials — Secret einmalig Form → Store. */
export function saveVenueCredentials(
  venue: string,
  apiKey: string,
  apiSecret: string
): Promise<ApiResult<BrokerStatusDto>> {
  return request<BrokerStatusDto>(
    `/api/brokers/${encodeURIComponent(venue)}/credentials`,
    "POST",
    { apiKey, apiSecret }
  );
}

/** DELETE /api/brokers/{venue}/credentials — Referenz loeschen + Zustand zurueck. */
export function deleteVenueCredentials(
  venue: string
): Promise<ApiResult<BrokerStatusDto>> {
  return request<BrokerStatusDto>(
    `/api/brokers/${encodeURIComponent(venue)}/credentials`,
    "DELETE"
  );
}

/** POST /api/brokers/{venue}/test — Verbindungstest + read-only Probe. */
export function testVenueConnection(
  venue: string
): Promise<ApiResult<BrokerStatusDto>> {
  return request<BrokerStatusDto>(
    `/api/brokers/${encodeURIComponent(venue)}/test`,
    "POST"
  );
}

/** POST /api/brokers/{venue}/discover — Market Discovery (definierte Aktion). */
export function discoverVenue(
  venue: string
): Promise<ApiResult<BrokerStatusDto>> {
  return request<BrokerStatusDto>(
    `/api/brokers/${encodeURIComponent(venue)}/discover`,
    "POST"
  );
}
