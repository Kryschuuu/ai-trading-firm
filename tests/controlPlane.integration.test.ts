/**
 * Integrationstests der Broker Control Plane (Task 08).
 *
 * Connect-Flow mit Mock-Adapter: Speichern → Permission-Probe →
 * Permissions → Status; Zustandsuebergaenge je Ebene; Audit-Eintraege je
 * Aktion (actor, venue, action, result, timestamp) — OHNE Secrets.
 * Fehlerpfade: Probe-Fehler (SAFE-Meldung), korrupter Datensatz,
 * Entschluesselungsfehler beim Test (CREDENTIAL_READ_FAILED).
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  ControlPlaneService,
  MemorySecretStorage,
  StateTransitionError,
  clearControlPlaneAuditForTests,
  createAesGcmSecretStore,
  readControlPlaneAudit,
  type ControlPlaneAuditEntry,
  type VenueSecretStore,
} from "../src/brokers/control-plane";
import { scanJsonBody } from "../src/brokers/control-plane/secretScan";

const NOW = "2026-08-28T12:00:00.000Z";

function makeService(opts: {
  probeConnected?: boolean;
  probePermissions?: string[];
  probeErrorCode?: string;
  probeMessage?: string;
  discoveryCount?: number;
  failDiscover?: boolean;
} = {}): ControlPlaneService {
  const storage = new MemorySecretStorage();
  const store: VenueSecretStore = createAesGcmSecretStore({
    storage,
    keyBuffer: Buffer.alloc(32, 4),
  });
  return new ControlPlaneService({
    store,
    now: () => NOW,
    probeFn: async () => ({
      ok: opts.probeConnected ?? true,
      connected: opts.probeConnected ?? true,
      permissions: opts.probePermissions ?? ["READ"],
      errorCode: opts.probeErrorCode,
      message: opts.probeMessage,
    }),
    discoverFn: async () => {
      if (opts.failDiscover) throw new Error("discovery kaputt");
      return opts.discoveryCount ?? 12;
    },
  });
}

const VALID = {
  apiKey: "k-integration-abcdef012345",
  apiSecret: "s-integration-abcdef012345",
};

beforeEach(() => {
  clearControlPlaneAuditForTests();
});

test("Integration: Connect-Flow (save → Probe → Permissions → Status → delete)", async () => {
  const svc = makeService({ probePermissions: ["READ", "TRADE"] });

  const saved = await svc.saveCredentials("admin", "BITUNIX", VALID);
  assert.equal(saved.ok, true);
  assert.equal(saved.configured, true);
  assert.equal(saved.connected, true);
  assert.deepEqual(saved.permissions, ["READ", "TRADE"]);
  assert.equal(saved.liveEnabled, false);
  assert.equal(saved.probe.state, "ok");

  const status = await svc.getStatus("BITUNIX");
  assert.equal(status.configured, true);
  assert.equal(status.connected, true);
  assert.equal(status.layers.connection.state, "active");
  assert.equal(status.layers.permissions.state, "active");
  assert.equal(status.layers.paper.state, "active"); // BITUNIX capabilities.paper
  assert.equal(status.layers.testnet.state, "off"); // BITUNIX: kein Testnet
  assert.equal(status.layers.live.state, "off");
  assert.equal(status.liveEnabled, false);
  assert.match(status.liveReason, /LIVE_GATE_LOCKED/);

  // Discovery (definierte Aktion, nach Verbindung erlaubt):
  const discovered = await svc.discover("admin", "BITUNIX");
  assert.equal(discovered.discovery.state, "active");
  assert.equal(discovered.discovery.count, 12);
  assert.equal(discovered.discovery.lastSync, NOW);

  const tested = await svc.testConnection("admin", "BITUNIX");
  assert.equal(tested.connected, true);
  assert.deepEqual(tested.permissions, ["READ", "TRADE"]);

  const deleted = await svc.deleteCredentials("admin", "BITUNIX");
  assert.equal(deleted.configured, false);
  const after = await svc.getStatus("BITUNIX");
  assert.equal(after.connected, false);
  for (const id of ["connection", "marketDiscovery", "permissions", "paper", "testnet", "live"] as const) {
    assert.equal(after.layers[id].state, "off", id);
  }
});

test("Integration: Audit je Aktion — saved/probe/transition/test/deleted, ohne Secrets", async () => {
  const svc = makeService();
  await svc.saveCredentials("admin", "KRAKEN", VALID);
  await svc.testConnection("admin", "KRAKEN");
  await svc.deleteCredentials("admin", "KRAKEN");

  const entries: ControlPlaneAuditEntry[] = readControlPlaneAudit(100);
  const actions = entries.map((e) => e.action);
  assert.ok(actions.includes("credential.saved"), "credential.saved");
  assert.ok(actions.includes("permission.probe"), "permission.probe");
  assert.ok(actions.includes("state.transition"), "state.transition");
  assert.ok(actions.includes("connection.test"), "connection.test");
  assert.ok(actions.includes("credential.deleted"), "credential.deleted");

  for (const entry of entries) {
    assert.equal(entry.actor, "admin");
    assert.equal(entry.venue, "KRAKEN");
    assert.ok(["OK", "DENIED", "ERROR"].includes(entry.result));
    assert.ok(Number.isFinite(Date.parse(entry.at)), "timestamp ISO");
  }

  // KEINE Secrets im Audit (Scanner muss leer sein):
  const findings = scanJsonBody(entries);
  assert.deepEqual(findings, [], "Audit enthaelt keine Secret-Muster");
});

test("Integration: Probe-Fehler → Zustand error mit SAFE-Meldung (kein Secret-Leak)", async () => {
  const svc = makeService({
    probeConnected: false,
    probeErrorCode: "UNAUTHORIZED",
    probeMessage: "Die Venue hat die Zugangsdaten abgelehnt (401, read-only Probe).",
  });
  const saved = await svc.saveCredentials("admin", "ALPACA", VALID);
  assert.equal(saved.connected, false);
  assert.equal(saved.probe.state, "error");
  assert.equal(saved.probe.errorCode, "UNAUTHORIZED");
  assert.match(saved.probe.message ?? "", /401/);
  assert.ok(!(saved.probe.message ?? "").includes(VALID.apiSecret));

  const status = await svc.getStatus("ALPACA");
  assert.equal(status.layers.connection.state, "error");
  assert.equal(status.connected, false);
});

test("Integration: Missbrauch — save bei aktiver Verbindung / test ohne Credentials / delete ohne Konfiguration", async () => {
  const svc = makeService();
  await svc.saveCredentials("admin", "BINANCE", VALID);
  await assert.rejects(
    () => svc.saveCredentials("admin", "BINANCE", VALID),
    (err: unknown) =>
      err instanceof StateTransitionError && err.code === "ALREADY_CONNECTED"
  );

  const svc2 = makeService();
  await assert.rejects(
    () => svc2.testConnection("admin", "BINANCE"),
    (err: unknown) =>
      err instanceof StateTransitionError && err.code === "NO_CREDENTIALS"
  );
  await assert.rejects(
    () => svc2.deleteCredentials("admin", "BINANCE"),
    (err: unknown) =>
      err instanceof StateTransitionError && err.code === "NOT_CONFIGURED"
  );
});

test("Integration: PAPER braucht keine Credentials (422) — Test funktioniert trotzdem", async () => {
  const svc = makeService({ probePermissions: ["READ", "TRADE"] });
  await assert.rejects(
    () => svc.saveCredentials("admin", "PAPER", VALID),
    (err: unknown) =>
      err instanceof StateTransitionError && err.code === "NO_CREDENTIALS_REQUIRED"
  );
  const tested = await svc.testConnection("admin", "PAPER");
  assert.equal(tested.connected, true);
  assert.deepEqual(tested.permissions, ["READ", "TRADE"]);
  const status = await svc.getStatus("PAPER");
  assert.equal(status.layers.connection.state, "active");
});

test("Integration: korrupter Datensatz (falscher Schluessel) → Test SAFE, kein Crash", async () => {
  // Datensatz mit Schluessel A schreiben, mit Schluessel B lesen:
  const storage = new MemorySecretStorage();
  const storeA = createAesGcmSecretStore({ storage, keyBuffer: Buffer.alloc(32, 1) });
  const storeB = createAesGcmSecretStore({ storage, keyBuffer: Buffer.alloc(32, 2) });
  await storeA.put("DYDX", VALID);

  const svcWrongKey = new ControlPlaneService({
    store: storeB, // falscher Schluessel fuer den Datensatz von storeA
    now: () => NOW,
  });
  const tested = await svcWrongKey.testConnection("admin", "DYDX");
  assert.equal(tested.connected, false);
  assert.deepEqual(tested.permissions, []);
  const status = await svcWrongKey.getStatus("DYDX");
  assert.equal(status.layers.connection.state, "error");
  assert.match(
    status.layers.connection.detail ?? "",
    /CREDENTIAL_READ_FAILED/
  );
});

test("Integration: getStatus enthaelt NIE Secret-Inhalte (Scanner + Feld-Whitelist)", async () => {
  const svc = makeService({ probePermissions: ["READ", "TRADE"] });
  await svc.saveCredentials("admin", "BITUNIX", VALID);
  const status = await svc.getStatus("BITUNIX");

  const json = JSON.stringify(status);
  assert.ok(!json.includes(VALID.apiKey), "kein apiKey-Echo");
  assert.ok(!json.includes(VALID.apiSecret), "kein apiSecret-Echo");
  assert.deepEqual(scanJsonBody(status), [], "Scanner findet keine Secret-Muster");

  const allowed = new Set([
    "ok", "venue", "configured", "connected", "permissions",
    "liveEnabled", "liveReason", "discovery", "health", "layers", "updatedAt",
    "state", "at", "detail", "count", "lastSync", "status", "latencyMs", "details",
    // 6 Zustands-Ebenen der Control Plane:
    "connection", "marketDiscovery", "permissions", "paper", "testnet", "live",
  ]);
  const walk = (value: unknown, path: string) => {
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    if (value && typeof value === "object") {
      // health.details ist der freie Adapter-Vertrag aus Task 02
      // (dort separat auditiert: niemals Credentials/Infrastruktur) —
      // fuer die Feld-Whitelist der Control Plane ist nur wichtig,
      // dass darin kein Secret-Muster steht (Scanner prueft das oben).
      if (path === "status.health.details") return;
      for (const [key, child] of Object.entries(value)) {
        assert.ok(allowed.has(key), `unerlaubtes Feld ${path}.${key}`);
        walk(child, `${path}.${key}`);
      }
    }
  };
  walk(status, "status");
});
