import { notFound } from "next/navigation";
import { DocsShell } from "@/components/docs/DocsShell";
import { readDocFile, resolveRenderableDoc } from "@/lib/docsContent";

export const dynamic = "force-dynamic";

/**
 * `/docs` — gerenderte Übersicht (`docs/README.md`).
 *
 * `?name=<slug>` wird in der Middleware auf `/docs/<Datei>.md` umgeleitet,
 * damit alte Ops-/Dashboard-Links weiter funktionieren.
 */
export default async function DocsIndexPage() {
  const resolved = resolveRenderableDoc("readme");
  if (!resolved) notFound();
  const content = await readDocFile(resolved.file);
  return <DocsShell active={resolved} content={content} />;
}
