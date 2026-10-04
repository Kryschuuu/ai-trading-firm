"use client";

/**
 * Rendert Markdown-Inhalt mit Link-Rewriting, Anker-IDs und **scrollbaren
 * Tabellen**.
 *
 * * **Anker:** `rehype-slug` vergibt GitHub-kompatible `id`s (`## 4. Steuerung
 *   über die API` → `id="4-steuerung-über-die-api"`). Erst damit funktionieren
 *   die Kapitel-Anker der Doku im Browser (Befund A2/A3).
 * * **Links:** Die Zuordnung Ziel → Viewer-URL kommt **serverseitig** aus
 *   `GET /api/docs` (`links`). Dort steht das Dateisystem zur Verfügung; hier
 *   im Client-Bundle nicht. Ohne Map bleibt der Link unverändert.
 * * **Nicht auflösbare Ziele** (`../src/db/schema.ts`, `../drizzle/*.sql`,
 *   Verzeichnisse ohne README) werden als nicht klickbarer Code-Text
 *   dargestellt statt als toter Link (Befund B7).
 * * **Tabellen (2026-10-04):** Breite Tabellen — z. B. die 11-spaltige
 *   Faktorübersicht in `DAILY_WEEKLY_RESEARCH.md` — ragten aus dem Artikel
 *   heraus bis unter das Inhaltsverzeichnis bzw. über den Viewport-Rand.
 *   Jede Tabelle sitzt jetzt in einem eigenen Scroll-Container
 *   (`.docs-table-scroll`): Sie nutzt volle Breite, wenn sie passt, und
 *   scrollt horizontal, wenn nicht. Der Wrapper ist per `tabIndex=0` auch mit
 *   der Tastatur scrollbar (A11y).
 */

import ReactMarkdown from "react-markdown";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";

export type DocLinkMap = Record<string, string | null>;

export default function DocsMarkdown({
  content,
  links,
  docPath,
}: {
  content: string;
  links?: DocLinkMap;
  /** Kanonischer Pfad — nur als `data-doc` für Debug/Tests hinterlegt. */
  docPath?: string;
}) {
  return (
    <div
      data-doc={docPath}
      className="docs-content prose prose-invert prose-slate max-w-none prose-headings:scroll-mt-24 prose-h1:text-2xl prose-h2:mt-10 prose-h2:border-b prose-h2:border-slate-800 prose-h2:pb-2 prose-h2:text-xl prose-h3:text-base prose-a:text-emerald-400 prose-a:break-words prose-code:rounded prose-code:bg-slate-800 prose-code:px-1 prose-code:py-0.5 prose-code:text-emerald-300 prose-code:before:content-none prose-code:after:content-none prose-code:break-words prose-pre:border prose-pre:border-slate-800 prose-pre:bg-slate-950 prose-table:text-sm prose-th:text-slate-300 prose-strong:text-slate-100"
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSlug]}
        components={{
          a: ({ node, href, children, ...props }) => {
            // `node` ist der mdast-Knoten von react-markdown — als DOM-Attribut
            // würde er als `node="[object Object]"` im HTML landen (Befund 2026-10-04).
            void node;
            const raw = href ?? "";
            const mapped = links && Object.prototype.hasOwnProperty.call(links, raw) ? links[raw] : undefined;

            // Vom Server als „liegt außerhalb der Doku“ markiert.
            if (mapped === null) {
              return (
                <span
                  className="rounded bg-slate-800 px-1 py-0.5 font-mono text-[0.85em] text-slate-400"
                  title={`Kein Dokument des Viewers — liegt außerhalb von docs/: ${raw}`}
                >
                  {children}
                </span>
              );
            }

            const target = mapped ?? raw;
            const external = /^(https?:|mailto:|tel:)/i.test(target);
            return (
              <a
                {...props}
                href={target}
                {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
              >
                {children}
              </a>
            );
          },
          table: ({ node, children, ...props }) => {
            void node; // siehe oben — kein DOM-Attribut
            return (
              <div
                className="docs-table-scroll"
                role="region"
                aria-label="Tabelle (horizontal scrollbar)"
                tabIndex={0}
              >
                <table {...props}>{children}</table>
              </div>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
