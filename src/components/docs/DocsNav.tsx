"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { DocsListItem } from "@/lib/docsCatalog";

export function DocsNav({ docs, indexHref }: { docs: DocsListItem[]; indexHref: string }) {
  const pathname = usePathname() ?? "/docs";
  const current = pathname.replace(/\/$/, "") || "/docs";

  return (
    <nav className="space-y-2 lg:sticky lg:top-6 lg:self-start lg:max-h-[calc(100vh-4rem)] lg:overflow-y-auto">
      {docs.map((d) => {
        const active = current === d.href || (d.href === indexHref && (current === "/docs" || current === d.href));
        return (
          <Link
            key={d.slug}
            href={d.href}
            className={`block w-full rounded-xl border px-4 py-3 text-left transition ${
              active
                ? "border-emerald-500/50 bg-emerald-500/10"
                : "border-slate-800 bg-slate-900/50 hover:bg-slate-800/60"
            }`}
          >
            <span className={`block text-sm font-bold ${active ? "text-emerald-300" : "text-slate-200"}`}>
              {d.title}
            </span>
            <span className="mt-0.5 block text-[11px] leading-snug text-slate-500">{d.subtitle}</span>
          </Link>
        );
      })}
      <div className="rounded-xl border border-slate-800 bg-slate-900/40 px-4 py-3 text-[11px] leading-relaxed text-slate-500">
        Jedes Dokument hat eine eigene URL unter <code>/docs/&lt;Datei&gt;.md</code> — z. B.{" "}
        <code>/docs/ARCHITECTURE.md</code>. Die Markdown-Dateien liegen im Repo unter{" "}
        <code>docs/</code> und sind dort auch offline lesbar.
      </div>
    </nav>
  );
}
