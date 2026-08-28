/**
 * Architektur-/Red-Team-Regression (Task 11, Security-Suite): Drifts, die
 * die Single-Point-Enforcement-Garantie brechen würden, dürfen nicht
 * zurückkehren. Statische Quelltext-Prüfungen (Muster wie task-10).
 *
 * 1. Factory-Live-Pfad ruft den Enforcer (kein blindes Werfen, kein Bypass).
 * 2. Bitunix-Adapter ruft assertLiveOrderAllowed in JEDEM Live-Pfad
 *    (placeOrder/getAccount/getPositions) — auch ohne Factory erreichbar.
 * 3. placeSerializedOrder existiert nur im Adapter (kein zweiter Order-Pfad).
 * 4. Kein Code setzt Live-Flags (LIVE_TRADING_ENABLED etc. sind read-only).
 * 5. live-gate importiert keine UI; Enforcer importiert keine Control-Plane-
 *    Service-Module (Provider-Pattern statt Import).
 * 6. Matrix-Kanonik: genau 9 Zustände/8 Übergänge; Fehlercodes katalogisiert.
 * 7. .env.example bleibt fail-closed (Defaults false/off).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  LEGAL_ADVANCE_KEYS,
  LIVE_GATE_ERROR_CODES,
  LIVE_GATE_STATES,
  LIVE_GATE_TRANSITIONS,
} from "../src/live-gate";

function read(rel: string): string {
  return readFileSync(path.join(process.cwd(), rel), "utf8");
}

test("Factory: Live-Pfad geht durch den zentralen Enforcer", () => {
  const src = read("src/brokers/factory.ts");
  assert.ok(src.includes('from "../live-gate/enforcer"'), "Enforcer-Import fehlt");
  assert.ok(src.includes("assertLiveOrderAllowed(venue)"), "Enforcer-Aufruf fehlt");
  assert.ok(src.includes("mode === \"live\""), "Live-Zweig fehlt");
  // Kein blindes Werfen mehr im Live-Zweig (das war der task-02-Stub):
  assert.ok(!src.includes("const err = new LiveTradingGateError(venue);"));
});

test("Bitunix-Adapter: alle Live-Pfade rufen assertLiveOrderAllowed (Schutz auch ohne Factory)", () => {
  const src = read("src/brokers/bitunix/adapter.ts");
  const liveGates = src.match(/if \(this\.mode === "live"\) \{[\s\S]{0,600}?assertLiveOrderAllowed/g) ?? [];
  assert.ok(liveGates.length >= 3, `erwartet >=3 Live-Gate-Aufrufe (placeOrder/getAccount/getPositions), fand ${liveGates.length}`);
  assert.ok(src.includes("TODO(task-11)") === false, "task-11-Stubs müssen ersetzt sein");
});

test("Bitunix-Gates delegieren an src/live-gate (kein Eigenleben)", () => {
  const src = read("src/brokers/bitunix/gates.ts");
  assert.ok(src.includes('from "@/live-gate/enforcer"'));
  assert.ok(src.includes("enforceCentral"), "Delegation an den Enforcer fehlt");
  assert.ok(src.includes("liveGateServiceEnabled: true"), "Snapshot muss Enforcer-Aktivität melden");
});

test("placeSerializedOrder existiert ausschließlich im Adapter (kein zweiter Order-Pfad)", () => {
  const adapter = read("src/brokers/bitunix/adapter.ts");
  assert.ok(adapter.includes("placeSerializedOrder"));
  for (const rel of [
    "src/brokers/factory.ts",
    "src/brokers/stubs.ts",
    "src/brokers/paper.ts",
    "src/live-gate/enforcer.ts",
    "src/live-gate/service.ts",
    "src/live-gate/checks.ts",
  ]) {
    assert.equal(read(rel).includes("placeSerializedOrder"), false, `${rel} darf die Order-Schnittstelle nicht direkt nutzen`);
  }
});

test("Red-Team: kein Code schreibt Live-Flags (Env-Flags sind read-only)", () => {
  const flagWrites = [
    /process\.env\.LIVE_TRADING_ENABLED\s*=/,
    /process\.env\.BITUNIX_LIVE_ENABLED\s*=/,
    /process\.env\.REQUIRE_HUMAN_APPROVAL\s*=/,
    /process\.env\.BITUNIX_ENABLED\s*=/,
  ];
  const files = [
    "src/live-gate/enforcer.ts",
    "src/live-gate/service.ts",
    "src/live-gate/checks.ts",
    "src/brokers/factory.ts",
    "src/brokers/bitunix/gates.ts",
  ];
  for (const rel of files) {
    const src = read(rel);
    for (const re of flagWrites) {
      assert.equal(re.test(src), false, `${rel} schreibt ein Live-Flag: ${re.source}`);
    }
  }
});

test("live-gate importiert keine UI; Enforcer bleibt frei von Control-Plane-Imports", () => {
  for (const rel of [
    "src/live-gate/enforcer.ts",
    "src/live-gate/service.ts",
    "src/live-gate/states.ts",
    "src/live-gate/store.ts",
    "src/live-gate/audit.ts",
    "src/live-gate/checks.ts",
    "src/live-gate/killFile.ts",
    "src/live-gate/suite.ts",
    "src/live-gate/runtime.ts",
  ]) {
    const src = read(rel);
    assert.equal(src.includes("@/components"), false, `${rel} importiert UI`);
    assert.equal(src.includes("@/app/"), false, `${rel} importiert Routen`);
  }
  // Enforcer: kein direkter Control-Plane-Import (Provider-Pattern).
  const enforcer = read("src/live-gate/enforcer.ts");
  assert.equal(enforcer.includes("control-plane"), false, "Enforcer importiert Control Plane direkt");
});

test("Kanonik: 9 Zustände, 8 legale Advances, Fehlerkatalog geschlossen", () => {
  assert.equal(LIVE_GATE_STATES.length, 9);
  assert.equal(LIVE_GATE_TRANSITIONS.length, 8);
  assert.equal(LEGAL_ADVANCE_KEYS.size, 8);
  // Matrix enthält den Human-Gate-Schritt exakt einmal:
  assert.equal(LEGAL_ADVANCE_KEYS.has("LIVE_PENDING->HUMAN_APPROVED"), true);
  assert.equal(LEGAL_ADVANCE_KEYS.has("HUMAN_APPROVED->LIVE_ENABLED"), true);
  assert.equal(LEGAL_ADVANCE_KEYS.has("PAPER_APPROVED->LIVE_ENABLED"), false);
  assert.equal(LEGAL_ADVANCE_KEYS.has("DISCONNECTED->LIVE_ENABLED"), false);
  // Fehlerkatalog deckt alle Security-relevanten Denys ab:
  for (const code of [
    "ILLEGAL_TRANSITION",
    "COOLDOWN_ACTIVE",
    "KILL_SWITCH_ACTIVE",
    "SECURITY_SUITE_INVALID",
    "STATE_NOT_LIVE_ENABLED",
  ]) {
    assert.ok((LIVE_GATE_ERROR_CODES as readonly string[]).includes(code), code);
  }
});

test("Defaults bleiben fail-closed: .env.example und Kill/Suite-Dateinamen", () => {
  const envExample = read(".env.example");
  assert.ok(envExample.includes("# BITUNIX_LIVE_ENABLED=false"));
  assert.ok(envExample.includes("# LIVE_TRADING_ENABLED=false"));
  assert.ok(envExample.includes("LIVE_GATE_COOLDOWN_MS=86400000"));
  assert.ok(/AKTIVIERT KEIN LIVE|aktiviert kein Live/i.test(envExample));
  // Keine versehentlich aktiven Live-Flags in der Vorlage:
  assert.equal(/^BITUNIX_LIVE_ENABLED=true/m.test(envExample), false);
  assert.equal(/^LIVE_TRADING_ENABLED=true/m.test(envExample), false);
});

test("Kill-Switch und Suite-Stamp leben im Data-Dir (gitignored, persistente Artefakte)", () => {
  const gitignore = read(".gitignore");
  assert.ok(gitignore.includes("/data/live-gate"));
  const config = read("src/live-gate/config.ts");
  assert.ok(config.includes('LIVE_GATE_DATA_DIR_DEFAULT = "data/live-gate"'));
  assert.ok(config.includes("LIVE_GATE_COOLDOWN_DEFAULT_MS = 24 * 60 * 60 * 1000"));
  const killFile = read("src/live-gate/killFile.ts");
  assert.ok(killFile.includes('KILL_FILE_NAME = "kill-switch.json"'));
  const audit = read("src/live-gate/audit.ts");
  assert.ok(audit.includes("prevHash") && audit.includes("sha256"));
});

test("Keine echten Orders in der Security-Suite: Mock-Ports only", () => {
  const testUtil = read("tests/fixtures/liveGateTestUtil.ts");
  assert.ok(testUtil.includes("placeTestOrder"), "Mock-Port braucht placeTestOrder-Zähler");
  assert.ok(/niemals echt|NIE echte Orders/.test(testUtil));
  // Die Suite darf den Bitunix-Private-Client nie mit echten Credentials nutzen:
  for (const rel of ["tests/liveGate.states.test.ts", "tests/liveGate.enforcement.test.ts", "tests/liveGate.e2e.test.ts"]) {
    const src = read(rel);
    assert.equal(src.includes("BITUNIX_API_SECRET"), false, `${rel} nutzt echte Credentials`);
  }
});
