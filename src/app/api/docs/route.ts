import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const dynamic = "force-dynamic";

/** Whitelist — es dürfen nur diese Dateien gelesen werden (kein Path-Traversal). */
const DOCS: Record<string, { file: string; title: string; subtitle: string }> = {
  readme: {
    file: "README.md",
    title: "README",
    subtitle: "Überblick, Architektur und Schnellstart",
  },
  install: {
    file: "docs/INSTALL.md",
    title: "Installation",
    subtitle: "Schritt für Schritt auf CachyOS — Variante A und B",
  },
  handbuch: {
    file: "docs/HANDBUCH.md",
    title: "Handbuch",
    subtitle: "Bedienung, Beispiele, Runbooks und Troubleshooting",
  },
};

export async function GET(req: Request) {
  const name = new URL(req.url).searchParams.get("name") ?? "";

  if (!name) {
    return NextResponse.json({
      docs: Object.entries(DOCS).map(([slug, d]) => ({
        slug,
        title: d.title,
        subtitle: d.subtitle,
      })),
    });
  }

  const entry = DOCS[name];
  if (!entry) {
    return NextResponse.json({ error: "Unbekanntes Dokument" }, { status: 404 });
  }

  try {
    const content = await readFile(path.join(process.cwd(), entry.file), "utf8");
    return NextResponse.json({ slug: name, ...entry, content });
  } catch {
    return NextResponse.json(
      { error: `Datei ${entry.file} nicht gefunden. Liegt sie im Projektstamm?` },
      { status: 404 }
    );
  }
}
