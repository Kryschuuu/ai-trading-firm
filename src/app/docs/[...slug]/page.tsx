import { notFound } from "next/navigation";
import { DocsShell } from "@/components/docs/DocsShell";
import { DOCS_CATALOG } from "@/lib/docsCatalog";
import { readDocFile, resolveRenderableDoc } from "@/lib/docsContent";

export const dynamic = "force-dynamic";
export const dynamicParams = true;

type PageProps = { params: Promise<{ slug: string[] }> };

/**
 * Kanonische Docs-URL: `/docs/ARCHITECTURE.md`, `/docs/HANDBUCH.md`, …
 *
 * Der Catch-All nimmt auch `audit-remediation/<Datei>.md` und Katalog-Slugs
 * (`/docs/architecture`). Inhalt wird aus der Whitelist gelesen und als HTML
 * gerendert — relative Markdown-Links zeigen auf dieselben URLs.
 */
export default async function DocPage({ params }: PageProps) {
  const { slug } = await params;
  const joined = slug.map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  }).join("/");
  const resolved = resolveRenderableDoc(joined);
  if (!resolved) notFound();
  const content = await readDocFile(resolved.file);
  return <DocsShell active={resolved} content={content} />;
}

export function generateStaticParams(): { slug: string[] }[] {
  return Object.values(DOCS_CATALOG).map((entry) => ({
    slug: entry.file.replace(/^docs\//, "").split("/"),
  }));
}
