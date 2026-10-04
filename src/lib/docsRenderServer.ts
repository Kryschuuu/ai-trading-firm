/**
 * Server-Helfer des Doku-Viewers: Datei lesen + Link-Map bauen.
 *
 * Dieser Code lag vorher **nur** in `src/app/api/docs/route.ts`. Seit die
 * Dokuseiten ihren Inhalt serverseitig mitgeben (kein Ladezustand, korrekte
 * Druckansicht, kein Fetch-Flackern), brauchen Route **und** Seite dieselbe
 * Logik — deshalb genau eine Implementierung hier (SSoT), die beide nutzen.
 *
 * `node:fs` → **server-only**. Der Client bekommt nur das Ergebnis (`content`,
 * `links`) als Props.
 */
import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { resolveRuntimePath } from "./appPaths";
import { extractMarkdownLinks, resolveDocLink } from "./docsLinks";

/** Dateisystem-Blick für die Link-Auflösung (server-only). */
const fsProbe = {
  isFile: (file: string): boolean => {
    try {
      return statSync(resolveRuntimePath(file)).isFile();
    } catch {
      return false;
    }
  },
  isDir: (dir: string): boolean => {
    try {
      return statSync(resolveRuntimePath(dir)).isDirectory();
    } catch {
      return false;
    }
  },
};

export type DocLinkMap = Record<string, string | null>;

export type LoadedDoc = {
  content: string;
  /** Rohes Link-Ziel → Viewer-URL (oder `null` = außerhalb der Doku). */
  links: DocLinkMap;
};

/**
 * Liest ein Dokument aus dem Projektstamm und löst alle relativen
 * Markdown-Links relativ zu seinem Verzeichnis auf (wie GitHub es tut).
 *
 * Wirft, wenn die Datei fehlt — Aufrufer entscheiden, ob das ein 404 (API)
 * oder eine Fehlermeldung im Artikel (Seite) ist.
 */
export async function loadDocFile(file: string): Promise<LoadedDoc> {
  // turbopackIgnore: true — verhindert das Tracen des gesamten Projektverzeichnisses.
  // Der Pfad stammt aus `resolveDocRequest` und ist auf docs/** bzw.
  // Root-`*.md` eingegrenzt.
  const content = await readFile(
    path.join(/* turbopackIgnore: true */ process.cwd(), file),
    "utf8",
  );
  const links: DocLinkMap = {};
  for (const target of extractMarkdownLinks(content)) {
    const resolution = resolveDocLink(target, file, fsProbe);
    links[target] = resolution.kind === "doc" ? resolution.href : null;
  }
  return { content, links };
}
