/**
 * ASA-06 — Cross-Prozess-Verhalten der Live-Gate-Audit-Kette.
 *
 * Der Web-Server (`next start`), die CLI (`npm run live:kill`) und der
 * `micro-executor` schreiben dieselbe `audit-log.ndjson`. Diese Suite prüft die
 * Synchronisation über die Datei (Lock-Datei, Byte-Offset, Dateischwanz als
 * Wahrheit) sowie den `verifyAuditChain()`-Cache — ohne echte zweite Prozesse
 * zu starten, aber mit exakt denselben Datei-Zuständen, die ein zweiter
 * Prozess hinterlässt (verwaistes Lock, Torn Write, Truncation, Fremdzeile).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  AUDIT_LOCK_STALE_MS,
  LiveGateAudit,
  resetAuditChainCacheForTests,
  verifyAuditChain,
  type LiveGateAuditEntry,
  type LiveGateAuditInput,
} from "../src/live-gate";

const entry = (reason: string): LiveGateAuditInput => ({
  actor: "admin",
  venue: "BITUNIX",
  from: null,
  to: null,
  action: "advance",
  result: "OK",
  reason,
});

/** Führt `fn` in einem frischen Temp-Verzeichnis aus und räumt danach auf. */
function withDir(fn: (dir: string, file: string, lock: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), "live-gate-audit-sync-"));
  const file = path.join(dir, "audit-log.ndjson");
  try {
    resetAuditChainCacheForTests();
    fn(dir, file, `${file}.lock`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    resetAuditChainCacheForTests();
  }
}

/** Eine tote PID (Kindprozess beendet) — simuliert einen abgestürzten Schreiber. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "0"], { stdio: "ignore" });
  return child.pid ?? 999_999;
}

/** Alle parsebaren Audit-Zeilen (Fremd-Müll wird für die Assertions ignoriert). */
const lines = (file: string): LiveGateAuditEntry[] =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as LiveGateAuditEntry];
      } catch {
        return [];
      }
    });

test("Audit-Sync: zwei Instanzen schreiben abwechselnd eine lückenlose Kette", () => {
  withDir((dir, file) => {
    const web = new LiveGateAudit(dir);
    const cli = new LiveGateAudit(dir);
    for (let i = 1; i <= 12; i++) {
      const written = (i % 2 === 0 ? cli : web).append(entry(`Eintrag ${i}`));
      assert.equal(written.seq, i);
    }
    const verification = verifyAuditChain(dir);
    assert.equal(verification.ok, true, verification.problem ?? "Kette gebrochen");
    assert.equal(verification.entries, 12);
    assert.deepEqual(
      lines(file).map((e) => e.seq),
      Array.from({ length: 12 }, (_, i) => i + 1)
    );
    // Kein Lock-Rest nach erfolgreichen Appends.
    assert.equal(existsSync(`${file}.lock`), false);
  });
});

test("Audit-Sync: verwaistes Lock (tote PID) wird entfernt und der Append läuft weiter", () => {
  withDir((dir, file, lock) => {
    const audit = new LiveGateAudit(dir);
    assert.equal(audit.append(entry("vor dem Crash")).seq, 1);
    // Absturz-Simulation: Lock-Datei mit toter PID bleibt liegen.
    writeFileSync(lock, String(deadPid()), "utf8");
    const started = Date.now();
    const next = audit.append(entry("nach dem Crash"));
    assert.equal(next.seq, 2, "Stale-Lock darf den Append nicht blockieren");
    assert.ok(Date.now() - started < AUDIT_LOCK_STALE_MS, "Stale-Recovery muss sofort greifen");
    assert.equal(existsSync(lock), false);
    assert.equal(verifyAuditChain(dir).ok, true);
    assert.equal(lines(file).length, 2);
  });
});

test("Audit-Sync: Lock älter als AUDIT_LOCK_STALE_MS gilt als verwaist", () => {
  withDir((dir, file, lock) => {
    const audit = new LiveGateAudit(dir);
    audit.append(entry("Zeile 1"));
    // Frische PID, aber Uralt-Zeitstempel ⇒ Alterskriterium greift.
    writeFileSync(lock, String(process.pid), "utf8");
    const old = new Date(Date.now() - AUDIT_LOCK_STALE_MS - 5_000);
    utimesSync(lock, old, old);
    const next = audit.append(entry("Zeile 2"));
    assert.equal(next.seq, 2);
    assert.equal(existsSync(lock), false);
    assert.equal(verifyAuditChain(dir).entries, 2);
    assert.equal(file.length > 0, true);
  });
});

test("Audit-Sync: lebendes fremdes Lock blockiert nur bis zum Timeout (kein Eintragsverlust)", () => {
  withDir((dir, file, lock) => {
    const audit = new LiveGateAudit(dir);
    audit.append(entry("Zeile 1"));
    // Ein lebender Prozess hält das Lock (frischer Zeitstempel, eigene PID).
    writeFileSync(lock, String(process.pid), "utf8");
    const started = Date.now();
    const next = audit.append(entry("Zeile 2"));
    assert.ok(Date.now() - started >= 1_000, "der Append muss auf das Lock warten");
    assert.equal(next.seq, 2, "nach dem Timeout wird best-effort geschrieben");
    unlinkSync(lock);
    assert.equal(verifyAuditChain(dir).ok, true);
  });
});

test("Audit-Sync: halb geschriebene letzte Zeile wird abgeschnitten statt zu verkleben", () => {
  withDir((dir, file) => {
    const audit = new LiveGateAudit(dir);
    audit.append(entry("vollständig"));
    // Torn Write eines abgestürzten Schreibers (kein Zeilenumbruch).
    appendFileSync(file, '{"seq":2,"ts":"2026-', "utf8");
    const next = audit.append(entry("nach Torn Write"));
    assert.equal(next.seq, 2, "Seq muss auf dem letzten vollständigen Eintrag aufsetzen");
    const parsed = lines(file);
    assert.equal(parsed.length, 2, "das Fragment darf keine dritte (unparsebare) Zeile erzeugen");
    assert.equal(parsed[1].reason, "nach Torn Write");
    assert.equal(verifyAuditChain(dir).ok, true);
  });
});

test("Audit-Sync: Datei mit reinem Fragment ohne Zeilenumbruch wird zurückgesetzt", () => {
  withDir((dir, file) => {
    writeFileSync(file, "GARBAGE-OHNE-NEWLINE", "utf8");
    const audit = new LiveGateAudit(dir);
    const first = audit.append(entry("Neustart"));
    assert.equal(first.seq, 1);
    const parsed = lines(file);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].reason, "Neustart");
    assert.equal(verifyAuditChain(dir).ok, true);
  });
});

test("Audit-Sync: unparsebare Fremdzeile wird übersprungen, gültiger Schwanz übernommen", () => {
  withDir((dir, file) => {
    const audit = new LiveGateAudit(dir);
    audit.append(entry("Zeile 1"));
    const valid = audit.append(entry("Zeile 2"));
    // Ein fremder Schreiber hängt Müll und eine Zeile ohne seq/hash an.
    appendFileSync(file, "{KEIN-JSON\n", "utf8");
    appendFileSync(file, `${JSON.stringify({ ts: "2026-10-28T00:00:00.000Z" })}\n`, "utf8");
    const next = audit.append(entry("Zeile 3"));
    // Der gültige Dateischwanz bleibt Zeile 2 ⇒ Seq 3 mit ihrem Hash als prevHash.
    assert.equal(next.seq, 3);
    assert.equal(next.prevHash, valid.hash);
    assert.equal(lines(file).at(-1)?.reason, "Zeile 3");
  });
});

test("Audit-Sync: Kettenlücke eines anderen Schreibers wird übernommen und gewarnt", () => {
  withDir((dir, file) => {
    const audit = new LiveGateAudit(dir);
    audit.append(entry("Zeile 1"));
    // Fremder Schreiber mit gebrochener Kette (Seq-Sprung, falscher prevHash).
    const foreign: LiveGateAuditEntry = {
      seq: 7,
      ts: "2026-10-28T00:00:00.000Z",
      actor: "cli:live-kill",
      venue: "*",
      from: null,
      to: "DISABLED",
      action: "kill",
      result: "KILLED",
      reason: "fremde Zeile",
      policyVersion: "live-gate-policy/1",
      prevHash: "f".repeat(64),
      hash: "e".repeat(64),
    };
    appendFileSync(file, `${JSON.stringify(foreign)}\n`, "utf8");
    const next = audit.append(entry("nach Lücke"));
    assert.equal(next.seq, 8, "Monotonie folgt dem Dateischwanz, nicht dem RAM-Kopf");
    assert.equal(next.prevHash, foreign.hash);
    assert.equal(audit.chainHead()?.seq, 8);
    // Der Bruch bleibt sichtbar — wir heilen die Vergangenheit nicht.
    assert.equal(verifyAuditChain(dir).ok, false);
  });
});

test("Audit-Sync: schrumpfende Datei (Rotation) wird vollständig neu verifiziert", () => {
  withDir((dir, file) => {
    const audit = new LiveGateAudit(dir);
    for (let i = 1; i <= 4; i++) audit.append(entry(`Zeile ${i}`));
    // Rotation/Truncation durch einen zweiten Prozess: nur die ersten 2 Zeilen.
    const kept = lines(file).slice(0, 2).map((e) => JSON.stringify(e));
    writeFileSync(file, `${kept.join("\n")}\n`, "utf8");
    const next = audit.append(entry("nach Rotation"));
    assert.equal(next.seq, 3, "der Kopf folgt der geschrumpften Datei");
    assert.equal(next.prevHash, JSON.parse(kept[1]).hash);
    assert.equal(verifyAuditChain(dir).ok, true);
    assert.equal(lines(file).length, 3);
  });
});

test("Audit-Sync: nicht anlegbares Verzeichnis bricht nichts (Ring bleibt Wahrheit)", () => {
  const base = mkdtempSync(path.join(tmpdir(), "live-gate-audit-blocked-"));
  try {
    const blocker = path.join(base, "kein-verzeichnis");
    writeFileSync(blocker, "x", "utf8");
    const audit = new LiveGateAudit(blocker);
    const first = audit.append(entry("im RAM"));
    const second = audit.append(entry("weiter im RAM"));
    assert.deepEqual([first.seq, second.seq], [1, 2]);
    assert.equal(audit.recent(1)[0].reason, "weiter im RAM");
    assert.equal(verifyAuditChain(blocker).ok, true, "fehlende Datei = leere, gültige Kette");
  } finally {
    rmSync(base, { recursive: true, force: true });
    resetAuditChainCacheForTests();
  }
});

test("Audit-Cache: Treffer liefert Kopien, jede Dateiänderung invalidiert", () => {
  withDir((dir, file) => {
    const audit = new LiveGateAudit(dir);
    audit.append(entry("Zeile 1"));
    audit.append(entry("Zeile 2"));
    const first = verifyAuditChain(dir);
    assert.equal(first.ok, true);
    const signature = statSync(file);
    const cached = verifyAuditChain(dir);
    assert.deepEqual(cached, first);
    assert.notEqual(cached.head, first.head, "Cache-Treffer muss eine Kopie liefern");
    assert.equal(statSync(file).mtimeMs, signature.mtimeMs, "Cache-Treffer liest die Datei nicht");

    // Manipulation mit identischer Länge (nur mtimeMs/ctimeMs ändern sich).
    // Der explizit gesetzte Zeitstempel simuliert eine spätere Änderung auch auf
    // Dateisystemen mit grober mtime-Auflösung (der Cache prüft size, mtimeMs,
    // ctimeMs und ino — jede sichtbare Änderung invalidiert ihn).
    const original = readFileSync(file, "utf8");
    const patched = original.replace("Zeile 2", "Zeile 9");
    writeFileSync(file, patched, "utf8");
    const later = new Date(Date.now() + 5_000);
    utimesSync(file, later, later);
    assert.equal(statSync(file).size, original.length);
    const tampered = verifyAuditChain(dir);
    assert.equal(tampered.ok, false);
    assert.equal(tampered.firstBrokenSeq, 2);

    // Cache ist kein Zustand: nach Reparatur ist die Kette wieder gültig.
    writeFileSync(file, original, "utf8");
    assert.equal(verifyAuditChain(dir).ok, true);
    assert.equal(existsSync(`${file}.lock`), false);
  });
});
