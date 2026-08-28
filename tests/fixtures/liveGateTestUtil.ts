/**
 * Test-Utilities für die Live-Gate-Suite (Task 11).
 *
 * Hermetisch: Jeder Test bekommt ein eigenes Data-Dir (tmpdir), eigene Env
 * und eigene Mock-Ports. Es werden NIE echte Orders gesetzt — der Test-Order-
 * Port ist ein Zähler-Mock (Red-Team-Anforderung „keine echten Orders in CI").
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  LiveGateService,
  getLiveGateRuntime,
  registerGatePort,
  resetGatePortsForTests,
  setVenueReadinessProvider,
  writeSuiteStamp,
  type BrokerGatePort,
  type LiveGateEnv,
  type LiveGateState,
  type LiveGateVenueRecord,
} from "../../src/live-gate";

const dirs: string[] = [];

export function mkGateDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), "live-gate-test-"));
  dirs.push(d);
  return d;
}

process.on("exit", () => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

/** Env mit hermetischem Data-Dir + wählbaren Flags (Default: alles OFF). */
export function mkEnv(overrides: Record<string, string> = {}): LiveGateEnv {
  return {
    LIVE_GATE_DATA_DIR: mkGateDir(),
    LIVE_GATE_COOLDOWN_MS: "0", // Zeitraffer: Cooldown aus (separate Tests prüfen ihn)
    ...overrides,
  };
}

/** Env für die EINZIGE erlaubende Konstellation (Flags an — State/Suite dazu). */
export function allowEnv(overrides: Record<string, string> = {}): LiveGateEnv {
  return mkEnv({
    BITUNIX_ENABLED: "true",
    BITUNIX_LIVE_ENABLED: "true",
    LIVE_TRADING_ENABLED: "true",
    REQUIRE_HUMAN_APPROVAL: "false",
    ...overrides,
  });
}

export interface MockPortBehavior {
  healthCheck?: boolean;
  fetchTicker?: boolean;
  readAccount?: boolean;
  placeTestOrder?: boolean;
  errorFreeOrders?: number;
  orders?: number;
}

export interface CountingMockPort extends BrokerGatePort {
  calls: Record<string, number>;
}

/** Zählender Mock-Port: read-only, simuliert NIE echte Orders. */
export function mockPort(behavior: MockPortBehavior = {}): CountingMockPort {
  const calls: Record<string, number> = {
    healthCheck: 0,
    fetchTicker: 0,
    readAccount: 0,
    placeTestOrder: 0,
    paperStats: 0,
  };
  return {
    calls,
    async healthCheck() {
      calls.healthCheck += 1;
      return behavior.healthCheck === false
        ? { ok: false, detail: "Verbindungstest simuliert fehlgeschlagen." }
        : { ok: true, detail: "Verbindungstest simuliert ok." };
    },
    async fetchTicker() {
      calls.fetchTicker += 1;
      return behavior.fetchTicker === false
        ? { ok: false, detail: "Market-Data-Check simuliert fehlgeschlagen." }
        : { ok: true, detail: "Public-Ticker simuliert gelesen (read-only)." };
    },
    async readAccount() {
      calls.readAccount += 1;
      return behavior.readAccount === false
        ? { ok: false, detail: "Account-Read simuliert fehlgeschlagen." }
        : { ok: true, detail: "Account-Read simuliert ok (read-only)." };
    },
    async placeTestOrder() {
      calls.placeTestOrder += 1;
      return behavior.placeTestOrder === false
        ? { ok: false, detail: "Test-Order simuliert fehlgeschlagen." }
        : { ok: true, detail: "Test-Order simuliert ok (Mock, niemals echt)." };
    },
    async paperStats() {
      calls.paperStats += 1;
      return {
        errorFreeOrders: behavior.errorFreeOrders ?? 50,
        orders: behavior.orders ?? 50,
        detail: "Paper-Statistik aus Mock-Port.",
      };
    },
  };
}

/** Service + registrierte Mock-Ports + optional Suite-Stamp/Readiness. */
export function serviceFor(
  env: LiveGateEnv,
  opts: {
    port?: CountingMockPort;
    suite?: boolean;
    readiness?: "active" | "inactive" | "none";
    paperMinOrders?: number;
  } = {}
): LiveGateService {
  const rt = getLiveGateRuntime(env);
  const port = opts.port ?? mockPort();
  registerGatePort("BITUNIX", port);
  if (opts.suite !== false) {
    writeSuiteStamp(rt.dir, { passed: true, runId: "suite-test-run", sha: "deadbeef", source: "ci" });
  }
  const readiness = opts.readiness ?? "active";
  setVenueReadinessProvider(
    readiness === "none" ? null : () => ({ active: readiness === "active" })
  );
  return new LiveGateService(rt, env);
}

/** Schreibt einen Venue-Record direkt (weißes Box-Setup für Matrix-Tests). */
export function seedState(env: LiveGateEnv, venue: string, state: LiveGateState): LiveGateVenueRecord {
  const rt = getLiveGateRuntime(env);
  const rec: LiveGateVenueRecord = {
    schemaVersion: 1,
    venue,
    state,
    updatedAt: new Date().toISOString(),
    updatedBy: "test-seed",
    pendingTransition: null,
    livePendingAt: state === "LIVE_PENDING" ? new Date().toISOString() : null,
    pendingApproval: null,
    killed: null,
    history: { transitions: 0, denials: 0, kills: 0, lastTransitionAt: null },
    auditHead: null,
  };
  rt.store.write(venue, rec);
  return rec;
}

/** Datiert livePendingAt zurück (Cooldown-Zeitraffer ohne echte Uhnen). */
export function backdateCooldown(env: LiveGateEnv, venue: string, msAgo: number): void {
  const rt = getLiveGateRuntime(env);
  const rec = rt.store.read(venue);
  rec.livePendingAt = new Date(Date.now() - msAgo).toISOString();
  rt.store.write(venue, rec);
}

/** Alle globalen Test-Zustände zurücksetzen (afterEach). */
export function resetLiveGateTestGlobals(): void {
  resetGatePortsForTests();
  setVenueReadinessProvider(null);
}
