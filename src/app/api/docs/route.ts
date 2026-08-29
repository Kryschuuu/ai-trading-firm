/**
 * `GET /api/docs` — liefert ein Dokument aus der Whitelist als Markdown.
 *
 * Die Whitelist liegt in `src/lib/docsCatalog.ts` (Single Source of Truth),
 * damit die Help-Sektion des Operations Centers dieselbe Liste nutzt.
 */
import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DOCS_CATALOG, listDocs } from "@/lib/docsCatalog";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const name = new URL(req.url).searchParams.get("name") ?? "";

  if (!name) {
    return NextResponse.json({ docs: listDocs() });
  }

  const entry = DOCS_CATALOG[name];
  if (!entry) {
    return NextResponse.json({ error: "Unbekanntes Dokument" }, { status: 404 });
  }

  try {
    // turbopackIgnore: true — verhindert das Tracen des gesamten Projektverzeichnisses.
    // Die Whitelist oben stellt sicher, dass nur die Doku-Dateien lesbar sind.
    const content = await readFile(
      path.join(/* turbopackIgnore: true */ process.cwd(), entry.file),
      "utf8"
    );
    return NextResponse.json({ slug: name, ...entry, content });
  } catch {
    return NextResponse.json(
      { error: `Datei ${entry.file} nicht gefunden. Liegt sie unter docs/?` },
      { status: 404 }
    );
  }
}
