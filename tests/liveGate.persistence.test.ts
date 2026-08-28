/**
 * Persistenz-/Crash-Recovery- und Audit-Ketten-Tests (Task 11, Security-Suite).
 *
 * 1. Zustand über „Neustart" (neue Runtime, gleiches Dir) konsistent.
 * 2. Halboffene Transition (Crash zwischen Intent und Commit) → als
 *    FEHLGESCHLAGEN auditiert (crash-recovery/ABORTED), Zustand bleibt `from`.
 * 3. Korruptes State-File → fail-safe DISCONNECTED + Konservierung + Audit.
 * 4. Audit-Hash-Kette: Manipulation eines Eintrags → verifyAuditChain schlägt
 *    an; Seq-/prevHash-Bruch (Einfügen/Entfernen) wird erkannt; Truncation
 *    wird über den Kettenkopf im State-File sichtbar.
 * 5. Atomares Schreiben: keine tmp-Reste nach Commit.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  LiveGateStore,
  LiveGateAudit,
  computeAuditHash,
  createInitialVenueRecord,
  getLiveGateRuntime,
  resetLiveGateRuntimesForTests,
  verifyAuditChain,
  type LiveGateAuditEntry,
} from "../src/live-gate";
import { allowEnv, mkEnv, mockPort, resetLiveGateTestGlobals, serviceFor } from "./fixtures/liveGateTestUtil";
import { seedState } from "./fixtures/liveGateTestUtil";

let env: ReturnType<typeof mkEnv>;

beforeEach(() => {
  env = mkEnv();
});

afterEach(() => {
  resetLiveGateRuntimesForTests();
  resetLiveGateTestGlobals();
});

test("Persistenz: Zustand über Runtime-Neustart konsistent", async () => {
  const service = serviceFor(env, { port: mockPort() });
  await service.transition({ venue: "BITUNIX", to: "CONNECTED", actor: "admin" });
  await service.transition({ venue: "BITUNIX", to: "MARKET_DATA_OK", actor: "admin" });

  // „Neustart": neue Runtime (gleiche Dateien).
  resetLiveGateRuntimesForTests();
  const rt = getLiveGateRuntime(env);
  const rec = rt.store.read("BITUNIX");
  assert.equal(rec.state, "MARKET_DATA_OK");
  assert.equal(rec.updatedBy, "admin");

  // Und die neue Service-Instanz geht von dort aus weiter:
  const service2 = serviceFor(env, { port: mockPort() });
  await service2.transition({ venue: "BITUNIX", to: "ACCOUNT_READ_OK", actor: "admin" });
  assert.equal(getLiveGateRuntime(env).store.read("BITUNIX").state, "ACCOUNT_READ_OK");
});

test("Crash-Recovery: halboffene Transition gilt als fehlgeschlagen (ABORTED-Audit)", async () => {
  const service = serviceFor(env, { port: mockPort() });
  await service.transition({ venue: "BITUNIX", to: "CONNECTED", actor: "admin" });
  const rt = getLiveGateRuntime(env);

  // Crash simulieren: Intent für CONNECTED→MARKET_DATA_OK schreiben, dann
  // „abstürzen" (kein Commit, Cache verwerfen).
  const rec = rt.store.read("BITUNIX");
  rec.pendingTransition = {
    id: "crash-test",
    from: "CONNECTED",
    to: "MARKET_DATA_OK",
    startedAt: new Date().toISOString(),
    actor: "admin",
  };
  rt.store.write("BITUNIX", rec);
  resetLiveGateRuntimesForTests();

  // Neustart: Recovery muss den Intent verwerfen + als ABORTED auditieren.
  const rt2 = getLiveGateRuntime(env);
  const rec2 = rt2.store.read("BITUNIX");
  assert.equal(rec2.state, "CONNECTED", "Zustand muss beim from bleiben");
  assert.equal(rec2.pendingTransition, null, "Intent muss entfernt sein");
  const aborted = rt2.audit.recent(10).find(
    (e) => e.action === "crash-recovery" && e.result === "ABORTED" && /CONNECTED->MARKET_DATA_OK/.test(e.reason)
  );
  assert.ok(aborted, "Halboffene Transition nicht als fehlgeschlagen auditiert");
  // Kette bleibt danach gültig:
  assert.equal(verifyAuditChain(rt2.dir).ok, true);
});

test("Crash-Recovery: korruptes State-File → fail-safe DISCONNECTED + Konservierung", () => {
  const dir = env.LIVE_GATE_DATA_DIR as string;
  const file = path.join(dir, "venue-BITUNIX.json");
  writeFileSync(file, '{"schemaVersion":1,"venue":"BITUNIX","state":"HACKED_LIVE"', "utf8");

  const rt = getLiveGateRuntime(env);
  const rec = rt.store.read("BITUNIX");
  assert.equal(rec.state, "DISCONNECTED", "Korruptes File muss zu DISCONNECTED führen");
  const corruptCopies = readdirSync(dir).filter((f) => f.startsWith("venue-BITUNIX.json.corrupt-"));
  assert.equal(corruptCopies.length, 1, "Korruptes File muss konserviert werden");
  const recovered = rt.audit.recent(5).find((e) => e.action === "crash-recovery" && /ungültig\/korrupt/.test(e.reason));
  assert.ok(recovered);
});

test("Audit-Hash-Kette: Manipulation eines Eintrags wird erkannt", () => {
  const audit = new LiveGateAudit(env.LIVE_GATE_DATA_DIR as string);
  audit.append({ actor: "admin", venue: "BITUNIX", from: "DISCONNECTED", to: "CONNECTED", action: "advance", result: "OK", reason: "Erster" });
  audit.append({ actor: "admin", venue: "BITUNIX", from: "CONNECTED", to: "MARKET_DATA_OK", action: "advance", result: "OK", reason: "Zweiter" });
  audit.append({ actor: "system", venue: "BITUNIX", from: null, to: null, action: "enforce", result: "DENIED", reason: "Dritter" });
  assert.equal(verifyAuditChain((env.LIVE_GATE_DATA_DIR as string)).ok, true);

  // Manipulation: reason des 2. Eintrags nachträglich ändern.
  const file = path.join(env.LIVE_GATE_DATA_DIR as string, "audit-log.ndjson");
  const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
  const second = JSON.parse(lines[1]) as LiveGateAuditEntry;
  second.reason = "UNSCHULDIG UMGESCHRIEBEN";
  lines[1] = JSON.stringify(second);
  writeFileSync(file, lines.join("\n") + "\n", "utf8");

  const verification = verifyAuditChain(env.LIVE_GATE_DATA_DIR as string);
  assert.equal(verification.ok, false, "Manipulierte Kette muss auffallen");
  assert.equal(verification.firstBrokenSeq, 2);
  assert.match(verification.problem ?? "", /Hash-Abweichung/);
});

test("Audit-Hash-Kette: Einfügen/Entfernen (Seq-/prevHash-Bruch) wird erkannt", () => {
  const audit = new LiveGateAudit(env.LIVE_GATE_DATA_DIR as string);
  for (let i = 0; i < 4; i++) {
    audit.append({ actor: "admin", venue: "*", from: null, to: null, action: "enforce", result: "DENIED", reason: `Eintrag ${i + 1}` });
  }
  const file = path.join(env.LIVE_GATE_DATA_DIR as string, "audit-log.ndjson");
  const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim());

  // Entfernen von Eintrag 3 (Zeile index 2):
  const removed = lines.filter((_, i) => i !== 2);
  writeFileSync(file, removed.join("\n") + "\n", "utf8");
  const v1 = verifyAuditChain(env.LIVE_GATE_DATA_DIR as string);
  assert.equal(v1.ok, false, "Entfernen muss auffallen");
  assert.equal(v1.firstBrokenSeq, 3);

  // Einfügen einer komplett gefälschten Zeile am Ende (falscher prevHash/seq):
  const forged: LiveGateAuditEntry = {
    seq: 99,
    ts: new Date().toISOString(),
    actor: "attacker",
    venue: "*",
    from: "HUMAN_APPROVED",
    to: "LIVE_ENABLED",
    action: "advance",
    result: "OK",
    reason: "gefaelscht",
    policyVersion: "live-gate-policy/1",
    prevHash: "0".repeat(64),
    hash: "0".repeat(64),
  };
  writeFileSync(file, [...removed, JSON.stringify(forged)].join("\n") + "\n", "utf8");
  const v2 = verifyAuditChain(env.LIVE_GATE_DATA_DIR as string);
  assert.equal(v2.ok, false, "Einfügen muss auffallen");
});

test("Audit-Hash-Kette: Truncation wird über den Kettenkopf im State-File sichtbar", async () => {
  const service = serviceFor(env, { port: mockPort() });
  await service.transition({ venue: "BITUNIX", to: "CONNECTED", actor: "admin" });
  const rt = getLiveGateRuntime(env);
  const headBefore = rt.audit.chainHead();
  assert.ok(headBefore);
  const rec = rt.store.read("BITUNIX");
  assert.ok(rec.auditHead, "State-File muss den Kettenkopf speichern");
  assert.equal(rec.auditHead!.seq, headBefore!.seq);

  // Truncation: letzte Audit-Zeile löschen (Kette selbst bleibt konsistent).
  const file = path.join(env.LIVE_GATE_DATA_DIR as string, "audit-log.ndjson");
  const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
  writeFileSync(file, lines.slice(0, -1).join("\n") + "\n", "utf8");
  const after = verifyAuditChain(env.LIVE_GATE_DATA_DIR as string);
  // Der im State-File dokumentierte Kopf zeigt auf den entfernten Eintrag:
  assert.ok(after.head === null || after.head.seq < headBefore!.seq, "Truncation muss head-Abgleich verraten");
  assert.notEqual(after.head?.seq ?? 0, headBefore!.seq);
  assert.ok(rec.auditHead!.seq > (after.head?.seq ?? 0), "State-Head referenziert einen entfernten Eintrag");
});

test("Hash-Reproduzierbarkeit: computeAuditHash ist deterministisch und versioniert", () => {
  const base = {
    seq: 1,
    ts: "2026-08-28T00:00:00.000Z",
    actor: "admin",
    venue: "BITUNIX",
    from: "DISCONNECTED",
    to: "CONNECTED",
    action: "advance" as const,
    result: "OK" as const,
    reason: "deterministisch",
    policyVersion: "live-gate-policy/1",
    prevHash: "0".repeat(64),
  };
  assert.equal(computeAuditHash(base), computeAuditHash({ ...base }));
  assert.notEqual(
    computeAuditHash(base),
    computeAuditHash({ ...base, reason: "veraendert" })
  );
  assert.match(computeAuditHash(base), /^[0-9a-f]{64}$/);
});

test("Atomares Schreiben: keine tmp-Reste, Store write/read Roundtrip", () => {
  const audit = new LiveGateAudit(env.LIVE_GATE_DATA_DIR as string);
  const store = new LiveGateStore(env.LIVE_GATE_DATA_DIR as string, audit);
  const rec = createInitialVenueRecord("BITUNIX");
  rec.state = "PAPER_APPROVED";
  store.write("BITUNIX", rec);
  const files = readdirSync(env.LIVE_GATE_DATA_DIR as string);
  assert.equal(files.some((f) => f.endsWith(".tmp")), false, "tmp-Reste gefunden");
  assert.equal(store.read("BITUNIX").state, "PAPER_APPROVED");
  assert.equal(existsSync(path.join(env.LIVE_GATE_DATA_DIR as string, "venue-BITUNIX.json")), true);
});

test("Store-Cache-Konsistenz: evict erzwingt Neulesen der Datei", () => {
  seedState(env, "BITUNIX", "ORDER_TEST_OK");
  const rt = getLiveGateRuntime(env);
  assert.equal(rt.store.read("BITUNIX").state, "ORDER_TEST_OK");
  rt.store.evictForTests("BITUNIX");
  assert.equal(rt.store.read("BITUNIX").state, "ORDER_TEST_OK");
});
