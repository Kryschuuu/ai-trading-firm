/**
 * Dateibaum der Doku (`GET /api/docs?tree=1`) — **server-only** (liest `docs/`).
 *
 * Warum das zusätzlich zum Katalog existiert:
 *   Der Katalog (`DOCS_CATALOG`) ist die kuratierte, thematisch sortierte
 *   Navigation. Er führt bewusst **nicht** jede Datei — die ~255 Detailseiten
 *   der Audit-Ordner (`audits/<datum>/findings/…`) sollen das Menü nicht
 *   fluten. Ohne Baum waren sie im Browser aber praktisch unauffindbar, weil
 *   nur der Katalog verlinkt wurde.
 *
 * Der Baum ist deshalb die „vollständige Sicht“ und wird im Viewer als
 * aufklappbarer Ordnerbaum angeboten (Suche filtert über Pfad und Titel).
 * Er enthält ausschließlich Dateien, die `resolveDocRequest` auch ausliefern
 * darf — die Traversal-Schranke bleibt damit unangetastet.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { resolveRuntimePath } from "./appPaths";
import { DOCS_CATALOG } from "./docsCatalog";
import { canonicalPathForFile } from "./docsLinks";

export type DocsTreeNode = {
  /** Segmentname der Anzeige (`audits`, `README.md`, `findings`). */
  name: string;
  /** Kanonische URL: Datei → `/docs/…/X.md`, Ordner → `/docs/…` (ohne Datei). */
  path: string;
  type: "dir" | "file";
  /** Anzeigetitel (Katalogtitel, sonst Dateiname ohne `.md`). */
  title: string;
  /** Nur bei katalogisierten Dateien gesetzt. */
  subtitle?: string;
  /** True, wenn die Datei im Katalog steht (dann auch über das Menü erreichbar). */
  cataloged?: boolean;
  children?: DocsTreeNode[];
};

/** Titel-Index: Dateipfad (relativ zum Repo) → Katalogeintrag. */
const BY_FILE = new Map<string, { title: string; subtitle: string }>(
  Object.values(DOCS_CATALOG).map((entry) => [
    entry.file,
    { title: entry.title, subtitle: entry.subtitle },
  ]),
);

/** Repo-Root-Dateien, die der Viewer ausliefern darf (bewusste Whitelist). */
const ROOT_FILES = [
  "README.md",
  "CHANGELOG.md",
  "CONFIGURATION.md",
  "VERSION.md",
  "INSTALL.md",
  "CONTRIBUTING.md",
] as const;

const MAX_DEPTH = 6;

function labelFor(relFile: string, name: string): string {
  const base = name.replace(/\.md$/i, "");
  if (/^readme$/i.test(base)) {
    // `audits/2026-09-20-roadmap-audit/README.md` → Titel des Ordners.
    const parts = relFile.split("/");
    const dir = parts.length >= 2 ? parts[parts.length - 2] : "";
    return dir && !/^docs$/i.test(dir) ? dir : "README";
  }
  if (/^TEMPLATE/i.test(base)) return base;
  return base;
}

function fileNode(relFile: string, name: string): DocsTreeNode {
  const entry = BY_FILE.get(relFile);
  return {
    name,
    path: canonicalPathForFile(relFile) ?? `/docs/${relFile}`,
    type: "file",
    title: entry?.title ?? labelFor(relFile, name),
    ...(entry ? { subtitle: entry.subtitle } : {}),
    ...(entry ? { cataloged: true } : {}),
  };
}

function walkDir(absDir: string, relDir: string, depth: number): DocsTreeNode[] {
  if (depth > MAX_DEPTH) return [];
  let names: string[] = [];
  try {
    names = readdirSync(absDir);
  } catch {
    return [];
  }

  const dirs: DocsTreeNode[] = [];
  const files: DocsTreeNode[] = [];

  for (const name of names.sort((a, b) => a.localeCompare(b, "de"))) {
    if (name.startsWith(".")) continue;
    const abs = path.join(absDir, name);
    const rel = relDir ? `${relDir}/${name}` : name;
    let isDir = false;
    let isFile = false;
    try {
      isDir = statSync(abs).isDirectory();
      isFile = statSync(abs).isFile();
    } catch {
      continue;
    }
    if (isDir) {
      const children = walkDir(abs, rel, depth + 1);
      if (children.length === 0) continue;
      dirs.push({
        name,
        path: `/docs/${rel}`,
        type: "dir",
        title: name.replace(/-/g, " "),
        children,
      });
    } else if (isFile && name.toLowerCase().endsWith(".md")) {
      files.push(fileNode(`docs/${rel}`, name));
    }
  }

  return [...dirs, ...files];
}

/**
 * Kompletter Baum unterhalb von `docs/` plus die auslieferbaren Root-Dateien
 * in einem eigenen Zweig `root/` (gleiche Konvention wie die kanonischen URLs).
 *
 * Ergebnis ist bei jedem Aufruf frisch — 350 Dateien zu statten kostet wenige
 * Millisekunden und der Endpunkt ist kein Hot Path.
 */
export function buildDocsTree(): DocsTreeNode[] {
  const docsDir = resolveRuntimePath("docs");
  const tree = existsSync(docsDir) ? walkDir(docsDir, "", 0) : [];

  const rootFiles: DocsTreeNode[] = ROOT_FILES.filter((name) =>
    existsSync(resolveRuntimePath(name)),
  ).map((name) => fileNode(name, name));

  if (rootFiles.length > 0) {
    tree.push({
      name: "root",
      path: "/docs/root",
      type: "dir",
      title: "Repository-Wurzel",
      children: rootFiles,
    });
  }
  return tree;
}
