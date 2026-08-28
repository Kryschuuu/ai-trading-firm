/**
 * Unit-Tests für die Randbereiche des Live-Gates (Task 11, Security-Suite):
 * Default-Gate-Port (fail-closed), Config-Flag-Mapper, Kill-File-Clear-Pfade,
 * Suite-Stamp-Validierung, Enforcer-Edge-Cases, Store/Suite-Fehlerpfade.
 * Diese Datei existiert, damit der sicherheitskritische Code (≥ 95 % Tor)
 * vollständig ausgeleuchtet ist — inklusive der Fehlerzweige.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LiveTradingGateError } from "../src/contracts/broker";
import {
  appendKillEntry,
  assertLiveOrderAllowed,
  clearKillEntries,
  createDefaultGatePort,
  evaluateLiveOrder,
  getLiveGateRuntime,
  isLegalAdvance,
  killFilePath,
  liveGateConfig,
  liveGateErrorStatus,
  platformLiveFromEnv,
  readKillFile,
  readSuiteStamp,
  resetGatePortsForTests,
  resolveGatePort,
  suiteStampFile,
  transitionDef,
  validateSuiteStamp,
  venueEnabledFlagName,
  venueEnabledFromEnv,
  venueLiveFlagFromEnv,
  venueLiveFlagName,
  writeSuiteStamp,
  LiveGateError,
  humanApprovalRequired,
  setVenueReadinessProvider,
  type BrokerGatePort,
} from "../src/live-gate";
import { mkEnv, resetLiveGateTestGlobals } from "./fixtures/liveGateTestUtil";

afterEach(() => {
  resetLiveGateTestGlobals();
});

beforeEach(() => {
  resetGatePortsForTests();
});

// ── Config ───────────────────────────────────────────────────────────────────

test("config: Flag-Mapper + fail-closed Defaults", () => {
  const env = mkEnv({
    LIVE_GATE_COOLDOWN_MS: "5000",
    LIVE_GATE_FOUR_EYES: "true",
    LIVE_GATE_PAPER_MIN_ORDERS: "7",
    LIVE_GATE_SUITE_MAX_AGE_MS: "1000",
  });
  const cfg = liveGateConfig(env);
  assert.equal(cfg.cooldownMs, 5000);
  assert.equal(cfg.fourEyes, true);
  assert.equal(cfg.paperMinOrders, 7);
  assert.equal(cfg.suiteMaxAgeMs, 1000);
  assert.ok(cfg.dir.length > 0);

  assert.equal(venueEnabledFlagName("bitunix"), "BITUNIX_ENABLED");
  assert.equal(venueLiveFlagName("Bitunix"), "BITUNIX_LIVE_ENABLED");
  // PAPER: immer enabled, nie live-fähig über Flags.
  assert.equal(venueEnabledFromEnv("PAPER", {}), true);
  assert.equal(venueLiveFlagFromEnv("PAPER", { PAPER_LIVE_ENABLED: "true" }), false);
  assert.equal(venueLiveFlagFromEnv("BITUNIX", { BITUNIX_LIVE_ENABLED: "true" }), true);
  assert.equal(venueLiveFlagFromEnv("BITUNIX", { BITUNIX_LIVE_ENABLED: "1" }), false, "nur exakt true");
  assert.equal(platformLiveFromEnv({ LIVE_TRADING_ENABLED: "true" }), true);
  assert.equal(platformLiveFromEnv({}), false);
  assert.equal(humanApprovalRequired({ REQUIRE_HUMAN_APPROVAL: "false" }), false);
  assert.equal(humanApprovalRequired({}), true, "Default: Human-Gate an");
});

// ── Default-Port (fail-closed) ───────────────────────────────────────────────

test("Default-Port: PAPER healthCheck ok; BITUNIX healthCheck offline ohne Flag", async () => {
  const paperPort = createDefaultGatePort("PAPER");
  const paperHealth = await paperPort.healthCheck();
  assert.equal(paperHealth.ok, true);

  const bitunixPort = createDefaultGatePort("BITUNIX");
  const bitunixHealth = await bitunixPort.healthCheck();
  assert.equal(bitunixHealth.ok, false, "BITUNIX ohne BITUNIX_ENABLED muss failen");
  assert.match(bitunixHealth.detail, /offline|enabled/i);
});

test("Default-Port: fetchTicker nur für BITUNIX und nur mit Flag (read-only)", async () => {
  const other = createDefaultGatePort("KRAKEN");
  const kraken = await other.fetchTicker("BTCUSDT");
  assert.equal(kraken.ok, false);
  assert.match(kraken.detail, /fail-closed/);

  const prev = process.env.BITUNIX_ENABLED;
  delete process.env.BITUNIX_ENABLED;
  const bitunix = await createDefaultGatePort("BITUNIX").fetchTicker("BTCUSDT");
  assert.equal(bitunix.ok, false);
  assert.match(bitunix.detail, /BITUNIX_ENABLED/);
  if (prev !== undefined) process.env.BITUNIX_ENABLED = prev;
});

test("Default-Port: placeTestOrder VERWEIGERT immer (kein Testnet, keine echten Orders)", async () => {
  for (const venue of ["BITUNIX", "PAPER"]) {
    const r = await createDefaultGatePort(venue).placeTestOrder();
    assert.equal(r.ok, false, venue);
    assert.match(r.detail, /Kein Test-Order-Provider/);
  }
});

test("Default-Port: paperStats meldet 0 (fail-closed, keine Quelle registriert)", async () => {
  const stats = await createDefaultGatePort("BITUNIX").paperStats();
  assert.equal(stats.errorFreeOrders, 0);
  assert.equal(stats.orders, 0);
});

test("Port-Registry: registerGatePort überschreibt Default; reset räumt auf", async () => {
  const { registerGatePort } = await import("../src/live-gate");
  const custom: BrokerGatePort = {
    healthCheck: async () => ({ ok: true, detail: "custom" }),
    fetchTicker: async () => ({ ok: true, detail: "custom" }),
    readAccount: async () => ({ ok: true, detail: "custom" }),
    placeTestOrder: async () => ({ ok: true, detail: "custom" }),
    paperStats: async () => ({ errorFreeOrders: 99, orders: 100, detail: "custom" }),
  };
  registerGatePort("BITUNIX", custom);
  assert.equal(resolveGatePort("BITUNIX").placeTestOrder === custom.placeTestOrder, true);
  resetGatePortsForTests();
  const fallback = resolveGatePort("BITUNIX");
  const r = await fallback.placeTestOrder();
  assert.equal(r.ok, false, "nach Reset muss der Default-Port (deny) greifen");
});

test("TransitionChecks: ein werfender Port wird als CHECK_FAILED behandelt (fail-closed)", async () => {
  const { TRANSITION_CHECKS, liveGateConfig } = await import("../src/live-gate");
  const throwing: BrokerGatePort = {
    healthCheck: async () => {
      throw new Error("Netz weg");
    },
    fetchTicker: async () => ({ ok: false, detail: "-" }),
    readAccount: async () => ({ ok: false, detail: "-" }),
    placeTestOrder: async () => ({ ok: false, detail: "-" }),
    paperStats: async () => ({ errorFreeOrders: 0, orders: 0, detail: "-" }),
  };
  const outcome = await TRANSITION_CHECKS.connectivity.run({
    venue: "BITUNIX",
    env: {},
    config: liveGateConfig(mkEnv()),
    port: throwing,
  });
  assert.equal(outcome.ok, false);
  assert.match(outcome.detail, /fail-closed/);
  // Labels/Requirements sind dokumentiert (UI/Doku):
  for (const id of ["connectivity", "marketData", "accountRead", "orderTest", "paperCriteria"] as const) {
    assert.ok(TRANSITION_CHECKS[id].label.length > 3, id);
    assert.ok(TRANSITION_CHECKS[id].requirement.length > 10, id);
  }
});

test("TransitionChecks: FAIL-Zweige je Check (marketData/accountRead/orderTest/paperCriteria)", async () => {
  const { TRANSITION_CHECKS, liveGateConfig } = await import("../src/live-gate");
  const failing: BrokerGatePort = {
    healthCheck: async () => ({ ok: false, detail: "health down" }),
    fetchTicker: async () => ({ ok: false, detail: "feed down" }),
    readAccount: async () => ({ ok: false, detail: "account denied" }),
    placeTestOrder: async () => ({ ok: false, detail: "test order denied" }),
    paperStats: async () => ({ errorFreeOrders: 0, orders: 0, detail: "keine Orders" }),
  };
  const ctx = {
    venue: "BITUNIX" as const,
    env: {},
    config: liveGateConfig(mkEnv({ LIVE_GATE_PAPER_MIN_ORDERS: "5" })),
    port: failing,
  };
  for (const id of ["marketData", "accountRead", "orderTest", "paperCriteria"] as const) {
    const outcome = await TRANSITION_CHECKS[id].run(ctx);
    assert.equal(outcome.ok, false, id);
    assert.match(outcome.detail, new RegExp(id), id);
  }
  // … und der PASS-Zweig von paperCriteria mit ausreichenden Orders:
  const ok = await TRANSITION_CHECKS.paperCriteria.run({
    ...ctx,
    port: {
      ...failing,
      paperStats: async () => ({ errorFreeOrders: 5, orders: 5, detail: "genug" }),
    },
  });
  assert.equal(ok.ok, true);
  assert.match(ok.detail, /5\/5/);
});

test("Service: snapshot()/overview() projizieren Zustand, Flags, Cooldown, Suite, Kill", async () => {
  const { LiveGateService, getLiveGateRuntime, writeSuiteStamp } = await import("../src/live-gate");
  const env = mkEnv({
    BITUNIX_ENABLED: "true",
    BITUNIX_LIVE_ENABLED: "true",
    LIVE_TRADING_ENABLED: "true",
    LIVE_GATE_COOLDOWN_MS: "3600000",
  });
  const rt = getLiveGateRuntime(env);
  const service = new LiveGateService(rt, env);
  const rec = rt.store.read("BITUNIX");
  rec.state = "LIVE_PENDING";
  rec.livePendingAt = new Date().toISOString();
  rt.store.write("BITUNIX", rec);
  writeSuiteStamp(rt.dir, { passed: true, runId: "snap", sha: null, source: "ci" });

  const snap = service.snapshot("BITUNIX");
  assert.equal(snap.state, "LIVE_PENDING");
  assert.equal(snap.flags.venueEnabled, true);
  assert.equal(snap.flags.venueLiveFlag, true);
  assert.equal(snap.flags.platformLive, true);
  assert.equal(snap.cooldownElapsed, false);
  assert.ok(snap.cooldownRemainingMs > 0);
  assert.equal(snap.suite.valid, true);
  assert.equal(snap.suite.runId, "snap");
  assert.equal(snap.liveOrderAllowed, false);
  assert.equal(snap.denyCodeIfAny, "STATE_NOT_LIVE_ENABLED");
  assert.equal(snap.fourEyesRequired, false);

  const overview = service.overview();
  assert.equal(overview.ok, true);
  assert.equal(overview.policyVersion, "live-gate-policy/1");
  assert.ok(overview.venues.length >= 7);
  assert.equal(overview.killSwitch.active, false);
  assert.equal(overview.suite.valid, true);
  assert.equal(overview.audit.integrity.ok, true);
  assert.ok(Array.isArray(overview.audit.recent));
  assert.equal(overview.audit.head, null); // noch keine Audit-Einträge in diesem Dir

  // Nach Kill: overview zeigt aktiv + scopes; snapshot zeigt killSwitchActive.
  await service.kill({ venue: "BITUNIX", actor: "admin", reason: "Snapshot-Kill-Test", confirm: "KILL" });
  const overview2 = service.overview();
  assert.equal(overview2.killSwitch.active, true);
  assert.ok(overview2.killSwitch.scopes.includes("BITUNIX"));
  assert.equal(service.snapshot("BITUNIX").killSwitchActive, true);
  assert.ok(service.history(5).length >= 1);
});

// ── Suite-Stamp ──────────────────────────────────────────────────────────────

test("Suite-Stamp: Validierung (fehlend/false/alt/ok) + Datei-Roundtrip", () => {
  const dir = mkEnv().LIVE_GATE_DATA_DIR as string;
  assert.equal(readSuiteStamp(dir), null, "fehlender Stamp");
  assert.equal(validateSuiteStamp(null, { maxAgeMs: 0 }).valid, false);

  writeSuiteStamp(dir, { passed: false, runId: "r1", sha: null, source: "ci" });
  assert.equal(validateSuiteStamp(readSuiteStamp(dir), { maxAgeMs: 0 }).valid, false, "passed=false");

  writeSuiteStamp(dir, { passed: true, runId: "", sha: null, source: "ci" });
  assert.equal(validateSuiteStamp(readSuiteStamp(dir), { maxAgeMs: 0 }).valid, false, "leere runId");

  writeSuiteStamp(dir, {
    passed: true,
    runId: "r2",
    sha: null,
    source: "ci",
    at: new Date(Date.now() - 10_000).toISOString(),
  });
  assert.equal(validateSuiteStamp(readSuiteStamp(dir), { maxAgeMs: 60_000 }).valid, true, "frisch ok");
  assert.equal(validateSuiteStamp(readSuiteStamp(dir), { maxAgeMs: 1_000 }).valid, false, "zu alt");
  assert.equal(validateSuiteStamp(readSuiteStamp(dir), { maxAgeMs: 0 }).valid, true, "0 = unbegrenzt");

  // Korrupte Datei:
  mkdirSync(dir, { recursive: true });
  writeFileSync(suiteStampFile(dir), "{nope", "utf8");
  assert.equal(readSuiteStamp(dir), null);
});

// ── Kill-File Clear-Pfade ────────────────────────────────────────────────────

test("Kill-File: Clear entfernt Einzelne (Rewrite) und Letzte (Rename)", () => {
  const dir = mkEnv().LIVE_GATE_DATA_DIR as string;
  appendKillEntry(dir, { scope: "BITUNIX", at: new Date().toISOString(), actor: "a", reason: "r" });
  appendKillEntry(dir, { scope: "KRAKEN", at: new Date().toISOString(), actor: "a", reason: "r" });

  assert.equal(clearKillEntries(dir, "BITUNIX"), 1, "ein Eintrag entfernt");
  assert.equal(readKillFile(dir).length, 1);
  assert.equal(readKillFile(dir)[0].scope, "KRAKEN");

  assert.equal(clearKillEntries(dir, "BITUNIX"), 0, "nichts zu entfernen");
  assert.equal(clearKillEntries(dir, "KRAKEN"), 1, "letzter entfernt");
  assert.equal(readKillFile(dir).length, 0);
});

test("Kill-File: unlesbare Datei wird als kein Kill behandelt (Defense in Depth dokumentiert)", () => {
  const dir = mkEnv().LIVE_GATE_DATA_DIR as string;
  mkdirSync(dir, { recursive: true });
  writeFileSync(killFilePath(dir), "not-json", "utf8");
  assert.equal(readKillFile(dir).length, 0);
});

// ── Enforcer-Edge-Cases ──────────────────────────────────────────────────────

test("Enforcer: Readiness-Provider wirft → CONTROL_PLANE_UNKNOWN (fail-safe)", () => {
  const env = mkEnv({
    BITUNIX_ENABLED: "true",
    BITUNIX_LIVE_ENABLED: "true",
    LIVE_TRADING_ENABLED: "true",
  });
  const rt = getLiveGateRuntime(env);
  const rec = rt.store.read("BITUNIX");
  rec.state = "LIVE_ENABLED";
  rt.store.write("BITUNIX", rec);
  writeSuiteStamp(rt.dir, { passed: true, runId: "edge", sha: null, source: "ci" });
  setVenueReadinessProvider(() => {
    throw new Error("control plane exploded");
  });
  const decision = evaluateLiveOrder("BITUNIX", { env, audit: false });
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, "CONTROL_PLANE_UNKNOWN");
});

test("Enforcer: assert mit unbekanntem Venue wirft LiveTradingGateError(UNKNOWN_VENUE)", () => {
  assert.throws(
    () => assertLiveOrderAllowed("NOT_A_VENUE", { env: mkEnv() }),
    (e: unknown) => e instanceof LiveTradingGateError && /Unbekanntes Venue/.test((e as Error).message)
  );
});

test("Enforcer: Flags-Meldung im Decision-Objekt ist korrekt befüllt", () => {
  const env = mkEnv({ BITUNIX_ENABLED: "true", LIVE_TRADING_ENABLED: "true" });
  const decision = evaluateLiveOrder("BITUNIX", { env, audit: false });
  assert.equal(decision.flags.venueEnabled, true);
  assert.equal(decision.flags.platformLive, true);
  assert.equal(decision.flags.venueLiveFlag, false);
  assert.equal(decision.flags.requireHumanApproval, true);
  assert.equal(decision.policyVersion, "live-gate-policy/1");
});

// ── States/Errors ────────────────────────────────────────────────────────────

test("states: transitionDef/isLegalAdvance für illegale/unbekannte Kombis", () => {
  assert.equal(transitionDef("LIVE_ENABLED", "DISCONNECTED"), null);
  assert.equal(transitionDef("DISCONNECTED", "LIVE_ENABLED"), null);
  assert.equal(transitionDef("DISCONNECTED", "CONNECTED")?.check, "connectivity");
  const weird = isLegalAdvance("HACKED", "LIVE_ENABLED");
  assert.equal(weird.legal, false);
  assert.equal(weird.key, "HACKED->LIVE_ENABLED");
  assert.equal(liveGateErrorStatus("UNKNOWN_STATE"), 422);
  assert.equal(liveGateErrorStatus("REASON_REQUIRED"), 422);
  assert.equal(liveGateErrorStatus("ILLEGAL_TRANSITION"), 409);
  assert.ok(new LiveGateError("ILLEGAL_TRANSITION", "x") instanceof Error);
});

// ── Audit/Ring ───────────────────────────────────────────────────────────────

test("Audit: Ring recent() + lastKill() + gebrochene JSON-Zeile in verify", async () => {
  const { LiveGateAudit, verifyAuditChain } = await import("../src/live-gate");
  const dir = mkEnv().LIVE_GATE_DATA_DIR as string;
  const audit = new LiveGateAudit(dir);
  audit.append({ actor: "admin", venue: "BITUNIX", from: null, to: "CONNECTED", action: "advance", result: "OK", reason: "Ring-Test" });
  audit.append({
    actor: "admin",
    venue: "*",
    from: null,
    to: "DISCONNECTED",
    action: "kill",
    result: "KILLED",
    reason: "Ring-Kill",
  });
  assert.equal(audit.recent(1)[0].action, "kill");
  assert.ok(audit.lastKill());
  assert.match(audit.lastKill()!.reason, /Ring-Kill/);

  // Gebrochene Zeile (Bytes trunciert):
  const file = path.join(dir, "audit-log.ndjson");
  const original = readFileSync(file, "utf8");
  writeFileSync(file, original + "{BROKEN\n", "utf8");
  const broken = verifyAuditChain(dir);
  assert.equal(broken.ok, false);
  assert.match(broken.problem ?? "", /kein gültiges JSON/);
});
