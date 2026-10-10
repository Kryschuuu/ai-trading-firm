#!/usr/bin/env node
/**
 * DC-07 — erzeugt `docs/generated/schema-inventory.md` **deterministisch**
 * aus `src/db/schema.ts` und `drizzle/*.sql`.
 *
 * Warum generiert und nicht handgeschrieben: die Inventar-Tabelle muss
 * jede der inzwischen 67 `pgTable(...)`-Definitionen aufführen — sonst
 * driftet die Doku binnen weniger Migrations-Pakete wieder ab (Befund
 * DC-07: 15 von 67 Tabellen dokumentiert). Die Generierung ist
 * idempotent (byte-identisch bei zweitem Lauf), LF-Zeilenenden und
 * ohne Zeitstempel; das "Stand"-Datum kommt ausschließlich aus der
 * Umgebungsvariable `SCHEMA_INVENTORY_STAND` (optional).
 *
 *   npm run docs:inventories
 *   npm run docs:inventories:check   # Idempotenz-Check (Exit != 0 bei Drift)
 *
 * Die 15 "Ur-Tabellen" (risk_config … equity_snapshots) haben keine
 * eigene SQL-Migrations-Datei — sie wurden mit dem ersten Schema-Snapshot
 * ausgerollt und sind in der Inventar-Spalte mit "(initial)" markiert.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ─────────────────────────────────────────────────────────────────────────────
// Pfade
// ─────────────────────────────────────────────────────────────────────────────
const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(here, "..");
const SCHEMA_FILE = path.join(REPO, "src", "db", "schema.ts");
const MIGRATIONS_DIR = path.join(REPO, "drizzle");
const OUT_DIR = path.join(REPO, "docs", "generated");
const OUT_FILE = path.join(OUT_DIR, "schema-inventory.md");

// ─────────────────────────────────────────────────────────────────────────────
// Parser für src/db/schema.ts: pgTable-Definitionen + TSDoc-Kopf
// ─────────────────────────────────────────────────────────────────────────────

interface TableEntry {
  /** Zeile der `export const … = pgTable(`-Zeile (1-basiert). */
  line: number;
  /** TypeScript-Export-Name (z. B. `riskConfig`). */
  exportName: string;
  /** PostgreSQL-Tabellenname (String-Literal in pgTable, z. B. `risk_config`). */
  pgName: string;
  /** Anzahl Spalten (einfache Zählung der `:`-getypten Felder im ersten Argument-Block). */
  columns: number;
  /** Erste Zeile des TSDoc-Blocks über der Export-Zeile, oder "" wenn keiner da ist. */
  purpose: string;
  /** Migrationsdatei(en), die die Tabelle per CREATE TABLE anlegen (nur Dateiname). */
  migrations: string[];
}

/** Liest schema.ts und extrahiert alle pgTable-Definitionen in Dateireihenfolge. */
function parseSchema(source: string): Omit<TableEntry, "migrations">[] {
  const lines = source.split(/\r?\n/);
  const out: Omit<TableEntry, "migrations">[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // `export const <name> = pgTable( … )` – fange sowohl einzeiligen
    // `pgTable("name", {` als auch mehrzeiligen `pgTable(\n  "name",\n  {`-Aufruf ab.
    const m = line.match(/^export\s+const\s+([A-Za-z0-9_$]+)\s*=\s*pgTable\s*\(/);
    if (!m) continue;

    const exportName = m[1];
    const startLine = i; // 0-basiert; an Aufrufer als 1-basierte Zeile melden
    const pgName = extractPgTableName(lines, i);
    if (!pgName) continue;

    // TSDoc-Block VOR dieser export-Zeile suchen (schließt andere Exporte/
    // leere Zeilen aus, indem wir rückwärts bis zur ersten nicht-leeren
    // Nicht-Kommentar-Zeile laufen — nur der unmittelbar anschließende
    // Block ist der Tabellen-TSDoc).
    const purpose = extractPurpose(lines, startLine);

    // Spalten zählen: im Rumpf zwischen dem ersten `{` nach pgTable(...)
    // und dem zugehörigen `},` (das zweite Argument beginnt meist mit
    // `}, (table) => [ … ]`). Wir zählen Zeilen, die mit "  foo:" anfangen
    // (zwei Leerzeichen, Bezeichner, Doppelpunkt) — robust gegen Kommentare.
    const columns = countColumns(lines, i);

    out.push({
      line: startLine + 1, // 1-basiert für Menschen
      exportName,
      pgName,
      columns,
      purpose,
    });
  }

  return out;
}

/**
 * Sucht das String-Literal des PostgreSQL-Tabellennamens im pgTable-Aufruf,
 * sowohl einzeilig (`pgTable("risk_config", {`) als auch mehrzeilig
 * (`pgTable(\n  "trade_journal",\n  {`).
 */
function extractPgTableName(lines: string[], startIdx: number): string | null {
  // Prüfe erst die Startzeile selbst (einzeiliger Aufruf).
  let m = lines[startIdx].match(/pgTable\s*\(\s*"([^"]+)"/);
  if (m) return m[1];
  // Sonst: nachfolgende Zeilen durchsuchen bis wir das erste String-Literal
  // nach `pgTable(` finden (höchstens 5 Zeilen, um bei Fehlern nicht ewig
  // zu laufen).
  for (let j = startIdx + 1; j < Math.min(startIdx + 6, lines.length); j++) {
    m = lines[j].match(/^\s*"([^"]+)"\s*,?\s*$/);
    if (m) return m[1];
  }
  return null;
}

/**
 * Extracts the first summary line of the JSDoc/TSDoc block immediately
 * preceding the `export const X = pgTable(...)` declaration. Returns ""
 * if there is no such block. Inline block comments on fields are ignored.
 *
 * Walks backward from `declIdx` (0-based): skips blank lines, then reads
 * a contiguous block of comment lines starting with "/**" and ending with "*\/".
 */
function extractPurpose(lines: string[], declIdx: number): string {
  let i = declIdx - 1;
  // Leerzeilen/Decorator-Zeilen über dem Export übergehen.
  while (i >= 0 && /^\s*$/.test(lines[i])) i--;
  if (i < 0) return "";
  if (!/^\s*\*\/\s*$/.test(lines[i])) return ""; // Block muss mit `*/` enden.
  const end = i;
  i--;
  const blockLines: string[] = [];
  let started = false;
  while (i >= 0) {
    const l = lines[i];
    if (/^\s*\/\*\*/.test(l)) {
      // Startzeile des Blocks: `/** …` oder `/**`.
      started = true;
      const rest = l.replace(/^\s*\/\*\*/, "").replace(/\*\/\s*$/, "").trim();
      if (rest) blockLines.unshift(rest);
      break;
    }
    if (/^\s*\*/.test(l)) {
      const content = l.replace(/^\s*\*\/?/, "").trim();
      blockLines.unshift(content);
      i--;
      continue;
    }
    // Irgendwas anderes: kein zusammenhängender Block.
    break;
  }
  if (!started) return "";
  // TSDoc-Summary: die ersten Zeilen bis zur ersten Leerzeile im Block
  // (erster Absatz), zusammengefügt — das Projekt nutzt harte Zeilenumbrüche
  // bei ~80 Zeichen, daher ist die alleinige "erste Quellzeile" oft mittendrin
  // abgeschnitten. Wir kappen bei dem ersten Satzende-Punkt (". ") bzw. bei
  // einer Obergrenze, damit die Zelle nicht den Tabellenkörper sprengt.
  const paragraph: string[] = [];
  for (const bl of blockLines) {
    if (!bl) break;
    paragraph.push(bl);
    if (/[.!?]\s*$/.test(bl)) break;
  }
  const joined = paragraph.join(" ").replace(/\s+/g, " ").trim();
  if (!joined) return "";
  // Auf eine sinnvolle Länge kürzen (keine Abschneidung mitten im Wort).
  const MAX = 110;
  if (joined.length <= MAX) return joined;
  const cut = joined.slice(0, MAX);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 40 ? cut.slice(0, lastSpace) : cut) + " …";
}

/**
 * Zählt Spalten im ersten Objekt-Literal des pgTable-Aufrufs.
 * Strategie: vorwärts gehen bis zum ersten `{` nach pgTableName,
 * dann Klammer-Ebene für `{}` mitzählen und bei jeder Ebene-1-Zeile,
 * die wie ein Feld aussieht (`  identifier:` oder `  "identifier":`),
 * den Zähler hochsetzen. Stoppt, wenn die `}` die erste öffnende Klammer
 * wieder schließt — das ist das Ende des Spalten-Objekts vor der
 * optionalen Index-/Constraints-Tabelle (zweites Argument).
 */
function countColumns(lines: string[], startIdx: number): number {
  // Finde das öffnende `{` des Spaltenobjekts. Beginne in der Startzeile
  // nach dem pgTable(...) und suche bis zu 30 Zeilen vorwärts.
  let i = startIdx;
  let depth = 0;
  let foundOpen = false;
  let count = 0;
  const fieldRe = /^\s{2,}[A-Za-z_$][A-Za-z0-9_$]*\s*:/;
  const fieldQuotedRe = /^\s{2,}"[A-Za-z_$][A-Za-z0-9_$]*"\s*:/;
  for (; i < Math.min(startIdx + 400, lines.length); i++) {
    const l = lines[i];
    for (let c = 0; c < l.length; c++) {
      const ch = l[c];
      if (ch === "{") {
        depth++;
        if (depth === 1) foundOpen = true;
      } else if (ch === "}") {
        depth--;
        if (foundOpen && depth === 0) {
          return count;
        }
      }
    }
    if (foundOpen && depth >= 1) {
      // Zähle Feld-Zeilen NUR auf Ebene des Spaltenobjekts (depth === 1).
      // Indizes/Constraints im zweiten Argument haben depth >= 2.
      if (depth === 1 && (fieldRe.test(l) || fieldQuotedRe.test(l))) {
        count++;
      }
    }
  }
  return count;
}

// ─────────────────────────────────────────────────────────────────────────────
// Migration-Scan: für jede Tabelle die Datei(en) ermitteln, die sie anlegen
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parst alle drizzle/*.sql-Dateien in lexikalischer Reihenfolge (die
 * Migrationen sind nach Datum sortiert, das ist die gewünschte stabile
 * Reihenfolge) und gibt eine Map pgTableName -> Migrationsdateiname[]
 * zurück. Eine Tabelle kann in mehr als einer Datei auftauchen (selten
 * bei DROP+CREATE, idempotente Skripte ignorieren wir nicht).
 */
function scanMigrations(): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort(); // lexikalisch = Datumsreihenfolge, stabil

  const createRe = /create\s+table(?:\s+if\s+not\s+exists)?\s+(?:"([^"]+)"|([a-z_][a-z0-9_]*))/gi;

  for (const file of files) {
    const full = path.join(MIGRATIONS_DIR, file);
    const sql = readFileSync(full, "utf8");
    let m: RegExpExecArray | null;
    createRe.lastIndex = 0;
    const seenInFile = new Set<string>();
    while ((m = createRe.exec(sql)) !== null) {
      const name = m[1] ?? m[2];
      if (!name || seenInFile.has(name)) continue;
      seenInFile.add(name);
      const list = map.get(name);
      if (list) list.push(file);
      else map.set(name, [file]);
    }
  }
  return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// Markdown-Rendering
// ─────────────────────────────────────────────────────────────────────────────

function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function renderMarkdown(tables: TableEntry[], standDate: string): string {
  // Die Datei liegt in docs/generated/, also zwei Ebenen über dem Repo-Root.
  const SRC_REF = "../../src/db/schema.ts";
  const DRIZZLE_REF = "../../drizzle";

  // Hinweis: wir verlinken auf schema.ts ohne `#L<Zeile>`-Anker, weil der
  // Docs-Viewer nur Markdown-Anker auflöst und der Link-Check sonst jeden
  // Zeilenanker als "tot" meldet. Die Zeilennummer steht als Klartext im
  // Link-Text und wird bei Generierung stets synchron gehalten.
  const rows = tables.map((t) => {
    const lineRef = `[\`schema.ts:${t.line}\`](${SRC_REF})`;
    const migCell = t.migrations.length > 0
      ? t.migrations.map((m) => `[\`${m}\`](${DRIZZLE_REF}/${m})`).join(", ")
      : "*(initial)*";
    const purpose = t.purpose ? cell(t.purpose) : "—";
    return `| \`${t.pgName}\` | ${lineRef} | ${t.columns} | ${migCell} | ${purpose} |`;
  });

  const standLine = standDate ? `**Stand:** ${standDate}  \n` : "";
  return [
    "# Schema-Inventar (generiert)",
    "",
    "<!-- GENERIERT — nicht editieren (`npm run docs:inventories`). -->",
    "",
    "> **GENERIERT — nicht editieren** (`npm run docs:inventories`)",
    `> — Quelle: [\`src/db/schema.ts\`](${SRC_REF}) + [\`drizzle/*.sql\`](${DRIZZLE_REF}/)`,
    "> — Pflegehinweise: ändere TSDoc/Schema im Code und lasse das Skript neu laufen.",
    "",
    standLine + `Insgesamt **${tables.length}** \`pgTable\`-Definitionen. Tabellen, die keine ` +
      "Migrationsdatei nennen, wurden bereits im Initial-Setup ausgerollt (\"`(initial)`\").",
    "",
    "| Tabelle | Quelle (schema.ts-Zeile) | Spalten | Migrationsdatei(en) | Zweck (TSDoc-Kurzform) |",
    "| --- | --- | ---:| --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

export interface GenerateResult {
  file: string;
  count: number;
  initialCount: number;
  migratedCount: number;
  withoutPurpose: number;
}

export function generateInventory(): GenerateResult {
  const source = readFileSync(SCHEMA_FILE, "utf8");
  const parsed = parseSchema(source);
  const migrations = scanMigrations();

  const tables: TableEntry[] = parsed.map((p) => ({
    ...p,
    migrations: migrations.get(p.pgName) ?? [],
  }));

  // Sortierung ist bereits stabil (Dateireihenfolge des Parsers) — nichts sortieren.

  const standDate = process.env.SCHEMA_INVENTORY_STAND?.trim() ?? "";
  const md = renderMarkdown(tables, standDate);

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, md, { encoding: "utf8", flag: "w" });

  const initialCount = tables.filter((t) => t.migrations.length === 0).length;
  const migratedCount = tables.length - initialCount;
  const withoutPurpose = tables.filter((t) => !t.purpose).length;
  return {
    file: OUT_FILE,
    count: tables.length,
    initialCount,
    migratedCount,
    withoutPurpose,
  };
}

/** Idempotenz-Check: Datei schreiben, dann vergleichen ob sie sich änderte. */
export function checkInventory(): { ok: boolean; detail: string } {
  const before = readFileSync(OUT_FILE, "utf8");
  const r = generateInventory();
  const after = readFileSync(OUT_FILE, "utf8");
  // Beim Check soll der ggf. vorhandene Stand-Datum-Eintrag ignoriert werden,
  // damit er im CI nie zu einem falschen Negativ führt — wir vergleichen
  // ohne die "**Stand:** …"-Zeile.
  const stripStand = (s: string) => s.replace(/^\*\*Stand:\*\*[^\n]*\n?/m, "");
  const ok = stripStand(before) === stripStand(after);
  return {
    ok,
    detail: ok
      ? `${r.count} Tabellen, Inventar ist aktuell.`
      : `schema-inventory.md ist nicht aktuell — bitte \`npm run docs:inventories\` ausführen.`,
  };
}

// Direktstart.
const invokedAsScript =
  typeof process.argv[1] === "string" && process.argv[1].endsWith("gen-schema-inventory.ts");

if (invokedAsScript) {
  const mode = process.argv.includes("--check") ? "check" : "generate";
  if (mode === "check") {
    const res = checkInventory();
    if (res.ok) {
      console.log(`[docs:inventories:check] OK — ${res.detail}`);
      process.exit(0);
    } else {
      console.error(`[docs:inventories:check] FAIL — ${res.detail}`);
      process.exit(1);
    }
  } else {
    const r = generateInventory();
    const rel = path.relative(REPO, r.file);
    console.log(
      `[docs:inventories] ${rel} geschrieben (${r.count} Tabellen: ` +
        `${r.migratedCount} aus Migrationen, ${r.initialCount} initial, ` +
        `${r.withoutPurpose} ohne TSDoc-Zweck).`,
    );
  }
}
