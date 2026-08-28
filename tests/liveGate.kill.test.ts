/**
 * Kill-Switch-Drill (Task 11, Security-Suite).
 *
 * 1. Kill aus JEDEM der 9 Zustände: sofort gesperrt (Memory + persistente
 *    Failsafe-Datei), State → DISCONNECTED, Audit-Eintrag KILLED; danach ist
 *    eine Live-Order selbst in der erlaubenden Konstellation verweigert.
 * 2. Kill wirkt systemweit (scope all) und venue-scoped.
 * 3. Kill funktioniert bei Store-/DB-Ausfall (read-only-Dir): Memory-Sperre
 *    bleibt wirksam, Datei-Schreiben wird gemeldet.
 * 4. clearKill entfernt die Sperre auditiert — Zustand bleibt DISCONNECTED,
 *    kompletter Neudurchlauf nötig (Kill nach Freigabe erneut verweigert).
 * 5. Confirm-Phrase "KILL" serverseitig erzwungen; Grund Pflicht.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LiveTradingGateError } from "../src/contracts/broker";
import {
  KILL_CLEAR_CONFIRM_PHRASE,
  KILL_CONFIRM_PHRASE,
  LiveGateError,
  assertLiveOrderAllowed,
  getLiveGateRuntime,
  killFilePath,
  readKillFile,
  setVenueReadinessProvider,
  writeSuiteStamp,
  type LiveGateState,
} from "../src/live-gate";
import { allowEnv, mkEnv, resetLiveGateTestGlobals, seedState, serviceFor } from "./fixtures/liveGateTestUtil";
import { LIVE_GATE_STATES } from "../src/live-gate";

let env: ReturnType<typeof allowEnv>;

beforeEach(() => {
  env = allowEnv();
});

afterEach(() => {
  resetLiveGateTestGlobals();
});

test("Kill-Drill: aus JEDEM der 9 Zustände → sofort gesperrt + Audit + Failsafe-Datei", async () => {
  for (const state of LIVE_GATE_STATES) {
    const e = allowEnv();
    seedState(e, "BITUNIX", state);
    writeSuiteStamp(getLiveGateRuntime(e).dir, { passed: true, runId: "kill-drill", sha: null, source: "ci" });
    setVenueReadinessProvider(() => ({ active: true }));
    const service = serviceFor(e, {});

    const result = await service.kill({
      venue: "BITUNIX",
      actor: "admin",
      reason: `Kill-Drill aus ${state}`,
      confirm: KILL_CONFIRM_PHRASE,
    });
    assert.equal(result.ok, true, state);
    assert.equal(result.scope, "BITUNIX");
    assert.equal(result.failsafeFileWritten, true, `${state}: Failsafe-Datei muss geschrieben sein`);

    // Failsafe-Datei gesetzt:
    assert.ok(existsSync(killFilePath(getLiveGateRuntime(e).dir)), `${state}: kill-switch.json fehlt`);
    const entries = readKillFile(getLiveGateRuntime(e).dir);
    assert.ok(entries.some((k) => k.scope === "BITUNIX" && /Kill-Drill/.test(k.reason)), state);

    // State-Reset:
    const rec = getLiveGateRuntime(e).store.read("BITUNIX");
    assert.equal(rec.state, "DISCONNECTED", state);
    assert.ok(rec.killed, `${state}: Kill-Marker im State-File fehlt`);

    // Audit-KILLED:
    const killed = getLiveGateRuntime(e).audit.recent(5).find((x) => x.action === "kill" && x.result === "KILLED");
    assert.ok(killed, `${state}: KILLED-Audit fehlt`);

    // Live-Order bleibt selbst in erlaubender Konstellation verweigert:
    assert.throws(
      () => assertLiveOrderAllowed("BITUNIX", { env: e }),
      (err: unknown) =>
        err instanceof LiveTradingGateError && /KILL_SWITCH_ACTIVE/.test((err as Error).message),
      `${state}: Live-Order nach Kill nicht verweigert!`
    );
  }
});

test("Kill systemweit (scope all): alle Venues gesperrt, auch PAPER-fremde Live-Venues", async () => {
  const e = allowEnv();
  seedState(e, "BITUNIX", "HUMAN_APPROVED");
  const service = serviceFor(e, {});
  const result = await service.kill({
    scope: "all",
    actor: "admin",
    reason: "Systemweiter Notfall-Drill",
    confirm: KILL_CONFIRM_PHRASE,
  });
  assert.equal(result.scope, "*");
  assert.ok(result.venues.length >= 7, "alle Adapter-Venues betroffen");
  const entries = readKillFile(getLiveGateRuntime(e).dir);
  assert.ok(entries.some((k) => k.scope === "*"));
  // BITUNIX (live-capable): Kill dominiert.
  assert.throws(() => assertLiveOrderAllowed("BITUNIX", { env: e }), /KILL_SWITCH_ACTIVE/);
  // Nicht-live-capable Venues: trotzdem denied (Capability vor Kill in der
  // Prüfreihenfolge — beide Gründe sind harte Denys).
  assert.throws(() => assertLiveOrderAllowed("BINANCE", { env: e }), /VENUE_NOT_LIVE_CAPABLE/);
  assert.throws(() => assertLiveOrderAllowed("PAPER", { env: e }), /VENUE_NOT_LIVE_CAPABLE/);
});

test("Kill-Datei wirkt über Runtime-Neustart hinweg (persistente Sperre)", async () => {
  const e = allowEnv();
  const service = serviceFor(e, {});
  await service.kill({ venue: "BITUNIX", actor: "admin", reason: "Persistenz-Drill", confirm: KILL_CONFIRM_PHRASE });
  // Simulierter Neustart: Runtime-Cache verwerfen, Dateien bleiben.
  const { resetLiveGateRuntimesForTests } = await import("../src/live-gate/runtime");
  resetLiveGateRuntimesForTests();
  setVenueReadinessProvider(() => ({ active: true }));
  writeSuiteStamp(getLiveGateRuntime(e).dir, { passed: true, runId: "restart", sha: null, source: "ci" });
  assert.throws(() => assertLiveOrderAllowed("BITUNIX", { env: e }), /KILL_SWITCH_ACTIVE/);
});

test("Kill bei Store-Ausfall (read-only-Dir): Memory-Sperre wirkt, Ergebnis meldet Datei-Fehler", async () => {
  const e = allowEnv();
  const service = serviceFor(e, {});
  // Data-Dir read-only setzen → State-Writes UND Kill-File-Append scheitern.
  chmodSync(e.LIVE_GATE_DATA_DIR as string, 0o500);
  try {
    const result = await service.kill({
      venue: "BITUNIX",
      actor: "admin",
      reason: "Drill bei defektem Dateisystem",
      confirm: KILL_CONFIRM_PHRASE,
    });
    assert.equal(result.ok, true, "Kill muss auch bei IO-Fehler durchgreifen");
    assert.equal(result.failsafeFileWritten, false, "Datei-Schreiben muss als fehlgeschlagen gemeldet werden");
    assert.ok(result.venues.some((v) => v.stateReset === false));
    // Trotzdem: prozesslokale Sperre verweigert Live:
    assert.throws(() => assertLiveOrderAllowed("BITUNIX", { env: e }), /KILL_SWITCH_ACTIVE/);
  } finally {
    chmodSync(e.LIVE_GATE_DATA_DIR as string, 0o700);
  }
});

test("Kill blockiert auch Transitions bis zum expliziten Clear", async () => {
  const e = allowEnv();
  const service = serviceFor(e, {});
  await service.kill({ venue: "BITUNIX", actor: "admin", reason: "Transition-Sperre-Drill", confirm: KILL_CONFIRM_PHRASE });
  await assert.rejects(
    () => service.transition({ venue: "BITUNIX", to: "CONNECTED", actor: "admin" }),
    (err: unknown) => err instanceof LiveGateError && (err as LiveGateError).code === "KILL_SWITCH_ACTIVE"
  );
  // Clear: Phrase + Grund Pflicht; danach Transitions wieder möglich, aber
  // Zustand bleibt DISCONNECTED (kompletter Neudurchlauf).
  await assert.rejects(
    () => service.clearKill({ scope: "BITUNIX", actor: "admin", reason: "Falsche Phrase", confirm: "NOPE" }),
    (e2: unknown) => e2 instanceof LiveGateError && (e2 as LiveGateError).code === "CONFIRM_REQUIRED"
  );
  const cleared = await service.clearKill({
    scope: "BITUNIX",
    actor: "admin",
    reason: "Fehleranalyse abgeschlossen",
    confirm: KILL_CLEAR_CONFIRM_PHRASE,
  });
  assert.equal(cleared.removed >= 1, true);
  assert.equal(getLiveGateRuntime(e).store.read("BITUNIX").state, "DISCONNECTED");
  // LIVE_ENABLED-Versuch direkt nach Clear → illegal (Matrix) — Neudurchlauf nötig:
  await assert.rejects(
    () =>
      service.transition({
        venue: "BITUNIX",
        to: "LIVE_ENABLED",
        actor: "admin",
        reason: "Sofort-Freigabe nach Kill",
        confirm: true,
        approvedBy: "a",
      }),
    (e2: unknown) => e2 instanceof LiveGateError && (e2 as LiveGateError).code === "ILLEGAL_TRANSITION"
  );
});

test("Kill-Confirm serverseitig: Phrase 'KILL' und Grund sind Pflicht", async () => {
  const service = serviceFor(env, {});
  await assert.rejects(
    () => service.kill({ venue: "BITUNIX", actor: "admin", reason: "Ohne Phrase", confirm: "kill" }),
    (e: unknown) => e instanceof LiveGateError && (e as LiveGateError).code === "CONFIRM_REQUIRED"
  );
  await assert.rejects(
    () => service.kill({ venue: "BITUNIX", actor: "admin", reason: "kurz", confirm: KILL_CONFIRM_PHRASE }),
    (e: unknown) => e instanceof LiveGateError && (e as LiveGateError).code === "REASON_REQUIRED"
  );
  assert.equal(readKillFile(getLiveGateRuntime(env).dir).length, 0, "kein Kill-Eintrag bei abgewiesenen Versuchen");
});

test("Unlesbare Kill-Datei (korrupt) bricht den Enforcer nicht (Defense in Depth)", () => {
  const e = allowEnv();
  const dir = e.LIVE_GATE_DATA_DIR as string;
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "kill-switch.json"), "{corrupt json!!", "utf8");
  seedState(e, "BITUNIX", "DISCONNECTED");
  // Datei unlesbar => kein Kill aus der Datei, aber State != LIVE_ENABLED => deny.
  assert.throws(() => assertLiveOrderAllowed("BITUNIX", { env: e }), /STATE_NOT_LIVE_ENABLED/);
});

test("CLI-Äquivalent: service.kill mit actor 'cli' auditiert den Notfallpfad", async () => {
  const e = mkEnv();
  const service = serviceFor(e, {});
  await service.kill({
    venue: "BITUNIX",
    actor: "cli",
    reason: "CLI-Notfall: API nicht erreichbar",
    confirm: KILL_CONFIRM_PHRASE,
  });
  const killed = getLiveGateRuntime(e).audit.recent(3).find((x) => x.action === "kill");
  assert.ok(killed);
  assert.equal(killed!.actor, "cli");
  const file = readKillFile(getLiveGateRuntime(e).dir);
  assert.equal(file[file.length - 1].actor, "cli");
});
