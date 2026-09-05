import Link from "next/link";
import { listDocs } from "@/lib/docsCatalog";
import { APP_VERSION } from "@/lib/version";
import type { ResolvedDoc } from "@/lib/docsContent";
import { DocsNav } from "./DocsNav";
import { MarkdownDoc } from "./MarkdownDoc";

export function DocsShell({ active, content }: { active: ResolvedDoc; content: string }) {
  const docs = listDocs();
  const indexHref = docs.find((d) => d.slug === "readme")?.href ?? "/docs";

  return (
    <main className="min-h-screen bg-slate-950">
      <div className="mx-auto max-w-7xl px-4 py-8">
        <header className="mb-6 flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-5">
          <div>
            <p className="text-xs uppercase tracking-[0.15em] text-emerald-400">Dokumentation</p>
            <h1 className="mt-1 text-2xl font-bold text-slate-50">{active.title}</h1>
            <p className="mt-1 text-sm text-slate-400">
              {active.subtitle || active.publicPath} · v{APP_VERSION}
            </p>
          </div>
          <Link
            href="/"
            className="rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-700"
          >
            ← Zum Dashboard
          </Link>
        </header>

        <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
          <DocsNav docs={docs} indexHref={indexHref} />
          <article className="min-w-0 rounded-2xl border border-slate-800 bg-slate-900/40 p-6 md:p-8">
            <MarkdownDoc content={content} />
          </article>
        </div>
      </div>
    </main>
  );
}
