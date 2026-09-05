/**
 * Markdown-Link-Umschreibung für den lokalen Docs-Renderer.
 *
 * Relative `*.md`-Links (wie in `docs/README.md`) dürfen im Browser nicht als
 * `http://host:3369/ARCHITECTURE.md` landen — das ist eine 404, weil Next.js
 * dort keine Seite hat. Ziel ist die kanonische, gerenderte URL
 * `/docs/<Datei>.md` (plus optionale Heading-Anker).
 *
 * Rein, ohne Dateisystem — nutzbar in Middleware, Server- und Client-Komponenten.
 */
import { docsHrefForFile, lookupCatalog } from "@/lib/docsCatalog";

const ABSOLUTE_SCHEME = /^(?:https?:|mailto:|tel:)/i;

/**
 * Wandelt einen Markdown-`href` in eine im lokalen Docs-Viewer gültige URL.
 * Unbekannte oder externe Ziele bleiben unverändert.
 */
export function rewriteDocsHref(href: string | undefined): string {
  if (!href) return "";
  const trimmed = href.trim();
  if (!trimmed) return "";

  const hashIdx = trimmed.indexOf("#");
  const hash = hashIdx >= 0 ? trimmed.slice(hashIdx) : "";
  const beforeHash = hashIdx >= 0 ? trimmed.slice(0, hashIdx) : trimmed;
  const pathPart = beforeHash.split("?")[0].trim();

  if (!pathPart) return hash || trimmed;
  if (ABSOLUTE_SCHEME.test(pathPart)) return trimmed;
  if (pathPart.startsWith("/docs/")) return `${pathPart}${hash}`;

  if (pathPart.startsWith("/") && /\.md$/i.test(pathPart)) {
    const inner = pathPart.replace(/^\/+/, "");
    const catalog = lookupCatalog(inner);
    if (catalog) return `${docsHrefForFile(catalog.entry.file)}${hash}`;
    if (inner.toLowerCase().startsWith("audit-remediation/")) {
      return `/docs/${inner}${hash}`;
    }
    const base = inner.split("/").pop();
    return base ? `/docs/${base}${hash}` : trimmed;
  }

  if (pathPart.startsWith("/")) return trimmed;

  const catalog = lookupCatalog(pathPart);
  if (catalog) return `${docsHrefForFile(catalog.entry.file)}${hash}`;

  let decoded = pathPart;
  try {
    decoded = decodeURIComponent(pathPart);
  } catch {
    /* unkodiert lassen */
  }
  decoded = decoded.replace(/\\/g, "/");

  const audit = decoded.match(/(?:^|\/)(audit-remediation\/[^/]+\.md)$/i);
  if (audit) return `/docs/${audit[1]}${hash}`;

  const md = decoded.match(/([^/]+\.md)$/i);
  if (md) return `/docs/${md[1]}${hash}`;

  return trimmed;
}

/** `?name=<slug|Datei>` → kanonische Docs-URL, oder null. */
export function docsHrefFromNameParam(name: string | null | undefined): string | null {
  if (!name) return null;
  const rewritten = rewriteDocsHref(name);
  return rewritten.startsWith("/docs/") ? rewritten : null;
}
