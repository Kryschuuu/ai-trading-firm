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
import { NextResponse } from "next/server";
import { listDocs, resolveDocRequest } from "@/lib/docsCatalog";
import { DOCS_QUICK_ACCESS, DOCS_SECTIONS, sectionForSlug } from "@/lib/docsNav";
import { loadDocFile } from "@/lib/docsRenderServer";
import { buildDocsTree } from "@/lib/docsTree";

export const dynamic = "force-dynamic";

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
  const url = new URL(req.url);
  const name = (url.searchParams.get("name") ?? "").trim();

  if (!name) {
    // Übersicht: Katalog (kuratiert, thematisch sortiert) + Abschnitts-Metadaten.
    // Neu 2026-10-04: `sections` und `quickAccess` liefern die Struktur mit,
    // damit der Client keine zweite Wahrheit über die Themen-Reihenfolge hält.
    return NextResponse.json({
      docs: listDocs(),
      sections: DOCS_SECTIONS,
      quickAccess: DOCS_QUICK_ACCESS,
      /** Vollständige Dateisicht — nur auf Anforderung (Bundesgröße). */
      ...(url.searchParams.get("tree") === "1" ? { tree: buildDocsTree() } : {}),
    });
  }

  if (!isPlausibleDocName(name)) {
    return NextResponse.json({ error: "Ungültiger Dokumentname" }, { status: 400 });
  }

  const resolved = resolveDocRequest(name);
  if (!resolved) {
    return NextResponse.json({ error: "Unbekanntes Dokument" }, { status: 404 });
  }

  // Datei lesen + Link-Ziele serverseitig auflösen (relativ zum Verzeichnis
  // dieses Dokuments, genau wie GitHub es tut) — dieselbe Implementierung
  // nutzt die Dokuseite (`src/app/docs/[...path]/page.tsx`).
  let loaded;
  try {
    loaded = await loadDocFile(resolved.file);
  } catch {
    return NextResponse.json(
      { error: `Datei ${resolved.file} nicht gefunden. Liegt sie unter docs/?` },
      { status: 404 },
    );
  }

  return NextResponse.json({
    slug: resolved.slug,
    ...resolved.entry,
    file: resolved.file,
    canonicalPath: resolved.canonicalPath,
    /** Themen-Abschnitt für Sidebar-Kontext und Breadcrumb. */
    section: sectionForSlug(resolved.slug),
    content: loaded.content,
    links: loaded.links,
  });
}
