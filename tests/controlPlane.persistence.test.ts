/**
 * C4 (v1.36.16) — Control-Plane-Zustand ueberlebt einen Prozess-Neustart.
 *
 * Befund: `VenueControlState` lebte nur in `globalThis.__controlPlaneStates`;
 * nach einem Neustart zeigte der Broker-Tab `configured=true, connected=false`
 * (INITIAL), obwohl die Credentials persistent waren.
 *
 * Akzeptanz (Prompt C4):
 *   - writeState + „Neustart" (Cache geleert) → readState liefert den
 *     persistierten Zustand; getStatus spiegelt ihn.
 *   - Kein Verhaltensunterschied, solange der Cache warm ist.
 *   - Zeile ist status-only (keine Secrets), Live wird IMMER neu projiziert.
 *   - DB-Ausfall bricht den Control-Plane-Pfad NIE (Fail-Safe wie vor C4).
 */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import {
  ControlPlaneService,
  DbControlStateRepository,
  MemoryControlStateRepository,
  MemorySecretStorage,
  StateTransitionError,
  clearControlPlaneAuditForTests,
  clearControlPlaneStateCacheForTests,
  createAesGcmSecretStore,
  createInitialControlState,
  fromPersistedRow,
  loadVenueControlState,
  readVenueControlStatePublic,
  resetControlPlaneForTests,
  resolveControlStateRepository,
  setControlStateRepositoryForTests,
  toPersistedRow,
  warmControlPlaneStateCache,
  type ControlStateRepository,
  type PersistedControlState,
  type VenueSecretStore,
} from "../src/brokers/control-plane";
import { scanJsonBody } from "../src/brokers/control-plane/secretScan";

const NOW = "2026-09-04T09:00:00.000Z";
const VALID = {
  apiKey: "k-persist-abcdef0123456789",
  apiSecret: "s-persist-abcdef0123456789",
};

/** Ein Secret-Store, der (wie die echte DB) einen Neustart ueberlebt. */
function persistentStore(): VenueSecretStore {
  return createAesGcmSecretStore({
    storage: new MemorySecretStorage(),
    keyBuffer: Buffer.alloc(32, 9),
  });
}

function service(store: VenueSecretStore, opts: { connected?: boolean; permissions?: string[] } = {}) {
  return new ControlPlaneService({
    store,
    now: () => NOW,
    probeFn: async () => ({
      ok: opts.connected ?? true,
      connected: opts.connected ?? true,
      permissions: opts.permissions ?? ["READ", "TRADE"],
      errorCode: opts.connected === false ? "UNAUTHORIZED" : undefined,
    }),
    discoverFn: async () => 42,
  });
}

/** Simulierter Prozess-Neustart: nur der Cache stirbt, „DB" + Secrets bleiben. */
function restartProcess(): void {
  clearControlPlaneStateCacheForTests();
}

let repo: MemoryControlStateRepository;

beforeEach(() => {
  resetControlPlaneForTests();
  clearControlPlaneAuditForTests();
  repo = new MemoryControlStateRepository();
  setControlStateRepositoryForTests(repo);
});

after(() => {
  resetControlPlaneForTests();
});

test("C4: save → Neustart → getStatus zeigt den letzten bekannten Zustand (nicht INITIAL)", async () => {
  const store = persistentStore();
  const svc = service(store, { permissions: ["READ", "TRADE"] });

  await svc.saveCredentials("admin", "BITUNIX", VALID);
  const warm = await svc.getStatus("BITUNIX");
  assert.equal(warm.configured, true);
  assert.equal(warm.connected, true);
  assert.equal(warm.layers.connection.state, "active");

  // Zeile wurde upsertet (writeState → repo.save):
  const row = await repo.load("BITUNIX");
  assert.ok(row, "venue_control_state-Zeile existiert");
  assert.equal(row.configured, true);
  assert.equal(row.connected, true);
  assert.equal(row.connectionState, "active");
  assert.deepEqual(row.permissions, ["READ", "TRADE"]);
  assert.equal(row.lastProbe, NOW);
  assert.equal(row.updatedAt, NOW);

  // ── Prozess-„Neustart": Cache weg, DB + Secrets bleiben ──
  restartProcess();
  const svc2 = service(store);

  // Vor C4: configured=true, connected=false (INITIAL). Jetzt:
  const cold = await svc2.getStatus("BITUNIX");
  assert.equal(cold.configured, true);
  assert.equal(cold.connected, true, "connected ueberlebt den Neustart");
  assert.deepEqual(cold.permissions, ["READ", "TRADE"]);
  assert.equal(cold.layers.connection.state, "active");
  assert.equal(cold.layers.connection.detail, "READ_ONLY_PROBE_OK");
  assert.equal(cold.layers.permissions.state, "active");
  assert.equal(cold.layers.paper.state, "active");
  assert.equal(cold.layers.marketDiscovery.state, "pending");
  assert.equal(cold.updatedAt, NOW);
  // Live bleibt eine Projektion des Enforcers — nie aus der DB:
  assert.equal(cold.liveEnabled, false);
  assert.equal(cold.layers.live.state, "off");
  // Identisch mit dem warmen Zustand (bis auf die Live-Reason, die live projiziert wird):
  assert.deepEqual(
    { ...cold, health: null, liveReason: null, layers: { ...cold.layers, live: null } },
    { ...warm, health: null, liveReason: null, layers: { ...warm.layers, live: null } }
  );
});

test("C4: readState laedt nach Neustart aus der DB (loadVenueControlState / readVenueControlStatePublic)", async () => {
  const store = persistentStore();
  await service(store).saveCredentials("admin", "KRAKEN", VALID);
  restartProcess();

  // Async-Pfad: direkt der persistierte Zustand.
  const loaded = await loadVenueControlState("KRAKEN");
  assert.equal(loaded.connected, true);
  assert.equal(loaded.layers.connection.state, "active");

  // Sync-Pfad (Live-Gate-Bridge) liest den jetzt warmen Cache:
  const pub = readVenueControlStatePublic("KRAKEN");
  assert.equal(pub.layers.connection.state, "active");
  assert.equal(pub.connected, true);
});

test("C4: Sync-Leser bei kaltem Cache ist fail-safe (off) und stoesst die Hydration an", async () => {
  const store = persistentStore();
  await service(store).saveCredentials("admin", "BINANCE", VALID);
  restartProcess();

  // Kalt + synchron: Initialzustand (nicht aktiv => Live-Gate deny), kein Crash.
  const cold = readVenueControlStatePublic("BINANCE");
  assert.equal(cold.layers.connection.state, "off");
  // Hydration wurde im Hintergrund gestartet — kurz danach ist der Cache warm:
  await loadVenueControlState("BINANCE");
  assert.equal(readVenueControlStatePublic("BINANCE").layers.connection.state, "active");
});

test("C4: Boot-Warm-up laedt alle persistierten Venues in den Cache (auch fuer synchrone Leser)", async () => {
  const store = persistentStore();
  const svc = service(store);
  await svc.saveCredentials("admin", "BITUNIX", VALID);
  await svc.saveCredentials("admin", "ALPACA", VALID);
  restartProcess();

  const loaded = await warmControlPlaneStateCache();
  assert.equal(loaded, 2);
  assert.equal(readVenueControlStatePublic("BITUNIX").connected, true);
  assert.equal(readVenueControlStatePublic("ALPACA").connected, true);
  // Idempotent: zweiter Aufruf laedt nichts doppelt.
  assert.equal(await warmControlPlaneStateCache(), 2);
});

test("C4: Fehler-Zustand + Discovery + disable werden persistiert und rehydriert", async () => {
  const store = persistentStore();

  // Fehler-Probe → connection=error + lastError.
  await service(store, { connected: false, permissions: [] }).saveCredentials("admin", "DYDX", VALID);
  let row = await repo.load("DYDX");
  assert.ok(row);
  assert.equal(row.connected, false);
  assert.equal(row.connectionState, "error");
  assert.equal(row.lastError, "UNAUTHORIZED");
  restartProcess();
  const err = await service(store).getStatus("DYDX");
  assert.equal(err.connected, false);
  assert.equal(err.layers.connection.state, "error");
  assert.equal(err.layers.connection.detail, "UNAUTHORIZED");

  // Discovery auf PAPER → discovery_state/count/lastSync.
  const paper = service(store);
  await paper.testConnection("admin", "PAPER");
  await paper.discover("admin", "PAPER");
  row = await repo.load("PAPER");
  assert.ok(row);
  assert.equal(row.discoveryState, "active");
  assert.equal(row.discoveryCount, 42);
  assert.equal(row.discoveryLastSync, NOW);
  restartProcess();
  const disc = await service(store).getStatus("PAPER");
  assert.equal(disc.discovery.state, "active");
  assert.equal(disc.discovery.count, 42);
  assert.equal(disc.layers.marketDiscovery.state, "active");

  // delete/disable → alles off, configured=false — auch nach Neustart.
  const svc = service(store);
  await svc.saveCredentials("admin", "IBKR", VALID);
  await svc.deleteCredentials("admin", "IBKR");
  row = await repo.load("IBKR");
  assert.ok(row);
  assert.equal(row.configured, false);
  assert.equal(row.connectionState, "off");
  restartProcess();
  const off = await service(store).getStatus("IBKR");
  assert.equal(off.configured, false);
  assert.equal(off.connected, false);
  assert.equal(off.layers.connection.state, "off");
});

test("C4: fehlende Zeile → Initialzustand, lazy persistiert; Zeile ist status-only (keine Secrets)", async () => {
  const store = persistentStore();
  assert.equal(await repo.load("ALPACA"), null);
  const status = await service(store).getStatus("ALPACA");
  assert.equal(status.connected, false);
  const row = await repo.load("ALPACA");
  assert.ok(row, "Initialzustand wurde lazy persistiert");
  assert.equal(row.configured, false);
  assert.equal(row.connectionState, "off");

  await service(store).saveCredentials("admin", "ALPACA", VALID);
  const all = await repo.all();
  const json = JSON.stringify(all);
  assert.ok(!json.includes(VALID.apiKey), "kein apiKey in venue_control_state");
  assert.ok(!json.includes(VALID.apiSecret), "kein apiSecret in venue_control_state");
  assert.deepEqual(scanJsonBody(all), [], "Scanner: keine Secret-Muster in der Persistenz");
  const allowed = new Set([
    "venue", "configured", "connected", "permissions", "liveEnabled", "lastProbe",
    "connectionState", "discoveryState", "discoveryCount", "discoveryLastSync",
    "lastError", "layers", "updatedAt",
  ]);
  for (const r of all) for (const k of Object.keys(r)) assert.ok(allowed.has(k), `unerwartetes Feld ${k}`);
});

test("C4: Warm-Cache-Verhalten unveraendert — Missbrauch (ALREADY_CONNECTED) greift auch nach Neustart", async () => {
  const store = persistentStore();
  const svc = service(store);
  await svc.saveCredentials("admin", "BITUNIX", VALID);
  const isAlreadyConnected = (err: unknown) =>
    err instanceof StateTransitionError && err.code === "ALREADY_CONNECTED";
  await assert.rejects(() => svc.saveCredentials("admin", "BITUNIX", VALID), isAlreadyConnected);
  restartProcess();
  // Vor C4 ging ein erneutes save nach Neustart durch (Zustand INITIAL) — jetzt nicht mehr.
  await assert.rejects(() => service(store).saveCredentials("admin", "BITUNIX", VALID), isAlreadyConnected);
});

test("C4: Fail-Safe — kaputtes Repository bricht den Control-Plane-Pfad nicht (Cache bleibt Wahrheit)", async () => {
  const broken: ControlStateRepository = {
    backend: "broken",
    load: async () => { throw new Error("db down"); },
    save: async () => { throw new Error("db down"); },
    all: async () => { throw new Error("db down"); },
    remove: async () => { throw new Error("db down"); },
  };
  setControlStateRepositoryForTests(broken);
  const origWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  try {
    const svc = service(persistentStore());
    const saved = await svc.saveCredentials("admin", "BITUNIX", VALID);
    assert.equal(saved.connected, true);
    const status = await svc.getStatus("BITUNIX");
    assert.equal(status.connected, true, "warmer Cache liefert weiter");
    assert.equal(await warmControlPlaneStateCache(), 0);
    // Genau EINE Warnung pro Prozess, redigiert (keine Secrets):
    assert.equal(warnings.filter((w) => w.includes("venue_control_state")).length, 1);
    assert.ok(!warnings.join("\n").includes(VALID.apiSecret));
  } finally {
    console.warn = origWarn;
  }
});

test("C4: Serialisierung — toPersistedRow/fromPersistedRow sind verlustfrei; Live wird neu projiziert", () => {
  const initial = createInitialControlState("BITUNIX");
  const row = toPersistedRow(initial, false);
  assert.equal(row.venue, "BITUNIX");
  assert.equal(row.configured, false);
  assert.equal(row.connectionState, "off");
  assert.deepEqual(row.permissions, []);
  const back = fromPersistedRow(row);
  assert.deepEqual(back.layers, initial.layers);
  assert.deepEqual(back.discovery, initial.discovery);
  assert.equal(back.liveEnabled, false);

  // Legacy-/Fremd-Zeile ohne Ebenen-Snapshot: Rekonstruktion aus Einzelspalten.
  const legacy: PersistedControlState = {
    venue: "KRAKEN",
    configured: true,
    connected: true,
    permissions: ["READ"],
    liveEnabled: true, // darf NIE durchschlagen
    lastProbe: NOW,
    connectionState: "active",
    discoveryState: "error",
    discoveryCount: 0,
    discoveryLastSync: null,
    lastError: "DISCOVERY_FAILED",
    layers: null,
    updatedAt: NOW,
  };
  const rebuilt = fromPersistedRow(legacy);
  assert.equal(rebuilt.connected, true);
  assert.equal(rebuilt.layers.connection.state, "active");
  assert.equal(rebuilt.layers.connection.at, NOW);
  assert.equal(rebuilt.layers.permissions.state, "active");
  assert.equal(rebuilt.layers.marketDiscovery.state, "error");
  assert.equal(rebuilt.layers.marketDiscovery.detail, "DISCOVERY_FAILED");
  assert.equal(rebuilt.liveEnabled, false, "live_enabled aus der DB ist keine Freigabe");
  assert.equal(rebuilt.layers.live.state, "off");
});

test("C4: Backend-Wahl — memory/db explizit; automatisch db bei erreichbarer Tabelle, sonst Memory-Fallback", async () => {
  const mem = await resolveControlStateRepository({ CONTROL_STATE_BACKEND: "memory" });
  assert.equal(mem.backend, "memory");
  const explicitDb = await resolveControlStateRepository({ CONTROL_STATE_BACKEND: "db" });
  assert.equal(explicitDb.backend, "db", "explizit db → kein Ping, kein Fallback");
  const origWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  try {
    // Auto-Modus: mit erreichbarer venue_control_state → db, sonst (CI/Sandbox
    // ohne PostgreSQL) Memory-Fallback mit Warnung — nie ein Crash.
    const auto = await resolveControlStateRepository({});
    const reachable = await new DbControlStateRepository().ping();
    assert.equal(auto.backend, reachable ? "db" : "memory");
    if (!reachable) assert.ok(warnings.some((w) => w.includes("venue_control_state")), "Fallback wird gemeldet");
  } finally {
    console.warn = origWarn;
  }
});
