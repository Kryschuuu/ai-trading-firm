"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import DocsMarkdown from "./DocsMarkdown";

/**
 * Einzelne Doku-Seite (kanonische URL `/docs/<Datei>.md`).
 *
 * Lädt den Inhalt über `GET /api/docs?name=<Datei>` und rendert ihn mit
 * Link-Rewriting. Der Header bietet immer den Rücksprung zur Übersicht.
 */
export default function DocsView({
  name,
  title,
  subtitle,
  backHref = "/docs",
  backLabel = "← Alle Dokumente",
}: {
  name: string;
  title: string;
  subtitle?: string;
  backHref?: string;
  backLabel?: string;
}) {
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    fetch(`/api/docs?name=${encodeURIComponent(name)}`)
      .then((r) => r.json())
      .then((d) => setContent(d.content ?? `> ${d.error ?? "Dokument nicht verfügbar."}`))
      .catch(() => setContent("> Dokument konnte nicht geladen werden."))
      .finally(() => setLoading(false));
  }, [name]);

  useEffect(() => {
    const id = window.setTimeout(load, 0);
    return () => window.clearTimeout(id);
  }, [load]);

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

        <article className="min-w-0 rounded-2xl border border-slate-800 bg-slate-900/40 p-6 md:p-8">
          {loading ? (
            <p className="text-sm text-slate-500">Lade Dokument…</p>
          ) : (
            <DocsMarkdown content={content} />
          )}
        </article>
      </div>
    </main>
  );
}
