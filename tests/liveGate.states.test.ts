/**
 * Unit-Tests: Live-Gate-State-Matrix (Task 11, Security-Suite).
 *
 * 1. VOLLE Transitionsmatrix: alle 81 (from × to)-Kombinationen der 9 Zustände
 *    — die 8 legalen Übergänge erfolgreich (Checks bestanden), ALLE anderen
 *    (Sprünge, Rückwärts, Selbst-Übergänge) → definierte Ablehnung
 *    ILLEGAL_TRANSITION (+ Audit-DENY-Eintrag). Ziel: 0 Durchlässe.
 * 2. Cooldown-Enforcement (Freigabe vor Ablauf → deny, danach → ok).
 * 3. 4-Augen-Modus (erste Bestätigung → PENDING, gleicher Approver → deny,
 *    zweiter anderer Approver → ok).
 * 4. Begründungs-/Confirm-/Approver-Pflicht, unbekannte Zustände/Venues.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  LIVE_GATE_STATES,
  LIVE_GATE_TRANSITIONS,
  LiveGateError,
  getLiveGateRuntime,
  readKillFile,
  registerGatePort,
  verifyAuditChain,
  type LiveGateState,
} from "../src/live-gate";
import {
  allowEnv,
  backdateCooldown,
  mkEnv,
  mockPort,
  resetLiveGateTestGlobals,
  serviceFor,
  seedState,
} from "./fixtures/liveGateTestUtil";

const WALK: Record<string, (env: ReturnType<typeof allowEnv>) => Promise<void>> = {};
void WALK;

let env: ReturnType<typeof allowEnv>;
let port: ReturnType<typeof mockPort>;

beforeEach(() => {
  env = allowEnv();
  port = mockPort();
});

afterEach(() => {
  resetLiveGateTestGlobals();
});

/** Legaler kompletter Durchlauf DISCONNECTED → target (Policy erfüllt). */
async function walkTo(target: LiveGateState): Promise<void> {
  const service = serviceFor(env, { port });
  const order = LIVE_GATE_STATES.slice(0, LIVE_GATE_STATES.indexOf(target) + 1);
  let from: LiveGateState = "DISCONNECTED";
  for (const to of order.slice(1)) {
    await service.transition({
      venue: "BITUNIX",
      to,
      actor: "admin",
      reason: "Runbook-Übergang im Matrix-Test",
      confirm: true,
      approvedBy: "approver-a",
    });
    if (from === "PAPER_APPROVED" && to === "LIVE_PENDING") {
      // Cooldown ist 0 in der Default-Test-Env — kein Backdating nötig.
    }
    from = to;
  }
}

test("Kanonik: 9 Zustände, exakt 8 Transitions in der Tabelle", () => {
  assert.equal(LIVE_GATE_STATES.length, 9);
  assert.equal(LIVE_GATE_TRANSITIONS.length, 8);
  assert.equal(new Set(LIVE_GATE_TRANSITIONS.map((t) => `${t.from}->${t.to}`)).size, 8);
});

test("Matrix: alle 8 legalen Übergänge erfolgreich (Checks bestanden)", async () => {
  const service = serviceFor(env, { port });
  const seen: string[] = [];
  let from: LiveGateState = "DISCONNECTED";
  for (const def of LIVE_GATE_TRANSITIONS) {
    assert.equal(def.from, from, "Kette lückenhaft");
    const result = await service.transition({
      venue: "BITUNIX",
      to: def.to,
      actor: "admin",
      reason: "Legal-Edge-Matrixdurchlauf",
      confirm: true,
      approvedBy: "approver-a",
    });
    assert.equal(result.from, def.from);
    assert.equal(result.to, def.to);
    seen.push(`${def.from}->${def.to}`);
    from = def.to;
  }
  assert.equal(from, "LIVE_ENABLED");
  assert.equal(seen.length, 8);
  // Audit-Kette enthält alle 8 OK-Übergänge.
  const audit = verifyAuditChain(getLiveGateRuntime(env).dir);
  assert.equal(audit.ok, true);
  const okTransitions = getLiveGateRuntime(env).audit.recent(100).filter(
    (e) => e.action === "advance" && e.result === "OK"
  );
  assert.equal(okTransitions.length, 8);
  assert.deepEqual(
    okTransitions.reverse().map((e) => `${e.from}->${e.to}`),
    seen
  );
});

test("Matrix: ALLE illegalen (from×to)-Kombinationen abgelehnt (0 Durchlässe)", async () => {
  const legal = new Set(LIVE_GATE_TRANSITIONS.map((t) => `${t.from}->${t.to}`));
  let illegalDenied = 0;
  let illegalPassed = 0;
  for (const from of LIVE_GATE_STATES) {
    for (const to of LIVE_GATE_STATES) {
      const key = `${from}->${to}`;
      if (legal.has(key)) continue;
      // Frische Machine pro Kombination (isoliert, kein Schleppfehler).
      env = allowEnv();
      await walkTo(from);
      const service = serviceFor(env, { port });
      try {
        await service.transition({
          venue: "BITUNIX",
          to,
          actor: "admin",
          reason: "Illegaler Sprung-Versuch (Red-Team)",
          confirm: true,
          approvedBy: "approver-a",
        });
        illegalPassed += 1;
      } catch (err) {
        assert.ok(err instanceof LiveGateError, `${key}: LiveGateError erwartet`);
        assert.equal((err as LiveGateError).code, "ILLEGAL_TRANSITION", `${key}: ${String(err)}`);
        illegalDenied += 1;
      }
    }
  }
  assert.equal(illegalPassed, 0, "ILLEGALER ÜBERGANG DURCHGELASSEN — Sicherheitsverletzung");
  // 81 Kombinationen − 8 legale = 73 illegale.
  assert.equal(illegalDenied, 9 * 9 - 8);
});

test("Red-Team: LIVE_PENDING → LIVE_ENABLED Sprung wird abgelehnt (kein Human-Gate-Skip)", async () => {
  const service = serviceFor(env, { port });
  await walkTo("LIVE_PENDING");
  await assert.rejects(
    () =>
      service.transition({
        venue: "BITUNIX",
        to: "LIVE_ENABLED",
        actor: "admin",
        reason: "Sprung über das Human-Gate hinweg",
        confirm: true,
        approvedBy: "approver-a",
      }),
    (e: unknown) => e instanceof LiveGateError && (e as LiveGateError).code === "ILLEGAL_TRANSITION"
  );
  // Zustand unverändert:
  assert.equal(getLiveGateRuntime(env).store.read("BITUNIX").state, "LIVE_PENDING");
});

test("Unbekannte Zustände/Venues → definierte Ablehnung (422-Codes)", async () => {
  const service = serviceFor(env, { port });
  await assert.rejects(
    () => service.transition({ venue: "BITUNIX", to: "LIVE", actor: "admin" }),
    (e: unknown) => e instanceof LiveGateError && (e as LiveGateError).code === "UNKNOWN_STATE"
  );
  await assert.rejects(
    () => service.transition({ venue: "BITUNIX", to: "SUPER_ENABLED", actor: "admin" }),
    (e: unknown) => e instanceof LiveGateError && (e as LiveGateError).code === "UNKNOWN_STATE"
  );
  await assert.rejects(
    () => service.transition({ venue: "NOSUCHVENUE", to: "CONNECTED", actor: "admin" }),
    (e: unknown) => e instanceof LiveGateError && (e as LiveGateError).code === "UNKNOWN_VENUE"
  );
});

test("Checks: fehlschlagender Check verweigert den Übergang (Zustand bleibt, ABORTED-Audit)", async () => {
  env = allowEnv();
  const failing = mockPort({ healthCheck: false });
  const service = serviceFor(env, { port: failing });
  await assert.rejects(
    () => service.transition({ venue: "BITUNIX", to: "CONNECTED", actor: "admin" }),
    (e: unknown) => e instanceof LiveGateError && (e as LiveGateError).code === "CHECK_FAILED"
  );
  const rec = getLiveGateRuntime(env).store.read("BITUNIX");
  assert.equal(rec.state, "DISCONNECTED");
  assert.equal(rec.pendingTransition, null);
  const aborted = getLiveGateRuntime(env).audit.recent(10).find(
    (e) => e.action === "advance" && e.result === "ABORTED"
  );
  assert.ok(aborted, "ABORTED-Audit-Eintrag fehlt");
  assert.match(aborted!.reason, /connectivity/);
});

test("PAPER_APPROVED: zu wenige fehlerfreie Orders → CHECK_FAILED", async () => {
  const e2 = allowEnv({ LIVE_GATE_PAPER_MIN_ORDERS: "10" });
  const good = mockPort();
  const svc = serviceFor(e2, { port: good });
  for (const to of ["CONNECTED", "MARKET_DATA_OK", "ACCOUNT_READ_OK", "ORDER_TEST_OK"] as LiveGateState[]) {
    await svc.transition({ venue: "BITUNIX", to, actor: "admin" });
  }
  const weak = mockPort({ errorFreeOrders: 3, orders: 3 });
  registerGatePort("BITUNIX", weak);
  await assert.rejects(
    () => svc.transition({ venue: "BITUNIX", to: "PAPER_APPROVED", actor: "admin" }),
    (e: unknown) => e instanceof LiveGateError && (e as LiveGateError).code === "CHECK_FAILED"
  );
  assert.equal(getLiveGateRuntime(e2).store.read("BITUNIX").state, "ORDER_TEST_OK");
});

test("Cooldown: Freigabe VOR Ablauf → deny mit Restzeit; danach → ok", async () => {
  env = allowEnv({ LIVE_GATE_COOLDOWN_MS: String(60 * 60 * 1000) }); // 1 h
  const service = serviceFor(env, { port });
  for (const to of ["CONNECTED", "MARKET_DATA_OK", "ACCOUNT_READ_OK", "ORDER_TEST_OK", "PAPER_APPROVED", "LIVE_PENDING"] as LiveGateState[]) {
    await service.transition({
      venue: "BITUNIX",
      to,
      actor: "admin",
      reason: "Bis LIVE_PENDING für Cooldown-Test",
    });
  }
  await assert.rejects(
    () =>
      service.transition({
        venue: "BITUNIX",
        to: "HUMAN_APPROVED",
        actor: "admin",
        reason: "Freigabe vor Cooldown-Ablauf",
        confirm: true,
        approvedBy: "approver-a",
      }),
    (e: unknown) =>
      e instanceof LiveGateError &&
      (e as LiveGateError).code === "COOLDOWN_ACTIVE" &&
      /retryAt/.test((e as Error).message)
  );
  // Zustand unverändert + Audit-DENY:
  assert.equal(getLiveGateRuntime(env).store.read("BITUNIX").state, "LIVE_PENDING");
  assert.ok(
    getLiveGateRuntime(env).audit.recent(5).some((e) => e.result === "DENIED" && /COOLDOWN_ACTIVE/.test(e.reason))
  );
  // Zeitraffer: livePendingAt 2 h zurückdatieren → Freigabe ok.
  backdateCooldown(env, "BITUNIX", 2 * 60 * 60 * 1000);
  await service.transition({
    venue: "BITUNIX",
    to: "HUMAN_APPROVED",
    actor: "admin",
    reason: "Freigabe nach Cooldown-Ablauf",
    confirm: true,
    approvedBy: "approver-a",
  });
  assert.equal(getLiveGateRuntime(env).store.read("BITUNIX").state, "HUMAN_APPROVED");
});

test("Human-Gate: Begründung, confirm:true und Approver sind Pflicht", async () => {
  const e2 = allowEnv();
  const svc = serviceFor(e2, { port });
  for (const to of ["CONNECTED", "MARKET_DATA_OK", "ACCOUNT_READ_OK", "ORDER_TEST_OK", "PAPER_APPROVED", "LIVE_PENDING"] as LiveGateState[]) {
    await svc.transition({ venue: "BITUNIX", to, actor: "admin", reason: "Setup Human-Gate-Test" });
  }
  await assert.rejects(
    () => svc.transition({ venue: "BITUNIX", to: "HUMAN_APPROVED", actor: "admin", reason: "zu kurz", confirm: true }),
    (e: unknown) => e instanceof LiveGateError && (e as LiveGateError).code === "REASON_REQUIRED"
  );
  await assert.rejects(
    () =>
      svc.transition({
        venue: "BITUNIX",
        to: "HUMAN_APPROVED",
        actor: "admin",
        reason: "Ausreichend langer Grund",
        approvedBy: "approver-a",
      }),
    (e: unknown) => e instanceof LiveGateError && (e as LiveGateError).code === "CONFIRM_REQUIRED"
  );
  await assert.rejects(
    () =>
      svc.transition({
        venue: "BITUNIX",
        to: "HUMAN_APPROVED",
        actor: "admin",
        reason: "Ausreichend langer Grund",
        confirm: true,
      }),
    (e: unknown) => e instanceof LiveGateError && (e as LiveGateError).code === "APPROVER_REQUIRED"
  );
});

test("4-Augen: erste Bestätigung → PENDING, gleicher Approver → deny, anderer → ok", async () => {
  env = allowEnv({ LIVE_GATE_FOUR_EYES: "true" });
  const service = serviceFor(env, { port });
  for (const to of ["CONNECTED", "MARKET_DATA_OK", "ACCOUNT_READ_OK", "ORDER_TEST_OK", "PAPER_APPROVED", "LIVE_PENDING"] as LiveGateState[]) {
    await service.transition({ venue: "BITUNIX", to, actor: "admin", reason: "Setup 4-Augen-Test" });
  }
  const attempt = (by: string) =>
    service.transition({
      venue: "BITUNIX",
      to: "HUMAN_APPROVED",
      actor: "admin",
      reason: "4-Augen-Freigabe-Test",
      confirm: true,
      approvedBy: by,
    });
  // 1) Erste Bestätigung: PENDING, kein Zustandswechsel, auditiert.
  await assert.rejects(() => attempt("alice"), (e: unknown) =>
    e instanceof LiveGateError && (e as LiveGateError).code === "FOUR_EYES_PENDING"
  );
  const rec1 = getLiveGateRuntime(env).store.read("BITUNIX");
  assert.equal(rec1.state, "LIVE_PENDING");
  assert.equal(rec1.pendingApproval?.approvedBy, "alice");
  assert.ok(
    getLiveGateRuntime(env).audit.recent(5).some((e) => e.action === "four-eyes-first" && /alice/.test(e.reason))
  );
  // 2) Gleicher Approver: deny.
  await assert.rejects(() => attempt("alice"), (e: unknown) =>
    e instanceof LiveGateError && (e as LiveGateError).code === "FOUR_EYES_SAME_APPROVER"
  );
  assert.equal(getLiveGateRuntime(env).store.read("BITUNIX").state, "LIVE_PENDING");
  // 3) Anderer Approver: Übergang vollzogen.
  await attempt("bob");
  const rec2 = getLiveGateRuntime(env).store.read("BITUNIX");
  assert.equal(rec2.state, "HUMAN_APPROVED");
  assert.equal(rec2.pendingApproval, null);
});

test("LIVE_ENABLED: Voraussetzungen (Flags/Suite/Control Plane) werden geprüft", async () => {
  // Flags OFF → FLAGS-artiger Deny trotz HUMAN_APPROVED.
  const eFlags = mkEnv({ LIVE_GATE_COOLDOWN_MS: "0" });
  seedState(eFlags, "BITUNIX", "HUMAN_APPROVED");
  const svcFlags = serviceFor(eFlags, { port });
  await assert.rejects(
    () =>
      svcFlags.transition({
        venue: "BITUNIX",
        to: "LIVE_ENABLED",
        actor: "admin",
        reason: "Enable ohne Flags",
        confirm: true,
        approvedBy: "approver-a",
      }),
    (e: unknown) => {
      const code = (e as LiveGateError).code;
      return (
        e instanceof LiveGateError &&
        (code === "VENUE_FLAG_MISSING" ||
          code === "PLATFORM_FLAG_MISSING" ||
          code === "VENUE_LIVE_FLAG_MISSING")
      );
    }
  );
  assert.equal(getLiveGateRuntime(eFlags).store.read("BITUNIX").state, "HUMAN_APPROVED");

  // Suite ungültig → SECURITY_SUITE_INVALID.
  const eSuite = allowEnv();
  seedState(eSuite, "BITUNIX", "HUMAN_APPROVED");
  const svcSuite = serviceFor(eSuite, { port, suite: false });
  await assert.rejects(
    () =>
      svcSuite.transition({
        venue: "BITUNIX",
        to: "LIVE_ENABLED",
        actor: "admin",
        reason: "Enable ohne Suite",
        confirm: true,
        approvedBy: "approver-a",
      }),
    (e: unknown) => e instanceof LiveGateError && (e as LiveGateError).code === "SECURITY_SUITE_INVALID"
  );

  // Control Plane inaktiv → CONTROL_PLANE_INACTIVE.
  const eCp = allowEnv();
  seedState(eCp, "BITUNIX", "HUMAN_APPROVED");
  const svcCp = serviceFor(eCp, { port, readiness: "inactive" });
  await assert.rejects(
    () =>
      svcCp.transition({
        venue: "BITUNIX",
        to: "LIVE_ENABLED",
        actor: "admin",
        reason: "Enable mit inaktiver Control Plane",
        confirm: true,
        approvedBy: "approver-a",
      }),
    (e: unknown) => e instanceof LiveGateError && (e as LiveGateError).code === "CONTROL_PLANE_INACTIVE"
  );

  // Alles erfüllt → Übergang ok.
  const eOk = allowEnv();
  seedState(eOk, "BITUNIX", "HUMAN_APPROVED");
  const svcOk = serviceFor(eOk, { port });
  await svcOk.transition({
    venue: "BITUNIX",
    to: "LIVE_ENABLED",
    actor: "admin",
    reason: "Enable mit vollständigen Gates",
    confirm: true,
    approvedBy: "approver-a",
  });
  assert.equal(getLiveGateRuntime(eOk).store.read("BITUNIX").state, "LIVE_ENABLED");
});

test("disable: expliziter Downgrade → DISCONNECTED (auditiert), No-Op auf DISCONNECTED → deny", async () => {
  const service = serviceFor(env, { port });
  await walkTo("MARKET_DATA_OK");
  const result = await service.disable({
    venue: "BITUNIX",
    actor: "admin",
    reason: "Expliziter Downgrade im Test",
  });
  assert.equal(result.to, "DISCONNECTED");
  assert.equal(getLiveGateRuntime(env).store.read("BITUNIX").state, "DISCONNECTED");
  assert.ok(
    getLiveGateRuntime(env).audit.recent(5).some((e) => e.action === "disable" && e.result === "OK")
  );
  await assert.rejects(
    () => service.disable({ venue: "BITUNIX", actor: "admin", reason: "No-Op-Versuch" }),
    (e: unknown) => e instanceof LiveGateError && (e as LiveGateError).code === "ILLEGAL_TRANSITION"
  );
  assert.equal(readKillFile(getLiveGateRuntime(env).dir).length, 0, "disable setzt KEINEN Kill");
});
