"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { rewriteDocHref } from "@/lib/docsLinks";

/**
 * Rendert Markdown-Inhalt mit Link-Rewriting.
 *
 * Relative `*.md`-Links (z. B. `ARCHITECTURE.md`) werden in ihre kanonische
 * URL `/docs/ARCHITECTURE.md` umgeschrieben, damit die Doku lokal ohne 404
 * navigierbar ist. Externe URLs, Anker und bereits absolute Pfade bleiben
 * unverändert.
 */
export default function DocsMarkdown({ content }: { content: string }) {
  return (
    <div className="prose prose-invert prose-slate max-w-none prose-headings:scroll-mt-20 prose-h1:text-2xl prose-h2:mt-10 prose-h2:border-b prose-h2:border-slate-800 prose-h2:pb-2 prose-h2:text-xl prose-h3:text-base prose-a:text-emerald-400 prose-code:rounded prose-code:bg-slate-800 prose-code:px-1 prose-code:py-0.5 prose-code:text-emerald-300 prose-code:before:content-none prose-code:after:content-none prose-pre:border prose-pre:border-slate-800 prose-pre:bg-slate-950 prose-table:text-sm prose-th:text-slate-300 prose-strong:text-slate-100">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: (props) => <a {...props} href={rewriteDocHref(props.href ?? "")} />,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
