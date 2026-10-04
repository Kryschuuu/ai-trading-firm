/**
 * Doku-Übersicht (`/docs`) — Katalog-Hub.
 *
 * - `/docs` → themensortierter Katalog (Suche, Abschnitte, Dateibaum).
 * - `/docs?name=<slug|Datei>` → Redirect auf die kanonische Einzelseite
 *   `/docs/<Datei>.md`, damit altbekannte Help-Links (Operations Center,
 *   OPS-Sektionen) ohne 404 auf der gerenderten Seite landen.
 */

import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { listDocs, resolveDocRequest } from "@/lib/docsCatalog";
import { DOCS_QUICK_ACCESS, DOCS_SECTIONS } from "@/lib/docsNav";
import DocsIndex from "@/components/docs/DocsIndex";

export const metadata: Metadata = {
  title: "Dokumentation — Autonome KI-Trading-Firma",
  description:
    "Katalog der Projekt-Dokumentation: Einstieg, Architektur, Indikatoren, Strategie, Broker, Betrieb und Audits.",
};

export default async function DocsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const name = typeof sp.name === "string" ? sp.name.trim() : "";
  if (name) {
    const resolved = resolveDocRequest(name);
    if (resolved) redirect(resolved.canonicalPath);
  }
  // Katalog serverseitig mitgeben: die Übersicht erscheint ohne Ladezustand
  // und ohne zusätzlichen API-Aufruf (die Suche läuft weiter im Client).
  return <DocsIndex docs={listDocs()} sections={[...DOCS_SECTIONS]} quickAccess={[...DOCS_QUICK_ACCESS]} />;
}
