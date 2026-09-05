import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { rewriteDocsHref } from "@/lib/docsLinks";

const PROSE =
  "prose prose-invert prose-slate max-w-none prose-headings:scroll-mt-20 prose-h1:text-2xl prose-h2:mt-10 prose-h2:border-b prose-h2:border-slate-800 prose-h2:pb-2 prose-h2:text-xl prose-h3:text-base prose-a:text-emerald-400 prose-code:rounded prose-code:bg-slate-800 prose-code:px-1 prose-code:py-0.5 prose-code:text-emerald-300 prose-code:before:content-none prose-code:after:content-none prose-pre:border prose-pre:border-slate-800 prose-pre:bg-slate-950 prose-table:text-sm prose-th:text-slate-300 prose-strong:text-slate-100";

function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "object" && node !== null && "props" in node) {
    const props = (node as { props?: { children?: ReactNode } }).props;
    return textOf(props?.children);
  }
  return "";
}

/** GitHub-ähnlicher Heading-Anker, analog `scripts/docs-validate.ts`. */
function headingSlug(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function Heading({
  Tag,
  children,
}: {
  Tag: "h1" | "h2" | "h3" | "h4";
  children: ReactNode;
}) {
  const id = headingSlug(textOf(children));
  return <Tag id={id || undefined}>{children}</Tag>;
}

export function MarkdownDoc({ content }: { content: string }) {
  return (
    <div className={PROSE}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a({ href, children }) {
            const next = rewriteDocsHref(href);
            const external = /^(https?:|mailto:|tel:)/i.test(next);
            if (external) {
              return (
                <a href={next} target="_blank" rel="noreferrer noopener">
                  {children}
                </a>
              );
            }
            return <a href={next}>{children}</a>;
          },
          h1({ children }) {
            return <Heading Tag="h1">{children}</Heading>;
          },
          h2({ children }) {
            return <Heading Tag="h2">{children}</Heading>;
          },
          h3({ children }) {
            return <Heading Tag="h3">{children}</Heading>;
          },
          h4({ children }) {
            return <Heading Tag="h4">{children}</Heading>;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
