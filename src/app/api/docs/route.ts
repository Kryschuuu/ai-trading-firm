/**
 * `GET /api/docs` — liefert ein Dokument aus der Whitelist als Markdown.
 *
 * Die Whitelist liegt in `src/lib/docsCatalog.ts` (Single Source of Truth),
 * damit die Help-Sektion des Operations Centers dieselbe Liste nutzt.
 *
 * `name` akzeptiert Slug (`architecture`) und Dateiname (`ARCHITECTURE.md`).
 */
import { NextResponse } from "next/server";
import { listDocs } from "@/lib/docsCatalog";
import { readDocFile, resolveRenderableDoc } from "@/lib/docsContent";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const name = new URL(req.url).searchParams.get("name") ?? "";

  if (!name) {
    return NextResponse.json({ docs: listDocs() });
  }

  const resolved = resolveRenderableDoc(name);
  if (!resolved) {
    return NextResponse.json({ error: "Unbekanntes Dokument" }, { status: 404 });
  }

  try {
    const content = await readDocFile(resolved.file);
    return NextResponse.json({
      slug: resolved.slug,
      file: resolved.file,
      title: resolved.title,
      subtitle: resolved.subtitle,
      href: resolved.href,
      content,
    });
  } catch {
    return NextResponse.json(
      { error: `Datei ${resolved.file} nicht gefunden. Liegt sie unter docs/?` },
      { status: 404 },
    );
  }
}
