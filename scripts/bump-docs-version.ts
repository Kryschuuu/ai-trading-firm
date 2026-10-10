#!/usr/bin/env node
/**
 * DC-09 — synchronisiert die **Code-Version**-Header der Fachdokumente auf die
 * Version in `package.json`.
 *
 *   node --import tsx scripts/bump-docs-version.ts --dry-run   # zeigt geplante Änderungen
 *   node --import tsx scripts/bump-docs-version.ts --write     # schreibt sie
 *
 * Zwei Header-Arten (siehe CONTRIBUTING.md, „Zwei Header-Arten“):
 *   - `Code-Version`     → Modulstand, von diesem Skript und `docs:validate` (L3) geprüft.
 *   - `Dokument-Version` → eigene Vokabular-/Formatversion, wird **nie** angefasst.
 *
 * Erkennung ist identisch zu L3 (`firstCodeVersion` in docs-validate-checks.ts),
 * damit „was der Validator als Code-Version zählt“ und „was dieses Skript
 * ändert“ dieselbe Menge sind. Ausgenommen: `docs/archive/`, `docs/audits/`,
 * `docs/peer-reviews/`, `docs/generated/` (historische Stände bzw. generiert).
 *
 * Bewusst ohne `git`: das Skript ändert nur Dateiinhalte; Commit macht der Mensch.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { firstCodeVersion, walkFiles } from "./docs-validate-checks";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(here, "..");
const DOCS = path.join(REPO, "docs");

/** Verzeichnisse, deren Header historische bzw. generierte Stände sind. */
const EXCLUDED_SEGMENTS: ReadonlySet<string> = new Set(["archive", "audits", "peer-reviews", "generated"]);

interface PlannedChange {
  /** Repo-relativ, POSIX. */
  file: string;
  /** 1-basierte Zeilennummer des Headers. */
  line: number;
  from: string;
  to: string;
}

export function readPackageVersion(): string {
  const pkg = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8")) as { version?: unknown };
  if (typeof pkg.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)) {
    throw new Error(`package.json: version '${String(pkg.version)}' ist keine SemVer-Version`);
  }
  return pkg.version;
}

function isExcluded(relPosix: string): boolean {
  return relPosix.split("/").some((segment) => EXCLUDED_SEGMENTS.has(segment));
}

/**
 * Plant die Änderungen für alle Dokumente. Liest nur, schreibt nichts.
 * Rückgabe: geplante Änderungen plus Zähler für die Zusammenfassung.
 */
export function planBump(version: string): {
  changes: PlannedChange[];
  upToDate: number;
  withoutHeader: number;
  contents: Map<string, string>;
} {
  const changes: PlannedChange[] = [];
  const contents = new Map<string, string>();
  let upToDate = 0;
  let withoutHeader = 0;

  const files = walkFiles(DOCS)
    .filter((f) => f.endsWith(".md"))
    .map((f) => path.relative(REPO, f).split(path.sep).join("/"))
    .filter((rel) => !isExcluded(rel.replace(/^docs\//, "")))
    .sort();

  for (const rel of files) {
    const content = readFileSync(path.join(REPO, rel), "utf8");
    const header = firstCodeVersion(content);
    if (!header) {
      withoutHeader++;
      continue;
    }
    if (header.version === version) {
      upToDate++;
      continue;
    }
    if (header.version === null) continue; // nicht parsebar: L3 meldet es; hier nicht raten.

    const lines = content.split("\n");
    const idx = header.line - 1;
    // Gleiche Regel wie firstCodeVersion: nur die Versionszahl hinter „Code-Version“ ersetzen.
    const replaced = lines[idx].replace(
      /(Code-Version[^\d\n]{0,48}v?)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/i,
      `$1${version}`,
    );
    lines[idx] = replaced;
    contents.set(rel, lines.join("\n"));
    changes.push({ file: rel, line: header.line, from: header.version, to: version });
  }
  return { changes, upToDate, withoutHeader, contents };
}

function main(): number {
  const dryRun = process.argv.includes("--dry-run");
  const write = process.argv.includes("--write");
  if (dryRun === write) {
    console.error("Aufruf: bump-docs-version.ts --dry-run | --write");
    return 2;
  }

  const version = readPackageVersion();
  const plan = planBump(version);

  for (const c of plan.changes) {
    console.log(`${c.file}:${c.line}  Code-Version ${c.from} → ${version}`);
  }
  console.log(
    `[bump-docs-version] ${dryRun ? "dry-run" : "write"}: ${plan.changes.length} Header auf ${version} ` +
      `(${plan.upToDate} bereits aktuell, ${plan.withoutHeader} ohne Code-Version-Header; Dokument-Version bleibt unangetastet).`,
  );

  if (write) {
    for (const [rel, content] of plan.contents) writeFileSync(path.join(REPO, rel), content, "utf8");
  }
  return 0;
}

const invokedAsScript = typeof process.argv[1] === "string" && process.argv[1].endsWith("bump-docs-version.ts");
if (invokedAsScript) process.exit(main());
