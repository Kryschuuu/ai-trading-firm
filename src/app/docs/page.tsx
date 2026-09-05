import { redirect } from "next/navigation";
import { resolveDoc } from "@/lib/docsCatalog";
import DocsIndex from "@/components/docs/DocsIndex";

/**
 * Doku-Übersicht.
 *
 * - `/docs` → rendert `docs/README.md` (Index + Sidebar-Navigation).
 * - `/docs?name=<slug|Datei>` → Redirect auf die kanonische Einzelseite
 *   `/docs/<Datei>.md`, damit altbekannte Help-Links (Operations Center,
 *   OPS-Sektionen) ohne 404 auf der gerenderten Seite landen.
 */
export default async function DocsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const name = typeof sp.name === "string" ? sp.name.trim() : "";
  if (name) {
    const resolved = resolveDoc(name);
    if (resolved) redirect(resolved.canonicalPath);
  }
  return <DocsIndex />;
}
