"use client";

/**
 * Themensortierte Dokumentations-Navigation (Sidebar, Drawer, Übersicht).
 *
 * Struktur statt Liste: Der Katalog hatte 80 Einträge in einer flachen Spalte —
 * unübersichtlich und auf kleinen Bildschirmen meterlang. Hier gruppieren
 * {@link DOCS_SECTIONS} die Dokumente thematisch; jede Gruppe ist auf- und
 * zuklappbar, Suche filtert über Titel, Untertitel, Pfad und Abschnitt.
 *
 * Die Komponente ist rein darstellend: Daten kommen aus `useDocsNav()`.
 */

import Link from "next/link";
import { useMemo, useState } from "react";

import type { DocsNavItem, DocsSection, DocsSectionId } from "@/lib/docsNav";
import { ChevronIcon, CloseIcon, SearchIcon } from "./DocsIcons";

/** Suchindex eines Dokuments — einmal berechnet, dann nur noch verglichen. */
function searchText(doc: DocsNavItem, sections: DocsSection[]): string {
  const section = sections.find((s) => s.id === doc.section);
  return [doc.title, doc.subtitle, doc.path, doc.slug, section?.label ?? "", section?.short ?? ""]
    .join(" ")
    .toLowerCase();
}

export function filterDocs(docs: DocsNavItem[], sections: DocsSection[], query: string): DocsNavItem[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return docs;
  return docs.filter((doc) => {
    const haystack = searchText(doc, sections);
    return terms.every((t) => haystack.includes(t));
  });
}

type NavListProps = {
  docs: DocsNavItem[];
  sections: DocsSection[];
  /** Kanonischer Pfad des offenen Dokuments (Highlight). */
  activePath?: string;
  /** Wird beim Klick auf einen Eintrag gerufen (z. B. Drawer schließen). */
  onNavigate?: () => void;
  /** Suchfeld anzeigen (Default true). */
  showFilter?: boolean;
  /** Untertitel der Einträge anzeigen (Default: nur aktiver Eintrag). */
  showAllSubtitles?: boolean;
  /** Auto-Fokus auf das Suchfeld (Drawer). */
  autoFocusFilter?: boolean;
};

export function DocsNavList({
  docs,
  sections,
  activePath,
  onNavigate,
  showFilter = true,
  showAllSubtitles = false,
  autoFocusFilter = false,
}: NavListProps) {
  const [query, setQuery] = useState("");
  /**
   * Zu-/Klapp-Zustand je Gruppe. Kein `useEffect`: Die Gruppe des offenen
   * Dokuments ist **abgeleitet** geöffnet (`overrides` ist leer), bis der
   * Nutzer sie selbst anfasst. Damit gibt es keinen Zustandswechsel nach dem
   * Rendern — und keine Kaskade (react-hooks/set-state-in-effect).
   */
  const [overrides, setOverrides] = useState<Map<DocsSectionId, boolean>>(new Map());

  const filtered = useMemo(() => filterDocs(docs, sections, query), [docs, sections, query]);
  const searching = query.trim().length > 0;
  const activeSection = docs.find((d) => d.path === activePath)?.section;

  const groups = useMemo(
    () =>
      sections
        .map((section) => ({
          section,
          items: filtered.filter((d) => d.section === section.id),
        }))
        .filter((g) => g.items.length > 0),
    [sections, filtered],
  );

  const isOpen = (id: DocsSectionId) =>
    searching || (overrides.get(id) ?? id === activeSection);

  const toggle = (id: DocsSectionId) =>
    setOverrides((prev) => new Map(prev).set(id, !isOpen(id)));

  return (
    <div className="flex min-h-0 flex-col">
      {showFilter && (
        <div className="relative mb-3 shrink-0">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
          <input
            type="search"
            value={query}
            autoFocus={autoFocusFilter}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Dokumente filtern…"
            aria-label="Dokumente filtern"
            className="w-full rounded-lg border border-slate-700 bg-slate-950/60 py-2 pl-8 pr-8 text-sm text-slate-100 placeholder:text-slate-500 focus:border-emerald-500/70 focus:outline-none focus:ring-1 focus:ring-emerald-500/40"
          />
          {searching && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Filter löschen"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-slate-400 hover:text-slate-100 focus-visible:outline focus-visible:outline-1 focus-visible:outline-emerald-400"
            >
              <CloseIcon className="h-3 w-3" />
            </button>
          )}
        </div>
      )}

      {searching && (
        <p className="mb-2 shrink-0 text-xs text-slate-500">
          {filtered.length} Treffer in {groups.length} Bereichen
        </p>
      )}

      <nav aria-label="Dokumentations-Navigation" className="min-h-0 flex-1 overflow-y-auto pr-1">
        {groups.length === 0 ? (
          <p className="rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-4 text-xs text-slate-500">
            Kein Dokument passt zu „{query}“.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {groups.map(({ section, items }) => {
              const expanded = isOpen(section.id);
              return (
                <li key={section.id}>
                  <button
                    type="button"
                    onClick={() => toggle(section.id)}
                    aria-expanded={expanded}
                    title={section.description}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs font-semibold uppercase tracking-[0.12em] text-slate-400 transition hover:bg-slate-800/50 hover:text-slate-200 focus-visible:outline focus-visible:outline-1 focus-visible:outline-emerald-400"
                  >
                    <ChevronIcon
                      className={`h-2.5 w-2.5 shrink-0 text-slate-500 transition-transform ${expanded ? "rotate-90" : ""}`}
                    />
                    <span className="min-w-0 flex-1 truncate">{section.label}</span>
                    <span className="shrink-0 rounded-full bg-slate-800 px-1.5 py-0.5 text-[11px] font-medium text-slate-400">
                      {items.length}
                    </span>
                  </button>

                  {expanded && (
                    <ul className="mt-0.5 space-y-0.5 border-l border-slate-800 pl-2">
                      {items.map((doc) => {
                        const active = activePath === doc.path;
                        return (
                          <li key={doc.slug}>
                            <Link
                              href={doc.path}
                              onClick={onNavigate}
                              aria-current={active ? "page" : undefined}
                              title={doc.subtitle}
                              className={`block rounded-md px-2 py-1.5 text-[12.5px] leading-snug transition ${
                                active
                                  ? "bg-emerald-500/15 font-semibold text-emerald-300"
                                  : "text-slate-300 hover:bg-slate-800/60 hover:text-slate-100"
                              }`}
                            >
                              <span className="block break-words">{doc.title}</span>
                              {(showAllSubtitles || active) && doc.subtitle && (
                                <span className="mt-0.5 block text-xs font-normal leading-snug text-slate-500 line-clamp-2">
                                  {doc.subtitle}
                                </span>
                              )}
                            </Link>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </nav>
    </div>
  );
}
