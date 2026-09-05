"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import DocsMarkdown from "./DocsMarkdown";

type DocListItem = { slug: string; title: string; subtitle: string; path: string };

/**
 * Doku-Übersicht (`/docs`). Zeigt die README an und navigiert über die
 * Sidebar zu den kanonischen Einzelseiten (`d.path`), damit jede Doku-Datei
 * lokal unter `/docs/<Datei>.md` gerendert wird.
 */
export default function DocsIndex() {
  const [docs, setDocs] = useState<DocListItem[]>([]);
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);

  const loadDocs = useCallback(() => {
    fetch("/api/docs")
      .then((r) => r.json())
      .then((d) => setDocs(d.docs ?? []))
      .catch(() => setDocs([]));
  }, []);

  const loadReadme = useCallback(() => {
    setLoading(true);
    fetch("/api/docs?name=readme")
      .then((r) => r.json())
      .then((d) => setContent(d.content ?? `> ${d.error ?? "Dokument nicht verfügbar."}`))
      .catch(() => setContent("> Dokument konnte nicht geladen werden."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const id = window.setTimeout(() => {
      loadDocs();
      loadReadme();
    }, 0);
    return () => window.clearTimeout(id);
  }, [loadDocs, loadReadme]);

  return (
    <main className="min-h-screen bg-slate-950">
      <div className="mx-auto max-w-7xl px-4 py-8">
        <header className="mb-6 flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-5">
          <div>
            <p className="text-xs uppercase tracking-[0.15em] text-emerald-400">Dokumentation</p>
            <h1 className="mt-1 text-2xl font-bold text-slate-50">
              Autonome KI-Trading-Firma — Handbuch
            </h1>
          </div>
          <Link
            href="/"
            className="rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-700"
          >
            ← Zum Dashboard
          </Link>
        </header>

        <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
          <nav className="space-y-2 lg:sticky lg:top-6 lg:self-start">
            {docs.map((d) => (
              <Link
                key={d.slug}
                href={d.path}
                className={`block w-full rounded-xl border px-4 py-3 text-left transition ${
                  d.slug === "readme"
                    ? "border-emerald-500/50 bg-emerald-500/10"
                    : "border-slate-800 bg-slate-900/50 hover:bg-slate-800/60"
                }`}
              >
                <span
                  className={`block text-sm font-bold ${
                    d.slug === "readme" ? "text-emerald-300" : "text-slate-200"
                  }`}
                >
                  {d.title}
                </span>
                <span className="mt-0.5 block text-[11px] leading-snug text-slate-500">
                  {d.subtitle}
                </span>
              </Link>
            ))}
            <div className="rounded-xl border border-slate-800 bg-slate-900/40 px-4 py-3 text-[11px] leading-relaxed text-slate-500">
              Die Dateien liegen im Projekt unter <code>docs/README.md</code>,{" "}
              <code>docs/INSTALL.md</code>, <code>docs/HANDBUCH.md</code>,{" "}
              <code>docs/CHANGELOG.md</code> und <code>docs/SECURITY_AUDIT.md</code> — sie
              sind also auch offline im Repo lesbar.
            </div>
          </nav>

          <article className="min-w-0 rounded-2xl border border-slate-800 bg-slate-900/40 p-6 md:p-8">
            {loading ? (
              <p className="text-sm text-slate-500">Lade Dokument…</p>
            ) : (
              <DocsMarkdown content={content} />
            )}
          </article>
        </div>
      </div>
    </main>
  );
}
