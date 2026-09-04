/**
 * S2 (v1.36.22) — zentrale State-Registry: ALLE Cross-Cutting-Singletons an
 * EINEM Ort, EIN Reset fuer das Test-Harness.
 *
 * Akzeptanzkriterien aus audit-remediation/S2-singleton-consistency.md:
 *   - Alle prozess-weiten Mutables liegen in `stateRegistry` (testbar: jeder
 *     dokumentierte Singleton-Name ist als `state.*`-Accessor registriert).
 *   - Tests reseten ueber EINE Funktion (`__resetAllSingletonsForTests()`) —
 *     auch die frueher verstreuten Singletons (firmHydrated, Kill-Switch,
 *     Risk-Limits, Control-Plane-Cache, Rate-Limiter, Broker-Factory).
 *   - Ein Doc-Kommentar benennt pro Singleton die Wahrheitsquelle (DB vs. RAM).
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { state, __resetAllSingletonsForTests } from "../src/lib/stateRegistry";
import {
  DEFAULT_LIMITS,
  applyAdaptiveRisk,
  getAdaptiveRiskState,
  getLimits,
  killSwitch,
  resetRuntimeLimits,
} from "../src/lib/riskGuard";

/** Jeder registrierte Accessor = ein dokumentierter Cross-Cutting-Singleton. */
const EXPECTED_SLOTS = [
  // Engine
  "firmHydrated",
  "pipelineBusy",
  // Control Plane
  "controlPlaneStates",
  "controlPlaneHydrating",
  "controlPlaneWarmupPromise",
  "controlPlaneServicePromise",
  "controlPlanePersistWarned",
  // Risk-Guard
  "killSwitchArmed",
  "baseLimits",
  "currentLimits",
  "adaptiveState",
  // Broker-Factory
  "brokerAdapters",
  "paperBrokerLedger",
  // API-Auth
  "rateLimiterHits",
] as const;

beforeEach(() => {
  __resetAllSingletonsForTests();
});

test("S2: alle dokumentierten Singletons sind unter `state` registriert", () => {
  for (const slot of EXPECTED_SLOTS) {
    assert.ok(
      slot in state,
      `stateRegistry: Singleton '${slot}' fehlt als Accessor`
    );
  }
  // Dieselben Namen stehen im Lifecycle-Kommentar (Wahrheitsquelle DB vs. RAM).
  const source = readFileSync(
    new URL("../src/lib/stateRegistry.ts", import.meta.url),
    "utf8"
  );
  for (const slot of EXPECTED_SLOTS) {
    assert.ok(
      source.includes(slot),
      `stateRegistry-Header muss '${slot}' dokumentieren`
    );
  }
});

test("S2: Doc-Kommentar benennt DB-Wahrheit und RAM-Cache pro Singleton", () => {
  const source = readFileSync(
    new URL("../src/lib/stateRegistry.ts", import.meta.url),
    "utf8"
  );
  // Persistente Quelle-Quellen (DB-Tabellen) …
  for (const dbTruth of [
    "positions",
    "kill_switches",
    "risk_config",
    "venue_control_state",
    "proposals",
  ]) {
    assert.ok(
      source.includes(dbTruth),
      `Lifecycle-Doku muss die DB-Wahrheit '${dbTruth}' nennen`
    );
  }
  // … und mindestens eine reine RAM-Cache-Kategorie.
  assert.match(source, /RAM-Cache|RAM/);
  assert.match(source, /Source-of-Truth|SOURCE-OF-TRUTH|Wahrheit/);
});

test("S2: EIN Reset stellt Engine-Singletons in den Ausgangszustand", () => {
  assert.equal(state.firmHydrated.get(), false, "firmHydrated startet false");
  assert.equal(state.pipelineBusy.get(), false, "pipelineBusy startet false");

  state.firmHydrated.set(true);
  state.pipelineBusy.set(true);
  assert.equal(state.firmHydrated.get(), true);
  assert.equal(state.pipelineBusy.get(), true);

  __resetAllSingletonsForTests();
  assert.equal(state.firmHydrated.get(), false, "firmHydrated nach Reset false");
  assert.equal(state.pipelineBusy.get(), false, "pipelineBusy nach Reset false");
});

test("S2: EIN Reset raeumt Risk-Guard auf (Kill-Switch, Limits, Adaptivfaktor)", () => {
  killSwitch.pull("test");
  applyAdaptiveRisk({ regime: "ELEVATED", factor: 0.5, reason: "t", at: "t", indicators: {} });
  assert.equal(killSwitch.isArmed(), true);
  assert.equal(getLimits().maxRiskPerTrade, DEFAULT_LIMITS.maxRiskPerTrade * 0.5);

  __resetAllSingletonsForTests();
  assert.equal(killSwitch.isArmed(), false, "Kill-Switch nach Reset entschaerft");
  assert.equal(getAdaptiveRiskState(), null, "adaptiver Faktor nach Reset weg");
  assert.equal(
    getLimits().maxRiskPerTrade,
    DEFAULT_LIMITS.maxRiskPerTrade,
    "Limits nach Reset wieder auf Code-Default"
  );
  // resetRuntimeLimits resettet bewusst NUR die Basis-Limits (Adaptivfaktor bleibt).
  applyAdaptiveRisk({ regime: "ELEVATED", factor: 0.5, reason: "t", at: "t", indicators: {} });
  resetRuntimeLimits();
  assert.equal(getLimits().maxRiskPerTrade, DEFAULT_LIMITS.maxRiskPerTrade * 0.5, "Reduktion ueberlebt resetRuntimeLimits");
});

test("S2: EIN Reset raeumt Control-Plane-Cache, Factory-Caches und Rate-Limiter auf", async () => {
  // Control-Plane-Cache-Map befuellen.
  state.controlPlaneStates.get().set("TEST", {} as never);
  assert.equal(state.controlPlaneStates.get().size, 1);

  // Broker-Factory-Singletons vorhanden / Rate-Limiter-Bucket befuellen.
  state.paperBrokerLedger.set({} as never);
  assert.equal(state.paperBrokerLedger.has(), true);
  state.brokerAdapters.get().set("PAPER:paper", {} as never);
  state.rateLimiterHits.get().set("local", [Date.now()]);
  assert.equal(state.rateLimiterHits.get().size, 1);

  __resetAllSingletonsForTests();

  assert.equal(state.controlPlaneStates.has(), false, "Cache-Map entfernt (lazy neu)");
  assert.equal(state.controlPlaneStates.get().size, 0, "Control-Plane-Cache leer nach Reset");
  assert.equal(state.controlPlaneHydrating.has(), false);
  assert.equal(state.controlPlaneWarmupPromise.has(), false, "Warmup-Singleton entfernt");
  assert.equal(state.controlPlaneServicePromise.has(), false, "Service-Singleton entfernt");
  assert.equal(state.controlPlanePersistWarned.get(), false);
  assert.equal(state.paperBrokerLedger.has(), false, "Ledger-Singleton entfernt");
  assert.equal(state.brokerAdapters.get().size, 0, "Adapter-Cache leer nach Reset");
  assert.equal(state.rateLimiterHits.get().size, 0, "Rate-Limiter-Bucket leer nach Reset");
});

test("S2: Registry-Zugriffe sind idempotent und lazy (kein Doppel-Reset-Drift)", () => {
  // Map wird beim Zugriff genau einmal erzeugt.
  assert.equal(state.rateLimiterHits.get(), state.rateLimiterHits.get(), "Map-Singleton stabil");
  assert.equal(state.controlPlaneStates.get(), state.controlPlaneStates.get(), "Cache-Singleton stabil");
  // Mehrmaliger Reset ist gefahrlos.
  __resetAllSingletonsForTests();
  __resetAllSingletonsForTests();
  assert.equal(state.firmHydrated.get(), false);
  assert.equal(getLimits().maxRiskPerTrade, DEFAULT_LIMITS.maxRiskPerTrade);
});