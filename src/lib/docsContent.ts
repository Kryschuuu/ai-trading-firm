/**
 * Lesen und Auflösen von Dokumentationsdateien (Node-only).
 *
 * Der Katalog (`docsCatalog.ts`) bleibt ohne I/O, damit Middleware/Edge ihn
 * nutzen kann. Hier liegt der Dateizugriff: Whitelist-Katalog plus begrenzter
 * Fallback auf `docs/**.md` und `audit-remediation/*.md`. Path-Traversal wird
 * über `path.resolve` + Prefix-Check ausgeschlossen.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  docPublicPath,
  docsHrefForFile,
  lookupCatalog,
  normalizeDocRef,
  type DocsEntry,
} from "@/lib/docsCatalog";

export type ResolvedDoc = {
  slug: string;
  file: string;
  title: string;
  subtitle: string;
  publicPath: string;
  href: string;
};

const ALLOWED_ROOTS = ["docs", "audit-remediation"] as const;

function cwd(): string {
  return process.cwd();
}

function isInsideAllowed(abs: string): boolean {
  const root = cwd();
  return ALLOWED_ROOTS.some((prefix) => {
    const allowed = path.resolve(root, prefix);
    return abs === allowed || abs.startsWith(allowed + path.sep);
  });
}

function fromEntry(slug: string, entry: DocsEntry): ResolvedDoc {
  return {
    slug,
    file: entry.file,
    title: entry.title,
    subtitle: entry.subtitle,
    publicPath: docPublicPath(entry.file),
    href: docsHrefForFile(entry.file),
  };
}

function titleFromRel(rel: string): string {
  return path.basename(rel, ".md").replace(/[_-]+/g, " ");
}

function resolveFromDisk(ref: string): ResolvedDoc | null {
  let s = normalizeDocRef(ref);
  if (!s) return null;
  if (!/\.md$/i.test(s)) s = `${s}.md`;

  const base = s.split("/").pop() ?? s;
  const candidates = [s, s.startsWith("docs/") ? s : `docs/${s}`, `docs/${base}`];
  if (/audit-remediation\//i.test(s) || s.toLowerCase().startsWith("audit-remediation")) {
    candidates.push(s.startsWith("audit-remediation/") ? s : `audit-remediation/${base}`);
  } else {
    candidates.push(`audit-remediation/${base}`);
  }

  const root = cwd();
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const abs = path.resolve(root, candidate);
    if (seen.has(abs)) continue;
    seen.add(abs);
    if (!abs.toLowerCase().endsWith(".md")) continue;
    if (!isInsideAllowed(abs)) continue;
    if (!existsSync(abs)) continue;
    const rel = path.relative(root, abs).replace(/\\/g, "/");
    return {
      slug: rel,
      file: rel,
      title: titleFromRel(rel),
      subtitle: rel,
      publicPath: docPublicPath(rel),
      href: docsHrefForFile(rel),
    };
  }
  return null;
}

/** Slug, Dateiname oder Relativpfad → gerendertes Dokument, sonst null. */
export function resolveRenderableDoc(ref: string): ResolvedDoc | null {
  const catalog = lookupCatalog(ref);
  if (catalog) return fromEntry(catalog.slug, catalog.entry);
  return resolveFromDisk(ref);
}

/**
 * Liest eine Markdown-Datei relativ zum Projektstamm.
 * Wirft, wenn der Pfad außerhalb der erlaubten Wurzeln liegt.
 */
export async function readDocFile(relFile: string): Promise<string> {
  const root = cwd();
  const abs = path.resolve(/* turbopackIgnore: true */ root, relFile);
  if (!abs.toLowerCase().endsWith(".md")) {
    throw new Error("Nur Markdown-Dateien sind lesbar.");
  }
  if (!isInsideAllowed(abs)) {
    throw new Error("Dokument außerhalb der erlaubten Wurzeln.");
  }
  return readFile(abs, "utf8");
}
