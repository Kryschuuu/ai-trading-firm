/**
 * `GET /api/docs` — liefert ein Dokument aus der Whitelist als Markdown.
 *
 * Die Whitelist liegt in `src/lib/docsCatalog.ts` (Single Source of Truth),
 * damit die Help-Sektion des Operations Centers dieselbe Liste nutzt.
 */
import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { listDocs, resolveDoc } from "@/lib/docsCatalog";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const name = new URL(req.url).searchParams.get("name") ?? "";

  if (!name) {
    return NextResponse.json({ docs: listDocs() });
  }

  const resolved = resolveDoc(name);
  if (!resolved) {
    return NextResponse.json({ error: "Unbekanntes Dokument" }, { status: 404 });
  }

  try {
    // turbopackIgnore: true — verhindert das Tracen des gesamten Projektverzeichnisses.
    // Der Pfad wird ausschließlich über das (bereinigte) Basename des Katalogs
    // bzw. eines existierenden docs/*.md aufgelöst — keine Pfadübergabe von außen.
    const content = await readFile(
      path.join(/* turbopackIgnore: true */ process.cwd(), resolved.file),
      "utf8"
    );
    return NextResponse.json({
      slug: resolved.slug,
      ...resolved.entry,
      canonicalPath: resolved.canonicalPath,
      content,
    });
  } catch {
    return NextResponse.json(
      { error: `Datei ${resolved.file} nicht gefunden. Liegt sie unter docs/?` },
      { status: 404 }
    );
  }
}
