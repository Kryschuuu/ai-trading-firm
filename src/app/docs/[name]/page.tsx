import { notFound, redirect } from "next/navigation";
import { resolveDoc } from "@/lib/docsCatalog";
import DocsView from "@/components/docs/DocsView";

/**
 * Kanonische Doku-Seite (`/docs/<Datei>.md`).
 *
 * Löst den Segment-Namen (Dateiname oder Slug) zu einem Dokument auf und
 * leitet nicht-kanonische Formen (Slug, ohne `.md`) auf die kanonische URL
 * weiter. Nicht katalogisierte, aber vorhandene `docs/*.md`-Dateien werden
 * über den Existenz-Fallback dennoch gerendert — nie ein lokaler 404.
 */
export default async function DocPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;
  const resolved = resolveDoc(name);
  if (!resolved) notFound();

  const canonicalSegment = resolved.canonicalPath.split("/").pop() ?? name;
  if (name !== canonicalSegment) redirect(resolved.canonicalPath);

  return (
    <DocsView
      name={canonicalSegment}
      title={resolved.entry.title}
      subtitle={resolved.entry.subtitle || undefined}
    />
  );
}
