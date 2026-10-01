#!/usr/bin/env node
/**
 * STX-03-10 — erzeugt `docs/STRATEGY_TEMPLATES.md` **aus dem Code**.
 *
 * Warum generiert und nicht handgeschrieben: Die Tabelle ist eine Aussage über
 * den Katalog (`src/strategies/catalog.ts` → `STRATEGY_TEMPLATES`). Eine von
 * Hand gepflegte Kopie würde bei der nächsten Parameter-/Annahmen-Änderung
 * still veralten — genau der Drift, den die Vertragstests 03-10 ausschließen.
 * `tests/strategies.templates.test.ts` vergleicht die Datei deshalb byteweise
 * mit `renderStrategyTemplatesDoc()`; wer Parameter, Timeframes, Regimes oder
 * Annahmen ändert, führt dieses Skript erneut aus:
 *
 *   npm run docs:templates
 *
 * Das Skript ist **reine Projektion**: kein Netz, keine DB, keine Mutation am
 * Katalog, kein `buildRule()`-Aufruf mit anderen als den Default-Parametern
 * (die Bedingungsspalte zeigt die Rohform `RuleSpecInput` bei Defaults — die
 * einzige legitime Transformation bleibt `sanitizeRuleSpec()`, 03-09).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { STRATEGY_TEMPLATES } from "../src/strategies/catalog";
import type { ParamSpec, StrategyTemplate } from "../src/strategies/types";

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(here, "..", "docs", "STRATEGY_TEMPLATES.md");

// ─────────────────────────────────────────────────────────────────────────────
// Kleine Format-Helfer (deterministisch, ohne Locale/Zufall)
// ─────────────────────────────────────────────────────────────────────────────

/** Markdown-Tabellenzelle: Pipes maskieren, Zeilenumbrüche zu Leerzeichen. */
function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Eine Zahl so, wie sie im Parameterraster steht (`0.05`, `15`, `1.5`). */
function num(value: number): string {
  return String(value);
}

/** Bedingungen der Rohform als lesbare Zeile, z. B. `trend eq „UP“ ∧ adx14 gte 20`. */
function conditionLine(template: StrategyTemplate): string {
  const defaults: Record<string, number> = {};
  for (const [key, spec] of Object.entries(template.params)) defaults[key] = spec.default;

  let built: unknown;
  try {
    built = template.buildRule(defaults);
  } catch (err) {
    return `Builder wirft bei Defaults: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (!isRecord(built) || !isRecord(built.condition)) return "—";
  const items = built.condition.conditions;
  if (!Array.isArray(items) || items.length === 0) return "—";

  const logic = built.condition.logic === "any" ? " ∨ " : " ∧ ";
  const parts = items.map((item) => {
    if (!isRecord(item)) return "?";
    const field = String(item.field);
    const op = String(item.op);
    const value = typeof item.value === "string" ? `„${item.value}“` : JSON.stringify(item.value);
    return `\`${field}\` ${op} ${value}`;
  });
  return parts.join(logic);
}

/** Übersichtstabelle — eine Zeile pro Template. */
function renderOverview(): string {
  const rows = STRATEGY_TEMPLATES.map((template) => {
    const critical = template.assumptions.filter((assumption) => assumption.critical).length;
    return (
      `| [\`${template.id}\`](#${template.id}) ` +
      `| \`${template.class}\` ` +
      `| ${template.supportedTimeframes.map((tf) => `\`${tf}\``).join(", ")} ` +
      `| ${template.expectedRegimes.map((regime) => `\`${regime}\``).join(", ")} ` +
      `| ${template.version} ` +
      `| ${Object.keys(template.params).length} ` +
      `| ${template.assumptions.length} (${critical}) |`
    );
  });
  return [
    "| Template | Klasse | Timeframes | Erwartete Regimes | Version | Parameter | Annahmen (kritisch) |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

/** Parameter eines Templates — eine Zeile je `ParamSpec`. */
function renderParams(template: StrategyTemplate): string {
  const rows = Object.entries(template.params).map(([key, spec]: [string, ParamSpec]) => {
    return (
      `| \`${key}\` | ${cell(spec.label)} | ${cell(spec.unit)} | ${cell(spec.kind)} ` +
      `| ${num(spec.default)} | ${num(spec.min)} | ${num(spec.max)} | ${num(spec.step)} | \`${spec.mapsTo}\` |`
    );
  });
  return [
    "| Key | Label | Einheit | Art | Default | Min | Max | Step | mapsTo (Regelfeld) |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

/** Annahmen eines Templates — eine Zeile je `StrategyAssumption`. */
function renderAssumptions(template: StrategyTemplate): string {
  const rows = template.assumptions.map((assumption) => {
    return (
      `| \`${assumption.id}\` | ${cell(assumption.category)} | ${assumption.critical ? "**ja**" : "nein"} ` +
      `| ${cell(assumption.statement)} |`
    );
  });
  return [
    "| ID | Kategorie | Kritisch | Aussage |",
    "| --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

/** Ein Abschnitt je Template. */
function renderTemplate(template: StrategyTemplate): string {
  const version = `v${template.version}`;
  return [
    `## \`${template.id}\``,
    "",
    `**${template.name}** — ${cell(template.description)}`,
    "",
    `- **Klasse:** \`${template.class}\` (ADR-008, deklariert; nicht aus der ID abgeleitet)`,
    `- **Version:** ${template.version} (${version}; Teil des Artefakt-Hashs, 04-01)`,
    `- **Scope:** \`${template.scope}\``,
    `- **Timeframes:** ${template.supportedTimeframes.map((tf) => `\`${tf}\``).join(", ")} (\`SUPPORTED_TIMEFRAMES\`, STX-01)`,
    `- **Erwartete Regimes:** ${template.expectedRegimes.map((regime) => `\`${regime}\``).join(", ")} (ADR-009, ohne \`UNKNOWN\`)`,
    `- **Pflichtfelder:** ${template.requiredFields.map((field) => `\`${field}\``).join(", ")}`,
    `- **Bedingung (Defaults, Rohform \`RuleSpecInput\`):** ${conditionLine(template)}`,
    "",
    "### Parameter",
    "",
    renderParams(template),
    "",
    "### Annahmen",
    "",
    renderAssumptions(template),
    "",
  ].join("\n");
}

/**
 * Die vollständige Doku als String. **Pure Funktion** — dieselbe Katalog-Version
 * liefert byteweise denselben Text (der Test verlässt sich darauf).
 */
export function renderStrategyTemplatesDoc(): string {
  return [
    "# Strategie-Templates — Katalog (aus dem Code generiert)",
    "",
    "> **Nicht von Hand bearbeiten.** Diese Datei ist eine Projektion von",
    "> `STRATEGY_TEMPLATES` aus [`src/strategies/catalog.ts`](../src/strategies/catalog.ts);",
    "> erzeugt mit `npm run docs:templates`",
    "> ([`scripts/gen-strategy-templates-doc.ts`](../scripts/gen-strategy-templates-doc.ts)).",
    "> [`tests/strategies.templates.test.ts`](../tests/strategies.templates.test.ts)",
    "> vergleicht sie byteweise mit der Renderer-Ausgabe — eine Parameter-, Timeframe-",
    "> oder Annahmen-Änderung ohne neuen Generatorlauf lässt die Tests fehlschlagen.",
    "",
    "Sechs versionierte Strategie-Artefakte (Phase 3, Abnahme STX-03-10). Jedes",
    "Artefakt ist eine **reine Funktion der Parameter** (`buildRule(params) => RuleSpecInput`,",
    "STX-05); die einzige legale Transformation der Rohform ist `sanitizeRuleSpec()`",
    "über [`src/strategies/compiler.ts`](../src/strategies/compiler.ts). Vertrag und",
    "Klassen-/Regime-Vokabular: [`src/strategies/types.ts`](../src/strategies/types.ts),",
    "`STRATEGY_CLASS_KEYS` ([`src/lib/signalDecay.ts`](../src/lib/signalDecay.ts)),",
    "`MarketRegime` ([`src/lib/marketRegime.ts`](../src/lib/marketRegime.ts)).",
    "",
    "## Übersicht",
    "",
    renderOverview(),
    "",
    ...STRATEGY_TEMPLATES.flatMap((template) => [renderTemplate(template)]),
    "## Pflege",
    "",
    "1. Template ändern (`src/strategies/templates/*.ts`) — der Katalog validiert beim Import.",
    "2. `npm run docs:templates` ausführen und `docs/STRATEGY_TEMPLATES.md` mitcommitten.",
    "3. `npm test` prüft, dass Datei und Katalog übereinstimmen; die Vertragstests",
    "   `tests/strategies.templates.test.ts` prüfen zusätzlich Struktur-Invarianten,",
    "   Compiler-Parität, Fixture-/Negativ-Fixtures und die Engine-↔-Cache-Parität (02-02/02-03).",
    "",
  ].join("\n");
}

/** Schreibt die Datei und liefert den Pfad zurück (CLI-Nutzung). */
export function writeStrategyTemplatesDoc(): string {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, renderStrategyTemplatesDoc(), "utf8");
  return target;
}

// Direktstart (`npm run docs:templates`), nicht beim Test-Import.
const invokedAsScript =
  typeof process.argv[1] === "string" && process.argv[1].endsWith("gen-strategy-templates-doc.ts");
if (invokedAsScript) {
  const written = writeStrategyTemplatesDoc();
  console.log(`[docs:templates] ${written} aus STRATEGY_TEMPLATES neu erzeugt.`);
}
