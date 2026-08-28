/**
 * Enforcement-Tests (Task 11, Security-Suite): SINGLE POINT OF ENFORCEMENT.
 *
 * 1. VOLLE Matrix: Order-Versuch je Zustand (9) × Flags
 *    (BITUNIX_ENABLED, BITUNIX_LIVE_ENABLED, LIVE_TRADING_ENABLED,
 *    REQUIRE_HUMAN_APPROVAL = 2^4) × Suite (gültig/ungültig) × Control-Plane
 *    (aktiv/inaktiv/unbekannt) — NUR die exakt erlaubte Konstellation lässt
 *    durch; alle anderen → LiveTradingGateError + Audit-DENY.
 * 2. Red-Team „Flag-Manipulation": alle Flags an, kein State → deny.
 * 3. Red-Team „Zustands-Sprung": State-File manipulativ auf LIVE_ENABLED ohne
 *    Audit-Kette/Neudurchlauf → Enforcer folgt nur der persistierten Machine;
 *    Kill-Datei dominiert trotzdem (Defense in Depth).
 * 4. PAPER kann nie live (Capability); unbekannte Venues → deny.
 * 5. Integration: getBroker("BITUNIX","live") nur in der erlaubten
 *    Konstellation; Adapter placeOrder (live-Modus) ruft den Enforcer.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { LiveTradingGateError } from "../src/contracts/broker";
import {
  LIVE_GATE_STATES,
  appendKillEntry,
  assertLiveOrderAllowed,
  evaluateLiveOrder,
  getLiveGateRuntime,
  setVenueReadinessProvider,
  writeSuiteStamp,
  type LiveGateState,
} from "../src/live-gate";
import { setGatePortForTests } from "../src/live-gate/checks";
import { allowEnv, mkEnv, mockPort, resetLiveGateTestGlobals, seedState } from "./fixtures/liveGateTestUtil";

beforeEach(() => {
  setGatePortForTests("BITUNIX", null);
});

afterEach(() => {
  resetLiveGateTestGlobals();
  delete process.env.BITUNIX_ENABLED;
  delete process.env.BITUNIX_LIVE_ENABLED;
  delete process.env.LIVE_TRADING_ENABLED;
  delete process.env.REQUIRE_HUMAN_APPROVAL;
  delete process.env.LIVE_GATE_DATA_DIR;
});

const FLAG_KEYS = ["BITUNIX_ENABLED", "BITUNIX_LIVE_ENABLED", "LIVE_TRADING_ENABLED", "REQUIRE_HUMAN_APPROVAL"] as const;

/** Erlaubt der Enforcer für diese Konstellation? (Referenz-Oracle) */
function oracle(state: LiveGateState, mask: number, opts: { suite?: boolean; readiness?: string }): boolean {
  const flagsOk =
    (mask & 1) !== 0 && (mask & 2) !== 0 && (mask & 4) !== 0; // venue, venueLive, platform an
  const humanOk = (mask & 8) !== 0 || state === "HUMAN_APPROVED" || state === "LIVE_ENABLED";
  const suiteOk = opts.suite !== false;
  const cpOk = opts.readiness !== "inactive" && opts.readiness !== "none";
  return state === "LIVE_ENABLED" && flagsOk && humanOk && suiteOk && cpOk;
}

test("Matrix 9 States × 16 Flag-Kombis × Suite × Control Plane: nur exakt erlaubte Konstellation lässt durch", async () => {
  let allowed = 0;
  let denied = 0;
  let falseAllows = 0;
  let falseDenies = 0;

  for (const state of LIVE_GATE_STATES) {
    for (let mask = 0; mask < 16; mask++) {
      const suiteVariants: Array<boolean | "invalid"> = state === "LIVE_ENABLED" && oracle(state, mask, { suite: true }) ? [true, false] : [true];
      const readinessVariants =
        state === "LIVE_ENABLED" && oracle(state, mask, { suite: true }) ? ["active", "inactive", "none"] : ["active"];
      for (const suiteVariant of suiteVariants) {
        for (const readiness of readinessVariants) {
          const env = mkEnv({
            BITUNIX_ENABLED: mask & 1 ? "true" : "false",
            BITUNIX_LIVE_ENABLED: mask & 2 ? "true" : "false",
            LIVE_TRADING_ENABLED: mask & 4 ? "true" : "false",
            REQUIRE_HUMAN_APPROVAL: mask & 8 ? "false" : "true",
          });
          seedState(env, "BITUNIX", state);
          if (suiteVariant === true || suiteVariant === "invalid") {
            writeSuiteStamp(getLiveGateRuntime(env).dir, {
              passed: suiteVariant === true,
              runId: suiteVariant === true ? "suite-matrix-ok" : "suite-matrix-fail",
              sha: null,
              source: "ci",
            });
          }
          setVenueReadinessProvider(
            readiness === "none" ? null : () => ({ active: readiness === "active" })
          );
          const expected = oracle(state, mask, {
            suite: suiteVariant !== false && suiteVariant !== "invalid",
            readiness,
          });
          const decision = evaluateLiveOrder("BITUNIX", { env, audit: false });
          if (decision.allowed === expected) {
            if (expected) allowed += 1;
            else denied += 1;
          } else if (decision.allowed) {
            falseAllows += 1;
          } else {
            falseDenies += 1;
          }
        }
      }
    }
  }
  assert.equal(falseAllows, 0, "ENFORCER HAT EINE VERBOTENE KONSTELLATION DURCHGELASSEN");
  assert.equal(falseDenies, 0, "Enforcer verweigert eine erlaubte Konstellation");
  assert.ok(allowed >= 1, "mindestens eine erlaubende Konstellation muss existieren");
  // 9 States × 16 Masken; LIVE_ENABLED-Maske 7 hat 2 Suite- × 3 Readiness-Varianten.
  assert.ok(denied > 100, `erwartet deutlich mehr Denys, war ${denied}`);
});

test("Nur State=LIVE_ENABLED + alle Flags + Human-Klausel + Suite + CP aktiv → assert erlaubt", () => {
  const env = allowEnv();
  seedState(env, "BITUNIX", "LIVE_ENABLED");
  writeSuiteStamp(getLiveGateRuntime(env).dir, { passed: true, runId: "allow-run", sha: null, source: "ci" });
  setVenueReadinessProvider(() => ({ active: true }));
  // REQUIRE_HUMAN_APPROVAL=true UND State ≥ HUMAN_APPROVED => Klausel erfüllt.
  const eHumanTrue = allowEnv({ REQUIRE_HUMAN_APPROVAL: "true" });
  seedState(eHumanTrue, "BITUNIX", "LIVE_ENABLED");
  writeSuiteStamp(getLiveGateRuntime(eHumanTrue).dir, { passed: true, runId: "allow-run-human", sha: null, source: "ci" });
  assert.doesNotThrow(() => assertLiveOrderAllowed("BITUNIX", { env }));
  assert.doesNotThrow(() => assertLiveOrderAllowed("BITUNIX", { env: eHumanTrue }));
});

test("Red-Team Flag-Manipulation: alle Flags an, State != LIVE_ENABLED → deny + Audit", () => {
  const env = allowEnv();
  seedState(env, "BITUNIX", "PAPER_APPROVED"); // irgendwo mittendrin
  writeSuiteStamp(getLiveGateRuntime(env).dir, { passed: true, runId: "allow-run", sha: null, source: "ci" });
  setVenueReadinessProvider(() => ({ active: true }));
  assert.throws(
    () => assertLiveOrderAllowed("BITUNIX", { env }),
    (e: unknown) =>
      e instanceof LiveTradingGateError &&
      /STATE_NOT_LIVE_ENABLED/.test((e as Error).message)
  );
  // Und der Deny ist auditiert (action=enforce, result=DENIED):
  const denials = getLiveGateRuntime(env).audit.recent(5).filter(
    (e) => e.action === "enforce" && e.result === "DENIED"
  );
  assert.ok(denials.length >= 1, "Deny ohne Audit-Eintrag");
  assert.match(denials[0].reason, /STATE_NOT_LIVE_ENABLED/);
});

test("Red-Team Zustands-Manipulation: LIVE_ENABLED im State-File OHNE Neudurchlauf — Kill-Datei dominiert", () => {
  // Angreifer schreibt das State-File direkt auf LIVE_ENABLED …
  const env = allowEnv();
  seedState(env, "BITUNIX", "LIVE_ENABLED");
  writeSuiteStamp(getLiveGateRuntime(env).dir, { passed: true, runId: "x", sha: null, source: "ci" });
  setVenueReadinessProvider(() => ({ active: true }));
  // … ohnehin erlaubt (Simulation eines vollständigen Manipulations-Szenarios
  // NUR auf Datei-Ebene) — aber ein vorheriger Kill bleibt wirksam:
  appendKillEntry(getLiveGateRuntime(env).dir, {
    scope: "*",
    at: new Date().toISOString(),
    actor: "cli",
    reason: "Red-Team: Kill dominiert manipuliertes State-File",
  });
  assert.throws(
    () => assertLiveOrderAllowed("BITUNIX", { env }),
    (e: unknown) => e instanceof LiveTradingGateError && /KILL_SWITCH_ACTIVE/.test((e as Error).message)
  );
});

test("Suite-Stamp: fehlt/abgelaufen/nicht bestanden → deny (fail-safe)", () => {
  // 1) fehlt
  const envNoSuite = allowEnv();
  seedState(envNoSuite, "BITUNIX", "LIVE_ENABLED");
  setVenueReadinessProvider(() => ({ active: true }));
  assert.throws(() => assertLiveOrderAllowed("BITUNIX", { env: envNoSuite }), /SECURITY_SUITE_INVALID/);
  // 2) nicht bestanden
  const envFail = allowEnv();
  seedState(envFail, "BITUNIX", "LIVE_ENABLED");
  writeSuiteStamp(getLiveGateRuntime(envFail).dir, { passed: false, runId: "failed-run", sha: null, source: "ci" });
  assert.throws(() => assertLiveOrderAllowed("BITUNIX", { env: envFail }), /SECURITY_SUITE_INVALID/);
  // 3) abgelaufen (Max-Alter 1 ms, Stamp 1 h alt)
  const envOld = allowEnv({ LIVE_GATE_SUITE_MAX_AGE_MS: "1" });
  seedState(envOld, "BITUNIX", "LIVE_ENABLED");
  writeSuiteStamp(getLiveGateRuntime(envOld).dir, {
    passed: true,
    runId: "old-run",
    sha: null,
    source: "ci",
    at: new Date(Date.now() - 3_600_000).toISOString(),
  });
  assert.throws(() => assertLiveOrderAllowed("BITUNIX", { env: envOld }), /SECURITY_SUITE_INVALID/);
});

test("Control-Plane: unbekannt/inaktiv → deny (fail-safe)", () => {
  const env = allowEnv();
  seedState(env, "BITUNIX", "LIVE_ENABLED");
  writeSuiteStamp(getLiveGateRuntime(env).dir, { passed: true, runId: "cp-run", sha: null, source: "ci" });
  setVenueReadinessProvider(null);
  assert.throws(() => assertLiveOrderAllowed("BITUNIX", { env }), /CONTROL_PLANE_UNKNOWN/);
  setVenueReadinessProvider(() => ({ active: false }));
  assert.throws(() => assertLiveOrderAllowed("BITUNIX", { env }), /CONTROL_PLANE_INACTIVE/);
});

test("Venue-Fälle: PAPER niemals live (Capability), unbekanntes Venue → deny", () => {
  const env = allowEnv();
  seedState(env, "PAPER", "LIVE_ENABLED");
  writeSuiteStamp(getLiveGateRuntime(env).dir, { passed: true, runId: "paper-run", sha: null, source: "ci" });
  setVenueReadinessProvider(() => ({ active: true }));
  assert.throws(
    () => assertLiveOrderAllowed("PAPER", { env }),
    (e: unknown) =>
      e instanceof LiveTradingGateError && /VENUE_NOT_LIVE_CAPABLE/.test((e as Error).message)
  );
  assert.throws(() => assertLiveOrderAllowed("BITUNIXX", { env: allowEnv() }), /UNKNOWN_VENUE/);
  assert.throws(() => assertLiveOrderAllowed("", { env: allowEnv() }), /UNKNOWN_VENUE/);
});

test("Integration Factory: getBroker('BITUNIX','live') nur in der erlaubten Konstellation", async () => {
  const { getBroker } = await import("../src/brokers/factory");
  const { clearBrokerFactoryAuditForTests, readBrokerFactoryAudit } = await import("../src/brokers/audit");

  // Default (State DISCONNECTED, Flags aus): weiter hart LiveTradingGateError.
  const deniedEnv = allowEnv();
  clearBrokerFactoryAuditForTests();
  await assert.rejects(
    () => getBroker("BITUNIX", "live"),
    (e: unknown) =>
      e instanceof LiveTradingGateError &&
      /STATE_NOT_LIVE_ENABLED/.test((e as Error).message)
  );
  assert.ok(
    readBrokerFactoryAudit(5).some((e) => e.errorCode === "LIVE_TRADING_GATE"),
    "Factory-Deny nicht auditiert"
  );

  // Erlaubte Konstellation (Test-Double der Machine): Adapter wird geliefert
  // und IM_ADAPTER erneut geprüft (placeOrder live ruft Enforcer).
  process.env.BITUNIX_ENABLED = "true";
  process.env.BITUNIX_LIVE_ENABLED = "true";
  process.env.LIVE_TRADING_ENABLED = "true";
  process.env.REQUIRE_HUMAN_APPROVAL = "false";
  const env = allowEnv();
  process.env.LIVE_GATE_DATA_DIR = env.LIVE_GATE_DATA_DIR as string;
  seedState(env, "BITUNIX", "LIVE_ENABLED");
  writeSuiteStamp(getLiveGateRuntime(env).dir, { passed: true, runId: "factory-run", sha: null, source: "ci" });
  setVenueReadinessProvider(() => ({ active: true }));
  const adapter = await getBroker("BITUNIX", "live");
  assert.equal(adapter.id, "BITUNIX");
  assert.equal(adapter.mode, "live");
});

test("Red-Team: Adapter-Order-Aufruf IMMER durch den Enforcer (auch ohne Factory)", async () => {
  const { BitunixBrokerAdapter } = await import("../src/brokers/bitunix/adapter");
  const { loadBitunixConfig } = await import("../src/brokers/bitunix/config");
  // Direkt konstruierter Live-Adapter (kein Factory-Weg) — placeOrder/getAccount
  // rufen selbst assertLiveOrderAllowed => deny.
  const env = allowEnv();
  const adapter = new BitunixBrokerAdapter("live", {
    env,
    config: loadBitunixConfig(env),
  });
  await assert.rejects(
    () =>
      adapter.placeOrder({
        symbol: "BTCUSDT",
        side: "LONG",
        qty: 0.01,
        riskNotional: 650,
        stopLoss: 60000,
      }),
    (e: unknown) => e instanceof LiveTradingGateError && /STATE_NOT_LIVE_ENABLED/.test((e as Error).message)
  );
  await assert.rejects(() => adapter.getAccount(), /STATE_NOT_LIVE_ENABLED/);
  await assert.rejects(() => adapter.getPositions(), /STATE_NOT_LIVE_ENABLED/);
});

test("Enforcer-Audit: Allow wird ebenfalls auditiert (lückenlose Kette)", () => {
  const env = allowEnv();
  seedState(env, "BITUNIX", "LIVE_ENABLED");
  writeSuiteStamp(getLiveGateRuntime(env).dir, { passed: true, runId: "audit-run", sha: null, source: "ci" });
  setVenueReadinessProvider(() => ({ active: true }));
  assert.doesNotThrow(() => assertLiveOrderAllowed("BITUNIX", { env, actor: "admin" }));
  const allow = getLiveGateRuntime(env).audit.recent(3).find((e) => e.action === "enforce" && e.result === "OK");
  assert.ok(allow, "Allow ohne Audit-Eintrag");
});
