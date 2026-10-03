"use client";

/**
 * Einzelne Doku-Seite (kanonische URL `/docs/<Pfad>.md`).
 *
 * Lädt Inhalt **und** Link-Zuordnung über `GET /api/docs?name=…` und rendert
 * sie mit Anker-IDs. Der Header bietet immer den Rücksprung zur Übersicht.
 *
 * Zwei Pflichtteile, damit Kapitel-Sprünge funktionieren (Befund A4):
 * Der Inhalt wird per `fetch` nachgeladen. Der Browser versucht zu springen,
 * bevor das Ziel im DOM existiert — der Sprung muss also nach dem Rendern
 * nachgeholt werden. `prose-headings:scroll-mt-20` verhindert, dass der
 * Sticky-Header das Ziel verdeckt.
 */

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import DocsMarkdown, { type DocLinkMap } from "./DocsMarkdown";

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
  backHref = "/docs",
  backLabel = "← Alle Dokumente",
}: {
  /** Kanonische URL des Dokuments (`/docs/audits/…/README.md`). */
  docPath: string;
  title: string;
  subtitle?: string;
  backHref?: string;
  backLabel?: string;
}) {
  const [content, setContent] = useState("");
  const [links, setLinks] = useState<DocLinkMap>({});
  const [loading, setLoading] = useState(true);
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [activeId, setActiveId] = useState("");
  const articleRef = useRef<HTMLElement | null>(null);
  const hash = useLocationHash();

  const load = useCallback(() => {
    setLoading(true);
    fetch(`/api/docs?name=${encodeURIComponent(docPath)}`)
      .then((r) => r.json())
      .then((d) => {
        setContent(d.content ?? `> ${d.error ?? "Dokument nicht verfügbar."}`);
        setLinks((d.links ?? {}) as DocLinkMap);
      })
      .catch(() => {
        setContent("> Dokument konnte nicht geladen werden.");
        setLinks({});
      })
      .finally(() => setLoading(false));
  }, [docPath]);

  useEffect(() => {
    const id = window.setTimeout(load, 0);
    return () => window.clearTimeout(id);
  }, [load]);

  // A4 — Sprung nachholen, sobald der Inhalt im DOM steht.
  useEffect(() => {
    if (loading) return;
    const id = decodeURIComponent(hash.replace(/^#/, ""));
    if (!id) return;
    const timer = window.setTimeout(() => {
      document.getElementById(id)?.scrollIntoView({ block: "start" });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loading, hash]);

  // A5 — Inhaltsverzeichnis aus dem gerenderten DOM (IDs kommen von rehype-slug).
  useEffect(() => {
    if (loading) return;
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
  }, [loading, content]);

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
      // Oberer Rand = unter dem Sticky-Header, unterer Rand = erstes Drittel.
      { rootMargin: "-96px 0px -66% 0px", threshold: 0 },
    );
    for (const el of elements) observer.observe(el);
    return () => observer.disconnect();
  }, [headings]);

  return (
    <main className="min-h-screen bg-slate-950">
      <div className="mx-auto max-w-4xl px-4 py-8">
        <header className="mb-6 flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-5">
          <div>
            <p className="text-xs uppercase tracking-[0.15em] text-emerald-400">Dokumentation</p>
            <h1 className="mt-1 text-2xl font-bold text-slate-50">{title}</h1>
            {subtitle && <p className="mt-1 text-sm text-slate-400">{subtitle}</p>}
          </div>
          <Link
            href={backHref}
            className="rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-700"
          >
            {backLabel}
          </Link>
        </header>

        <div className="xl:grid xl:grid-cols-[minmax(0,1fr)_220px] xl:gap-8">
          <article
            ref={articleRef}
            className="min-w-0 rounded-2xl border border-slate-800 bg-slate-900/40 p-6 md:p-8"
          >
            {loading ? (
              <p className="text-sm text-slate-500">Lade Dokument…</p>
            ) : (
              <DocsMarkdown content={content} links={links} />
            )}
          </article>

          {headings.length >= 3 && (
            <nav
              aria-label="Inhaltsverzeichnis"
              className="mt-6 hidden self-start xl:sticky xl:top-6 xl:mt-0 xl:block xl:max-h-[calc(100vh-3rem)] xl:overflow-y-auto"
            >
              <p className="mb-2 text-[11px] uppercase tracking-[0.15em] text-slate-500">
                Auf dieser Seite
              </p>
              <ul className="space-y-1 border-l border-slate-800">
                {headings.map((h) => (
                  <li key={h.id}>
                    <a
                      href={`#${h.id}`}
                      className={`block border-l-2 py-0.5 text-[12px] leading-snug transition ${
                        h.level === 3 ? "pl-6" : "pl-3"
                      } ${
                        activeId === h.id
                          ? "-ml-px border-emerald-400 text-emerald-300"
                          : "-ml-px border-transparent text-slate-500 hover:text-slate-300"
                      }`}
                    >
                      {h.text}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          )}
        </div>
      </div>
    </main>
  );
}
