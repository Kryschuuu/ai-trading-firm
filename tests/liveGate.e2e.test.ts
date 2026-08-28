/**
 * E2E (Task 11, Security-Suite): kompletter LEGALER Durchlauf mit Mock-Adapter
 * DISCONNECTED → … → LIVE_ENABLED inkl. Human-Gate (Cooldown-Zeitraffer),
 * danach Kill-Drill — plus die Verweigerungspfade (ohne Gates, Sprung, Kill).
 *
 * Es werden NIE echte Orders gesetzt: Der Gate-Port ist ein zählender Mock,
 * die „Order" ist der Enforcer-Entscheid selbst (assert/evaluate).
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { LiveTradingGateError } from "../src/contracts/broker";
import {
  KILL_CONFIRM_PHRASE,
  LiveGateError,
  assertLiveOrderAllowed,
  evaluateLiveOrder,
  getLiveGateRuntime,
  registerControlPlaneBridge,
  setVenueReadinessProvider,
  verifyAuditChain,
  writeSuiteStamp,
  type LiveGateState,
} from "../src/live-gate";
import {
  allowEnv,
  backdateCooldown,
  mockPort,
  resetLiveGateTestGlobals,
  serviceFor,
  type CountingMockPort,
} from "./fixtures/liveGateTestUtil";

let env: ReturnType<typeof allowEnv>;
let port: CountingMockPort;

beforeEach(() => {
  // Cooldown 1 h real, per Backdating gerafft; 4-Augen aus (separat getestet).
  env = allowEnv({ LIVE_GATE_COOLDOWN_MS: String(60 * 60 * 1000) });
  port = mockPort();
});

afterEach(() => {
  resetLiveGateTestGlobals();
});

const REASON = "E2E-Runbook: schrittweise Freischaltung nach Checklist";

async function advance(service: ReturnType<typeof serviceFor>, to: LiveGateState, extra: Record<string, unknown> = {}) {
  return service.transition({
    venue: "BITUNIX",
    to,
    actor: "admin",
    reason: REASON,
    confirm: true,
    approvedBy: "approver-e2e",
    ...extra,
  });
}

test("E2E legaler Durchlauf bis LIVE_ENABLED mit Human-Gate (Zeitraffer), dann Kill", async () => {
  const service = serviceFor(env, { port });

  // 1..5: Check-Übergänge (Mock-Ports bestanden, read-only, keine Orders).
  for (const to of ["CONNECTED", "MARKET_DATA_OK", "ACCOUNT_READ_OK", "ORDER_TEST_OK", "PAPER_APPROVED"] as LiveGateState[]) {
    const r = await advance(service, to);
    assert.equal(r.to, to);
  }
  // 6: Antrag → LIVE_PENDING startet den Cooldown-Timer.
  await advance(service, "LIVE_PENDING");
  assert.ok(getLiveGateRuntime(env).store.read("BITUNIX").livePendingAt);
  // Freigabe VOR Ablauf → deny (menschliche Bedenkzeit erzwingen).
  await assert.rejects(() => advance(service, "HUMAN_APPROVED"), (e: unknown) =>
    e instanceof LiveGateError && (e as LiveGateError).code === "COOLDOWN_ACTIVE"
  );
  // Zeitraffer: Cooldown-Basis 2 h zurückdatieren.
  backdateCooldown(env, "BITUNIX", 2 * 60 * 60 * 1000);
  // 7: Human-Gate (Confirm + Grund + Approver, Cooldown abgelaufen).
  await advance(service, "HUMAN_APPROVED");
  // 8: Enablement (Flags + Suite + Control Plane in serviceFor gesetzt).
  await advance(service, "LIVE_ENABLED");
  assert.equal(getLiveGateRuntime(env).store.read("BITUNIX").state, "LIVE_ENABLED");

  // Enforcer erlaubt NUR jetzt (exakt eine erlaubende Konstellation):
  const decision = evaluateLiveOrder("BITUNIX", { env, audit: false });
  assert.equal(decision.allowed, true, decision.reason);
  assert.doesNotThrow(() => assertLiveOrderAllowed("BITUNIX", { env, actor: "admin" }));

  // Mock-Adapter-Anbindung: Test-Order-Port wurde genau 1× je Check-Übergang
  // gefragt — niemals öfter, niemals eine echte Order:
  assert.equal(port.calls.placeTestOrder, 1);
  assert.equal(port.calls.healthCheck, 1);
  assert.equal(port.calls.fetchTicker, 1);
  assert.equal(port.calls.readAccount, 1);

  // Audit-Kette über den gesamten Durchlauf intakt:
  const chain = verifyAuditChain(getLiveGateRuntime(env).dir);
  assert.equal(chain.ok, true);
  assert.ok((chain.entries ?? 0) >= 8, "alle 8 Übergänge + Denys müssen auditiert sein");
  const okAdvances = getLiveGateRuntime(env).audit.recent(100).filter((e) => e.action === "advance" && e.result === "OK");
  assert.equal(okAdvances.length, 8);

  // KILL aus LIVE_ENABLED: sofort gesperrt, danach systemweit verweigert.
  const kill = await service.kill({
    venue: "BITUNIX",
    actor: "admin",
    reason: "E2E-Kill nach Freischaltung (Drill)",
    confirm: KILL_CONFIRM_PHRASE,
  });
  assert.equal(kill.ok, true);
  assert.throws(() => assertLiveOrderAllowed("BITUNIX", { env }), /KILL_SWITCH_ACTIVE/);
  assert.equal(getLiveGateRuntime(env).store.read("BITUNIX").state, "DISCONNECTED");
});

test("E2E Verweigerungspfad: Live-Versuch OHNE Gates → LiveTradingGateError (Fabrik+Enforcer)", async () => {
  // Frische Machine ohne irgendeinen Durchlauf (State DISCONNECTED).
  const bareEnv = allowEnv();
  const { getBroker } = await import("../src/brokers/factory");
  await assert.rejects(
    () => getBroker("BITUNIX", "live"),
    (e: unknown) => e instanceof LiveTradingGateError && /STATE_NOT_LIVE_ENABLED/.test((e as Error).message)
  );
  assert.throws(() => assertLiveOrderAllowed("BITUNIX", { env: bareEnv }), /STATE_NOT_LIVE_ENABLED/);

  // Auch der komplette Durchlauf OHNE Suite/Control-Plane bleibt am Ende verweigert:
  const noSuiteEnv = allowEnv();
  const svc = serviceFor(noSuiteEnv, { port: mockPort(), suite: false, readiness: "none" });
  for (const to of ["CONNECTED", "MARKET_DATA_OK", "ACCOUNT_READ_OK", "ORDER_TEST_OK", "PAPER_APPROVED", "LIVE_PENDING"] as LiveGateState[]) {
    await svc.transition({ venue: "BITUNIX", to, actor: "admin", reason: REASON });
  }
  backdateCooldown(noSuiteEnv, "BITUNIX", 2 * 60 * 60 * 1000);
  await advance(svc, "HUMAN_APPROVED");
  // LIVE_ENABLED-Übergang scheitert an Suite/Control Plane:
  await assert.rejects(() => advance(svc, "LIVE_ENABLED"), (e: unknown) => {
    const code = (e as LiveGateError).code;
    return e instanceof LiveGateError && (code === "SECURITY_SUITE_INVALID" || code === "CONTROL_PLANE_UNKNOWN");
  });
  assert.equal(getLiveGateRuntime(noSuiteEnv).store.read("BITUNIX").state, "HUMAN_APPROVED");
  assert.throws(() => assertLiveOrderAllowed("BITUNIX", { env: noSuiteEnv }), /STATE_NOT_LIVE_ENABLED/);
});

test("E2E: Control-Plane-Bridge projiziert die echte Verbindungsebene", async () => {
  registerControlPlaneBridge();
  const { readVenueControlStatePublic } = await import("../src/brokers/control-plane/service");
  const idle = readVenueControlStatePublic("BITUNIX");
  assert.equal(idle.layers.connection.state, "off"); // Bridge: nicht aktiv
  const decision = evaluateLiveOrder("BITUNIX", { env, audit: false });
  // State ist DISCONNECTED → deny mit STATE_NOT_LIVE_ENABLED (Capability/Kill/State zuerst).
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, "STATE_NOT_LIVE_ENABLED");
  setVenueReadinessProvider(() => ({ active: true })); // für andere Tests zurücksetzen
});
