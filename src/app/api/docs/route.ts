/**
 * `GET /api/docs` — liefert ein Dokument aus der Whitelist als Markdown.
 *
 * Die Whitelist liegt in `src/lib/docsCatalog.ts` (Single Source of Truth),
 * damit die Help-Sektion des Operations Centers dieselbe Liste nutzt.
 *
 * Antwort bei `?name=<Slug|Pfad|URL>`:
 *   { slug, file, title, subtitle, canonicalPath, content, links }
 *
 * `links` ist die serverseitig berechnete Zuordnung **rohes Link-Ziel →
 * Viewer-URL** (oder `null` für Ziele außerhalb der Doku). Der Client
 * (`DocsMarkdown`) hat keinen Dateisystem-Zugriff und wendet die Map nur an —
 * dadurch zeigt der Viewer exakt das, was der Validator prüft (Befund B1/B2).
 */
import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { resolveRuntimePath } from "@/lib/appPaths";
import { listDocs, resolveDocRequest } from "@/lib/docsCatalog";
import { extractMarkdownLinks, resolveDocLink } from "@/lib/docsLinks";

export const dynamic = "force-dynamic";

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

/**
 * Traversal-Schranke (Befund B4): `name` darf ein Slug, ein Pfad unter
 * `docs/`, `root/<Datei>.md` oder eine kanonische URL sein — nie ein
 * absoluter Pfad und keine Null-Bytes. Die inhaltliche Eingrenzung auf
 * `docs/**` bzw. Root-`*.md` macht anschließend `resolveDocRequest`.
 */
function isPlausibleDocName(name: string): boolean {
  if (!name) return false;
  if (name.includes("\0")) return false;
  if (/^[a-zA-Z]:/.test(name)) return false; // Windows-Laufwerk
  return true;
}

export async function GET(req: Request) {
  const name = (new URL(req.url).searchParams.get("name") ?? "").trim();

  if (!name) {
    return NextResponse.json({ docs: listDocs() });
  }

  if (!isPlausibleDocName(name)) {
    return NextResponse.json({ error: "Ungültiger Dokumentname" }, { status: 400 });
  }

  const resolved = resolveDocRequest(name);
  if (!resolved) {
    return NextResponse.json({ error: "Unbekanntes Dokument" }, { status: 404 });
  }

  let content: string;
  try {
    // turbopackIgnore: true — verhindert das Tracen des gesamten Projektverzeichnisses.
    // Der Pfad stammt ausschließlich aus dem Katalog bzw. von einer Datei, die
    // `resolveDoc` gegen `docs/` (oder die Root-`*.md`) eingegrenzt hat.
    content = await readFile(
      path.join(/* turbopackIgnore: true */ process.cwd(), resolved.file),
      "utf8",
    );
  } catch {
    return NextResponse.json(
      { error: `Datei ${resolved.file} nicht gefunden. Liegt sie unter docs/?` },
      { status: 404 },
    );
  }

  // Link-Ziele serverseitig auflösen: relativ zum Verzeichnis dieses
  // Dokuments, genau wie GitHub es tut.
  const links: Record<string, string | null> = {};
  for (const target of extractMarkdownLinks(content)) {
    const resolution = resolveDocLink(target, resolved.file, fsProbe);
    links[target] = resolution.kind === "doc" ? resolution.href : null;
  }

  return NextResponse.json({
    slug: resolved.slug,
    ...resolved.entry,
    file: resolved.file,
    canonicalPath: resolved.canonicalPath,
    content,
    links,
  });
}
