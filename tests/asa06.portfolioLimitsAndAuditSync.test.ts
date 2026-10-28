/**
 * ASA-06 — Regression-Gates für die beiden HIGH-Befunde:
 *
 * 1. **Portfolio-DoS:** `POST /api/portfolio/optimize` verlangt bei aktivem
 *    Token-Auth ein Credential (401 ohne) und weist Rechenparameter oberhalb
 *    des API-Budgets (`maxIterations > 2_000`, `maxAdjustmentRounds > 10`) mit
 *    HTTP 400 ab — statt den Node.js-Event-Loop zu blockieren.
 * 2. **LiveGateAudit-Ketten-Split:** Zwei unabhängige `LiveGateAudit`-Instanzen
 *    auf derselben Datei (Simulation von Web-Server + CLI `npm run live:kill`)
 *    halten `seq`/`prevHash` über die Datei synchron; zusätzlich invalidiert
 *    jede Dateiänderung den `verifyAuditChain()`-Cache zuverlässig.
 *
 * Die Tests laufen ohne Datenbank und ohne Netzwerk direkt gegen die Handler.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { POST as optimizePOST } from "../src/app/api/portfolio/optimize/route";
import { POST as correlationPOST } from "../src/app/api/portfolio/correlation/route";
import { POST as metricsPOST } from "../src/app/api/portfolio/metrics/route";
import { PORTFOLIO_API_LIMITS, PORTFOLIO_LIMITS } from "../src/portfolio/config";
import { resetRateLimiterForTests } from "../src/lib/apiAuth";
import { LiveGateAudit, verifyAuditChain, type LiveGateAuditEntry } from "../src/live-gate/audit";
import { blockReturns, seriesFrom } from "./fixtures/portfolioFixtures";

const ENV_KEYS = ["FIRM_API_TOKEN", "FIRM_ADMIN_TOKEN", "AUTH_MODE", "FIRM_RATE_LIMIT"] as const;
const savedEnv = new Map<string, string | undefined>();

before(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
});
after(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetRateLimiterForTests();
});

/** Serien für die Optimierung (drei unabhängige Blöcke à zwei Assets). */
function payloadSeries(count = 4, periods = 60) {
  return seriesFrom(blockReturns(2, 2, periods, 4242), "P")
    .slice(0, count)
    .map((s) => ({ symbol: s.symbol, logReturns: s.logReturns as number[] }));
}

/** POST-Helfer mit den für den Guard nötigen Headern. */
function post(url: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost:3369${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

// ── 1) Portfolio: Auth + Rechenbudget ───────────────────────────────────────

test("ASA-06: optimize weist unauthentifizierte Aufrufe bei aktivem Token-Auth mit 401 ab", async () => {
  resetRateLimiterForTests();
  process.env.FIRM_API_TOKEN = "asa06-secret-token";
  delete process.env.AUTH_MODE; // kein local-open ⇒ Token ist Pflicht
  try {
    const res = await optimizePOST(post("/api/portfolio/optimize", { series: payloadSeries(), mode: "min_variance" }));
    assert.equal(res.status, 401, "ohne x-firm-token darf optimize nicht rechnen");
    const body = (await res.json()) as { ok: boolean; error?: string };
    assert.equal(body.ok, false);
  } finally {
    delete process.env.FIRM_API_TOKEN;
    resetRateLimiterForTests();
  }
});

test("ASA-06: optimize weist maxIterations > 2.000 und maxAdjustmentRounds > 10 mit 400 ab", async () => {
  resetRateLimiterForTests();
  process.env.FIRM_API_TOKEN = "asa06-secret-token";
  const headers = { "x-firm-token": "asa06-secret-token" };
  try {
    const tooManyIterations = await optimizePOST(
      post("/api/portfolio/optimize", { series: payloadSeries(), mode: "min_variance", solver: { maxIterations: 50_000 } }, headers)
    );
    assert.equal(tooManyIterations.status, 400, "maxIterations = 50.000 muss 400 liefern");
    const iterationBody = (await tooManyIterations.json()) as { ok: boolean; error: string; field?: string };
    assert.equal(iterationBody.ok, false);
    assert.equal(iterationBody.error, "INVALID_INPUT");
    assert.equal(iterationBody.field, "solver.maxIterations");

    const tooManyRounds = await optimizePOST(
      post(
        "/api/portfolio/optimize",
        { series: payloadSeries(), mode: "min_variance", guard: { maxAdjustmentRounds: 11 } },
        headers
      )
    );
    assert.equal(tooManyRounds.status, 400, "maxAdjustmentRounds = 11 muss 400 liefern");
    assert.equal(((await tooManyRounds.json()) as { field?: string }).field, "guard.maxAdjustmentRounds");

    // Genau an der Grenze bleibt die Anfrage gültig (kein Off-by-one).
    const atLimit = await optimizePOST(
      post(
        "/api/portfolio/optimize",
        {
          series: payloadSeries(),
          mode: "min_variance",
          solver: { maxIterations: PORTFOLIO_API_LIMITS.maxIterations },
          guard: { maxAdjustmentRounds: PORTFOLIO_API_LIMITS.maxAdjustmentRounds },
        },
        headers
      )
    );
    assert.ok([200, 422].includes(atLimit.status), `Grenzwert muss rechnen, war ${atLimit.status}`);
  } finally {
    delete process.env.FIRM_API_TOKEN;
    resetRateLimiterForTests();
  }
});

test("ASA-06: correlation/metrics verlangen firm.read und lehnen überlange Serien ab", async () => {
  resetRateLimiterForTests();
  const series = payloadSeries(2, 20);
  // Ohne Auth (kein local-open): 401 statt Rechenzeit.
  process.env.FIRM_API_TOKEN = "asa06-secret-token";
  delete process.env.AUTH_MODE;
  try {
    for (const [name, handler] of [
      ["correlation", correlationPOST],
      ["metrics", metricsPOST],
    ] as const) {
      const denied = await handler(post(`/api/portfolio/${name}`, { series }));
      assert.equal(denied.status, 401, `${name} ohne Credential`);
    }
    // Mit Credential, aber zu langer Serie → 413 (kein stilles Kürzen).
    const tooLong = await metricsPOST(
      post(
        "/api/portfolio/metrics",
        { series: [{ symbol: "AAA", returns: new Array(PORTFOLIO_LIMITS.maxSeriesLength + 1).fill(0.01) }] },
        { "x-firm-token": "asa06-secret-token" }
      )
    );
    assert.equal(tooLong.status, 413);
    assert.equal(((await tooLong.json()) as { error: string }).error, "LIMIT_EXCEEDED");
  } finally {
    delete process.env.FIRM_API_TOKEN;
    resetRateLimiterForTests();
  }
});

// ── 2) LiveGateAudit: Cross-Prozess-Synchronisation ─────────────────────────

test("ASA-06: zwei LiveGateAudit-Instanzen halten seq/prevHash über die Datei synchron", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "asa06-audit-"));
  try {
    // Instanz A = Web-Server, Instanz B = CLI (`npm run live:kill`).
    const web = new LiveGateAudit(dir);
    const cli = new LiveGateAudit(dir);
    for (let i = 1; i <= 20; i++) {
      const writer = i % 2 === 0 ? cli : web;
      const entry = writer.append({
        actor: i % 2 === 0 ? "cli:live-kill" : "web:server",
        venue: "BITUNIX",
        from: null,
        to: null,
        action: i % 5 === 0 ? "kill" : "advance",
        result: "OK",
        reason: `Eintrag ${i}`,
      });
      assert.equal(entry.seq, i, `Seq muss lückenlos monoton sein (Eintrag ${i})`);
    }

    const verification = verifyAuditChain(dir);
    assert.equal(verification.ok, true, verification.problem ?? "Kette gebrochen");
    assert.equal(verification.entries, 20);
    assert.equal(verification.head?.seq, 20);

    // Datei ist die Wahrheit: 20 Zeilen, 20 lückenlose seq-Werte.
    const lines = readFileSync(path.join(dir, "audit-log.ndjson"), "utf8")
      .split("\n")
      .filter((line) => line.trim());
    assert.equal(lines.length, 20);
    const entries = lines.map((line) => JSON.parse(line) as LiveGateAuditEntry);
    assert.deepEqual(
      entries.map((e) => e.seq),
      Array.from({ length: 20 }, (_, i) => i + 1)
    );
    for (let i = 1; i < entries.length; i++) {
      assert.equal(entries[i].prevHash, entries[i - 1].hash, `prevHash von Seq ${i + 1} verweist nicht auf den Vorgänger`);
    }

    // Kein veralteter prevHash: Die nächste Zeile des Web-Servers übernimmt den
    // Dateischwanz der CLI (Seq 20) und schreibt Seq 21 — nicht Seq 20 doppelt.
    const next = web.append({
      actor: "web:server",
      venue: "BITUNIX",
      from: null,
      to: null,
      action: "advance",
      result: "OK",
      reason: "Nach CLI-Append",
    });
    assert.equal(next.seq, 21);
    assert.equal(next.prevHash, entries[19].hash, "prevHash muss auf den CLI-Eintrag zeigen");

    const afterCrossProcess = verifyAuditChain(dir);
    assert.equal(afterCrossProcess.ok, true, afterCrossProcess.problem ?? "Kette nach Prozesswechsel gebrochen");
    assert.equal(afterCrossProcess.entries, 21);
    assert.equal(web.chainHead()?.seq, 21);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ASA-06: verifyAuditChain cached nach (size, mtimeMs, ctimeMs, ino) und erkennt Manipulation", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "asa06-cache-"));
  try {
    const audit = new LiveGateAudit(dir);
    for (let i = 1; i <= 3; i++) {
      audit.append({ actor: "admin", venue: "*", from: null, to: null, action: "enforce", result: "DENIED", reason: `Zeile ${i}` });
    }
    const file = path.join(dir, "audit-log.ndjson");
    const first = verifyAuditChain(dir);
    assert.equal(first.ok, true);
    assert.equal(first.entries, 3);

    // Wiederholter Aufruf bei unveränderter Datei trifft den Cache — Ergebnis
    // bleibt identisch und unabhängig vom zurückgegebenen Objekt.
    const signatureBefore = statSync(file);
    const cached = verifyAuditChain(dir);
    assert.deepEqual(cached, first);
    assert.notEqual(cached.head, first.head, "Cache muss eine Kopie liefern (kein geteiltes Mutationsziel)");
    assert.equal(statSync(file).mtimeMs, signatureBefore.mtimeMs, "Cache-Treffer darf die Datei nicht anfassen");

    // Manipulation mit GLEICHER Länge (nur Bytes getauscht) → size bleibt
    // gleich, mtimeMs/ctimeMs ändern sich ⇒ Cache muss invalidieren.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const handle = await open(file, "r+");
    try {
      const original = readFileSync(file, "utf8");
      const offset = original.indexOf("Zeile 2");
      const patched = `Zeile 9${original.slice(offset + "Zeile 2".length)}`;
      await handle.write(Buffer.from(patched, "utf8"), 0, patched.length, offset);
    } finally {
      await handle.close();
    }
    assert.equal(statSync(file).size, signatureBefore.size, "Testbedingung: Dateigröße unverändert");

    const tampered = verifyAuditChain(dir);
    assert.equal(tampered.ok, false, "Manipulation muss trotz identischer Dateigröße erkannt werden");
    assert.equal(tampered.firstBrokenSeq, 2);
    assert.match(tampered.problem ?? "", /Hash-Abweichung/);

    // Neu aufgebaute Datei ⇒ der Cache liefert wieder `ok: true` (kein
    // "ewiges false" nach einer einmal erkannten Manipulation).
    rmSync(file, { force: true });
    const fresh = new LiveGateAudit(dir);
    fresh.append({ actor: "admin", venue: "*", from: null, to: null, action: "enforce", result: "DENIED", reason: "neu" });
    const recovered = verifyAuditChain(dir);
    assert.equal(recovered.ok, true);
    assert.equal(recovered.entries, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
