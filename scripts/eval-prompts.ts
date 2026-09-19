/**
 * `npm run eval:prompts` — Prompt-Eval-Harness (GAP-08, v1.49.0).
 *
 * Bewertet Prompt-Änderungen gegen das Golden-Dataset
 * (`tests/fixtures/golden/<step>/*.json`): Jede Fixture enthält Kerzen,
 * eine Provider-Antwort und die Erwartung (schemaValid/plausible/codes).
 * Der Runner führt Schema-Validierung + Plausibilitäts-Schicht aus und
 * vergleicht Ist gegen Erwartung.
 *
 *   npm run eval:prompts                    # Offline-Modus (Default, deterministisch, ohne Netz)
 *   npm run eval:prompts -- --provider      # Provider-Modus (echte LLM-Aufrufe, kostet Tokens!)
 *   npm run eval:prompts -- --out-dir=tmp/eval --fixtures=tests/fixtures/golden
 *
 * Regeln:
 *   - Offline ist Default: gestubbte Antworten aus den Fixtures, kein Netz,
 *     keine Secrets. Zwei Läufe liefern byte-identische Reports (keine
 *     Zeitstempel im Report — Determinismus-Test per Hash).
 *   - Reports (JSON + MD) landen unter `data/eval/` (via `resolveRuntimePath`,
 *     Override `EVAL_OUTPUT_DIR`).
 *   - Exit-Code: 0 = alle Fixtures wie erwartet, 1 = Regression/Fehlschlag,
 *     2 = Bedien-/Fixture-Fehler.
 *   - Provider-Modus nur mit explizitem `--provider`-Flag (Rauchtest:
 *     Schema+Plausibilität, KEIN Golden-Vergleich — LLM-Output variiert).
 *     Der Report trägt einen Budget-Hinweis (Tokens/Latenz).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveRuntimePath } from "../src/lib/appPaths";
import { validateMacroOutput, validateResearchOutput } from "../src/cycle/schemas";
import {
  adaptMacroOutput,
  adaptResearchOutput,
  findingCodes,
  isPlausibilityCode,
  loadPlausibilityConfig,
  runPlausibilitySpec,
  type PlausibilityCandle,
  type PlausibilityCode,
  type PlausibilityConfig,
} from "../src/cycle/plausibility";
import { safeExtractJson } from "../src/cycle/security";
import { chatLlm } from "../src/lib/llmProvider";

export const EVAL_VERSION = 1;
export const EVAL_DEFAULT_DIR = "data/eval";
export const EVAL_DEFAULT_FIXTURES = "tests/fixtures/golden";
export const EVAL_REPORT_JSON = "eval-report.json";
export const EVAL_REPORT_MD = "eval-report.md";

export type EvalStep = "research" | "macro";
export type EvalMode = "offline" | "provider";

export interface GoldenFixture {
  id: string;
  step: EvalStep;
  description: string;
  candles: PlausibilityCandle[];
  providerResponse: unknown;
  expect: {
    schemaValid: boolean;
    plausible: boolean;
    codes: PlausibilityCode[];
  };
  /** Relativer Pfad ab Fixture-Root (Traceability, deterministisch). */
  file: string;
}

export interface EvalFixtureResult {
  id: string;
  step: EvalStep;
  file: string;
  schemaValid: boolean;
  schemaError: string | null;
  plausible: boolean;
  codes: PlausibilityCode[];
  expected: { schemaValid: boolean; plausible: boolean; codes: PlausibilityCode[] };
  pass: boolean;
  notes: string[];
}

export interface EvalReport {
  evalVersion: number;
  mode: EvalMode;
  thresholds: { priceBandPct: number; minRationaleChars: number };
  summary: { total: number; passed: number; failed: number };
  results: EvalFixtureResult[];
  /** Nur Provider-Modus: Verbrauch + Kostenhinweis. Offline immer null. */
  budgetNote: null | {
    calls: number;
    tokensUsed: number;
    latencyMs: number;
    note: string;
  };
}

/** Fehlerhafter Fixture-Satz / Bedienfehler → Exit-Code 2. */
export class EvalFixtureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvalFixtureError";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixture-Loader (strikt, hand-validiert — fail-closed statt Raten)
// ─────────────────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseCandle(raw: unknown, file: string, index: number): PlausibilityCandle {
  if (!isRecord(raw)) {
    throw new EvalFixtureError(`${file}: candles[${index}] muss ein Objekt sein.`);
  }
  const close = raw.close;
  if (typeof close !== "number" || !Number.isFinite(close) || close <= 0) {
    throw new EvalFixtureError(`${file}: candles[${index}].close muss eine positive Zahl sein.`);
  }
  const candle: PlausibilityCandle = { close };
  for (const key of ["high", "low"] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new EvalFixtureError(`${file}: candles[${index}].${key} muss eine positive Zahl sein.`);
    }
    candle[key] = value;
  }
  return candle;
}

function parseFixture(filePath: string, root: string): GoldenFixture {
  const file = path.relative(root, filePath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (e) {
    throw new EvalFixtureError(
      `${file}: kein gültiges JSON (${e instanceof Error ? e.message : String(e)}).`,
    );
  }
  if (!isRecord(parsed)) throw new EvalFixtureError(`${file}: Fixture muss ein Objekt sein.`);
  const id = parsed.id;
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new EvalFixtureError(`${file}: "id" muss eine nicht-leere Zeichenkette sein.`);
  }
  const step = parsed.step;
  if (step !== "research" && step !== "macro") {
    throw new EvalFixtureError(`${file}: "step" muss "research" oder "macro" sein.`);
  }
  if (!Array.isArray(parsed.candles)) {
    throw new EvalFixtureError(`${file}: "candles" muss ein Array sein (ggf. leer).`);
  }
  const candles = parsed.candles.map((c, i) => parseCandle(c, file, i));
  if (!("providerResponse" in parsed)) {
    throw new EvalFixtureError(`${file}: "providerResponse" fehlt.`);
  }
  if (!isRecord(parsed.expect)) {
    throw new EvalFixtureError(`${file}: "expect" muss ein Objekt sein.`);
  }
  const { schemaValid, plausible, codes } = parsed.expect;
  if (typeof schemaValid !== "boolean" || typeof plausible !== "boolean") {
    throw new EvalFixtureError(`${file}: "expect.schemaValid"/"expect.plausible" müssen Boolean sein.`);
  }
  if (!Array.isArray(codes) || !codes.every(isPlausibilityCode)) {
    throw new EvalFixtureError(
      `${file}: "expect.codes" muss ein Array gültiger Codes sein (PRICE_RANGE|MONOTONICITY|RATIONALE_MISSING|HALLUCINATED_PRICE).`,
    );
  }
  return {
    id: id.trim(),
    step,
    description: typeof parsed.description === "string" ? parsed.description : "",
    candles,
    providerResponse: parsed.providerResponse,
    expect: {
      schemaValid,
      plausible,
      codes: [...new Set(codes)].sort() as PlausibilityCode[],
    },
    file,
  };
}

/** Lädt alle Fixtures (rekursiv, sortiert nach ID — deterministisch). */
export function loadGoldenFixtures(root = EVAL_DEFAULT_FIXTURES): GoldenFixture[] {
  const dir = resolveRuntimePath(root);
  if (!existsSync(dir)) {
    throw new EvalFixtureError(`Fixture-Verzeichnis nicht gefunden: ${root}`);
  }
  const files: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current).sort()) {
      const full = path.join(current, entry);
      if (entry.endsWith(".json")) files.push(full);
      else if (!entry.includes(".")) {
        try {
          if (readdirSync(full)) walk(full);
        } catch {
          // Kein Verzeichnis (Race) — ignorieren, Loader bleibt total.
        }
      }
    }
  };
  walk(dir);
  files.sort();
  const fixtures = files.map((f) => parseFixture(f, dir));
  fixtures.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const seen = new Set<string>();
  for (const fixture of fixtures) {
    if (seen.has(fixture.id)) {
      throw new EvalFixtureError(`Doppelte Fixture-ID: ${fixture.id}`);
    }
    seen.add(fixture.id);
  }
  if (fixtures.length === 0) {
    throw new EvalFixtureError(`Keine Fixtures gefunden unter: ${root}`);
  }
  return fixtures;
}

// ─────────────────────────────────────────────────────────────────────────────
// Auswertung (Schema + Plausibilität — identische Pipeline wie im Betrieb)
// ─────────────────────────────────────────────────────────────────────────────

function codesEqual(a: readonly PlausibilityCode[], b: readonly PlausibilityCode[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((code, i) => code === b[i]);
}

export function evaluateFixture(
  fixture: GoldenFixture,
  response: unknown,
  config: PlausibilityConfig,
  opts: { goldenComparison: boolean } = { goldenComparison: true },
): EvalFixtureResult {
  const notes: string[] = [];
  const schema =
    fixture.step === "research"
      ? validateResearchOutput(response)
      : validateMacroOutput(response);
  const schemaValid = schema.valid === true && schema.data !== undefined;
  const schemaError = schemaValid ? null : (schema.error ?? "Schema ungültig");
  if (!schemaValid) {
    notes.push("Schema ungültig — Plausibilitäts-Schicht läuft nicht (valide Struktur ist Voraussetzung).");
  }

  let plausible = false;
  let codes: PlausibilityCode[] = [];
  if (schemaValid) {
    const check = runPlausibilitySpec(
      schema.data,
      {
        adapt: fixture.step === "research" ? adaptResearchOutput : adaptMacroOutput,
        // Eval-Vereinfachung (Fixture-README): EINE Kerzenreihe gilt für alle
        // Entscheidungen der Fixture; im Betrieb kommen Kerzen je Instrument.
        candles: fixture.candles,
        fieldPrefix: fixture.step === "research" ? "setups" : "macro",
        config,
      },
    );
    codes = findingCodes(check.findings);
    plausible = codes.length === 0;
    if (check.referenceMissingInstruments.length > 0) {
      notes.push(
        `Keine verwertbaren Referenzkerzen für: ${check.referenceMissingInstruments.join(", ")} (Preis-Regeln übersprungen).`,
      );
    }
  }

  const expected = fixture.expect;
  const pass = opts.goldenComparison
    ? schemaValid === expected.schemaValid &&
      plausible === expected.plausible &&
      codesEqual(codes, expected.codes)
    : schemaValid && plausible;
  if (!opts.goldenComparison) {
    notes.push("Provider-Modus: Rauchtest (Schema+Plausibilität), kein Golden-Vergleich.");
  }
  return {
    id: fixture.id,
    step: fixture.step,
    file: fixture.file,
    schemaValid,
    schemaError,
    plausible,
    codes,
    expected: { ...expected, codes: [...expected.codes] },
    pass,
    notes,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Runner
// ─────────────────────────────────────────────────────────────────────────────

export interface RunEvalOptions {
  fixturesRoot?: string;
  outDir?: string;
  mode?: EvalMode;
  env?: Record<string, string | undefined>;
  /** Injektion für Tests: Provider-Aufruf ersetzen (Default: echtes chatLlm). */
  chatFn?: typeof chatLlm;
}

export function resolveEvalOutDir(
  env: Record<string, string | undefined> = process.env,
  override?: string,
): string {
  const raw = override ?? env.EVAL_OUTPUT_DIR ?? EVAL_DEFAULT_DIR;
  return resolveRuntimePath(raw);
}

function providerPromptFor(fixture: GoldenFixture): string {
  return [
    `Produce the "${fixture.step}" step output as strictly valid JSON.`,
    `Reference candles (JSON, oldest first):`,
    JSON.stringify(fixture.candles),
    fixture.step === "research"
      ? `JSON shape: {"setups":[{"instrumentId":string,"side":"LONG"|"SHORT","entryPrice":number,"stopLoss":number,"takeProfit":number,"riskScore":number,"timeframe":string,"thesis":string,"isProposal":true}],"totalSetups":number,"disclaimer":"PROPOSAL_ONLY_NO_ORDERS_PLACED"}. Output JSON only.`
      : `JSON shape: {"view":"BULLISH"|"BEARISH"|"NEUTRAL","regime":"RISK_ON"|"RISK_OFF"|"MIXED","volatilityRegime":"LOW"|"NORMAL"|"HIGH"|"EXTREME","assets":{},"thesis":string,"confidence":number}. Output JSON only.`,
  ].join("\n");
}

/**
 * Führt den Eval aus und schreibt JSON- + MD-Report. Gibt den Report und die
 * geschriebenen Pfade zurück (Determinismus: gleiche Fixtures + Schwellen ⇒
 * byte-identische Reports — der Report enthält bewusst KEINE Zeitstempel).
 */
export async function runEval(opts: RunEvalOptions = {}): Promise<{
  report: EvalReport;
  jsonPath: string;
  mdPath: string;
}> {
  const env = opts.env ?? process.env;
  const mode: EvalMode = opts.mode ?? "offline";
  const config = loadPlausibilityConfig(env);
  const fixtures = loadGoldenFixtures(opts.fixturesRoot ?? EVAL_DEFAULT_FIXTURES);

  const results: EvalFixtureResult[] = [];
  let tokensUsed = 0;
  let latencyMs = 0;
  let calls = 0;

  for (const fixture of fixtures) {
    if (mode === "offline") {
      results.push(
        evaluateFixture(fixture, fixture.providerResponse, config, { goldenComparison: true }),
      );
    } else {
      const chat = opts.chatFn ?? chatLlm;
      const started = Date.now();
      const answer = await chat(
        {
          model: env.LLM_MODEL || "eval",
          messages: [
            { role: "system", content: "You emit strictly valid JSON, no prose." },
            { role: "user", content: providerPromptFor(fixture) },
          ],
          json: true,
          temperature: 0,
        },
      );
      calls += 1;
      const usage = answer.usage ?? {};
      tokensUsed += Number(usage.totalTokens ?? 0) || 0;
      latencyMs += Date.now() - started;
      const parsed = safeExtractJson<unknown>(answer.content);
      results.push(
        evaluateFixture(fixture, parsed.ok ? parsed.data : undefined, config, {
          goldenComparison: false,
        }),
      );
    }
  }

  const passed = results.filter((r) => r.pass).length;
  const report: EvalReport = {
    evalVersion: EVAL_VERSION,
    mode,
    thresholds: { priceBandPct: config.priceBandPct, minRationaleChars: config.minRationaleChars },
    summary: { total: results.length, passed, failed: results.length - passed },
    results,
    budgetNote:
      mode === "provider"
        ? {
            calls,
            tokensUsed,
            latencyMs,
            note:
              `Provider-Modus: ${calls} Aufrufe, ${tokensUsed} Tokens, ${latencyMs} ms — ` +
              `echte LLM-Aufrufe (Kosten möglich). Rauchtest ohne Golden-Vergleich.`,
          }
        : null,
  };

  const outDir = resolveEvalOutDir(env, opts.outDir);
  mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, EVAL_REPORT_JSON);
  const mdPath = path.join(outDir, EVAL_REPORT_MD);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(mdPath, `${renderMarkdownReport(report)}\n`);
  return { report, jsonPath, mdPath };
}

/** Deterministischer Markdown-Report (Tabellen, keine Zeitstempel). */
export function renderMarkdownReport(report: EvalReport): string {
  const lines: string[] = [
    "# Prompt-Eval-Report (GAP-08)",
    "",
    `Modus: \`${report.mode}\` · Schwellen: Preisband ±${report.thresholds.priceBandPct} %, ` +
      `Mindestbegründung ${report.thresholds.minRationaleChars} Zeichen`,
    `Ergebnis: **${report.summary.passed}/${report.summary.total} bestanden**` +
      (report.summary.failed > 0 ? `, **${report.summary.failed} Regressionen**` : ""),
    "",
  ];
  if (report.budgetNote) {
    lines.push(
      `> **Budget-Hinweis:** ${report.budgetNote.note}`,
      "",
    );
  }
  lines.push(
    "| Fixture | Step | Schema | Plausibel | Codes | Erwartet | Pass |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const r of report.results) {
    lines.push(
      `| \`${r.id}\` | ${r.step} | ${r.schemaValid ? "ja" : "NEIN"} | ${r.plausible ? "ja" : "nein"} | ` +
        `${r.codes.length > 0 ? r.codes.join(",") : "—"} | ` +
        `${r.expected.schemaValid ? "S" : "!S"}/${r.expected.plausible ? "P" : "!P"}` +
        `${r.expected.codes.length > 0 ? `:${r.expected.codes.join(",")}` : ""} | ` +
        `${r.pass ? "✅" : "❌"} |`,
    );
  }
  const failures = report.results.filter((r) => !r.pass);
  if (failures.length > 0) {
    lines.push("", "## Regressionen", "");
    for (const r of failures) {
      lines.push(
        `### \`${r.id}\` (${r.file})`,
        "",
        `- Schema: ${r.schemaValid ? "valide" : `UNGÜLTIG (${r.schemaError ?? "?"})`} (erwartet: ${r.expected.schemaValid ? "valide" : "ungültig"})`,
        `- Plausibel: ${r.plausible ? "ja" : "nein"} (erwartet: ${r.expected.plausible ? "ja" : "nein"})`,
        `- Codes: ${r.codes.length > 0 ? r.codes.join(", ") : "—"} (erwartet: ${r.expected.codes.length > 0 ? r.expected.codes.join(", ") : "—"})`,
        ...(r.notes.length > 0 ? [`- Hinweise: ${r.notes.join(" ")}`] : []),
        "",
      );
    }
  }
  return lines.join("\n").trimEnd();
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

function cliArg(argv: string[], name: string): string | undefined {
  return argv.find((a) => a.startsWith(`--${name}=`))?.slice(`--${name}=`.length);
}

function cliFlag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

function printHelp(): void {
  console.log(
    [
      "Prompt-Eval-Harness (GAP-08) — Golden-Dataset-Regression nach Prompt-Edits.",
      "",
      "  npm run eval:prompts                      Offline (Default): Fixture-Antworten, ohne Netz",
      "  npm run eval:prompts -- --provider        Provider-Modus: echte LLM-Aufrufe (kostet Tokens!)",
      "  npm run eval:prompts -- --out-dir=PFAD    Report-Verzeichnis (Default: data/eval bzw. EVAL_OUTPUT_DIR)",
      "  npm run eval:prompts -- --fixtures=PFAD   Fixture-Root (Default: tests/fixtures/golden)",
      "",
      "Exit: 0 = alle Fixtures wie erwartet · 1 = Regression/Fehlschlag · 2 = Bedien-/Fixture-Fehler.",
    ].join("\n"),
  );
}

/**
 * CLI-Einstieg (testbar: gibt den Exit-Code zurück, beendet NICHT selbst —
 * `main()` ruft `process.exit`).
 */
export async function runCli(
  argv: string[] = process.argv.slice(2),
  opts: { env?: Record<string, string | undefined> } = {},
): Promise<number> {
  const env = opts.env ?? process.env;
  if (cliFlag(argv, "help") || cliFlag(argv, "h")) {
    printHelp();
    return 0;
  }
  const unknown = argv.filter(
    (a) => a !== "--provider" && !a.startsWith("--out-dir=") && !a.startsWith("--fixtures="),
  );
  if (unknown.length > 0) {
    console.error(`[eval] Unbekannte Option: ${unknown.join(" ")} (siehe --help).`);
    return 2;
  }
  const mode: EvalMode = cliFlag(argv, "provider") ? "provider" : "offline";
  if (mode === "provider") {
    console.warn(
      "[eval] Provider-Modus: echte LLM-Aufrufe gegen den konfigurierten Provider — kostet Tokens (ggf. Geld).",
    );
  }
  try {
    const { report, jsonPath, mdPath } = await runEval({
      env,
      mode,
      outDir: cliArg(argv, "out-dir"),
      fixturesRoot: cliArg(argv, "fixtures"),
    });
    console.log(
      `[eval] Modus=${mode} Fixtures=${report.summary.total} ` +
        `bestanden=${report.summary.passed} regressionen=${report.summary.failed}`,
    );
    console.log(`[eval] Reports: ${jsonPath} ${mdPath}`);
    for (const r of report.results.filter((x) => !x.pass)) {
      console.log(
        `[eval] REGRESSION ${r.id}: schema=${r.schemaValid} plausibel=${r.plausible} ` +
          `codes=[${r.codes.join(",")}] erwartet=[${r.expected.codes.join(",")}]`,
      );
    }
    return report.summary.failed > 0 ? 1 : 0;
  } catch (e) {
    if (e instanceof EvalFixtureError) {
      console.error(`[eval] Fixture-Fehler: ${e.message}`);
      return 2;
    }
    console.error(
      `[eval] Unerwarteter Fehler: ${e instanceof Error ? e.message : String(e)}`,
    );
    return 2;
  }
}

async function main(): Promise<void> {
  process.exit(await runCli());
}

// Direktstart (`node scripts/eval-prompts.ts`), nicht bei Test-Import.
const invokedAsScript =
  typeof process.argv[1] === "string" && process.argv[1].endsWith("eval-prompts.ts");
if (invokedAsScript) {
  void main();
}
