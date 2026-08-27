/**
 * Architektur-Tests des Scanners (Task 04).
 *
 * Der Scanner ist eine deterministische, read-only Analyseschicht. Diese Tests
 * prüfen die Grenze **statisch** über einen Import-/Quelltext-Scan:
 *   - kein LLM-Import (Ollama, OpenAI, Gemini, Claude, Analysten, Prompts),
 *   - kein Netzwerk (fetch, node:http(s), ws, Broker-SDK),
 *   - keine Zufallsquelle ohne Seed (`Math.random`),
 *   - keine versteckte Uhr (`Date.now()`, `new Date()` außerhalb des Service),
 *   - keine Schreibpfade außer den Artefakten,
 *   - keine Datenbank/Order-Ausführung.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { FACTOR_IDS } from "../src/scanner/types";

const SCANNER_DIR = path.join(process.cwd(), "src/scanner");
const API_DIR = path.join(process.cwd(), "src/app/api/universe");

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

const FORBIDDEN_IMPORT = /(ollama|llmProvider|openai|anthropic|claude|gemini|analysts|prompt|langchain|\/engine|microExecutor|\/db\b|drizzle|\/brokers?\/|\bws\b|node:http|node:https|node:child_process|node:net|node:dgram)/i;

test("Architektur: das Scanner-Modul importiert kein LLM, kein Netzwerk, keine DB", () => {
  const files = sourceFiles(SCANNER_DIR);
  assert.ok(files.length >= 20, `erwartet ≥ 20 Dateien, gefunden ${files.length}`);
  for (const file of files) {
    for (const specifier of importsOf(readFileSync(file, "utf8"))) {
      assert.ok(
        !FORBIDDEN_IMPORT.test(specifier),
        `${path.relative(process.cwd(), file)} importiert verbotenes Modul "${specifier}"`
      );
    }
  }
});

test("Architektur: auch die Universe-API-Routen bleiben frei von LLM-Importen", () => {
  for (const file of sourceFiles(API_DIR)) {
    for (const specifier of importsOf(readFileSync(file, "utf8"))) {
      assert.ok(
        !/(ollama|llmProvider|openai|anthropic|claude|gemini|analysts|langchain)/i.test(specifier),
        `${path.relative(process.cwd(), file)} importiert LLM-Modul "${specifier}"`
      );
    }
  }
});

test("Architektur: keine Zufallsquelle, kein fetch, kein eval im Scanner", () => {
  for (const file of sourceFiles(SCANNER_DIR)) {
    const source = readFileSync(file, "utf8");
    const rel = path.relative(process.cwd(), file);
    assert.ok(!/Math\.random\s*\(/.test(source), `${rel} nutzt Math.random`);
    assert.ok(!/(^|[^.\w])fetch\s*\(/.test(source), `${rel} nutzt fetch`);
    assert.ok(!/\beval\s*\(/.test(source), `${rel} nutzt eval`);
    assert.ok(!/child_process|execSync|spawnSync/.test(source), `${rel} startet Prozesse`);
    assert.ok(!/process\.env\.(?!SCANNER_CONFIG_FILE|SCANNER_ARTIFACTS_DIR)/.test(source), `${rel} liest fremde Umgebungsvariablen`);
  }
});

test("Architektur: Zeitbezug ist injiziert — Date.now() nirgends, new Date() nur im Service", () => {
  for (const file of sourceFiles(SCANNER_DIR)) {
    const source = readFileSync(file, "utf8");
    const rel = path.relative(process.cwd(), file);
    assert.ok(!/Date\.now\s*\(/.test(source), `${rel} nutzt Date.now()`);
    if (path.basename(file) !== "service.ts") {
      assert.ok(!/new Date\(\s*\)/.test(source), `${rel} erzeugt eine unabhängige Uhr`);
    }
  }
});

test("Architektur: Schreibzugriffe existieren ausschließlich in artifacts.ts", () => {
  for (const file of sourceFiles(SCANNER_DIR)) {
    const source = readFileSync(file, "utf8");
    if (path.basename(file) === "artifacts.ts") continue;
    assert.ok(
      !/writeFileSync|appendFileSync|renameSync|rmSync|unlinkSync/.test(source),
      `${path.relative(process.cwd(), file)} schreibt Dateien außerhalb der Artefakt-Schicht`
    );
  }
});

test("Architektur: je Faktor genau eine Datei mit TSDoc-Formelblock", () => {
  const factorDir = path.join(SCANNER_DIR, "factors");
  const files = readdirSync(factorDir).filter((f) => f.endsWith(".ts") && !["index.ts", "helpers.ts"].includes(f));
  assert.equal(files.length, 14, `erwartet 14 Faktor-Dateien, gefunden ${files.length}`);
  for (const file of files) {
    const source = readFileSync(path.join(factorDir, file), "utf8");
    assert.match(source, /\/\*\*[\s\S]*Formel[ (:]/, `${file}: TSDoc mit Formel fehlt`);
    assert.match(source, /Normalisierung:/, `${file}: Normalisierung nicht dokumentiert`);
    assert.match(source, /Datenbedarf:/, `${file}: Datenbedarf nicht dokumentiert`);
  }
});

test("Doku: scanner.help.json deckt alle Faktoren im 3-Ebenen-Schema ab", () => {
  const help = JSON.parse(readFileSync(path.join(process.cwd(), "docs/help/scanner.help.json"), "utf8")) as {
    id: string;
    version: number;
    fields: Record<string, { kurzinfo?: string; technischeInfo?: string; risiko?: string }>;
  };
  assert.equal(help.id, "scanner");
  assert.equal(typeof help.version, "number");

  for (const id of FACTOR_IDS) {
    assert.ok(help.fields[id], `Hilfetext für Faktor ${id} fehlt`);
  }
  for (const key of [
    "marketScore",
    "funnelEligible",
    "funnelInteresting",
    "funnelDaily",
    "funnelDeep",
    "regime",
    "classCORE",
    "classROTATION",
    "classDISCOVERY",
    "classEXCLUDED",
  ]) {
    assert.ok(help.fields[key], `Hilfetext für ${key} fehlt`);
  }
  for (const [key, entry] of Object.entries(help.fields)) {
    for (const level of ["kurzinfo", "technischeInfo", "risiko"] as const) {
      const text = entry[level];
      assert.equal(typeof text, "string", `${key}.${level} fehlt`);
      assert.ok((text ?? "").length >= 40, `${key}.${level} ist zu knapp`);
    }
  }
});

test("Doku: DAILY_WEEKLY_RESEARCH.md nennt alle Faktoren, Gewichte und Filterregeln", () => {
  const doc = readFileSync(path.join(process.cwd(), "docs/DAILY_WEEKLY_RESEARCH.md"), "utf8");
  for (const id of FACTOR_IDS) assert.match(doc, new RegExp(`\`${id}\``), `Faktor ${id} nicht dokumentiert`);
  for (const rule of [
    "status-active",
    "paper-available",
    "market-type",
    "asset-class",
    "min-candles",
    "min-volume",
    "max-spread",
    "max-execution-cost",
    "max-drawdown",
    "regime-extreme",
  ]) {
    assert.match(doc, new RegExp(rule), `Filterregel ${rule} nicht dokumentiert`);
  }
  for (const regime of ["LOW", "NORMAL", "HIGH", "EXTREME"]) assert.match(doc, new RegExp(regime));
});
