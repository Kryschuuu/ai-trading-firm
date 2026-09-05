import Link from "next/link";

export default function DocsNotFound() {
  return (
    <main className="min-h-screen bg-slate-950">
      <div className="mx-auto max-w-xl px-4 py-24 text-center">
        <p className="text-xs uppercase tracking-[0.15em] text-emerald-400">Dokumentation</p>
        <h1 className="mt-3 text-2xl font-bold text-slate-50">Dokument nicht gefunden</h1>
        <p className="mt-3 text-sm leading-relaxed text-slate-400">
          Diese Markdown-Datei liegt nicht unter <code>docs/</code> bzw. ist nicht im
          Katalog. Relative Links aus der README zeigen auf{" "}
          <code>/docs/&lt;Datei&gt;.md</code>.
        </p>
        <Link
          href="/docs"
          className="mt-8 inline-block rounded-lg border border-emerald-600/50 bg-emerald-500/10 px-4 py-2 text-sm font-semibold text-emerald-300 hover:bg-emerald-500/20"
        >
          ← Zur Übersicht
        </Link>
      </div>
    </main>
  );
}
