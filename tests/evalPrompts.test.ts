/**
 * Prompt-Eval-Harness (GAP-08, D2).
 *
 *   - Alle Golden-Fixtures werden ausgewertet (Offline-Modus, ohne Netz).
 *   - Eine kaputte Erwartung (Regression) führt zu Exit-Code ≠ 0.
 *   - Zwei Läufe liefern byte-identische Reports (Determinismus per Hash).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  evaluateFixture,
  loadGoldenFixtures,
  runCli,
  runEval,
} from "../scripts/eval-prompts";
import { loadPlausibilityConfig } from "../src/cycle/plausibility";

function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

test("Eval: alle Golden-Fixtures werden offline ausgewertet — keine Regression", async () => {
  const fixtures = loadGoldenFixtures();
  assert.ok(fixtures.length >= 12, `erwartet ≥ 12 Fixtures, erhalten ${fixtures.length}`);
  const ids = fixtures.map((f) => f.id);
  assert.deepEqual([...ids].sort(), ids, "Fixtures sind nach ID sortiert");

  const outDir = mkdtempSync(path.join(tmpdir(), "gap08-eval-"));
  const { report, jsonPath, mdPath } = await runEval({
    outDir,
    mode: "offline",
    env: { ...process.env },
  });
  assert.equal(report.mode, "offline");
  assert.equal(report.summary.total, fixtures.length);
  assert.equal(report.summary.failed, 0);
  assert.equal(report.summary.passed, fixtures.length);
  assert.equal(report.budgetNote, null);
  // Jede Fixture ist im Report vertreten (kein stilles Überspringen).
  assert.deepEqual(
    report.results.map((r) => r.id).sort(),
    ids,
  );
  assert.match(readFileSync(jsonPath, "utf8"), /"evalVersion": 1/);
  assert.match(readFileSync(mdPath, "utf8"), /Prompt-Eval-Report/);
});

test("Eval: kaputte Erwartung (Regression) → Exit-Code 1 + benannter Befund", async () => {
  const broken = mkdtempSync(path.join(tmpdir(), "gap08-eval-broken-"));
  cpSync("tests/fixtures/golden", broken, { recursive: true });
  const victim = path.join(broken, "research", "valid-long.json");
  const fixture = JSON.parse(readFileSync(victim, "utf8")) as {
    expect: { plausible: boolean; codes: string[] };
  };
  fixture.expect.plausible = false;
  fixture.expect.codes = ["MONOTONICITY"];
  writeFileSync(victim, `${JSON.stringify(fixture, null, 2)}\n`);

  const outDir = mkdtempSync(path.join(tmpdir(), "gap08-eval-broken-out-"));
  const exit = await runCli(
    [`--fixtures=${broken}`, `--out-dir=${outDir}`],
    { env: { ...process.env } },
  );
  assert.equal(exit, 1);
  const report = JSON.parse(readFileSync(path.join(outDir, "eval-report.json"), "utf8")) as {
    summary: { failed: number };
    results: Array<{ id: string; pass: boolean }>;
  };
  assert.equal(report.summary.failed, 1);
  assert.equal(report.results.find((r) => r.id === "research-valid-long")?.pass, false);
});

test("Eval: zwei Offline-Läufe → byte-identische Reports (Hash-Test)", async () => {
  const env = { ...process.env };
  const out1 = mkdtempSync(path.join(tmpdir(), "gap08-eval-det1-"));
  const out2 = mkdtempSync(path.join(tmpdir(), "gap08-eval-det2-"));
  await runEval({ outDir: out1, mode: "offline", env });
  await runEval({ outDir: out2, mode: "offline", env });
  const json1 = readFileSync(path.join(out1, "eval-report.json"), "utf8");
  const json2 = readFileSync(path.join(out2, "eval-report.json"), "utf8");
  const md1 = readFileSync(path.join(out1, "eval-report.md"), "utf8");
  const md2 = readFileSync(path.join(out2, "eval-report.md"), "utf8");
  assert.equal(json1, json2);
  assert.equal(md1, md2);
  assert.equal(sha256Hex(json1), sha256Hex(json2));
  // Kein Zeitstempel im Report (Determinismus-Voraussetzung).
  assert.doesNotMatch(json1, /generatedAt|timestamp|20\d\d-\d\d-\d\dT\d\d:/);
});

test("Eval: CLI — Help/Fehlerpfade und EVAL_OUTPUT_DIR-Override", async () => {
  assert.equal(await runCli(["--help"], { env: { ...process.env } }), 0);
  assert.equal(await runCli(["--unbekannt"], { env: { ...process.env } }), 2);
  assert.equal(
    await runCli([`--fixtures=${mkdtempSync(path.join(tmpdir(), "gap08-eval-empty-"))}`], {
      env: { ...process.env },
    }),
    2,
  );

  const outDir = mkdtempSync(path.join(tmpdir(), "gap08-eval-envdir-"));
  const exit = await runCli([], { env: { ...process.env, EVAL_OUTPUT_DIR: outDir } });
  assert.equal(exit, 0);
  assert.ok(readFileSync(path.join(outDir, "eval-report.json"), "utf8").length > 0);
});

test("Eval: Provider-Modus mit Stub-Provider trägt Budget-Hinweis (kein Golden-Vergleich)", async () => {
  const outDir = mkdtempSync(path.join(tmpdir(), "gap08-eval-provider-"));
  const { report } = await runEval({
    outDir,
    mode: "provider",
    env: { ...process.env },
    chatFn: (async () => ({
      content: JSON.stringify({
        view: "NEUTRAL",
        regime: "MIXED",
        thesis: "Stub-Antwort mit ausreichend langer Begründung für den Rauchtest.",
        confidence: 0.5,
      }),
      provider: "ollama",
      model: "stub",
      usage: { totalTokens: 100 },
      latencyMs: 5,
      attempt: 1,
    })) as never,
  });
  assert.equal(report.mode, "provider");
  assert.ok(report.budgetNote !== null);
  assert.equal(report.budgetNote?.calls, report.summary.total);
  assert.match(report.budgetNote?.note ?? "", /kostet|Kosten/);
});

test("Eval: evaluateFixture meldet Schema-Bruch ohne Plausibilitäts-Befunde", () => {
  const config = loadPlausibilityConfig({});
  const result = evaluateFixture(
    {
      id: "x",
      step: "research",
      description: "",
      candles: [],
      providerResponse: { setups: "kaputt" },
      expect: { schemaValid: false, plausible: false, codes: [] },
      file: "x.json",
    },
    { setups: "kaputt" },
    config,
  );
  assert.equal(result.schemaValid, false);
  assert.equal(result.plausible, false);
  assert.deepEqual(result.codes, []);
  assert.equal(result.pass, true);
  assert.ok(result.schemaError !== null);
});
