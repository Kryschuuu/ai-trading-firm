"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type DocMeta = { slug: string; title: string; subtitle: string };

export default function DocsPage() {
  const [docs, setDocs] = useState<DocMeta[]>([]);
  const [active, setActive] = useState("readme");
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);

  // Ladelogik in stabile Callbacks — der Effekt selbst ruft kein setState auf
  // (react-hooks/set-state-in-effect); er startet nur asynchrones Laden.
  const loadDocs = useCallback(() => {
    fetch("/api/docs")
      .then((r) => r.json())
      .then((d) => setDocs(d.docs ?? []))
      .catch(() => setDocs([]));
  }, []);

  const loadContent = useCallback(() => {
    setLoading(true);
    fetch(`/api/docs?name=${active}`)
      .then((r) => r.json())
      .then((d) => setContent(d.content ?? `> ${d.error ?? "Dokument nicht verfügbar."}`))
      .catch(() => setContent("> Dokument konnte nicht geladen werden."))
      .finally(() => setLoading(false));
  }, [active]);

  useEffect(() => {
    const id = window.setTimeout(loadDocs, 0);
    return () => window.clearTimeout(id);
  }, [loadDocs]);

  useEffect(() => {
    const id = window.setTimeout(loadContent, 0);
    return () => window.clearTimeout(id);
  }, [loadContent]);

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
              <button
                key={d.slug}
                onClick={() => setActive(d.slug)}
                className={`block w-full rounded-xl border px-4 py-3 text-left transition ${
                  active === d.slug
                    ? "border-emerald-500/50 bg-emerald-500/10"
                    : "border-slate-800 bg-slate-900/50 hover:bg-slate-800/60"
                }`}
              >
                <span
                  className={`block text-sm font-bold ${
                    active === d.slug ? "text-emerald-300" : "text-slate-200"
                  }`}
                >
                  {d.title}
                </span>
                <span className="mt-0.5 block text-[11px] leading-snug text-slate-500">
                  {d.subtitle}
                </span>
              </button>
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
              <div className="prose prose-invert prose-slate max-w-none prose-headings:scroll-mt-20 prose-h1:text-2xl prose-h2:mt-10 prose-h2:border-b prose-h2:border-slate-800 prose-h2:pb-2 prose-h2:text-xl prose-h3:text-base prose-a:text-emerald-400 prose-code:rounded prose-code:bg-slate-800 prose-code:px-1 prose-code:py-0.5 prose-code:text-emerald-300 prose-code:before:content-none prose-code:after:content-none prose-pre:border prose-pre:border-slate-800 prose-pre:bg-slate-950 prose-table:text-sm prose-th:text-slate-300 prose-strong:text-slate-100">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
              </div>
            )}
          </article>
        </div>
      </div>
    </main>
  );
}
