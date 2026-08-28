/**
 * Zustandsmaschinen-Light der Broker Control Plane (Task 08, Regel 5).
 *
 * Pro Venue existiert GENAU EIN Zustandsobjekt mit 6 Ebenen:
 *   connection, marketDiscovery, permissions, paper, testnet, live
 * Jede Ebene hat einen eindeutigen Zustand: off | pending | active | error.
 *
 * Uebergaenge entstehen AUSSCHLIESSLICH durch definierte Aktionen:
 *   save (Credential speichern + Probe), test (Verbindungstest),
 *   discover (Market Discovery), disable (trennen + zuruecksetzen).
 * Jeder andere Uebergang ist Missbrauch → StateTransitionError (409/422).
 *
 * LIVE (hart, Regel 5): Die Live-Ebene bleibt `off` als Anzeige-Ebene; das
 * zentrale Live-Gate (Task 11) projiziert `liveEnabled` über readGateState().
 * Default bleibt false (State DISCONNECTED, Flags off, kein Suite-Stamp) —
 * KEIN Aufrufer, kein Env-Wert, keine UI kann das ohne kompletten,
 * auditierbaren Machine-Durchlauf (inkl. Human-Gate) ändern.
 */
import { BrokerError } from "@/contracts/broker";
import { evaluateLiveOrder } from "../../live-gate/enforcer";

export const CONTROL_LAYER_IDS = [
  "connection",
  "marketDiscovery",
  "permissions",
  "paper",
  "testnet",
  "live",
] as const;

export type ControlLayerId = (typeof CONTROL_LAYER_IDS)[number];

export type LayerStateValue = "off" | "pending" | "active" | "error";

export interface ControlLayer {
  state: LayerStateValue;
  /** ISO-Zeitstempel des letzten Uebergangs dieser Ebene. */
  at: string | null;
  /** Maschinenlesbarer Grund/Kontext (niemals Secret-Inhalt). */
  detail?: string | null;
}

export type ControlAction = "save" | "test" | "discover" | "disable";

export interface DiscoveryInfo {
  state: LayerStateValue;
  count: number;
  lastSync: string | null;
}

export interface VenueControlState {
  venue: string;
  layers: Record<ControlLayerId, ControlLayer>;
  discovery: DiscoveryInfo;
  /** Projiziert aus connection/permissions (kein eigenes Flag). */
  connected: boolean;
  permissions: string[];
  /** Projektion aus readGateState() (Enforcer) — kein eigenes Flag. */
  liveEnabled: boolean;
  liveReason: string;
  updatedAt: string | null;
}

/** Missbrauch eines definierten Uebergangs → 409/422 mit klarem Fehler. */
export class StateTransitionError extends BrokerError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "StateTransitionError";
  }
}

/**
 * Gate-Service-Meldung (einzige erlaubte Live-Quelle).
 *
 * Seit Task 11 liest diese Funktion den ZENTRALEN Live-Gate-Enforcer
 * (src/live-gate): `liveEnabled` ist genau dann true, wenn der Enforcer eine
 * Live-Order erlauben würde (State LIVE_ENABLED + Flags + Suite + Control
 * Plane + kein Kill). Default nach Task 11 bleibt false — die Anzeige ist
 * reine Projektion, es gibt keinen Parameter, der sie ohne Machine-Durchlauf
 * ändern kann.
 */
export interface GateState {
  liveEnabled: boolean;
  reason: string;
  source: "live-gate";
  /** Machine-Zustand des Venues (DISCONNECTED, …, LIVE_ENABLED). */
  state: string | null;
  /** Konkreter Deny-/Allow-Code des Enforcers. */
  code: string;
}

export function readGateState(venue = "BITUNIX"): GateState {
  try {
    // Statischer Import ist sicher: live-gate/enforcer importiert die
    // Control Plane NICHT (Provider-Pattern), es gibt keinen Import-Kreis.
    const decision = evaluateLiveOrder(venue, { audit: false });
    return {
      liveEnabled: decision.allowed,
      reason: decision.reason,
      source: "live-gate",
      state: decision.state,
      code: decision.code,
    };
  } catch (err) {
    return {
      liveEnabled: false,
      reason: `LIVE_GATE_LOCKED: Enforcer nicht bewertbar (${(err as Error).message}) — fail-safe deny.`,
      source: "live-gate",
      state: null,
      code: "ENFORCER_ERROR",
    };
  }
}

function layer(state: LayerStateValue, at: string | null, detail?: string | null): ControlLayer {
  return { state, at, detail: detail ?? null };
}

/** Initialzustand einer Venue: alles off, Live-Projektion aus dem Gate. */
export function createInitialControlState(venue: string): VenueControlState {
  const gate = readGateState(venue);
  return {
    venue,
    layers: {
      connection: layer("off", null),
      marketDiscovery: layer("off", null),
      permissions: layer("off", null),
      paper: layer("off", null),
      testnet: layer("off", null),
      live: layer("off", null, gate.reason),
    },
    discovery: { state: "off", count: 0, lastSync: null },
    connected: false,
    permissions: [],
    liveEnabled: gate.liveEnabled,
    liveReason: gate.reason,
    updatedAt: null,
  };
}

/** Ergebnis der read-only Account-Probe (siehe probe.ts). */
export interface ProbeOutcome {
  ok: boolean;
  connected: boolean;
  permissions: string[];
  errorCode?: string;
  message?: string;
}

export interface ActionPatch {
  action: ControlAction;
  probe?: ProbeOutcome;
  /** Faehigkeiten des Adapters (SSoT) fuer paper/testnet-Ebenen. */
  capabilities?: {
    paper: boolean;
    testnet: boolean;
    trading: boolean;
    discovery: boolean;
  };
  discoveryCount?: number;
  now?: string;
}

/**
 * Wendet eine definierte Aktion auf den Zustand an (pure, deterministisch).
 * Wirft `StateTransitionError` bei Missbrauch — der Aufrufer (Service/API)
 * uebersetzt die Codes in 409/422.
 */
export function applyAction(
  state: VenueControlState,
  patch: ActionPatch
): VenueControlState {
  const now = patch.now ?? new Date().toISOString();
  const layers = { ...state.layers };
  const discovery = { ...state.discovery };
  const caps = patch.capabilities ?? {
    paper: false,
    testnet: false,
    trading: false,
    discovery: false,
  };

  switch (patch.action) {
    case "save": {
      if (layers.connection.state === "active") {
        throw new StateTransitionError(
          "ALREADY_CONNECTED",
          "Verbindung ist bereits aktiv. Zuerst trennen (DELETE /credentials), dann neu speichern."
        );
      }
      const probe = patch.probe;
      if (!probe) {
        throw new StateTransitionError(
          "PROBE_MISSING",
          "Aktion 'save' verlangt ein Probe-Ergebnis."
        );
      }
      layers.connection = probe.connected
        ? layer("active", now, "READ_ONLY_PROBE_OK")
        : layer("error", now, probe.errorCode ?? "PROBE_FAILED");

      layers.permissions =
        probe.permissions.length > 0
          ? layer("active", now, `permissions=[${probe.permissions.join(",")}]`)
          : layer("off", now, "NO_PERMISSIONS");

      layers.paper = caps.paper
        ? probe.connected
          ? layer("active", now, "PAPER_MODE_AVAILABLE")
          : layer("pending", now, "wartet auf Verbindung")
        : layer("off", now, "NOT_SUPPORTED_CAPABILITY:paper");

      layers.testnet = caps.testnet
        ? probe.connected
          ? layer("active", now, "TESTNET_AVAILABLE")
          : layer("pending", now, "wartet auf Verbindung")
        : layer("off", now, "NOT_SUPPORTED_CAPABILITY:testnet");

      layers.marketDiscovery = caps.discovery
        ? layer("pending", now, "bereit fuer discover")
        : layer("off", now, "NOT_SUPPORTED_CAPABILITY:discovery");

      // Live bleibt IMMER off — Gate-Service-Meldung, keine Aenderung moeglich.
      layers.live = layer("off", now, readGateState(state.venue).reason);

      return {
        venue: state.venue,
        layers,
        discovery,
        connected: layers.connection.state === "active",
        permissions: probe.permissions,
        liveEnabled: readGateState(state.venue).liveEnabled,
        liveReason: readGateState(state.venue).reason,
        updatedAt: now,
      };
    }

    case "test": {
      const probe = patch.probe;
      if (!probe) {
        throw new StateTransitionError(
          "PROBE_MISSING",
          "Aktion 'test' verlangt ein Probe-Ergebnis."
        );
      }
      layers.connection = probe.connected
        ? layer("active", now, "CONNECTION_TEST_OK")
        : layer("error", now, probe.errorCode ?? "CONNECTION_TEST_FAILED");

      layers.permissions =
        probe.permissions.length > 0
          ? layer("active", now, `permissions=[${probe.permissions.join(",")}]`)
          : layers.permissions.state === "active"
            ? layer("active", now, "unveraendert")
            : layer("off", now, "NO_PERMISSIONS");

      if (probe.connected && layers.marketDiscovery.state === "off" && caps.discovery) {
        layers.marketDiscovery = layer("pending", now, "bereit fuer discover");
      }

      layers.paper = caps.paper
        ? probe.connected
          ? layer("active", now, "PAPER_MODE_AVAILABLE")
          : layer("error", now, probe.errorCode ?? "CONNECTION_TEST_FAILED")
        : layers.paper;

      layers.live = layer("off", now, readGateState(state.venue).reason);

      return {
        venue: state.venue,
        layers,
        discovery,
        connected: layers.connection.state === "active",
        permissions: probe.permissions,
        liveEnabled: readGateState(state.venue).liveEnabled,
        liveReason: readGateState(state.venue).reason,
        updatedAt: now,
      };
    }

    case "discover": {
      if (layers.connection.state !== "active") {
        throw new StateTransitionError(
          "CONNECTION_REQUIRED",
          "Market Discovery verlangt eine aktive Verbindung (erst connect/test)."
        );
      }
      if (!caps.discovery) {
        throw new StateTransitionError(
          "NOT_SUPPORTED_CAPABILITY",
          "Dieses Venue unterstuetzt keine Market Discovery (capabilities.discovery=false)."
        );
      }
      const count = patch.discoveryCount ?? -1;
      if (count < 0) {
        layers.marketDiscovery = layer("error", now, "DISCOVERY_FAILED");
        discovery.state = "error";
      } else {
        layers.marketDiscovery = layer("active", now, `count=${count}`);
        discovery.state = "active";
        discovery.count = count;
        discovery.lastSync = now;
      }
      layers.live = layer("off", now, readGateState(state.venue).reason);
      return {
        venue: state.venue,
        layers,
        discovery,
        connected: state.connected,
        permissions: state.permissions,
        liveEnabled: readGateState(state.venue).liveEnabled,
        liveReason: readGateState(state.venue).reason,
        updatedAt: now,
      };
    }

    case "disable": {
      if (CONTROL_LAYER_IDS.every((id) => state.layers[id].state === "off")) {
        throw new StateTransitionError(
          "NOT_CONFIGURED",
          "Nichts konfiguriert/verbunden — disable ist nur nach einer Verbindung erlaubt."
        );
      }
      const fresh = createInitialControlState(state.venue);
      fresh.updatedAt = now;
      return fresh;
    }

    default: {
      throw new StateTransitionError(
        "UNKNOWN_ACTION",
        `Unbekannte Aktion "${String((patch as { action?: string }).action)}".`
      );
    }
  }
}
