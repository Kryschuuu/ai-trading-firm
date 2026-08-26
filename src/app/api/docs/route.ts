import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const dynamic = "force-dynamic";

/**
 * Whitelist — es dürfen nur diese Dateien gelesen werden (kein Path-Traversal).
 * KORRIGIERT (v1.3.0): Alle Markdown-Dateien liegen jetzt in docs/.
 */
const DOCS: Record<string, { file: string; title: string; subtitle: string }> = {
  readme: {
    file: "docs/README.md",
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
  changelog: {
    file: "docs/CHANGELOG.md",
    title: "Changelog",
    subtitle: "Versionen, Bugfixes und Änderungen je Release",
  },
  security: {
    file: "docs/SECURITY_AUDIT.md",
    title: "Security-Audit",
    subtitle: "Findings, Schweregrad, Fixes und Peer-Review",
  },
  provider: {
    file: "docs/PROVIDER_INTEGRATION.md",
    title: "LLM-Provider",
    subtitle: "Ollama · OpenAI · Gemini · Claude — Konfiguration und Kosten",
  },
  pgsetup: {
    file: "docs/SETUP_PG_TROUBLESHOOTING.md",
    title: "PostgreSQL-Setup-Hilfe",
    subtitle: "Sofort-Hilfe & Fehlersuche für Setup-Schritt 2 (v1.5.4)",
  },
  architecture: {
    file: "docs/ARCHITECTURE.md",
    title: "Architektur: Makro/Mikro-Zyklen",
    subtitle: "Event-Driven-Blaupause — Regeln, Latenz, Skalierung, Security (v1.6)",
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
