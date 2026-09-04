/**
 * S1 (v1.36.18) — Audit-Zuverlässigkeit: Sicherheits-Audits dürfen nicht still
 * verschwinden; Best-Effort-Pfade loggen und zählen mindestens.
 *
 * Abgedeckte Akzeptanzkriterien des Audit-Prompts:
 *   1. `security`-Audit mit fehlschlagendem Insert → Retry mit Backoff, dann
 *      persistenter Spool (at-least-once), CRITICAL-Meldung, Metrik.
 *   2. `telemetry`-Audit → ein Versuch, kein Wurf, aber Warnung + Zähler
 *      (nie ein leeres catch).
 *   3. Totalverlust (DB **und** Spool schreibgeschützt) bei `failClosed` →
 *      `AuditPersistenceError`; die sicherheitsrelevante Mutation bleibt aus.
 *   4. dokumentierter Trade-off Agents-Route: Prompt wird gespeichert, die
 *      Lücke aber gemeldet (CRITICAL + Missed-Audit-Zähler + Response-Warnung).
 *   5. Kill-Switch-Disarm: fail-closed — ohne durable Audit bleibt der
 *      Not-Halt aktiv (kein Disarm).
 *   6. Nachzug (at-least-once) und Quarantäne für Giftzeilen.
 *   7. Architekturwächter: keine stillen Audit-catch-Blöcke in den
 *      sicherheitsrelevanten Audit-Modulen.
 *
 * Kein echtes PostgreSQL: die DB-Senke wird über `setAuditTransportForTests`
 * bzw. einen Fake in `globalThis.__arenaNextJsPostgresqlDb` gesteuert, der
 * Spool zeigt in ein temporäres Verzeichnis.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  AUDIT_QUARANTINE_FILE_NAME,
  AUDIT_SPOOL_FILE_NAME,
  AuditPersistenceError,
  auditDurabilitySnapshot,
  drainAuditSpool,
  flagMissedAudit,
  missedAuditCount,
  pendingAuditCount,
  readPendingAudits,
  resetAuditDurabilityForTests,
  setAuditSleepForTests,
  setAuditTransportForTests,
  writeAuditRecord,
  type AuditRow,
} from "../src/lib/auditSink";
import { setStructuredLogSinkForTests, type StructuredLogEntry } from "../src/lib/logger";
import { telemetry } from "../src/lib/telemetry";
import { agents as agentsTable, auditLog } from "../src/db/schema";
import { recordBitunixPrivateCall, readBitunixAuditDegradedCount, clearBitunixPrivateAuditForTests, readBitunixPrivateAudit } from "../src/brokers/bitunix/audit";

// ── Infrastruktur für Tests ─────────────────────────────────────────────────

const dirs: string[] = [];
const G = globalThis as typeof globalThis & {
  __arenaNextJsPostgresqlDb?: unknown;
};

let previousDb: unknown = undefined;
const previousEnv: Record<string, string | undefined> = {};

/** Frisches, beschreibbares Spool-Verzeichnis je Test. */
function spoolDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "s1-audit-spool-"));
  dirs.push(dir);
  return dir;
}

/**
 * Spool-Verzeichnis, das nicht anlegbar ist: die Datei steht dort, wo das
 * Verzeichnis sein müsste → `mkdir` schlägt fehl (ENOTDIR/EEXIST). Damit ist
 * der Totalverlust-Pfad deterministisch testbar.
 */
function unwritableSpoolDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "s1-audit-blocked-"));
  dirs.push(dir);
  const blocker = path.join(dir, "blocker");
  writeFileSync(blocker, "nicht-verzeichnis", "utf8");
  return path.join(blocker, "spool");
}

function snapshotFile(dir: string): string {
  return path.join(dir, AUDIT_SPOOL_FILE_NAME);
}

/** Zähler + Logzeilen, die ein Test auslösen will. */
let logged: StructuredLogEntry[] = [];
let dbRows: AuditRow[] = [];
let dbFailures = 0;

type Mode = "ok" | "throw" | "throwOnce";
let mode: Mode = "ok";

beforeEach(() => {
  for (const key of [
    "AUDIT_SPOOL_DIR",
    "AUDIT_RETRY_MAX",
    "AUDIT_RETRY_BASE_MS",
    "AUDIT_DB_COOLDOWN_MS",
    "AUTH_MODE",
    "FIRM_API_TOKEN",
    "FIRM_ADMIN_TOKEN",
    "FIRM_OPERATOR_TOKEN",
    "FIRM_VIEWER_TOKEN",
    "FIRM_RATE_LIMIT",
  ]) {
    previousEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.AUDIT_SPOOL_DIR = spoolDir();
  // Deterministisch und schnell: ein Retry, ohne echte Wartezeit.
  process.env.AUDIT_RETRY_MAX = "1";
  process.env.AUDIT_RETRY_BASE_MS = "5";
  process.env.AUDIT_DB_COOLDOWN_MS = "0";
  process.env.AUTH_MODE = "local-open";
  process.env.FIRM_RATE_LIMIT = "0";

  previousDb = G.__arenaNextJsPostgresqlDb;
  delete G.__arenaNextJsPostgresqlDb;

  resetAuditDurabilityForTests();
  telemetry.marketData.fetchFailures.reset();
  clearBitunixPrivateAuditForTests();
  logged = [];
  dbRows = [];
  dbFailures = 0;
  mode = "ok";
  setStructuredLogSinkForTests((entry) => {
    logged.push(entry);
  });
  setAuditSleepForTests(async () => {});
  setAuditTransportForTests(async (row) => {
    if (mode === "throw" || (mode === "throwOnce" && dbFailures === 0)) {
      dbFailures += 1;
      throw new Error("forced audit insert failure (S1-Test)");
    }
    dbFailures += 1;
    dbRows.push(row);
  });
});

afterEach(() => {
  setStructuredLogSinkForTests(null);
  resetAuditDurabilityForTests();
  delete G.__arenaNextJsPostgresqlDb;
  if (previousDb !== undefined) G.__arenaNextJsPostgresqlDb = previousDb;
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// ── 1. security-Klasse: Retry + persistenter Fallback, nie still ────────────

test("S1 security-Audit: DB-Fehler retryt und landet durable im Spool (mit Alarm + Metrik)", async () => {
  mode = "throw";
  const outcome = await writeAuditRecord({
    event: "CREDENTIAL_SAVED",
    level: "CRITICAL",
    detail: { venue: "BITUNIX", actor: "admin" },
    auditClass: "security",
  });

  // Retry mit Backoff: 1 Versuch + AUDIT_RETRY_MAX=1 → 2 Versuche.
  assert.equal(dbFailures, 2, "erster Versuch + ein Retry");
  // Nicht still: Ergebnis ist als degradiert gekennzeichnet und gemeldet.
  assert.equal(outcome.durable, true, "durable — wenn auch (noch) nicht in der DB");
  assert.equal(outcome.target, "spool");
  assert.equal(outcome.degraded, true);
  assert.equal(outcome.flagged, true);

  // Persistenter Fallback existiert wirklich und trägt den Originalinhalt.
  const file = snapshotFile(process.env.AUDIT_SPOOL_DIR!);
  assert.ok(existsSync(file), "audit-pending.ndjson muss als Beleg angelegt sein");
  const line = readFileSync(file, "utf8").trim();
  const parsed = JSON.parse(line) as AuditRow & { auditClass: string };
  assert.equal(parsed.event, "CREDENTIAL_SAVED");
  assert.equal(parsed.level, "CRITICAL");
  assert.deepEqual(parsed.detail, { venue: "BITUNIX", actor: "admin" });
  assert.equal(parsed.auditClass, "security");
  assert.equal(pendingAuditCount(), 1);

  // Alarm + Metrik (das ist der Unterschied zum stillen catch).
  const alert = logged.find((e) => e.event === "audit_write_degraded");
  assert.ok(alert, "CRITICAL-Meldung audit_write_degraded fehlt");
  assert.equal(alert!.level, "critical");
  assert.equal(telemetry.audit.writeFailures.byLabel()["auditClass=security,stage=db"], 2);
  assert.equal(telemetry.audit.spooled.total(), 1);

  const snap = auditDurabilitySnapshot();
  assert.equal(snap.spooled, 1);
  assert.equal(snap.pending, 1);
  assert.equal(snap.lost, 0, "kein Verlust, solange der Spool schreibt");
});

// ── 2. telemetry-Klasse: best-effort, aber mit Warnung + Metrik ─────────────

test("S1 telemetry-Audit: ein Versuch, kein Wurf, aber Warnung und Zähler", async () => {
  mode = "throw";
  const outcome = await writeAuditRecord({
    event: "FEED_FAILOVER",
    level: "WARN",
    detail: { instrumentId: "BITUNIX:BTCUSDT", reason: "timeout" },
    auditClass: "telemetry",
  });

  assert.equal(dbFailures, 1, "Telemetrie retryt nicht (kein Backoff auf dem Kurspfad)");
  assert.equal(outcome.durable, false);
  assert.equal(outcome.flagged, true, "aber nie still");
  assert.equal(
    existsSync(snapshotFile(process.env.AUDIT_SPOOL_DIR!)),
    false,
    "Telemetrie füllt den Sicherheits-Spool nicht zu"
  );
  const warn = logged.find((e) => e.event === "audit_telemetry_dropped");
  assert.ok(warn, "Warnung audit_telemetry_dropped fehlt");
  assert.equal(warn!.level, "warn");
  assert.equal(telemetry.audit.writeFailures.byLabel()["auditClass=telemetry,stage=db"], 1);
  assert.equal(telemetry.audit.missed.byLabel()["auditClass=telemetry,kind=dropped"], 1);
});

// ── 3. Totalverlust: fail-closed wirft, Mutation bleibt aus ──────────────────

test("S1 fail-closed: ohne DB und ohne Spool wirft das Audit — die Mutation bleibt aus", async () => {
  process.env.AUDIT_SPOOL_DIR = unwritableSpoolDir();
  mode = "throw";

  let mutationApplied = false;
  await assert.rejects(
    async () => {
      // Muster eines Sicherheitspfads: erst Beleg, dann Mutation.
      await writeAuditRecord({
        event: "KILL_SWITCH_DISARMED",
        level: "CRITICAL",
        detail: { actor: "admin", stage: "PRECHECK" },
        auditClass: "security",
        failClosed: true,
      });
      mutationApplied = true;
    },
    (e: unknown) => {
      assert.ok(e instanceof AuditPersistenceError, `AuditPersistenceError erwartet, kam: ${String(e)}`);
      assert.equal(e.code, "AUDIT_PERSISTENCE_FAILED");
      return true;
    }
  );

  assert.equal(mutationApplied, false, "fail-closed: ohne Auditbeleg wird nicht entschärft");
  assert.equal(auditDurabilitySnapshot().lost, 1);
  assert.equal(telemetry.audit.writeFailures.byLabel()["auditClass=security,stage=lost"], 1);
  assert.ok(
    logged.some((e) => e.event === "audit_write_lost" && e.level === "critical"),
    "Totalverlust muss eine CRITICAL-Zeile haben"
  );
});

// ── 4. dokumentierter Trade-off: Mutation zu, Lücke gemeldet ────────────────

test("S1 Trade-off-Meldung: flagMissedAudit zählt und loggt CRITICAL (kein Return ohne Spur)", () => {
  flagMissedAudit("AGENT_PROMPT_UPDATED", { agent: "CEO", reason: "audit nicht durable" });

  assert.equal(missedAuditCount(), 1);
  assert.equal(telemetry.audit.missed.byLabel()["auditClass=security,kind=flagged"], 1);
  const critical = logged.find((e) => e.event === "audit_missed_security");
  assert.ok(critical, "CRITICAL-Zeile audit_missed_security fehlt");
  assert.equal(critical!.level, "critical");
  assert.equal(critical!.fields.agent, "CEO");

  const recent = auditDurabilitySnapshot().recent;
  assert.equal(recent[0]?.path, "missed");
  assert.equal(recent[0]?.event, "AGENT_PROMPT_UPDATED");
});

// ── 5. at-least-once: Nachzug nach `audit_log`, Duplikat in Kauf ────────────

test("S1 at-least-once: Spool-Eintrag wird nach DB-Erholung nachgezogen", async () => {
  mode = "throw";
  await writeAuditRecord({ event: "ORDER_REJECTED", level: "WARN", detail: { reason: "KILL_SWITCH_ARMED" }, auditClass: "security" });
  await writeAuditRecord({ event: "PROPOSAL_APPROVED", level: "INFO", detail: { proposalId: "p-1" }, auditClass: "security" });
  assert.equal(pendingAuditCount(), 2);

  // DB ist wieder da.
  mode = "ok";
  const drained = await drainAuditSpool();
  assert.equal(drained.written, 2);
  assert.equal(drained.ok, true);
  assert.equal(pendingAuditCount(), 0, "nach erfolgreichem Nachzug ist der Spool leer");
  assert.deepEqual(
    dbRows.map((r) => r.event),
    ["ORDER_REJECTED", "PROPOSAL_APPROVED"],
    "Reihenfolge bleibt erhalten"
  );
  assert.equal(auditDurabilitySnapshot().drained, 2);
  assert.equal(telemetry.audit.spoolDrained.byLabel()["result=ok"], 2);
});

test("S1 Giftzeile: eine abgelehnte Zeile blockiert den Nachzug nicht dauerhaft", async () => {
  process.env.AUDIT_SPOOL_DIR = spoolDir();
  mode = "throw";
  await writeAuditRecord({ event: "BROKER_CONTROL_PLANE", level: "INFO", detail: { action: "credential.saved" }, auditClass: "security" });
  assert.equal(pendingAuditCount(), 1);

  // Die DB lehnt genau diese Zeile dauerhaft ab (z. B. FK-Verletzung), alles
  // andere würde durchgehen: ohne Quarantäne stünde der Spool für immer zu.
  mode = "ok";
  setAuditTransportForTests(async (row) => {
    if (row.event === "BROKER_CONTROL_PLANE") throw new Error("23503 foreign key audit_log_agent_id_fkey");
    dbRows.push(row);
  });
  let result = await drainAuditSpool();
  assert.equal(result.ok, false, "erster Versuch: Zeile bleibt, Nachzug stoppt");
  assert.equal(pendingAuditCount(), 1);
  result = await drainAuditSpool();
  assert.equal(result.ok, false);
  result = await drainAuditSpool();

  assert.equal(result.quarantined, 1, "nach 3 Versuchen wandert die Zeile in die Quarantäne");
  assert.equal(pendingAuditCount(), 0, "der Nachzug ist nicht dauerhaft blockiert");
  const quarantine = path.join(process.env.AUDIT_SPOOL_DIR!, AUDIT_QUARANTINE_FILE_NAME);
  assert.ok(existsSync(quarantine), "Quarantänedatei enthält den Beleg — nichts verloren");
  assert.match(readFileSync(quarantine, "utf8"), /foreign key/);
});

// ── 6. gebündelte Alarme bei Lärm, lückenlose Zählung ────────────────────────

test("S1 Alarm-Bündelung: jeder Fehler zählt, die Logzeile kommt gebündelt", async () => {
  mode = "throw";
  for (let i = 0; i < 5; i++) {
    await writeAuditRecord({ event: "BITUNIX_PRIVATE_CALL", level: "WARN", detail: { i }, auditClass: "security" });
  }
  const snap = auditDurabilitySnapshot();
  assert.equal(snap.pending, 5, "alle fünf Belege sind im Spool — keiner verschluckt");
  assert.ok(snap.dbFailures >= 5);
  const degraded = logged.filter((e) => e.event === "audit_write_degraded");
  assert.equal(degraded.length, 1, "Logzeile wird im Fenster gebündelt (kein Log-DoS)");
  assert.equal(telemetry.audit.spooled.total(), 5);
});

// ── 7. Bitunix-Venue-Audit: Call-Pfad läuft weiter, Lücke ist gemeldet ──────

test("S1 Bitunix: Venue-Audit ohne DB — Ring voll, degradiert gezählt, kein Throw im Pfad", async () => {
  mode = "throw";
  clearBitunixPrivateAuditForTests();
  const outcome = await recordBitunixPrivateCall({
    method: "POST",
    path: "/api/v1/order",
    outcome: "DENIED",
    errorCode: "AUTH_FAILED",
  });

  assert.equal(outcome.target, "spool", "Beleg ist persistent, nicht weg");
  assert.equal(outcome.degraded, true);
  assert.equal(readBitunixPrivateAudit(5).length, 1, "Ring bleibt als Sofort-View verfügbar");
  assert.equal(readBitunixAuditDegradedCount(), 1, "Prozess-Metrik des Venue-Audits");
  assert.equal(pendingAuditCount(), 1);
  const preview = readPendingAudits(5)[0] as AuditRow;
  assert.equal(preview.event, "BITUNIX_PRIVATE_CALL");
  assert.ok(JSON.stringify(preview).length < 8_000);
});

// ── 8/9. Route-Ebene: Prompt (flaggt) und Disarm (rollt back) ────────────────

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const MISSION_ID = "22222222-2222-4222-8222-222222222222";

interface FakeDbCalls {
  auditInserts: number;
  killSwitchInserts: number;
  promptWrites: number;
  missionUpdates: number;
}

/**
 * Fake-DB in `globalThis.__arenaNextJsPostgresqlDb` (der Singleton-Haken aus
 * `src/db/index.ts`), tabellenbewusst: Writes auf `audit_log` werfen (der
 * S1-Fall „Beleg nicht schreibbar“), die Mutationstabellen laufen durch.
 * So bleibt der Unterschied „fail-closed verhindert die Mutation“ vs.
 * „dokumentierter Trade-off speichert trotzdem“ messbar.
 */
function installFakeDb(calls: FakeDbCalls): void {
  const agentRow = {
    id: AGENT_ID,
    name: "CEO",
    role: "CEO",
    systemPrompt: "alter Prompt",
    status: "IDLE",
    updatedAt: new Date(),
  };
  const updatedRow = { ...agentRow, systemPrompt: "neuer Prompt — handle nur nach Mandat" };
  /** thenable + `returning()` — die Route awaited beides, je nach Pfad. */
  const result = (rows: unknown[]) => ({
    then: (resolve: (value: unknown[]) => void) => resolve(rows),
    returning: () => rows,
  });
  const fake = {
    select: () => ({ from: () => ({ where: () => [agentRow], limit: () => [agentRow] }) }),
    update: (table: unknown) => ({
      set: () => ({
        where: () => {
          if (table === agentsTable) {
            calls.promptWrites += 1;
            return result([updatedRow]);
          }
          calls.missionUpdates += 1;
          return result([{ ...agentRow, status: "PENDING" }]);
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (row: Record<string, unknown>) => {
        if (table === auditLog) {
          calls.auditInserts += 1;
          throw new Error("forced audit insert failure (S1-Route-Test)");
        }
        calls.killSwitchInserts += 1;
        return result([row]);
      },
    }),
  };
  G.__arenaNextJsPostgresqlDb = fake;
}

test("S1 Agents-Route: Prompt-Update trotz Audit-Totalverlust — gespeichert, aber gemeldet", async () => {
  const calls: FakeDbCalls = { auditInserts: 0, killSwitchInserts: 0, promptWrites: 0, missionUpdates: 0 };
  installFakeDb(calls);
  // Audit über den echten Pfad scheitern lassen (defaultTransport → Fake-DB).
  setAuditTransportForTests(null);
  process.env.AUDIT_SPOOL_DIR = unwritableSpoolDir();
  process.env.AUDIT_RETRY_MAX = "0";

  const { PUT } = await import("../src/app/api/firm/agents/route");
  const res = await PUT(
    new Request("http://localhost:3369/api/firm/agents", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: AGENT_ID, systemPrompt: "neuer Prompt — handle nur nach Mandat" }),
    })
  );
  const body = (await res.json()) as {
    ok: boolean;
    warnings?: string[];
    audit?: { durable: boolean; target: string; degraded: boolean };
  };

  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(calls.promptWrites, 1, "dokumentierter Trade-off: der Prompt wird gespeichert");
  assert.equal(calls.auditInserts, 1, "der Audit-Schreibversuch wurde unternommen");
  // …und die Lücke ist gemeldet statt still:
  assert.equal(body.audit?.durable, false);
  assert.equal(body.audit?.target, "none");
  assert.ok(
    (body.warnings ?? []).some((w) => /audit-/i.test(w) && /nicht persistent/i.test(w)),
    `warnings muss die Audit-Lücke nennen, kam: ${JSON.stringify(body.warnings)}`
  );
  assert.equal(missedAuditCount(), 1, "Missed-Audit-Zähler ist erhöht");
  assert.ok(
    logged.some((e) => e.event === "audit_missed_security" && e.level === "critical"),
    "CRITICAL-Alarm für die Prompt-Lücke fehlt"
  );
});

test("S1 Agents-Route: Spool-Reserve → Response meldet Nachzug (degraded, nicht verloren)", async () => {
  const calls: FakeDbCalls = { auditInserts: 0, killSwitchInserts: 0, promptWrites: 0, missionUpdates: 0 };
  installFakeDb(calls);
  setAuditTransportForTests(null);
  process.env.AUDIT_RETRY_MAX = "0";

  const { PUT } = await import("../src/app/api/firm/agents/route");
  const res = await PUT(
    new Request("http://localhost:3369/api/firm/agents", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId: AGENT_ID,
        systemPrompt: "neuer Prompt — nur Long bei Aufwärtstrend, Stop-Loss 5 %, sonst HOLD.",
      }),
    })
  );
  const body = (await res.json()) as { ok: boolean; warnings?: string[]; audit?: { degraded: boolean; target: string } };
  assert.equal(body.ok, true);
  assert.equal(body.audit?.target, "spool");
  assert.equal(body.audit?.degraded, true);
  assert.ok((body.warnings ?? []).some((w) => /nachgezogen/i.test(w)));
  assert.equal(missedAuditCount(), 0, "Spool = durable, also keine gemeldete Lücke");
  assert.equal(pendingAuditCount(), 1, "der Beleg wartet im Spool auf den Nachzug");
});

test("S1 Kill-Route: Disarm ohne durable Audit bleibt aus — Not-Halt bleibt aktiv", async () => {
  const calls: FakeDbCalls = { auditInserts: 0, killSwitchInserts: 0, promptWrites: 0, missionUpdates: 0 };
  installFakeDb(calls);
  setAuditTransportForTests(null);
  process.env.AUDIT_SPOOL_DIR = unwritableSpoolDir();
  process.env.AUDIT_RETRY_MAX = "0";

  const { killSwitch } = await import("../src/lib/riskGuard");
  const { issueDisarmNonce, resetDisarmNoncesForTests } = await import("../src/lib/disarmChallenge");
  resetDisarmNoncesForTests();
  const { nonce } = issueDisarmNonce(Date.now());

  killSwitch.pull("test:not-halt");
  try {
    const { POST } = await import("../src/app/api/firm/kill/route");
    const res = await POST(
      new Request("http://localhost:3369/api/firm/kill", {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": "local" },
        body: JSON.stringify({ arm: false, nonce, reason: "S1-test" }),
      })
    );
    const body = (await res.json()) as { ok: boolean; error?: string };
    assert.equal(res.status, 503);
    assert.equal(body.error, "AUDIT_PERSISTENCE_FAILED");
    assert.equal(killSwitch.isArmed(), true, "fail-closed: ohne Auditbeleg bleibt der Not-Halt aktiv");
    assert.equal(calls.missionUpdates, 0, "kein Missions-Reset — die Mutation blieb aus");
    assert.equal(calls.killSwitchInserts, 0, "kein kill_switches-Insert — die Mutation blieb aus");
    assert.equal(missedAuditCount(), 1, "der verhinderte Disarm ist gemeldet");
  } finally {
    killSwitch.disarm();
    resetDisarmNoncesForTests();
  }
});

test("S1 Kill-Route: Arm wird durch einen Auditfehler NICHT blockiert (sichere Richtung)", async () => {
  const calls: FakeDbCalls = { auditInserts: 0, killSwitchInserts: 0, promptWrites: 0, missionUpdates: 0 };
  installFakeDb(calls);
  setAuditTransportForTests(null);
  process.env.AUDIT_SPOOL_DIR = unwritableSpoolDir();
  process.env.AUDIT_RETRY_MAX = "0";

  const { killSwitch } = await import("../src/lib/riskGuard");
  killSwitch.disarm();
  try {
    const { POST } = await import("../src/app/api/firm/kill/route");
    const res = await POST(
      new Request("http://localhost:3369/api/firm/kill", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ arm: true, reason: "S1-test-arm" }),
      })
    );
    const body = (await res.json()) as { ok: boolean; audit?: { durable: boolean; target: string } };
    assert.equal(res.status, 200, "Scharfschalten darf nicht am Audit scheitern");
    assert.equal(killSwitch.isArmed(), true);
    assert.equal(calls.killSwitchInserts, 1, "die Kill-Switch-Zeile wurde geschrieben");
    assert.equal(body.audit?.durable, false, "die Audit-Lücke steht im Response-Body");
    assert.equal(missedAuditCount(), 1, "…und ist als Missed-Audit gezählt");
    assert.ok(logged.some((e) => e.event === "audit_missed_security" && e.level === "critical"));
  } finally {
    killSwitch.disarm();
  }
});

// ── 10. Architekturwächter: keine stillen Audit-catch-Blöcke ────────────────

test("S1 Architektur: sicherheitsrelevante Audit-Module enthalten kein stilles catch", async () => {
  const { readFileSync } = await import("node:fs");
  const files = [
    "src/brokers/bitunix/audit.ts",
    "src/brokers/alpaca/audit.ts",
    "src/brokers/audit.ts",
    "src/brokers/control-plane/audit.ts",
    "src/app/api/firm/agents/route.ts",
    "src/app/api/firm/missions/route.ts",
    "src/lib/auditSink.ts",
  ];
  // Leeres catch oder catch mit ausschließlich-Kommentar-Body (das alte Muster
  // `} catch { /* best-effort */ }`) ist in diesen Dateien nicht mehr erlaubt.
  const swallow = /catch\s*(?:\([^)]*\))?\s*\{\s*(?:\/\*[\s\S]*?\*\/|\/\/[^\n]*(?:\n\s*\/\/[^\n]*)*\s*)*\}/g;
  for (const rel of files) {
    const source = readFileSync(path.join(process.cwd(), rel), "utf8");
    const offenders = [...source.matchAll(swallow)].map(
      (m) => `${rel}:${source.slice(0, m.index ?? 0).split("\n").length}`
    );
    assert.deepEqual(offenders, [], `${rel} enthält stille catch-Blöcke: ${offenders.join(", ")}`);
    if (rel !== "src/lib/auditSink.ts") {
      assert.match(source, /auditSink/, `${rel} muss die klassifizierte Audit-Senke nutzen`);
    }
  }
});
