#!/usr/bin/env node
/**
 * DC-09 — erzeugt die generierten Mengen-Inventare unter `docs/generated/`
 * **deterministisch** aus dem Code:
 *
 *   - `route-inventory.md`   — `src/app/api/**\/route.ts`: Methoden + Guard-Klasse
 *   - `env-inventory.md`     — `process.env`-Reads vs. `.env.example` vs. `CONFIGURATION.md`
 *   - `schema-inventory.md`  — `src/db/schema.ts` + `drizzle/*.sql` (Renderer: gen-schema-inventory.ts)
 *
 * Warum generiert: DC-04 (41 falsche Header), DC-05 (Flags ohne Read) und DC-07
 * (15 von 67 Tabellen) sind Drift von Hand gepflegter Mengenverzeichnisse. Dasselbe
 * Muster schützt `docs/STRATEGY_TEMPLATES.md` seit STX-03-10.
 *
 * Eigenschaften:
 *   - Byte-deterministisch: LF, stabile Sortierung, keine Zeitstempel.
 *   - Das Stand-Datum kommt **nur** aus `--stand <DATUM>`. Ohne Angabe fehlt die
 *     Zeile, damit der Vergleich nicht an Datumsänderungen scheitert.
 *   - `--check` schreibt **nichts** in das Repo: Es rendert im Speicher und vergleicht
 *     mit dem committed Stand. Exit 1 bei Abweichung.
 *
 * Aufruf:
 *   npm run docs:inventories                      # schreiben
 *   npm run docs:inventories:check                # Drift-Prüfung (CI)
 *   node --import tsx scripts/gen-docs-inventories.ts --stand 2026-10-10
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ENV_DOC_NON_RUNTIME_WHITELIST,
  ENV_READ_PATTERN_PREFIX,
  apiRouteFiles,
  codeSourceFiles,
  documentedEnvFlagsFromDocs,
  envExampleKeys,
  envReadCoversName,
  envReadsFromCode,
  extractFlagTableNames,
  textFilesFromPaths,
  walkFiles,
  type TextFile,
} from "./docs-validate-checks";
import { renderSchemaInventory } from "./gen-schema-inventory";

// ─────────────────────────────────────────────────────────────────────────────
// Pfade
// ─────────────────────────────────────────────────────────────────────────────
const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(here, "..");
const OUT_DIR = path.join(REPO, "docs", "generated");
const API_DIR = path.join(REPO, "src", "app", "api");

/** Einheitliche Kopfzeile aller generierten Inventare. */
const GENERATED_HEADER = "<!-- GENERIERT — nicht editieren (`npm run docs:inventories`). -->";

// ─────────────────────────────────────────────────────────────────────────────
// Gemeinsame Helfer
// ─────────────────────────────────────────────────────────────────────────────

/** Markdown-Tabellenzelle: Pipes maskieren, Zeilenumbrüche entfernen. */
const cell = (value: string): string => value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();

/** Stand-Zeile nur, wenn ein Datum übergeben wurde. */
const standLine = (standDate: string): string => (standDate ? `**Stand:** ${standDate}  \n` : "");

const readText = (file: string): string => (existsSync(file) ? readFileSync(file, "utf8") : "");

/** Wortgenaue Erwähnung eines Env-Namens (nicht Teil eines längeren Namens). */
const mentions = (text: string, name: string): boolean =>
  new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`).test(text);

// ─────────────────────────────────────────────────────────────────────────────
// Route-Inventar
// ─────────────────────────────────────────────────────────────────────────────

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];
const WRITE_METHODS: ReadonlySet<HttpMethod> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Gesichtete schreibende Handler ohne sichtbaren Guard. Jeder Eintrag braucht
 * eine Begründung; `--check` schlägt fehl bei **neuen** ungesichteten Routen
 * und bei **veralteten** Einträgen (Route existiert nicht mehr / ist jetzt
 * geschützt). Damit ist die Warnzeile kein stiller Hinweis, sondern ein Gate.
 */
export const REVIEWED_UNGUARDED_WRITES: ReadonlyMap<string, string> = new Map([
  [
    "POST /api/auth/login",
    "Anmeldung selbst: die Credential-Prüfung ist die Authentisierung; Rate-Limit im Handler.",
  ],
  [
    "POST /api/auth/refresh",
    "Session-Erneuerung: Session-Cookie + Double-Submit-CSRF in `renewSession` (src/lib/authSession.ts), Rate-Limit im Handler.",
  ],
  [
    "POST /api/portfolio/correlation",
    "Reine Berechnung auf übergebenen Daten — keine Persistenz, keine Seiteneffekte.",
  ],
  [
    "POST /api/portfolio/metrics",
    "Reine Berechnung auf übergebenen Daten — keine Persistenz, keine Seiteneffekte.",
  ],
  [
    "POST /api/portfolio/optimize",
    "Reine Berechnung auf übergebenen Daten — keine Persistenz, keine Seiteneffekte.",
  ],
]);

interface MethodGuard {
  method: HttpMethod;
  /** Anzeige, z. B. `requirePermission(firm.write) + CSRF` oder `keiner`. */
  guard: string;
  /** Ob mindestens eine Auth-/Guard-Funktion im Handler-Rumpf vorkommt. */
  guarded: boolean;
}

export interface RouteRow {
  urlPath: string;
  source: string; // repo-relativ, POSIX
  methods: MethodGuard[];
}

/** Liefert die exportierten HTTP-Handler einer `route.ts` (Next.js App Router). */
function exportedMethods(source: string): HttpMethod[] {
  const found = new Set<HttpMethod>();
  for (const m of source.matchAll(/^export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\s*\(/gm)) {
    found.add(m[1] as HttpMethod);
  }
  return HTTP_METHODS.filter((method) => found.has(method));
}

/** Rumpf einer `export function <METHOD>(…)`-Definition (Klammerzählung). */
function handlerBody(source: string, method: HttpMethod): string {
  const sig = new RegExp(`export\\s+(?:async\\s+)?function\\s+${method}\\s*\\(`).exec(source);
  return sig ? bodyFrom(source, sig.index) : "";
}

/** Index der schließenden Klammer zu der öffnenden Klammer bei `open`. */
function matchingClose(source: string, open: number, pair: [string, string]): number {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === pair[0]) depth++;
    else if (source[i] === pair[1] && --depth === 0) return i;
  }
  return source.length - 1;
}

/** Rumpf einer Funktion/Arrow ab Deklarationsindex (Parameterliste überspringen). */
function bodyFrom(source: string, declIndex: number): string {
  const paren = source.indexOf("(", declIndex);
  const afterParams = paren >= 0 ? matchingClose(source, paren, ["(", ")"]) + 1 : declIndex;
  const arrow = source.slice(afterParams, afterParams + 200).match(/^[^{;]*?=>\s*/);
  const open = arrow ? afterParams + arrow[0].length : source.indexOf("{", afterParams);
  if (open < 0 || source[open] !== "{") {
    // Ausdrucks-Arrow ohne Block: bis zum Zeilenende.
    const end = source.indexOf("\n", open < 0 ? afterParams : open);
    return source.slice(open < 0 ? afterParams : open, end < 0 ? undefined : end);
  }
  return source.slice(open, matchingClose(source, open, ["{", "}"]) + 1);
}

/** Rumpf einer lokal oder exportiert definierten Funktion/Konstante `name`. */
function definitionBody(source: string, name: string): string | null {
  const re = new RegExp(
    `(?:^|\\n)\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*[<(]|(?:^|\\n)\\s*(?:export\\s+)?const\\s+${name}\\s*=`,
  );
  const m = re.exec(source);
  return m ? bodyFrom(source, m.index) : null;
}

/** Benannte Imports: lokaler Name → (Originalname, Modulpfad). */
function namedImports(source: string): Map<string, { orig: string; spec: string }> {
  const out = new Map<string, { orig: string; spec: string }>();
  for (const m of source.matchAll(/import\s+(?:type\s+)?\{([^}]+)\}\s*from\s*"([^"]+)"/g)) {
    for (const part of m[1].split(",")) {
      const t = part.trim().replace(/^type\s+/, "");
      if (!t) continue;
      const [orig, local] = t.split(/\s+as\s+/);
      out.set((local ?? orig).trim(), { orig: orig.trim(), spec: m[2] });
    }
  }
  return out;
}

/** Modulpfad (`@/…` oder relativ) → Datei, oder null (externe Pakete). */
function resolveModule(fromFile: string, spec: string): string | null {
  const base = spec.startsWith("@/")
    ? path.join(REPO, "src", spec.slice(2))
    : spec.startsWith(".")
      ? path.resolve(path.dirname(fromFile), spec)
      : null;
  if (!base) return null;
  for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), base]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * Sucht `name` in `file`: zuerst lokal definiert, sonst über Import bzw.
 * Re-Export (`export { x } from "…"`). Liefert Quelltext + Datei des Treffers.
 */
function locateDefinition(file: string, name: string, depth: number): { file: string; body: string } | null {
  if (depth > 4 || !existsSync(file)) return null;
  const source = readFileSync(file, "utf8");
  const local = definitionBody(source, name);
  if (local !== null) return { file, body: local };
  const imported = namedImports(source).get(name);
  if (imported) {
    const target = resolveModule(file, imported.spec);
    if (target) return locateDefinition(target, imported.orig, depth + 1);
  }
  for (const m of source.matchAll(/export\s*\{([^}]+)\}\s*from\s*"([^"]+)"/g)) {
    for (const part of m[1].split(",")) {
      const [orig, exported] = part.trim().split(/\s+as\s+/);
      if ((exported ?? orig).trim() !== name) continue;
      const target = resolveModule(file, m[2]);
      if (target) return locateDefinition(target, orig.trim(), depth + 1);
    }
  }
  return null;
}

/**
 * Sammelt die Guard-Klassen eines Rumpfs. Bekannte Guards werden direkt
 * benannt; alle anderen Aufrufe werden (bis Tiefe 4) über lokale Definitionen
 * und Imports verfolgt — so landen Wrapper wie `guardCredentialEndpoint` nicht
 * fälschlich als „keiner“.
 */
function collectGuards(file: string, body: string, depth: number, seen: Set<string>, out: string[]): void {
  const add = (label: string) => {
    if (!out.includes(label)) out.push(label);
  };
  for (const m of body.matchAll(/requirePermission\s*\(\s*[\w.]+\s*,\s*([^)]+)\)/g)) {
    const arg = m[1].trim();
    const literal = /^"([^"]+)"$/.exec(arg);
    add(literal ? `requirePermission(${literal[1]})` : "requirePermission(dynamisch)");
  }
  if (/\bcheckCsrfGuard\s*\(/.test(body)) add("CSRF");
  if (/\bguardWrite\s*\(/.test(body)) add("guardWrite");
  if (/\bcheckApiToken\s*\(/.test(body)) add("checkApiToken");

  if (depth >= 4) return;
  const known = new Set(["requirePermission", "checkCsrfGuard", "guardWrite", "checkApiToken"]);
  const KEYWORDS = new Set(["if", "for", "while", "switch", "return", "catch", "function", "typeof", "await", "new"]);
  const names = new Set<string>();
  for (const m of body.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) names.add(m[1]);
  for (const name of names) {
    if (known.has(name) || KEYWORDS.has(name) || seen.has(`${file}#${name}`)) continue;
    seen.add(`${file}#${name}`);
    const def = locateDefinition(file, name, 0);
    if (def) collectGuards(def.file, def.body, depth + 1, seen, out);
  }
}

/** Guard-Labels eines Handlers; leer ⇒ „keiner“. */
function classifyGuard(routeFile: string, body: string): string[] {
  const out: string[] = [];
  collectGuards(routeFile, body, 0, new Set(), out);
  return out;
}

function scanRoutes(): RouteRow[] {
  return apiRouteFiles(API_DIR).map(({ urlPath, file }) => {
    const source = readFileSync(file, "utf8");
    const methods = exportedMethods(source).map((method): MethodGuard => {
      const parts = classifyGuard(file, handlerBody(source, method));
      return {
        method,
        guard: parts.length > 0 ? parts.join(" + ") : "keiner",
        guarded: parts.length > 0,
      };
    });
    return { urlPath, source: path.relative(REPO, file).split(path.sep).join("/"), methods };
  });
}

export function renderRouteInventory(routes: readonly RouteRow[], standDate: string): string {
  const rows: string[] = [];
  const unguardedWrites: string[] = [];
  for (const route of routes) {
    for (const m of route.methods) {
      const unguardedWrite = WRITE_METHODS.has(m.method) && !m.guarded;
      if (unguardedWrite) unguardedWrites.push(`\`${m.method} ${route.urlPath}\``);
      const marker = unguardedWrite ? " ⚠️" : "";
      rows.push(
        `| \`${route.urlPath}\` | \`${m.method}\`${marker} | ${cell(m.guard)} | [\`${route.source}\`](../../${route.source}) |`,
      );
    }
  }
  const methodCount = routes.reduce((sum, r) => sum + r.methods.length, 0);

  // Pflicht-Warnzeile (DC-09): schreibende Methode ohne Guard fällt sofort auf.
  const warning =
    unguardedWrites.length > 0
      ? [
          `> ⚠️ **WARNUNG — schreibend ohne Guard (Rückfall zu DC-01):** ${unguardedWrites.join(", ")}. ` +
            "Guard prüfen (`requirePermission`/`guardWrite`/`checkCsrfGuard`) oder begründen.",
          "",
        ].join("\n")
      : "";

  return [
    "# Routen-Inventar (generiert)",
    "",
    GENERATED_HEADER,
    "",
    "> **GENERIERT — nicht editieren** (`npm run docs:inventories`)",
    "> — Quelle: [`src/app/api/**/route.ts`](../../src/app/api/)",
    "> — Guard-Klasse: `requirePermission(<Permission>)` · `guardWrite` · `checkApiToken` · `CSRF` (`checkCsrfGuard`) · `keiner`",
    "",
    standLine(standDate) +
      `Insgesamt **${routes.length}** Routen mit **${methodCount}** HTTP-Handlern.`,
    "",
    warning +
      [
        "| Route | Methode | Guard-Klasse | Quelle |",
        "| --- | --- | --- | --- |",
        ...rows,
        "",
      ].join("\n"),
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Env-Inventar
// ─────────────────────────────────────────────────────────────────────────────

export function renderEnvInventory(inputs: EnvInputs, standDate: string): string {
  const { reads, exampleText, configText, docs, installDocs } = inputs;

  const inExample = envExampleKeys(exampleText);
  const inConfig = extractFlagTableNames(configText);
  // Dokumentiert in Install-Guides und CONFIGURATION (Flag-Tabellen + Inline-Namen).
  const documentedInGuides = documentedEnvFlagsFromDocs(installDocs, exampleText);
  const documented = new Set<string>([...inExample, ...inConfig, ...documentedInGuides]);

  const patternReads = [...reads].filter((n) => n.startsWith(ENV_READ_PATTERN_PREFIX)).length;
  const concreteReads = [...reads].filter((n) => !n.startsWith(ENV_READ_PATTERN_PREFIX));
  const names = [...new Set([...concreteReads, ...documented])].sort();

  const isRead = (name: string) => envReadCoversName(reads, name);
  const allowlisted = (name: string) => ENV_DOC_NON_RUNTIME_WHITELIST.has(name);

  // gelesen, aber nirgends dokumentiert (auch nicht in docs/**)
  const allDocsText = docs.map((d) => d.content).join("\n") + "\n" + configText + "\n" + exampleText;
  const readUndocumented = concreteReads
    .filter((name) => !documented.has(name) && !mentions(allDocsText, name))
    .sort();
  // dokumentiert (Example/Config/Install), aber kein statischer Read
  const documentedUnread = [...documented]
    .filter((name) => !isRead(name) && !allowlisted(name))
    .sort();

  const rows = names.map((name) => {
    const r = isRead(name) ? "✅" : "—";
    const e = inExample.has(name) ? "✅" : "—";
    const c = mentions(configText, name) ? "✅" : "—";
    return `| \`${name}\` | ${r} | ${e} | ${c} |`;
  });

  const warnings = [
    readUndocumented.length > 0
      ? `> ⚠️ **gelesen, aber nirgends dokumentiert** (${readUndocumented.length}): ` +
        readUndocumented.map((n) => `\`${n}\``).join(", ")
      : "",
    documentedUnread.length > 0
      ? `> ⚠️ **dokumentiert, aber kein Read** (${documentedUnread.length}): ` +
        documentedUnread.map((n) => `\`${n}\``).join(", ")
      : "",
  ]
    .filter(Boolean)
    .map((line) => `${line}\n`)
    .join("");

  return [
    "# Env-Inventar (generiert)",
    "",
    GENERATED_HEADER,
    "",
    "> **GENERIERT — nicht editieren** (`npm run docs:inventories`)",
    "> — Quelle: statische `process.env`-Reads (`src/**`, `scripts/**`, Root-TS) mit den Idiomen aus `docs-validate-checks.ts`",
    "> — Abgleich: [`.env.example`](../../.env.example), [`CONFIGURATION.md`](../../CONFIGURATION.md), Install-Guides",
    "> — Pflege: neues Flag mit `env*`-Helper lesen, in `.env.example` und `CONFIGURATION.md` eintragen, Skript neu laufen lassen.",
    "",
    standLine(standDate) +
      `Insgesamt **${names.length}** Env-Namen (gelesen und/oder dokumentiert). ` +
      `Dynamische Namensräume (Muster \`env[…]\`): ${patternReads} — über die Musterprüfung ` +
      "abgedeckt, nicht einzeln gelistet.",
    "",
    warnings + (warnings ? "\n" : ""),
    [
      "| Flag | gelesen | in `.env.example` | in `CONFIGURATION.md` |",
      "| --- | :---: | :---: | :---: |",
      ...rows,
      "",
    ].join("\n"),
  ].join("\n");
}

interface EnvInputs {
  reads: Set<string>;
  exampleText: string;
  configText: string;
  installDocs: TextFile[];
  docs: TextFile[];
}

function collectEnvInputs(): EnvInputs {
  const codeFiles = textFilesFromPaths(codeSourceFiles(REPO), REPO);
  const docFiles = [
    ...walkFiles(path.join(REPO, "docs")).filter((f) => f.endsWith(".md")),
    path.join(REPO, "CONFIGURATION.md"),
    path.join(REPO, "INSTALL.md"),
    path.join(REPO, "README.md"),
  ].filter(existsSync);
  const installFiles = [path.join(REPO, "INSTALL.md"), path.join(REPO, "docs", "INSTALL.md")].filter(existsSync);
  const configFile = path.join(REPO, "CONFIGURATION.md");
  return {
    reads: envReadsFromCode(codeFiles),
    exampleText: readText(path.join(REPO, ".env.example")),
    configText: readText(configFile),
    installDocs: textFilesFromPaths(installFiles, REPO),
    docs: textFilesFromPaths(docFiles, REPO),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrierung
// ─────────────────────────────────────────────────────────────────────────────

export interface GeneratedDoc {
  /** Dateiname unter docs/generated/. */
  name: string;
  content: string;
}

/** Rendert alle Inventare im Speicher. Schreibt nichts. */
export function renderAllInventories(standDate = ""): GeneratedDoc[] {
  const schema = renderSchemaInventory(standDate);
  return [
    { name: "route-inventory.md", content: renderRouteInventory(scanRoutes(), standDate) },
    { name: "env-inventory.md", content: renderEnvInventory(collectEnvInputs(), standDate) },
    { name: "schema-inventory.md", content: schema.markdown },
  ];
}

/** Abgleich ungesichteter schreibender Routen mit `REVIEWED_UNGUARDED_WRITES`. */
export function reviewedWriteProblems(routes: readonly RouteRow[]): string[] {
  const unguarded = new Set<string>();
  for (const r of routes) {
    for (const m of r.methods) {
      if (WRITE_METHODS.has(m.method) && !m.guarded) unguarded.add(`${m.method} ${r.urlPath}`);
    }
  }
  const problems: string[] = [];
  for (const key of [...unguarded].sort()) {
    if (!REVIEWED_UNGUARDED_WRITES.has(key)) {
      problems.push(`${key}: schreibend ohne Guard und nicht gesichtet — Guard ergänzen oder in REVIEWED_UNGUARDED_WRITES mit Begründung aufnehmen (scripts/gen-docs-inventories.ts)`);
    }
  }
  for (const key of REVIEWED_UNGUARDED_WRITES.keys()) {
    if (!unguarded.has(key)) {
      problems.push(`${key}: Eintrag in REVIEWED_UNGUARDED_WRITES ist veraltet (Route fehlt oder ist jetzt geschützt) — Eintrag entfernen`);
    }
  }
  return problems;
}

/** Entfernt die optionale Stand-Zeile, damit Datumsänderungen keine Drift sind. */
const withoutStand = (s: string): string => s.replace(/^\*\*Stand:\*\*[^\n]*\n?/m, "");

/**
 * Drift-Prüfung: vergleicht die Neu-Erzeugung mit dem committed Stand.
 * Schreibt nicht ins Repo.
 */
export function checkInventories(): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  problems.push(...reviewedWriteProblems(scanRoutes()));
  for (const doc of renderAllInventories("")) {
    const file = path.join(OUT_DIR, doc.name);
    if (!existsSync(file)) {
      problems.push(`docs/generated/${doc.name} fehlt — \`npm run docs:inventories\` ausführen`);
      continue;
    }
    if (withoutStand(readFileSync(file, "utf8")) !== withoutStand(doc.content)) {
      problems.push(`docs/generated/${doc.name} weicht vom Generat ab — \`npm run docs:inventories\` ausführen und committen`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/** Schreibt alle Inventare nach docs/generated/. */
export function writeInventories(standDate = ""): string[] {
  mkdirSync(OUT_DIR, { recursive: true });
  const written: string[] = [];
  for (const doc of renderAllInventories(standDate)) {
    const file = path.join(OUT_DIR, doc.name);
    writeFileSync(file, doc.content, { encoding: "utf8" });
    written.push(path.relative(REPO, file));
  }
  return written;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

const invokedAsScript =
  typeof process.argv[1] === "string" && process.argv[1].endsWith("gen-docs-inventories.ts");

if (invokedAsScript) {
  if (process.argv.includes("--check")) {
    const res = checkInventories();
    if (res.ok) {
      console.log("[docs:inventories:check] OK — alle generierten Inventare sind aktuell.");
      process.exit(0);
    }
    console.error(`[docs:inventories:check] FAIL — ${res.problems.join(" | ")}`);
    process.exit(1);
  }
  const standIdx = process.argv.indexOf("--stand");
  const standDate = standIdx >= 0 ? (process.argv[standIdx + 1] ?? "").trim() : "";
  if (standIdx >= 0 && !/^\d{4}-\d{2}-\d{2}$/.test(standDate)) {
    console.error("[docs:inventories] --stand erwartet ein Datum im Format YYYY-MM-DD");
    process.exit(2);
  }
  const written = writeInventories(standDate);
  console.log(`[docs:inventories] geschrieben: ${written.join(", ")}`);
}
