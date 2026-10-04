/**
 * Kanonische Doku-Seite (`/docs/<Pfad>.md`).
 *
 * Catch-all-Route: der Pfad **innerhalb von `docs/`** ist Teil der URL, damit
 * sie eindeutig bleibt (`/docs/audits/2026-09-18-feature-gap/README.md`).
 * Vorher gab es nur ein Segment (`/docs/[name]`); damit kollidierten die ~31
 * `README.md` des Baums auf eine einzige URL (Befund B5).
 *
 * Repo-Root-Dateien liegen unter dem reservierten Segment `root/`
 * (`/docs/root/CHANGELOG.md`) — sonst kollidieren sie mit gleichnamigen
 * Dateien unter `docs/` (`docs/CHANGELOG.md` ist ein Weiterleitungs-Stub).
 *
 * Nicht-kanonische Formen (Slug, ohne `.md`, Basename-Altlast) werden auf die
 * kanonische URL weitergeleitet. Was nicht auflöst, bleibt 404.
 */

import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { listDocs, resolveDocRequest } from "@/lib/docsCatalog";
import { loadDocFile } from "@/lib/docsRenderServer";
import { DOCS_SECTIONS } from "@/lib/docsNav";
import DocsView from "@/components/docs/DocsView";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ path: string[] }>;
}): Promise<Metadata> {
  const { path } = await params;
  const resolved = resolveDocRequest((path ?? []).join("/"));
  if (!resolved) return { title: "Dokument nicht gefunden — Dokumentation" };
  return {
    title: `${resolved.entry.title} — Dokumentation`,
    description: resolved.entry.subtitle || undefined,
  };
}

export default async function DocPage({
  params,
}: {
  params: Promise<{ path: string[] }>;
}) {
  const { path } = await params;
  const requested = (path ?? []).join("/");

  const resolved = resolveDocRequest(requested);
  if (!resolved) notFound();

  if (`/docs/${requested}` !== resolved.canonicalPath) redirect(resolved.canonicalPath);

  // Inhalt serverseitig laden: Der Artikel steht sofort im HTML (kein
  // Ladezustand, korrekte Druck-/PDF-Ansicht) und wird dann hydratisiert.
  let loaded: { content: string; links: Record<string, string | null> };
  try {
    loaded = await loadDocFile(resolved.file);
  } catch {
    loaded = {
      content: `> Datei \`${resolved.file}\` nicht gefunden. Liegt sie unter \`docs/\`?`,
      links: {},
    };
  }

  return (
    <DocsView
      docPath={resolved.canonicalPath}
      content={loaded.content}
      links={loaded.links}
      title={resolved.entry.title}
      subtitle={resolved.entry.subtitle || undefined}
      // Sidebar-Navigation server-gerendert — sie steht, bevor der Inhalt da ist.
      nav={{ docs: listDocs(), sections: [...DOCS_SECTIONS] }}
    />
  );
}
