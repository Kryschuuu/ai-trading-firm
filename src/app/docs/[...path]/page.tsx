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

import { notFound, redirect } from "next/navigation";
import { resolveDocRequest } from "@/lib/docsCatalog";
import DocsView from "@/components/docs/DocsView";

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

  return (
    <DocsView
      docPath={resolved.canonicalPath}
      title={resolved.entry.title}
      subtitle={resolved.entry.subtitle || undefined}
    />
  );
}
