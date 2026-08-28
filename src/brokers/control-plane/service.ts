/**
 * Broker Control Plane — Backend-Credential-Manager (Task 08).
 *
 * Der EINZIGE Pfad fuer Broker-Credentials:
 *   Frontend (masked form) → POST /api/brokers/{venue}/credentials
 *   → validate → AES-256-GCM (AAD = venue) → Probe (read-only)
 *   → Zustandsmaschine (6 Ebenen) → Audit. Antworten sind IMMER
 *   Status-Objekte: configured/connected/permissions[]/liveEnabled —
 *   NIE ein Secret, NIE ein keyHint (empfohlen: gar nicht — so umgesetzt).
 *
 * Live bleibt in diesem Task ueberall OFF: `liveEnabled` ist immer false
 * und stammt ausschliesslich aus readGateState() (Gate-Service-Meldung,
 * bis task-11 hart gesperrt). Es gibt keinen Schalter.
 *
 * Zustandsmaschine: Uebergaenge nur via save/test/discover/disable —
 * Missbrauch wirft StateTransitionError (→ 409/422 mit klarem Fehler).
 * Audit: JEDES Ereignis → Control-Plane-Audit (Ring + audit_log).
 */
import {
  UnknownVenueError,
  type BrokerAdapter,
  type BrokerVenueId,
} from "@/contracts/broker";
import { VENUE_CAPABILITIES } from "../capabilities";
import { normalizeVenue } from "../factory";
import {
  recordControlPlaneEvent,
  type ControlPlaneAction,
} from "./audit";
import {
  applyAction,
  createInitialControlState,
  readGateState,
  StateTransitionError,
  type ControlLayerId,
  type LayerStateValue,
  type ProbeOutcome,
  type VenueControlState,
} from "./states";
import { disposeCredential, probePermissions } from "./probe";
import {
  assertValidCredential,
  type CredentialPayload,
  type VenueSecretStore,
} from "./secretStore";

// ── Ergebnis-Vertraege (status-only, siehe docs/FRONTEND_CONTROL_PLANE.md) ───

export interface LayerStatusDto {
  state: LayerStateValue;
  at: string | null;
  detail: string | null;
}

export interface StatusDto {
  ok: true;
  venue: BrokerVenueId;
  configured: boolean;
  connected: boolean;
  permissions: string[];
  liveEnabled: false;
  liveReason: string;
  discovery: { state: LayerStateValue; count: number; lastSync: string | null };
  health: {
    status: string;
    latencyMs: number;
    details: Record<string, unknown>;
  };
  layers: Record<ControlLayerId, LayerStatusDto>;
  updatedAt: string | null;
}

export interface SaveResultDto {
  ok: true;
  venue: BrokerVenueId;
  configured: true;
  connected: boolean;
  permissions: string[];
  liveEnabled: false;
  probe: {
    state: "ok" | "error";
    at: string;
    errorCode: string | null;
    message: string | null;
  };
  layers: Record<ControlLayerId, LayerStatusDto>;
}

export interface TestResultDto {
  ok: true;
  venue: BrokerVenueId;
  configured: boolean;
  connected: boolean;
  permissions: string[];
  liveEnabled: false;
  health: { status: string; latencyMs: number; details: Record<string, unknown> };
}

export interface DeleteResultDto {
  ok: true;
  venue: BrokerVenueId;
  configured: false;
  connected: false;
  permissions: [];
  liveEnabled: false;
}

export interface DiscoverResultDto {
  ok: true;
  venue: BrokerVenueId;
  discovery: { state: LayerStateValue; count: number; lastSync: string | null };
  layers: Record<ControlLayerId, LayerStatusDto>;
}

export interface ControlPlaneOptions {
  store?: VenueSecretStore;
  /** DI-Hook fuer die Discovery (Tests; Default: Adapter-Discovery). */
  discoverFn?: (venue: BrokerVenueId) => Promise<number>;
  /** DI-Hook fuer die Probe (Tests; Default: probe.ts). */
  probeFn?: (
    venue: BrokerVenueId,
    credential: CredentialPayload | null
  ) => Promise<ProbeOutcome>;
  now?: () => string;
}

function toLayerDto(record: Record<ControlLayerId, VenueControlState["layers"][ControlLayerId]>): Record<ControlLayerId, LayerStatusDto> {
  return Object.fromEntries(
    Object.entries(record).map(([id, l]) => [id, { state: l.state, at: l.at, detail: l.detail }])
  ) as Record<ControlLayerId, LayerStatusDto>;
}

const G = globalThis as typeof globalThis & {
  __controlPlaneServicePromise?: Promise<ControlPlaneService>;
  __controlPlaneStates?: Map<string, VenueControlState>;
};

function stateMap(): Map<string, VenueControlState> {
  return (G.__controlPlaneStates ??= new Map());
}

/** Ruft den Zustand einer Venue ab (faul initialisiert). */
function readState(venue: BrokerVenueId): VenueControlState {
  const map = stateMap();
  let state = map.get(venue);
  if (!state) {
    state = createInitialControlState(venue);
    map.set(venue, state);
  }
  return state;
}

function writeState(state: VenueControlState): void {
  stateMap().set(state.venue, state);
}

export class ControlPlaneService {
  private readonly discoverFn: (venue: BrokerVenueId) => Promise<number>;
  private readonly probeFn: (
    venue: BrokerVenueId,
    credential: CredentialPayload | null
  ) => Promise<ProbeOutcome>;
  private readonly now: () => string;

  constructor(private readonly opts: ControlPlaneOptions = {}) {
    this.probeFn =
      opts.probeFn ??
      ((venue, credential) => probePermissions(venue, credential));
    this.now = opts.now ?? (() => new Date().toISOString());
    this.discoverFn =
      opts.discoverFn ?? defaultDiscoverFn;
  }

  private store(): VenueSecretStore {
    if (!this.opts.store) {
      throw new Error(
        "ControlPlaneService ohne Secret-Store konfiguriert — getControlPlaneService() verwenden (Fabrik)."
      );
    }
    return this.opts.store;
  }

  private capabilities(venue: BrokerVenueId) {
    const caps = VENUE_CAPABILITIES[venue];
    return {
      paper: caps.paper,
      testnet: caps.testnet,
      trading: caps.trading,
      discovery: caps.discovery,
    };
  }

  // ── Aktionen ──────────────────────────────────────────────────────────────

  /** `POST /api/brokers/{venue}/credentials` — Secret einmalig entgegennehmen. */
  async saveCredentials(
    actor: string,
    venueRaw: string,
    body: unknown
  ): Promise<SaveResultDto> {
    const venue = this.requireVenue(venueRaw);

    if (venue === "PAPER") {
      await this.deny(actor, venue, "credential.saved", "NO_CREDENTIALS_REQUIRED");
      throw new StateTransitionError(
        "NO_CREDENTIALS_REQUIRED",
        "PAPER ist der interne Simulator und benoetigt keine Zugangsdaten. Verbindungstest genuegt (POST /test)."
      );
    }

    const credential = this.parseCredentialBody(body);
    const store = this.store();

    if (await store.exists(venue)) {
      const state = readState(venue);
      if (state.layers.connection.state === "active") {
        await this.deny(actor, venue, "credential.saved", "ALREADY_CONNECTED");
        throw new StateTransitionError(
          "ALREADY_CONNECTED",
          "Verbindung ist bereits aktiv. Zuerst trennen (DELETE), dann neu speichern."
        );
      }
      // Erneutes Speichern im Fehler-Zustand = Aendern (upsert).
      await this.audit(actor, venue, "credential.changed", "OK");
    } else {
      await this.audit(actor, venue, "credential.saved", "OK");
    }

    // 1) Verschluesseln (AES-256-GCM, AAD = venue) — Klartext danach weg.
    await store.put(venue, credential);

    // 2) Read-only Probe mit dem (noch im Speicher gehaltenen) Credential →
    //    permissions[] ableiten. Danach wird der Wert verworfen (zeroize);
    //    ein Fehler fuehrt zu Zustand error mit SAFE-Meldung.
    const probe = await this.runProbe(venue, credential);
    disposeCredential(credential);
    await this.auditProbe(actor, venue, probe);

    // 3) Zustandsuebergang nur ueber definierte Aktion "save".
    const state = readState(venue);
    const next = applyAction(state, {
      action: "save",
      probe,
      capabilities: this.capabilities(venue),
      now: this.now(),
    });
    writeState(next);
    await this.auditTransition(actor, venue, next);

    return {
      ok: true,
      venue,
      configured: true,
      connected: next.connected,
      permissions: next.permissions,
      liveEnabled: false,
      probe: {
        state: probe.ok ? "ok" : "error",
        at: this.now(),
        errorCode: probe.errorCode ?? null,
        message: probe.message ?? null,
      },
      layers: toLayerDto(next.layers),
    };
  }

  /** `DELETE /api/brokers/{venue}/credentials` — Referenz loeschen + disable. */
  async deleteCredentials(actor: string, venueRaw: string): Promise<DeleteResultDto> {
    const venue = this.requireVenue(venueRaw);
    const store = this.store();
    if (!(await store.exists(venue))) {
      await this.deny(actor, venue, "credential.deleted", "NOT_CONFIGURED");
      throw new StateTransitionError(
        "NOT_CONFIGURED",
        "Keine Zugangsdaten hinterlegt — nichts zu loeschen."
      );
    }
    await store.delete(venue);
    const state = readState(venue);
    const next = applyAction(state, {
      action: "disable",
      now: this.now(),
    });
    writeState(next);
    await this.audit(actor, venue, "credential.deleted", "OK");
    await this.auditTransition(actor, venue, next);
    return {
      ok: true,
      venue,
      configured: false,
      connected: false,
      permissions: [],
      liveEnabled: false,
    };
  }

  /** `GET /api/brokers/{venue}/status` — Status-Objekt, NIE Secret-Inhalt. */
  async getStatus(venueRaw: string): Promise<StatusDto> {
    const venue = this.requireVenue(venueRaw);
    const store = this.store();
    const state = readState(venue);
    const configured = await store.exists(venue);
    const gate = readGateState();
    return {
      ok: true,
      venue,
      configured,
      connected: state.connected,
      permissions: state.permissions,
      liveEnabled: gate.liveEnabled,
      liveReason: gate.reason,
      discovery: { ...state.discovery },
      health: await this.safeHealth(venue),
      layers: toLayerDto(state.layers),
      updatedAt: state.updatedAt,
    };
  }

  /** `POST /api/brokers/{venue}/test` — healthCheck + read-only Probe. */
  async testConnection(actor: string, venueRaw: string): Promise<TestResultDto> {
    const venue = this.requireVenue(venueRaw);
    const store = this.store();

    let credential: CredentialPayload | null = null;
    let configured = false;
    let probe: ProbeOutcome;
    if (venue === "PAPER") {
      configured = false; // PAPER braucht keine Credentials
      probe = await this.runProbe(venue, null);
    } else {
      configured = await store.exists(venue);
      if (!configured) {
        await this.deny(actor, venue, "connection.test", "NO_CREDENTIALS");
        throw new StateTransitionError(
          "NO_CREDENTIALS",
          "Keine Zugangsdaten hinterlegt — erst speichern (POST /credentials), dann testen."
        );
      }
      try {
        credential = await store.get(venue);
        probe = await this.runProbe(venue, credential);
      } catch {
        // Entschluesselung fehlgeschlagen (falscher Key/Tampering) →
        // Zustand error mit SAFE-Meldung, kein Secret-Leak.
        probe = {
          ok: false,
          connected: false,
          permissions: [],
          errorCode: "CREDENTIAL_READ_FAILED",
          message:
            "Gespeicherte Zugangsdaten konnten nicht entschluesselt werden (falscher SECRET_STORE_KEY oder manipulierter Datensatz).",
        };
      } finally {
        disposeCredential(credential);
      }
    }

    await this.auditProbe(actor, venue, probe);
    await this.audit(actor, venue, "connection.test", probe.ok ? "OK" : "ERROR");

    const state = readState(venue);
    const next = applyAction(state, {
      action: "test",
      probe,
      capabilities: this.capabilities(venue),
      now: this.now(),
    });
    writeState(next);
    await this.auditTransition(actor, venue, next);

    return {
      ok: true,
      venue,
      configured,
      connected: probe.connected,
      permissions: probe.permissions,
      liveEnabled: false,
      health: await this.safeHealth(venue),
    };
  }

  /** `POST /api/brokers/{venue}/discover` — Market Discovery (Aktion "discover"). */
  async discover(actor: string, venueRaw: string): Promise<DiscoverResultDto> {
    const venue = this.requireVenue(venueRaw);
    const state = readState(venue);

    if (!this.capabilities(venue).discovery) {
      await this.deny(actor, venue, "connection.discover", "NOT_SUPPORTED_CAPABILITY");
      throw new StateTransitionError(
        "NOT_SUPPORTED_CAPABILITY",
        "Dieses Venue unterstuetzt keine Market Discovery (capabilities.discovery=false)."
      );
    }

    let next: VenueControlState;
    try {
      const count = await this.discoverFn(venue);
      next = applyAction(state, {
        action: "discover",
        capabilities: this.capabilities(venue),
        discoveryCount: count,
        now: this.now(),
      });
    } catch (err) {
      if (err instanceof StateTransitionError) throw err;
      next = applyAction(state, {
        action: "discover",
        capabilities: this.capabilities(venue),
        discoveryCount: -1,
        now: this.now(),
      });
    }
    writeState(next);
    await this.audit(actor, venue, "connection.discover", next.discovery.state === "active" ? "OK" : "ERROR");
    await this.auditTransition(actor, venue, next);
    return {
      ok: true,
      venue,
      discovery: { ...next.discovery },
      layers: toLayerDto(next.layers),
    };
  }

  /** Nur Tests/Demo: Zustand einer Venue zuruecksetzen. */
  resetForTests(venue: BrokerVenueId): void {
    writeState(createInitialControlState(venue));
  }

  // ── interne Helfer ────────────────────────────────────────────────────────

  private requireVenue(raw: string): BrokerVenueId {
    const venue = normalizeVenue(raw);
    if (!venue) {
      const safe = String(raw ?? "").slice(0, 40);
      throw new UnknownVenueError(safe);
    }
    return venue;
  }

  private parseCredentialBody(body: unknown): CredentialPayload {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new StateTransitionError(
        "VALIDATION_ERROR",
        "Request-Body muss ein JSON-Objekt mit apiKey und apiSecret sein."
      );
    }
    const record = body as Record<string, unknown>;
    const credential: CredentialPayload = {
      apiKey: typeof record.apiKey === "string" ? record.apiKey : "",
      apiSecret: typeof record.apiSecret === "string" ? record.apiSecret : "",
    };
    assertValidCredential(credential);
    return credential;
  }

  private async runProbe(
    venue: BrokerVenueId,
    credential: CredentialPayload | null = null
  ): Promise<ProbeOutcome> {
    try {
      return await this.probeFn(venue, credential);
    } catch {
      return {
        ok: false,
        connected: false,
        permissions: [],
        errorCode: "PROBE_FAILED",
        message: "Read-only Probe fehlgeschlagen (SAFE: keine Details).",
      };
    }
  }

  private async safeHealth(venue: BrokerVenueId): Promise<StatusDto["health"]> {
    try {
      const adapter: BrokerAdapter = (await import("../factory")).createAdapter(venue, "paper");
      const health = await adapter.healthCheck();
      return {
        status: health.status,
        latencyMs: health.latencyMs,
        details: health.details,
      };
    } catch {
      return {
        status: "offline",
        latencyMs: 0,
        details: { error: "HEALTH_CHECK_FAILED" },
      };
    }
  }

  private async audit(
    actor: string,
    venue: string,
    action: ControlPlaneAction,
    result: "OK" | "DENIED" | "ERROR",
    errorCode?: string
  ): Promise<void> {
    await recordControlPlaneEvent({ actor, venue, action, result, errorCode: errorCode ?? null });
  }

  private async deny(
    actor: string,
    venue: string,
    action: ControlPlaneAction,
    errorCode: string
  ): Promise<void> {
    await recordControlPlaneEvent({ actor, venue, action, result: "DENIED", errorCode });
  }

  private async auditProbe(actor: string, venue: string, probe: ProbeOutcome): Promise<void> {
    await recordControlPlaneEvent({
      actor,
      venue,
      action: "permission.probe",
      result: probe.ok ? "OK" : "ERROR",
      errorCode: probe.errorCode ?? null,
      meta: { permissions: probe.permissions.join(",") || null },
    });
  }

  private async auditTransition(actor: string, venue: string, state: VenueControlState): Promise<void> {
    const changed = (Object.keys(state.layers) as ControlLayerId[])
      .filter((id) => state.layers[id].state !== "off")
      .join(",");
    if (!changed) return;
    await recordControlPlaneEvent({
      actor,
      venue,
      action: "state.transition",
      result: "OK",
      meta: { layers: changed },
    });
  }
}

/** Default-Discovery: Adapter-Discovery, sicher gekappt (kein Netzwerk ohne Flag). */
async function defaultDiscoverFn(venue: BrokerVenueId): Promise<number> {
  // PAPER: lokale Universe-Registry (DB-gestuetzt; Fehler → -1 → Ebene error).
  // Andere Venues: echte Discovery erst mit den Adapter-Aufgaben — hier
  // bewusst NICHTS (Mock-Discovery ist Aufgabe des Tests/DI-Hooks).
  if (venue !== "PAPER") {
    throw new StateTransitionError(
      "DISCOVERY_NOT_IMPLEMENTED",
      "Echte Market Discovery dieses Venues folgt mit dem Adapter-Ausbau (TODO(task-02/07))."
    );
  }
  const adapter = (await import("../factory")).createAdapter("PAPER", "paper");
  if (!adapter.discoverInstruments) return -1;
  try {
    const instruments = await adapter.discoverInstruments();
    return Array.isArray(instruments) ? instruments.length : -1;
  } catch {
    return -1;
  }
}

/**
 * Prozess-Singleton des Service: loest den Secret-Store einmalig auf
 * (Backend-Wahl: DB-Ping → Fallback file) und injiziert ihn. API-Routen
 * `await`en diese Fabrik; Tests erzeugen eigene Instanzen mit injiziertem
 * Memory-Store.
 */
export function getControlPlaneService(): Promise<ControlPlaneService> {
  if (!G.__controlPlaneServicePromise) {
    G.__controlPlaneServicePromise = (async () => {
      const { getControlPlaneSecretStore } = await import("./secretStore");
      const store = await getControlPlaneSecretStore();
      return new ControlPlaneService({ store });
    })();
  }
  return G.__controlPlaneServicePromise;
}

/** Nur Tests: Singleton + Zustands-Map zuruecksetzen. */
export function resetControlPlaneForTests(): void {
  G.__controlPlaneServicePromise = undefined;
  G.__controlPlaneStates = undefined;
}
