/**
 * ASA-02 — Vier-Augen-Regressionen für die Live-Gate-State-Machine.
 *
 * Diese Datei ist bewusst Teil des Globs `tests/liveGate.*.test.ts`, den der
 * merge-blockierende CI-Job `security-live-gate` mit dem Coverage-Tor
 * (>= 95 % Zeilen auf `src/live-gate/**`) ausfuehrt. Jede neue
 * Sicherheitsverzweigung im Live-Gate muss hier (oder in einer der anderen
 * `liveGate.*.test.ts`) einen Test haben — sonst sinkt die Quote und der
 * Required Check wird rot. Nicht das Tor senken, sondern den Pfad testen.
 *
 * Abgedeckte Fail-Closed-Pfade:
 *   - Schritt 1: Persistenz von Principal-Fingerprint, approvalId, Intent, TTL;
 *     `snapshot()`/`overview()` geben NUR Anzeigefelder heraus.
 *   - `local-open` / fehlender Principal => FOUR_EYES_PRINCIPALS_REQUIRED.
 *   - Schritt 2: falsche/fehlende approvalId, gleicher Principal,
 *     Intent-Mismatch, Ablauf (inkl. Aufraeum-Schreibfehler).
 *   - Legacy-State-Dateien ohne principalId/approvalId werden neu beantragt.
 *   - Erfolgreicher 2-Principal-Flow inkl. `four-eyes-second`-Audit.
 *   - `LIVE_ENABLED`: local-open-Sperre und 2-Principal-Freigabe.
 *   - Store-Fehler bei Erstfreigabe/Intent/Commit/Disable (fail-safe).
 *   - HTTP-Status-Mapping der neuen Fehlercodes + Store-/Runtime-Helfer.
 */
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import {
  LIVE_GATE_ERROR_CODES,
  LiveGateError,
  LiveGateRuntime,
  LiveGateService,
  LiveGateStore,
  getLiveGateRuntime,
  liveGateErrorStatus,
  resetLiveGateRuntimesForTests,
  verifyAuditChain,
  type LiveGateEnv,
  type LiveGateState,
  type LiveGateVenueRecord,
} from "../src/live-gate";
import {
  FOUR_EYES_TTL_MS,
  fourEyesHint,
  fourEyesIntent,
  type FourEyesDenyReason,
} from "../src/lib/fourEyesApproval";
import {
  allowEnv,
  mockPort,
  resetLiveGateTestGlobals,
  seedState,
  serviceFor,
  type CountingMockPort,
} from "./fixtures/liveGateTestUtil";

const VENUE = "BITUNIX";
const REASON = "Vier-Augen-Regression: ausreichend lange Begruendung";
const HUMAN_INTENT = fourEyesIntent([VENUE, "LIVE_PENDING", "HUMAN_APPROVED"]);

let env: LiveGateEnv;
let port: CountingMockPort;

beforeEach(() => {
  env = allowEnv({ LIVE_GATE_FOUR_EYES: "true" });
  port = mockPort();
});

afterEach(() => {
  resetLiveGateTestGlobals();
});

interface AttemptOptions {
  principalId?: string;
  principalDistinct?: boolean;
  approvalId?: string;
  approvedBy?: string;
  actor?: string;
  confirm?: boolean;
}

function attempt(service: LiveGateService, to: LiveGateState, o: AttemptOptions = {}) {
  return service.transition({
    venue: VENUE,
    to,
    actor: o.actor ?? "api:admin",
    reason: REASON,
    confirm: o.confirm ?? true,
    approvedBy: o.approvedBy ?? "alice",
    principalId: o.principalId,
    principalDistinct: o.principalDistinct,
    approvalId: o.approvalId,
  });
}

/** Schritt 1 ausfuehren und die strukturierten (nicht-geheimen) Details liefern. */
async function propose(
  service: LiveGateService,
  to: LiveGateState,
  principalId: string,
  approvedBy = "alice"
): Promise<{ approvalId: string; expiresAt: number }> {
  let approvalId = "";
  let expiresAt = 0;
  await assert.rejects(
    () => attempt(service, to, { principalId, principalDistinct: true, approvedBy }),
    (e: unknown) => {
      if (!(e instanceof LiveGateError) || e.code !== "FOUR_EYES_PENDING") return false;
      approvalId = String(e.details?.approvalId ?? "");
      expiresAt = Number(e.details?.expiresAt ?? 0);
      return true;
    }
  );
  assert.match(approvalId, /^[0-9a-f-]{36}$/, "approvalId muss eine UUID sein");
  assert.ok(expiresAt > Date.now(), "TTL muss in der Zukunft liegen");
  return { approvalId, expiresAt };
}

function codeIs(code: string) {
  return (e: unknown): boolean => e instanceof LiveGateError && e.code === code;
}

test("Schritt 1: Fingerprint/approvalId/Intent/TTL persistiert — Snapshot zeigt nur Anzeigefelder", async () => {
  const service = serviceFor(env, { port });
  seedState(env, VENUE, "LIVE_PENDING");
  const { approvalId, expiresAt } = await propose(service, "HUMAN_APPROVED", "principal-alice");

  assert.ok(expiresAt <= Date.now() + FOUR_EYES_TTL_MS + 1_000);
  const rt = getLiveGateRuntime(env);
  const rec = rt.store.read(VENUE);
  assert.equal(rec.state, "LIVE_PENDING", "Schritt 1 darf den Zustand nicht wechseln");
  assert.equal(rec.pendingApproval?.principalId, "principal-alice");
  assert.equal(rec.pendingApproval?.approvalId, approvalId);
  assert.equal(rec.pendingApproval?.intent, HUMAN_INTENT);
  assert.equal(rec.pendingApproval?.approvedBy, "alice");
  assert.equal(rec.pendingApproval?.expiresAt, expiresAt);
  assert.ok(
    rt.audit.recent(10).some((e) => e.action === "four-eyes-first" && e.reason.includes(approvalId)),
    "Erstfreigabe muss auditiert sein"
  );

  // ASA-02: Der Fingerprint und die approvalId duerfen die API nie verlassen.
  const snap = service.snapshot(VENUE);
  assert.equal(snap.fourEyesRequired, true);
  assert.deepEqual(Object.keys(snap.pendingApproval ?? {}).sort(), ["approvedBy", "at", "expiresAt"]);
  assert.equal(snap.pendingApproval?.approvedBy, "alice");
  assert.equal(snap.pendingApproval?.expiresAt, expiresAt);
  assert.ok(!JSON.stringify(snap).includes(approvalId));
  assert.ok(!JSON.stringify(snap).includes("principal-alice"));

  const overview = service.overview();
  assert.equal(overview.config.fourEyes, true);
  const venue = overview.venues.find((v) => v.venue === VENUE);
  assert.ok(venue, "Venue muss in der Uebersicht sein");
  assert.ok(!JSON.stringify(venue).includes(approvalId));
  assert.ok(!JSON.stringify(venue).includes("principal-alice"));
  assert.equal(verifyAuditChain(rt.dir).ok, true);
});

test("local-open / fehlender Principal: fail-closed mit klarem Hinweis auf getrennte Principals", async () => {
  const service = serviceFor(env, { port });
  seedState(env, VENUE, "LIVE_PENDING");
  const variants: AttemptOptions[] = [
    { principalId: "principal-alice", principalDistinct: false },
    { principalDistinct: true }, // kein Fingerprint
    {}, // gar kein Auth-Principal
  ];
  for (const variant of variants) {
    await assert.rejects(
      () => attempt(service, "HUMAN_APPROVED", { ...variant, approvedBy: "alice" }),
      (e: unknown) =>
        e instanceof LiveGateError &&
        e.code === "FOUR_EYES_PRINCIPALS_REQUIRED" &&
        /getrennte authentifizierte Principals/.test(e.message)
    );
  }
  const rt = getLiveGateRuntime(env);
  assert.equal(rt.store.read(VENUE).state, "LIVE_PENDING");
  assert.equal(rt.store.read(VENUE).pendingApproval, null, "Kein Antrag ohne verifizierten Principal");
  assert.ok(rt.audit.recent(20).some((e) => e.result === "DENIED" && /FOUR_EYES_PRINCIPALS_REQUIRED/.test(e.reason)));
});

test("Schritt 2: falsche/fehlende approvalId, gleicher Principal und Intent-Mismatch werden abgelehnt", async () => {
  const service = serviceFor(env, { port });
  seedState(env, VENUE, "LIVE_PENDING");
  const { approvalId } = await propose(service, "HUMAN_APPROVED", "principal-alice");
  const rt = getLiveGateRuntime(env);

  await assert.rejects(
    () => attempt(service, "HUMAN_APPROVED", {
      principalId: "principal-bob", principalDistinct: true, approvalId: "falsche-id", approvedBy: "bob",
    }),
    (e: unknown) =>
      e instanceof LiveGateError && e.code === "FOUR_EYES_APPROVAL_MISMATCH" && /WRONG_APPROVAL_ID/.test(e.message)
  );
  await assert.rejects(
    () => attempt(service, "HUMAN_APPROVED", {
      principalId: "principal-bob", principalDistinct: true, approvedBy: "bob",
    }),
    (e: unknown) =>
      e instanceof LiveGateError && e.code === "FOUR_EYES_APPROVAL_MISMATCH" && /APPROVAL_ID_REQUIRED/.test(e.message)
  );
  // Gleicher Principal — selbst mit einem anderen Freitextnamen im Body.
  await assert.rejects(
    () => attempt(service, "HUMAN_APPROVED", {
      principalId: "principal-alice", principalDistinct: true, approvalId, approvedBy: "bob",
    }),
    (e: unknown) =>
      e instanceof LiveGateError && e.code === "FOUR_EYES_SAME_APPROVER" && /Freitextnamen/.test(e.message)
  );

  // Manipulierter Intent (Ziel-Tausch) wird nicht gegengezeichnet.
  const rec = rt.store.read(VENUE);
  assert.ok(rec.pendingApproval, "Antrag muss nach den Denys weiter offen sein");
  rec.pendingApproval.intent = fourEyesIntent([VENUE, "LIVE_PENDING", "LIVE_ENABLED"]);
  rt.store.write(VENUE, rec);
  await assert.rejects(
    () => attempt(service, "HUMAN_APPROVED", {
      principalId: "principal-bob", principalDistinct: true, approvalId, approvedBy: "bob",
    }),
    (e: unknown) =>
      e instanceof LiveGateError && e.code === "FOUR_EYES_APPROVAL_MISMATCH" && /INTENT_MISMATCH/.test(e.message)
  );

  assert.equal(rt.store.read(VENUE).state, "LIVE_PENDING", "Kein Zustandswechsel nach Ablehnungen");
  assert.ok(
    !rt.audit.recent(30).some((e) => e.action === "four-eyes-second"),
    "Ohne gueltige Gegenzeichnung darf kein four-eyes-second entstehen"
  );
});

test("Abgelaufene Erstfreigabe: FOUR_EYES_EXPIRED, Aufraeumen und neuer Antrag", async () => {
  const service = serviceFor(env, { port });
  seedState(env, VENUE, "LIVE_PENDING");
  const { approvalId } = await propose(service, "HUMAN_APPROVED", "principal-alice");
  const rt = getLiveGateRuntime(env);

  const rec = rt.store.read(VENUE);
  assert.ok(rec.pendingApproval);
  rec.pendingApproval.expiresAt = Date.now() - 1;
  rt.store.write(VENUE, rec);

  await assert.rejects(
    () => attempt(service, "HUMAN_APPROVED", {
      principalId: "principal-bob", principalDistinct: true, approvalId, approvedBy: "bob",
    }),
    (e: unknown) =>
      e instanceof LiveGateError && e.code === "FOUR_EYES_EXPIRED" && /abgelaufen/.test(e.message)
  );
  assert.equal(rt.store.read(VENUE).pendingApproval, null, "Abgelaufener Antrag muss entfernt werden");

  const renewed = await propose(service, "HUMAN_APPROVED", "principal-carol", "carol");
  assert.notEqual(renewed.approvalId, approvalId, "Neuer Antrag braucht eine neue approvalId");
  assert.equal(rt.store.read(VENUE).pendingApproval?.principalId, "principal-carol");
});

test("Legacy-State ohne principalId/approvalId wird nicht als Freigabe akzeptiert", async () => {
  const service = serviceFor(env, { port });
  const rec = seedState(env, VENUE, "LIVE_PENDING");
  rec.pendingApproval = { approvedBy: "legacy", at: new Date().toISOString() };
  getLiveGateRuntime(env).store.write(VENUE, rec);

  const { approvalId } = await propose(service, "HUMAN_APPROVED", "principal-alice");
  const stored = getLiveGateRuntime(env).store.read(VENUE).pendingApproval;
  assert.equal(stored?.approvalId, approvalId);
  assert.equal(stored?.principalId, "principal-alice", "Alter Freitextantrag darf nicht zaehlen");
});

test("Erfolgreicher 2-Principal-Flow: HUMAN_APPROVED, four-eyes-second-Audit, single-use", async () => {
  const service = serviceFor(env, { port });
  seedState(env, VENUE, "LIVE_PENDING");
  const { approvalId } = await propose(service, "HUMAN_APPROVED", "principal-alice");
  const result = await attempt(service, "HUMAN_APPROVED", {
    principalId: "principal-bob", principalDistinct: true, approvalId, approvedBy: "bob",
  });

  assert.equal(result.from, "LIVE_PENDING");
  assert.equal(result.to, "HUMAN_APPROVED");
  const rt = getLiveGateRuntime(env);
  const rec = rt.store.read(VENUE);
  assert.equal(rec.state, "HUMAN_APPROVED");
  assert.equal(rec.pendingApproval, null, "Freigabe muss beim Commit atomar verbraucht werden");
  assert.equal(service.snapshot(VENUE).pendingApproval, null);
  assert.ok(
    rt.audit.recent(20).some((e) => e.action === "four-eyes-second" && e.reason.includes(approvalId)),
    "Gegenzeichnung muss auditiert sein"
  );
  assert.equal(verifyAuditChain(rt.dir).ok, true);
});

test("LIVE_ENABLED: local-open fail-closed — Legalitaetspruefung bleibt davor", async () => {
  const localEnv = allowEnv(); // vier Augen per Config aus — die Live-Sperre gilt trotzdem
  const service = serviceFor(localEnv, { port });
  seedState(localEnv, VENUE, "HUMAN_APPROVED");

  await assert.rejects(
    () => attempt(service, "LIVE_ENABLED", { principalId: "principal-alice", principalDistinct: false }),
    (e: unknown) => e instanceof LiveGateError && e.code === "FOUR_EYES_PRINCIPALS_REQUIRED"
  );
  assert.equal(getLiveGateRuntime(localEnv).store.read(VENUE).state, "HUMAN_APPROVED");

  // Illegale Spruenge behalten ihren Matrix-Fehler (kein Four-Eyes-Fehlercode).
  const illegalEnv = allowEnv({ LIVE_GATE_FOUR_EYES: "true" });
  const illegalSvc = serviceFor(illegalEnv, { port });
  seedState(illegalEnv, VENUE, "LIVE_PENDING");
  await assert.rejects(
    () => attempt(illegalSvc, "LIVE_ENABLED", { principalId: "p", principalDistinct: false }),
    codeIs("ILLEGAL_TRANSITION")
  );
});

test("LIVE_ENABLED mit Vier-Augen: zwei getrennte Principals schalten frei", async () => {
  const service = serviceFor(env, { port }); // Suite-Stamp + aktive Control Plane
  seedState(env, VENUE, "HUMAN_APPROVED");
  const { approvalId } = await propose(service, "LIVE_ENABLED", "principal-alice");
  const result = await attempt(service, "LIVE_ENABLED", {
    principalId: "principal-bob", principalDistinct: true, approvalId, approvedBy: "bob",
  });

  assert.equal(result.to, "LIVE_ENABLED");
  const rt = getLiveGateRuntime(env);
  const rec = rt.store.read(VENUE);
  assert.equal(rec.state, "LIVE_ENABLED");
  assert.equal(rec.pendingApproval, null);
  const recent = rt.audit.recent(20);
  assert.ok(recent.some((e) => e.action === "four-eyes-first"));
  assert.ok(recent.some((e) => e.action === "four-eyes-second"));
  assert.ok(recent.some((e) => e.action === "advance" && e.result === "OK" && e.to === "LIVE_ENABLED"));
});

/**
 * Service mit einem Store, der JEDE Mutation verweigert. Damit lassen sich die
 * fail-safe-Pfade (Erstfreigabe, Intent, Commit, Disable, Aufraeumen) ohne
 * Dateisystem-Fehler deterministisch drillen.
 */
function serviceWithWriteFailure(seed: LiveGateVenueRecord): LiveGateService {
  const rt = getLiveGateRuntime(env);
  const stubStore = {
    read: () => ({
      ...seed,
      history: { ...seed.history },
      pendingApproval: seed.pendingApproval ? { ...seed.pendingApproval } : null,
    }),
    write: () => {
      throw new Error("simulierter Schreibfehler (Fehlerdrill)");
    },
  } as unknown as LiveGateStore;
  const stub = Object.assign(Object.create(LiveGateRuntime.prototype) as LiveGateRuntime, {
    dir: rt.dir,
    audit: rt.audit,
    store: stubStore,
    killedMemory: rt.killedMemory,
    isKilled: (venue: string) => rt.isKilled(venue),
  });
  return new LiveGateService(stub, env);
}

test("Nicht persistierbare Erstfreigabe: STATE_WRITE_FAILED und kein Zustandswechsel", async () => {
  const service = serviceWithWriteFailure(seedState(env, VENUE, "LIVE_PENDING"));
  await assert.rejects(
    () => attempt(service, "HUMAN_APPROVED", { principalId: "principal-alice", principalDistinct: true }),
    (e: unknown) =>
      e instanceof LiveGateError && e.code === "STATE_WRITE_FAILED" && /nicht persistiert/.test(e.message)
  );
  assert.equal(getLiveGateRuntime(env).store.read(VENUE).pendingApproval, null);
});

test("Abgelaufene Freigabe: Aufraeum-Schreibfehler darf den Deny nicht verhindern", async () => {
  const seed = seedState(env, VENUE, "LIVE_PENDING");
  seed.pendingApproval = {
    approvedBy: "alice",
    at: new Date().toISOString(),
    principalId: "principal-alice",
    approvalId: "abgelaufene-freigabe",
    intent: HUMAN_INTENT,
    createdAt: Date.now() - FOUR_EYES_TTL_MS - 1_000,
    expiresAt: Date.now() - 1,
  };
  const service = serviceWithWriteFailure(seed);
  await assert.rejects(
    () => attempt(service, "HUMAN_APPROVED", {
      principalId: "principal-bob", principalDistinct: true, approvalId: "abgelaufene-freigabe", approvedBy: "bob",
    }),
    codeIs("FOUR_EYES_EXPIRED")
  );
  assert.ok(
    getLiveGateRuntime(env).audit.recent(10).some((e) => e.result === "DENIED" && /FOUR_EYES_EXPIRED/.test(e.reason)),
    "Deny muss trotz Store-Fehler auditiert sein"
  );
});

test("Store-Fehler bei Intent, Commit und Disable: Transition gilt als fehlgeschlagen", async () => {
  // 1) Intent (DISCONNECTED -> CONNECTED hat einen automatischen Check).
  const intentSvc = serviceWithWriteFailure(seedState(env, VENUE, "DISCONNECTED"));
  await assert.rejects(
    () => intentSvc.transition({ venue: VENUE, to: "CONNECTED", actor: "admin" }),
    codeIs("STATE_WRITE_FAILED")
  );

  // 2) Commit (PAPER_APPROVED -> LIVE_PENDING hat keinen Check, schreibt nur den Commit).
  const commitEnv = allowEnv();
  const commitRt = getLiveGateRuntime(commitEnv);
  const commitSeed = seedState(commitEnv, VENUE, "PAPER_APPROVED");
  const commitStubStore = {
    read: () => ({ ...commitSeed, history: { ...commitSeed.history } }),
    write: () => { throw new Error("Commit nicht schreibbar"); },
  } as unknown as LiveGateStore;
  const commitStub = Object.assign(Object.create(LiveGateRuntime.prototype) as LiveGateRuntime, {
    dir: commitRt.dir,
    audit: commitRt.audit,
    store: commitStubStore,
    killedMemory: commitRt.killedMemory,
    isKilled: (venue: string) => commitRt.isKilled(venue),
  });
  await assert.rejects(
    () => new LiveGateService(commitStub, commitEnv).transition({
      venue: VENUE, to: "LIVE_PENDING", actor: "admin", reason: REASON,
    }),
    (e: unknown) => e instanceof LiveGateError && e.code === "STATE_WRITE_FAILED" && /Commit/.test(e.message)
  );

  // 3) Disable.
  const disableSvc = serviceWithWriteFailure(seedState(env, VENUE, "CONNECTED"));
  await assert.rejects(
    () => disableSvc.disable({ venue: VENUE, actor: "admin", reason: REASON }),
    (e: unknown) => e instanceof LiveGateError && e.code === "STATE_WRITE_FAILED" && /Disable/.test(e.message)
  );
});

test("HTTP-Status-Mapping: neue Vier-Augen-Codes sind 403/409, Eingabefehler 422", () => {
  assert.equal(liveGateErrorStatus("FOUR_EYES_PRINCIPALS_REQUIRED"), 403);
  for (const code of ["UNKNOWN_VENUE", "UNKNOWN_STATE", "REASON_REQUIRED", "CONFIRM_REQUIRED", "APPROVER_REQUIRED"]) {
    assert.equal(liveGateErrorStatus(code), 422, code);
  }
  for (const code of [
    "FOUR_EYES_PENDING", "FOUR_EYES_SAME_APPROVER", "FOUR_EYES_EXPIRED",
    "FOUR_EYES_APPROVAL_MISMATCH", "ILLEGAL_TRANSITION", "STATE_WRITE_FAILED",
  ]) {
    assert.equal(liveGateErrorStatus(code), 409, code);
    assert.ok((LIVE_GATE_ERROR_CODES as readonly string[]).includes(code), `${code} muss kanonisch sein`);
  }
  assert.equal(new Set(LIVE_GATE_ERROR_CODES).size, LIVE_GATE_ERROR_CODES.length);
});

test("Fehlermeldungen der Vier-Augen-Ablehnung bleiben fuer jeden Grund eindeutig", () => {
  const reasons: FourEyesDenyReason[] = [
    "PRINCIPALS_REQUIRED", "NO_PROPOSAL", "APPROVAL_ID_REQUIRED",
    "WRONG_APPROVAL_ID", "EXPIRED", "SAME_PRINCIPAL", "INTENT_MISMATCH",
  ];
  const hints = reasons.map((r) => fourEyesHint(r));
  for (const hint of hints) assert.ok(hint.length > 20, "Hinweis muss handlungsleitend sein");
  assert.equal(new Set(hints).size, reasons.length, "Jeder Ablehnungsgrund braucht einen eigenen Hinweis");
  assert.match(fourEyesHint("PRINCIPALS_REQUIRED"), /local-open/);
  assert.match(fourEyesHint("EXPIRED"), /15 Minuten/);
});

test("Store-/Runtime-Helfer: Dateipfad, Cache-Reset, Datei-Entfernung, Memory-Kill", () => {
  const rt = getLiveGateRuntime(env);
  const seed = seedState(env, VENUE, "MARKET_DATA_OK");
  assert.ok(rt.store.fileFor(VENUE).endsWith("venue-BITUNIX.json"));
  rt.store.clearMemoryCacheForTests();
  assert.equal(rt.store.read(VENUE).state, "MARKET_DATA_OK", "Lesen muss nach Cache-Reset von der Platte kommen");
  rt.store.removeForTests(VENUE);
  assert.equal(rt.store.read(VENUE).state, "DISCONNECTED", "Ohne State-File gilt fail-safe DISCONNECTED");

  rt.killedMemory.add("*");
  const kill = rt.isKilled(VENUE);
  assert.ok(kill, "Memory-Kill muss sofort wirken");
  assert.equal(kill?.scope, "*");
  rt.killedMemory.delete("*");

  resetLiveGateRuntimesForTests();
  assert.notEqual(getLiveGateRuntime(env), rt, "Reset muss eine neue Runtime erzeugen");
  assert.equal(seed.venue, VENUE);
});
