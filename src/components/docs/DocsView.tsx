"use client";

/**
 * Einzelne Doku-Seite (kanonische URL `/docs/<Pfad>.md`).
 *
 * Aufbau (voll nutzbare Breite, responsiv):
 *   Kopf        Breadcrumb (Thema › Dokument), Titel, Untertitel, Dateipfad,
 *               Aktionen: Übersicht, Dashboard, „Menü“ (nur < lg).
 *   Sidebar     Themensortierte Navigation des gesamten Katalogs; auf großen
 *               Bildschirmen sticky, auf kleinen als Drawer über den Kopf
 *               erreichbar.
 *   Inhalt      Markdown mit Anker-IDs, Tabellen scrollen horizontal statt
 *               überzulaufen (siehe `DocsMarkdown` + `.docs-table-scroll`).
 *   Rechts      „Auf dieser Seite“ (Inhaltsverzeichnis, ab 2xl) mit
 *               IntersectionObserver-Highlighting.
 *   Fuß         Vor/Zurück innerhalb des Katalogs.
 *
 * Zwei Pflichtteile, damit Kapitel-Sprünge funktionieren (Befund A4):
 * Der Inhalt wird per `fetch` nachgeladen. Der Browser versucht zu springen,
 * bevor das Ziel im DOM existiert — der Sprung muss also nach dem Rendern
 * nachgeholt werden. `scroll-mt-24` verhindert, dass der Kopf das Ziel verdeckt.
 */

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import { DOCS_SECTIONS, docsSection, type DocsNavItem, type DocsSection } from "@/lib/docsNav";
import { PANEL, PAGE_GUTTER } from "@/components/ui/layout";
import DocsMarkdown, { type DocLinkMap } from "./DocsMarkdown";
import { MenuIcon } from "./DocsIcons";
import { DocsNavList } from "./DocsNav";

type Heading = { id: string; text: string; level: number };

/** Aktueller `location.hash` (inkl. `hashchange`, z. B. bei Client-Navigation). */
function useLocationHash(): string {
  const [hash, setHash] = useState("");
  useEffect(() => {
    const read = () => setHash(window.location.hash);
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);
  return hash;
}

export default function DocsView({
  docPath,
  title,
  subtitle,
  nav,
  content,
  links = {},
  backHref = "/docs",
  backLabel = "← Alle Dokumente",
}: {
  /** Kanonische URL des Dokuments (`/docs/audits/…/README.md`). */
  docPath: string;
  title: string;
  subtitle?: string;
  /** Katalog + Abschnitte, server-gerendert (sofortige Sidebar, kein Flackern). */
  nav: { docs: DocsNavItem[]; sections: DocsSection[] };
  /** Markdown-Inhalt, server-gerendert — kein Ladezustand beim ersten Aufruf. */
  content: string;
  /** Link-Zuordnung vom Server (siehe `src/lib/docsRenderServer.ts`). */
  links?: DocLinkMap;
  backHref?: string;
  backLabel?: string;
}) {
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [activeId, setActiveId] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [tocOpen, setTocOpen] = useState(false);
  const articleRef = useRef<HTMLElement | null>(null);
  const hash = useLocationHash();

  // Titel des Browser-Tabs an das Dokument anpassen.
  useEffect(() => {
    if (!title) return;
    const previous = document.title;
    document.title = `${title} — Dokumentation`;
    return () => {
      document.title = previous;
    };
  }, [title]);

  // A4 — Sprung nachholen, sobald der Inhalt im DOM steht.
  useEffect(() => {
    const id = decodeURIComponent(hash.replace(/^#/, ""));
    if (!id) return;
    const timer = window.setTimeout(() => {
      document.getElementById(id)?.scrollIntoView({ block: "start" });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [hash]);

  // A5 — Inhaltsverzeichnis aus dem gerenderten DOM (IDs kommen von rehype-slug).
  // Läuft nach dem ersten Paint: das Inhaltsverzeichnis hängt an den
  // tatsächlich gerenderten Überschriften, nicht an einer zweiten Quelle.
  useEffect(() => {
    const article = articleRef.current;
    if (!article) return;
    const nodes = Array.from(article.querySelectorAll<HTMLElement>("h2[id], h3[id]"));
    setHeadings(
      nodes.map((n) => ({
        id: n.id,
        text: (n.textContent ?? "").trim(),
        level: Number(n.tagName.slice(1)),
      })),
    );
  }, [content]);

  // A5 — aktives Kapitel per IntersectionObserver hervorheben.
  useEffect(() => {
    if (headings.length === 0) return;
    const elements = headings
      .map((h) => document.getElementById(h.id))
      .filter((el): el is HTMLElement => el !== null);
    if (elements.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]?.target.id) setActiveId(visible[0].target.id);
      },
      // Oberer Rand = unter dem Kopf, unterer Rand = erstes Drittel.
      { rootMargin: "-120px 0px -66% 0px", threshold: 0 },
    );
    for (const el of elements) observer.observe(el);
    return () => observer.disconnect();
  }, [headings]);

  // Drawer: Escape schließt, Hintergrund scrollt nicht mit.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const index = nav.docs.findIndex((d) => d.path === docPath);
  const previous = index > 0 ? nav.docs[index - 1] : null;
  const next = index >= 0 && index < nav.docs.length - 1 ? nav.docs[index + 1] : null;
  const section = useMemo(() => docsSection(nav.docs[index]?.section ?? ""), [nav.docs, index]);

  return (
    <main className="min-h-screen bg-slate-950">
      {/* ── Kopf / Breadcrumb ──────────────────────────────────────────── */}
      <header className="sticky top-0 z-30 border-b border-slate-800 bg-slate-950/95 backdrop-blur print:hidden">
        <div className={`flex w-full flex-wrap items-center gap-3 py-3 ${PAGE_GUTTER}`}>
          <button
            type="button"
            onClick={() => setMenuOpen(true)}
            className="flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-700 focus-visible:outline focus-visible:outline-1 focus-visible:outline-emerald-400 lg:hidden"
            aria-expanded={menuOpen}
            aria-controls="docs-nav-drawer"
          >
            <MenuIcon className="h-3.5 w-3.5" />
            Menü
          </button>

          <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
            <ol className="flex min-w-0 items-center gap-1.5 text-xs text-slate-500">
              <li className="shrink-0">
                <Link href="/docs" className="hover:text-emerald-400">
                  Dokumentation
                </Link>
              </li>
              {section && (
                <>
                  <li aria-hidden className="shrink-0">
                    /
                  </li>
                  <li className="shrink-0">
                    <a href={`/docs#${section.id}`} className="hover:text-emerald-400">
                      {section.short}
                    </a>
                  </li>
                </>
              )}
              <li aria-hidden className="hidden shrink-0 sm:block">
                /
              </li>
              <li className="hidden min-w-0 truncate text-slate-400 sm:block">{title}</li>
            </ol>
            <h1 className="mt-0.5 truncate text-base font-bold text-slate-50 sm:text-lg">{title}</h1>
          </nav>

          <div className="flex shrink-0 items-center gap-2">
            {headings.length >= 3 && (
              <button
                type="button"
                onClick={() => setTocOpen((v) => !v)}
                aria-expanded={tocOpen}
                className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-700 2xl:hidden"
              >
                Inhalt
              </button>
            )}
            <Link
              href={backHref}
              className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-700"
            >
              {backLabel}
            </Link>
          </div>
        </div>

        {/* Mobiles Inhaltsverzeichnis (aufklappbar) */}
        {tocOpen && headings.length >= 3 && (
          <nav aria-label="Inhaltsverzeichnis" className={`border-t border-slate-800 py-3 2xl:hidden ${PAGE_GUTTER}`}>
            <ul className="max-h-[45vh] space-y-0.5 overflow-y-auto">
              {headings.map((h) => (
                <li key={h.id}>
                  <a
                    href={`#${h.id}`}
                    onClick={() => setTocOpen(false)}
                    className={`block rounded px-2 py-1 text-xs leading-snug ${
                      h.level === 3 ? "pl-6" : "pl-2"
                    } ${activeId === h.id ? "bg-emerald-500/10 text-emerald-300" : "text-slate-400 hover:text-slate-200"}`}
                  >
                    {h.text}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        )}
      </header>

      <div className={`flex w-full gap-6 py-5 ${PAGE_GUTTER}`}>
        {/* ── Sidebar (Desktop) ────────────────────────────────────────── */}
        <aside className="hidden w-[260px] shrink-0 lg:block 2xl:w-[290px]">
          <div className="sticky top-[76px] flex max-h-[calc(100vh-100px)] flex-col print:hidden">
            <DocsNavList docs={nav.docs} sections={nav.sections} activePath={docPath} autoFocusFilter />
          </div>
        </aside>

        {/* ── Inhalt ───────────────────────────────────────────────────── */}
        <div className="min-w-0 flex-1">
          {(subtitle || docPath) && (
            <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500 print:hidden">
              {subtitle && <span className="min-w-0 flex-1">{subtitle}</span>}
              <code className="rounded bg-slate-900 px-1.5 py-0.5 text-xs text-slate-500">{docPath}</code>
            </div>
          )}

          <div className="flex gap-6">
            <article
              ref={articleRef}
              className="min-w-0 flex-1 rounded-2xl border border-slate-800 bg-slate-900/40 p-4 sm:p-6 lg:p-8"
            >
              <DocsMarkdown content={content} links={links} docPath={docPath} />
            </article>

            {/* Inhaltsverzeichnis rechts (ab 2xl, sticky) */}
            {headings.length >= 3 && (
              <nav
                aria-label="Inhaltsverzeichnis"
                className="hidden w-[230px] shrink-0 2xl:block print:hidden"
              >
                <div className="sticky top-[76px] max-h-[calc(100vh-100px)] overflow-y-auto pr-1">
                  <p className="mb-2 text-xs uppercase tracking-[0.15em] text-slate-500">Auf dieser Seite</p>
                  <ul className="space-y-0.5 border-l border-slate-800">
                    {headings.map((h) => (
                      <li key={h.id}>
                        <a
                          href={`#${h.id}`}
                          className={`-ml-px block border-l-2 py-0.5 text-[12px] leading-snug transition ${
                            h.level === 3 ? "pl-5" : "pl-3"
                          } ${
                            activeId === h.id
                              ? "border-emerald-400 text-emerald-300"
                              : "border-transparent text-slate-500 hover:text-slate-300"
                          }`}
                        >
                          {h.text}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              </nav>
            )}
          </div>

          {/* ── Vor/Zurück im Katalog ─────────────────────────────────── */}
          {(previous || next) && (
            <nav aria-label="Dokument-Navigation" className="mt-5 grid gap-3 sm:grid-cols-2 print:hidden">
              {previous ? (
                <Link
                  href={previous.path}
                  className={`min-w-0 ${PANEL} px-4 py-3 hover:border-emerald-500/40`}
                >
                  <span className="block text-xs uppercase tracking-[0.12em] text-slate-500">← Vorher</span>
                  <span className="mt-0.5 block truncate text-sm text-slate-200">{previous.title}</span>
                </Link>
              ) : (
                <span />
              )}
              {next && (
                <Link
                  href={next.path}
                  className={`min-w-0 ${PANEL} px-4 py-3 text-right hover:border-emerald-500/40 sm:text-right`}
                >
                  <span className="block text-xs uppercase tracking-[0.12em] text-slate-500">Weiter →</span>
                  <span className="mt-0.5 block truncate text-sm text-slate-200">{next.title}</span>
                </Link>
              )}
            </nav>
          )}

          <p className="mt-4 text-xs text-slate-600 print:hidden">
            {DOCS_SECTIONS.length} Themenbereiche · {nav.docs.length} Katalog-Dokumente · Quelle:{" "}
            <code>src/lib/docsCatalog.ts</code>
          </p>
        </div>
      </div>

      {/* ── Sidebar-Drawer (mobil/Tablet) ──────────────────────────────── */}
      {menuOpen && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Dokumentations-Navigation">
          <button
            type="button"
            aria-label="Menü schließen"
            onClick={() => setMenuOpen(false)}
            className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm"
          />
          <div
            id="docs-nav-drawer"
            className="absolute inset-y-0 left-0 flex w-[86%] max-w-sm flex-col border-r border-slate-800 bg-slate-950 p-4 shadow-2xl"
          >
            <div className="mb-3 flex items-center justify-between">
              <span className="text-sm font-semibold text-slate-100">Dokumentation</span>
              <button
                type="button"
                onClick={() => setMenuOpen(false)}
                className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:bg-slate-700"
              >
                Schließen ✕
              </button>
            </div>
            <div className="flex min-h-0 flex-1 flex-col">
              <DocsNavList
                docs={nav.docs}
                sections={nav.sections}
                activePath={docPath}
                onNavigate={() => setMenuOpen(false)}
                autoFocusFilter
              />
            </div>
            <Link
              href="/docs"
              onClick={() => setMenuOpen(false)}
              className="mt-3 block rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2 text-center text-xs font-semibold text-slate-300 hover:bg-slate-800"
            >
              Zur Übersicht
            </Link>
          </div>
        </div>
      )}
    </main>
  );
}
