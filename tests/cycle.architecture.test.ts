/**
 * Architektur-Tests des Cycle-Moduls (Task 06).
 *
 * Verifiziert statisch über Quelltext- und Import-Scans:
 *   1. Scanner-Step importiert kein LLM-Modul (Harte Regel: null LLM im Scanner)
 *   2. Keine Order-Pfade oder Broker-Zustandsänderungen im Cycle-Modul
 *   3. Vollständigkeit und Konformität von docs/help/cycle.help.json (3-Ebenen-Hilfe)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { createDailySteps, DAILY_CYCLE_SCHEDULE } from "../src/cycle/daily";
import { createWeeklySteps } from "../src/cycle/weekly";

const CYCLE_DIR = path.join(process.cwd(), "src/cycle");
const SCANNER_STEP_FILE = path.join(process.cwd(), "src/cycle/steps/scannerStep.ts");
const HELP_FILE = path.join(process.cwd(), "docs/help/cycle.help.json");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

function importsOf(source: string): string[] {
  const specifiers: string[] = [];
  const re = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) specifiers.push(match[1]);
  const dynamic = /import\s*\(\s*["']([^"']+)["']\s*\)/g;
  while ((match = dynamic.exec(source)) !== null) specifiers.push(match[1]);
  const required = /require\s*\(\s*["']([^"']+)["']\s*\)/g;
  while ((match = required.exec(source)) !== null) specifiers.push(match[1]);
  return specifiers;
}

const FORBIDDEN_LLM_IMPORTS =
  /(ollama|llmProvider|openai|anthropic|claude|gemini|analysts|langchain|prompt)/i;

const FORBIDDEN_ORDER_EXECUTION =
  /(placeOrder|executeOrder|createOrder|submitOrder|cancelOrder|flattenPosition)/i;

test("Architektur: Step 1 (scannerStep.ts) importiert kein LLM-Modul (Null-LLM-Garantie)", () => {
  const source = readFileSync(SCANNER_STEP_FILE, "utf8");
  const imports = importsOf(source);

  for (const specifier of imports) {
    assert.ok(
      !FORBIDDEN_LLM_IMPORTS.test(specifier),
      `scannerStep.ts importiert verbotenes LLM-Modul: "${specifier}"`
    );
  }
});

test("Architektur: Das Cycle-Modul ruft keine Order-Ausführung oder Broker-Order-Funktionen auf", () => {
  const files = sourceFiles(CYCLE_DIR);
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const rel = path.relative(process.cwd(), file);

    // Keine verbotenen Order-Aufrufe
    assert.ok(
      !FORBIDDEN_ORDER_EXECUTION.test(source),
      `${rel} enthält verbotene Order-Ausführungsfunktion`
    );
  }
});

test("Architektur: Alle 8 Tages-Steps und Weekly-Review haben feste Rollen und Zeitfenster", () => {
  const daily = createDailySteps();
  assert.equal(daily.length, 8);
  assert.equal(DAILY_CYCLE_SCHEDULE.length, 8);

  // Scanner darf kein LLM nutzen
  assert.equal(daily[0].llmAllowed, false);
  assert.equal(daily[0].role, "MARKET_SCANNER");

  // Backtest-Verifikation darf kein LLM nutzen (reine Arithmetik)
  assert.equal(daily[7].llmAllowed, false);
  assert.equal(daily[7].role, "BACKTEST_VERIFICATION");

  const weekly = createWeeklySteps();
  assert.equal(weekly.length, 1);
  assert.equal(weekly[0].role, "WEEKLY_REVIEW");
});

test("Architektur & Doku: docs/help/cycle.help.json erfüllt 3-Ebenen-Schema vollständig", () => {
  const raw = readFileSync(HELP_FILE, "utf8");
  const help = JSON.parse(raw) as {
    id: string;
    version: number;
    fields: Record<string, { kurzinfo: string; technischeInfo: string; risiko: string }>;
  };

  assert.equal(help.id, "cycle");
  assert.equal(typeof help.version, "number");

  const requiredKeys = [
    "dailyCandidateList",
    "deepAnalysis",
    "shortlistLimit",
    "classCORE",
    "classROTATION",
    "classDISCOVERY",
    "classEXCLUDED",
    "sharpeRatio",
    "sortinoRatio",
    "maxDrawdown",
    "profitFactor",
    "regimeRobustness",
  ];

  for (const key of requiredKeys) {
    const entry = help.fields[key];
    assert.ok(entry, `Fehlender Schlüssel in cycle.help.json: ${key}`);
    assert.ok(entry.kurzinfo && entry.kurzinfo.length >= 20, `${key}.kurzinfo zu kurz oder fehlt`);
    assert.ok(entry.technischeInfo && entry.technischeInfo.length >= 30, `${key}.technischeInfo zu kurz oder fehlt`);
    assert.ok(entry.risiko && entry.risiko.length >= 20, `${key}.risiko zu kurz oder fehlt`);
  }
});
