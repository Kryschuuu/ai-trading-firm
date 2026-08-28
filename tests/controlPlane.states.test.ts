/**
 * Unit-Tests der Zustandsmaschinen-Light (Task 08, Regel 5).
 *
 * 6 Ebenen × off/pending/active/error; Uebergaenge NUR ueber definierte
 * Aktionen (save/test/discover/disable); Missbrauch → StateTransitionError
 * (409/422). Live bleibt IMMER off — liveEnabled kommt ausschliesslich aus
 * readGateState() (bis task-11 hart gesperrt).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  StateTransitionError,
  applyAction,
  createInitialControlState,
  readGateState,
  type ControlLayerId,
  type ProbeOutcome,
} from "../src/brokers/control-plane/states";

const NOW = "2026-08-28T12:00:00.000Z";

const CAPS_FULL = {
  paper: true,
  testnet: true,
  trading: true,
  discovery: true,
};

const CAPS_PAPER_ONLY = {
  paper: true,
  testnet: false,
  trading: true,
  discovery: true,
};

const PROBE_OK: ProbeOutcome = {
  ok: true,
  connected: true,
  permissions: ["READ", "TRADE"],
};

const PROBE_FAILED: ProbeOutcome = {
  ok: false,
  connected: false,
  permissions: [],
  errorCode: "UNAUTHORIZED",
  message: "SAFE: abgelehnt",
};

test("Initialzustand: alle 6 Ebenen off, liveEnabled IMMER false, Gate-Reason gesetzt", () => {
  const state = createInitialControlState("ALPACA");
  for (const id of [
    "connection",
    "marketDiscovery",
    "permissions",
    "paper",
    "testnet",
    "live",
  ] as ControlLayerId[]) {
    assert.equal(state.layers[id].state, "off", id);
  }
  assert.equal(state.connected, false);
  assert.equal(state.permissions.length, 0);
  assert.equal(state.liveEnabled, false);
  assert.match(state.liveReason, /LIVE_GATE_LOCKED/);
  assert.equal(state.discovery.count, 0);
});

test("save mit OK-Probe: connection/permissions/paper aktiv, discovery pending, live off", () => {
  const next = applyAction(createInitialControlState("BITUNIX"), {
    action: "save",
    probe: PROBE_OK,
    capabilities: CAPS_FULL,
    now: NOW,
  });
  assert.equal(next.layers.connection.state, "active");
  assert.equal(next.layers.permissions.state, "active");
  assert.equal(next.layers.paper.state, "active");
  assert.equal(next.layers.marketDiscovery.state, "pending");
  assert.equal(next.layers.live.state, "off");
  assert.equal(next.connected, true);
  assert.deepEqual(next.permissions, ["READ", "TRADE"]);
  assert.equal(next.updatedAt, NOW);
});

test("save mit Fehler-Probe: connection error, permissions off, SAFE-Detail", () => {
  const next = applyAction(createInitialControlState("ALPACA"), {
    action: "save",
    probe: PROBE_FAILED,
    capabilities: CAPS_PAPER_ONLY,
    now: NOW,
  });
  assert.equal(next.layers.connection.state, "error");
  assert.match(next.layers.connection.detail ?? "", /UNAUTHORIZED/);
  assert.equal(next.layers.permissions.state, "off");
  assert.equal(next.connected, false);
  assert.equal(next.liveEnabled, false);
});

test("save ohne testnet-capability: testnet-Ebene off mit klarem Grund", () => {
  const next = applyAction(createInitialControlState("BITUNIX"), {
    action: "save",
    probe: PROBE_OK,
    capabilities: CAPS_PAPER_ONLY, // testnet=false (BITUNIX: kein Testnet)
    now: NOW,
  });
  assert.equal(next.layers.testnet.state, "off");
  assert.match(next.layers.testnet.detail ?? "", /NOT_SUPPORTED_CAPABILITY:testnet/);
  assert.equal(next.layers.paper.state, "active");
});

test("test mit OK-Probe reaktiviert connection/permissions; testnet bleibt wie vorher", () => {
  const initial = applyAction(createInitialControlState("BITUNIX"), {
    action: "save",
    probe: PROBE_OK,
    capabilities: CAPS_FULL,
    now: NOW,
  });
  const next = applyAction(initial, {
    action: "test",
    probe: PROBE_OK,
    capabilities: CAPS_FULL,
    now: NOW,
  });
  assert.equal(next.layers.connection.state, "active");
  assert.deepEqual(next.permissions, ["READ", "TRADE"]);
});

test("discover: nur nach aktiver Verbindung, setzt count/lastSync", () => {
  const connected = applyAction(createInitialControlState("BITUNIX"), {
    action: "save",
    probe: PROBE_OK,
    capabilities: CAPS_FULL,
    now: NOW,
  });
  const next = applyAction(connected, {
    action: "discover",
    capabilities: CAPS_FULL,
    discoveryCount: 42,
    now: NOW,
  });
  assert.equal(next.discovery.state, "active");
  assert.equal(next.discovery.count, 42);
  assert.equal(next.discovery.lastSync, NOW);
  assert.equal(next.layers.marketDiscovery.state, "active");
});

test("discover: Fehlschlag (count=-1) → Ebene error", () => {
  const connected = applyAction(createInitialControlState("BITUNIX"), {
    action: "save",
    probe: PROBE_OK,
    capabilities: CAPS_FULL,
    now: NOW,
  });
  const next = applyAction(connected, {
    action: "discover",
    capabilities: CAPS_FULL,
    discoveryCount: -1,
    now: NOW,
  });
  assert.equal(next.discovery.state, "error");
  assert.equal(next.layers.marketDiscovery.state, "error");
});

test("disable setzt komplett zurueck (off/off/…), live bleibt gesperrt", () => {
  const connected = applyAction(createInitialControlState("BITUNIX"), {
    action: "save",
    probe: PROBE_OK,
    capabilities: CAPS_FULL,
    now: NOW,
  });
  const next = applyAction(connected, { action: "disable", now: NOW });
  for (const id of [
    "connection",
    "marketDiscovery",
    "permissions",
    "paper",
    "testnet",
    "live",
  ] as ControlLayerId[]) {
    assert.equal(next.layers[id].state, "off", id);
  }
  assert.equal(next.connected, false);
  assert.equal(next.liveEnabled, false);
});

// ── Missbrauch (409/422) ────────────────────────────────────────────────────

test("Missbrauch: save bei aktiver Verbindung → ALREADY_CONNECTED", () => {
  const connected = applyAction(createInitialControlState("BITUNIX"), {
    action: "save",
    probe: PROBE_OK,
    capabilities: CAPS_FULL,
    now: NOW,
  });
  assert.throws(
    () =>
      applyAction(connected, {
        action: "save",
        probe: PROBE_OK,
        capabilities: CAPS_FULL,
        now: NOW,
      }),
    (err: unknown) =>
      err instanceof StateTransitionError && err.code === "ALREADY_CONNECTED"
  );
});

test("Missbrauch: discover ohne Verbindung → CONNECTION_REQUIRED", () => {
  assert.throws(
    () =>
      applyAction(createInitialControlState("BITUNIX"), {
        action: "discover",
        capabilities: CAPS_FULL,
        discoveryCount: 1,
        now: NOW,
      }),
    (err: unknown) =>
      err instanceof StateTransitionError && err.code === "CONNECTION_REQUIRED"
  );
});

test("Missbrauch: discover ohne Capability → NOT_SUPPORTED_CAPABILITY", () => {
  const connected = applyAction(createInitialControlState("PAPER"), {
    action: "save",
    probe: PROBE_OK,
    capabilities: { ...CAPS_PAPER_ONLY, discovery: false },
    now: NOW,
  });
  assert.throws(
    () =>
      applyAction(connected, {
        action: "discover",
        capabilities: { ...CAPS_PAPER_ONLY, discovery: false },
        discoveryCount: 1,
        now: NOW,
      }),
    (err: unknown) =>
      err instanceof StateTransitionError &&
      err.code === "NOT_SUPPORTED_CAPABILITY"
  );
});

test("Missbrauch: disable ohne Konfiguration → NOT_CONFIGURED", () => {
  assert.throws(
    () => applyAction(createInitialControlState("ALPACA"), { action: "disable", now: NOW }),
    (err: unknown) =>
      err instanceof StateTransitionError && err.code === "NOT_CONFIGURED"
  );
});

test("Missbrauch: Aktion ohne Probe → PROBE_MISSING; unbekannte Aktion → UNKNOWN_ACTION", () => {
  assert.throws(
    () =>
      applyAction(createInitialControlState("ALPACA"), {
        action: "save",
        capabilities: CAPS_PAPER_ONLY,
        now: NOW,
      }),
    (err: unknown) =>
      err instanceof StateTransitionError && err.code === "PROBE_MISSING"
  );
  assert.throws(
    () =>
      applyAction(createInitialControlState("ALPACA"), {
        action: "explode" as never,
        now: NOW,
      }),
    (err: unknown) =>
      err instanceof StateTransitionError && err.code === "UNKNOWN_ACTION"
  );
});

test("readGateState: einzige Live-Quelle — IMMER false, kein Parameter aendert das", () => {
  const gate = readGateState();
  assert.equal(gate.liveEnabled, false);
  assert.equal(gate.source, "control-plane");
  assert.match(gate.reason, /task-11/);
});
