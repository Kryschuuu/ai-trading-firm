"use client";

/**
 * Doku-Übersicht (`/docs`) — **Katalog-Hub**, thematisch sortiert.
 *
 * Vorher: eine flache Liste aller ~80 Einträge in einer schmalen Spalte
 * (`max-w-7xl`) plus die README daneben; auf schmalen Bildschirmen war das
 * Menü länger als der Inhalt. Jetzt:
 *
 *   1. Kopf mit Suche, Zähler und Schnellzugriff auf die häufigsten Dokumente.
 *   2. Sprungleiste über die Themenbereiche (sticky, horizontal scrollbar).
 *   3. Abschnitts-Raster (1 → 2 → 3 → 4 Spalten), das die volle Bildschirmbreite
 *      nutzt. Suche filtert über Titel, Untertitel, Pfad und Abschnitt.
 *   4. Aufklappbarer Dateibaum für die ~250 Detailseiten (Audit-Findings …).
 *
 * Die README ist selbst ein Katalogeintrag (Gruppe „Einstieg“) und über
 * Schnellzugriff sowie Kopfzeile direkt erreichbar.
 */

import Link from "next/link";
import { useMemo, useState } from "react";

import type { DocsNavItem, DocsSection } from "@/lib/docsNav";
import { filterDocs } from "./DocsNav";
import DocsFileTree from "./DocsFileTree";

export default function DocsIndex({
  docs,
  sections,
  quickAccess,
}: {
  /** Server-gerendert aus `listDocs()` — kein Ladezustand, kein Flackern. */
  docs: DocsNavItem[];
  sections: DocsSection[];
  quickAccess: string[];
}) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => filterDocs(docs, sections, query), [docs, sections, query]);
  const searching = query.trim().length > 0;

  const groups = useMemo(
    () =>
      sections
        .map((section) => ({ section, items: filtered.filter((d) => d.section === section.id) }))
        .filter((g) => g.items.length > 0),
    [sections, filtered],
  );

  const quick = quickAccess
    .map((slug) => docs.find((d) => d.slug === slug))
    .filter((d): d is NonNullable<typeof d> => Boolean(d));

  return (
    <main className="min-h-screen bg-slate-950">
      <div className="w-full px-3 py-6 sm:px-5 lg:px-8 2xl:px-10">
        {/* ── Kopf ─────────────────────────────────────────────────────── */}
        <header className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-800 pb-5">
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-[0.15em] text-emerald-400">Dokumentation</p>
            <h1 className="mt-1 text-2xl font-bold text-slate-50 sm:text-3xl">
              Autonome KI-Trading-Firma — Handbuch
            </h1>
            <p className="mt-2 max-w-4xl text-sm leading-relaxed text-slate-400">
              {`${docs.length} Dokumente in ${sections.length} Themenbereichen. Der Katalog ist die kuratierte Navigation — der vollständige Dateibaum steht am Ende der Seite.`}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <Link
              href="/docs/README.md"
              className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/20"
            >
              Überblick (README)
            </Link>
            <Link
              href="/"
              className="rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-700"
            >
              ← Zum Dashboard
            </Link>
          </div>
        </header>

        {/* ── Suche + Schnellzugriff ───────────────────────────────────── */}
        <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
          <div>
            <label htmlFor="docs-search" className="sr-only">
              Dokumente durchsuchen
            </label>
            <input
              id="docs-search"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Suchen: z. B. „Backtest“, „Live-Gate“, „Indikatoren“, „Session“ …"
              className="w-full rounded-xl border border-slate-700 bg-slate-900/60 px-4 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-emerald-500/70 focus:outline-none focus:ring-1 focus:ring-emerald-500/40"
            />
          </div>
          {quick.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] uppercase tracking-[0.12em] text-slate-500">Schnellzugriff</span>
              {quick.map((doc) => (
                <Link
                  key={doc.slug}
                  href={doc.path}
                  title={doc.subtitle}
                  className="rounded-full border border-slate-700 bg-slate-800/70 px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-emerald-500/50 hover:text-emerald-300"
                >
                  {doc.title}
                </Link>
              ))}
            </div>
          )}
        </div>

        {searching && (
          <p className="mt-3 text-xs text-slate-400">
            {filtered.length} Treffer für „{query.trim()}“ ·{" "}
            <button type="button" onClick={() => setQuery("")} className="text-emerald-400 underline">
              Filter zurücksetzen
            </button>
          </p>
        )}

        {/* ── Sprungleiste ─────────────────────────────────────────────── */}
        {!searching && (
          <nav
            aria-label="Themenbereiche"
            className="sticky top-0 z-20 -mx-3 mt-4 border-b border-slate-800 bg-slate-950/90 px-3 py-2 backdrop-blur sm:-mx-5 sm:px-5 lg:-mx-8 lg:px-8 2xl:-mx-10 2xl:px-10"
          >
            <ul className="flex gap-2 overflow-x-auto pb-0.5">
              {sections.map((section) => {
                const count = docs.filter((d) => d.section === section.id).length;
                if (count === 0) return null;
                return (
                  <li key={section.id} className="shrink-0">
                    <a
                      href={`#${section.id}`}
                      title={section.description}
                      className="flex items-center gap-1.5 rounded-full border border-slate-800 bg-slate-900/70 px-3 py-1.5 text-xs text-slate-300 hover:border-emerald-500/50 hover:text-emerald-300"
                    >
                      {section.short}
                      <span className="rounded-full bg-slate-800 px-1.5 text-[10px] text-slate-400">{count}</span>
                    </a>
                  </li>
                );
              })}
            </ul>
          </nav>
        )}

        {/* ── Abschnitts-Raster ────────────────────────────────────────── */}
        {groups.length === 0 ? (
          <p className="mt-6 rounded-xl border border-slate-800 bg-slate-900/40 px-4 py-6 text-sm text-slate-400">
            Kein Dokument passt zu „{query.trim()}“.{" "}
            <button type="button" onClick={() => setQuery("")} className="text-emerald-400 underline">
              Suche zurücksetzen
            </button>
          </p>
        ) : (
          <div className="mt-6 grid items-start gap-5 lg:grid-cols-2 2xl:grid-cols-3 min-[1900px]:grid-cols-4">
            {groups.map(({ section, items }) => (
              <section
                key={section.id}
                id={section.id}
                className="scroll-mt-24 rounded-2xl border border-slate-800 bg-slate-900/40 p-4 sm:p-5"
              >
                <header className="border-b border-slate-800 pb-3">
                  <h2 className="text-sm font-semibold text-slate-100">
                    {section.label}
                    <span className="ml-2 rounded-full bg-slate-800 px-2 py-0.5 text-[10px] font-medium text-slate-400">
                      {items.length}
                    </span>
                  </h2>
                  <p className="mt-1 text-[11.5px] leading-snug text-slate-500">{section.description}</p>
                </header>

                <ul className="mt-3 space-y-1">
                  {items.map((doc) => (
                    <li key={doc.slug}>
                      <Link
                        href={doc.path}
                        className="block rounded-lg px-2 py-2 transition hover:bg-slate-800/60"
                      >
                        <span className="block text-[13px] font-medium leading-snug text-slate-200 break-words">
                          {doc.title}
                        </span>
                        {doc.subtitle && (
                          <span className="mt-0.5 block text-[11px] leading-snug text-slate-500 line-clamp-2">
                            {doc.subtitle}
                          </span>
                        )}
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}

        {/* ── Vollständiger Baum + Offline-Hinweis ─────────────────────── */}
        <DocsFileTree />

        <div className="mt-6">
          <p className="rounded-2xl border border-slate-800 bg-slate-900/40 px-4 py-3 text-[11.5px] leading-relaxed text-slate-500">
            Die Dateien liegen im Projekt unter <code className="text-slate-400">docs/</code> (Root-Dateien wie{" "}
            <code className="text-slate-400">CHANGELOG.md</code> unter <code className="text-slate-400">/docs/root/</code>) —
            sie sind also auch offline im Repo lesbar. Dieselbe Navigation steht auf jeder Dokuseite in der Sidebar bereit.
          </p>
        </div>
      </div>
    </main>
  );
}
