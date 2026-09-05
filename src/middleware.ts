/**
 * Docs-URL-Normalisierung (v1.36.22).
 *
 * 1. `/ARCHITECTURE.md` (Root, typische Auflösung relativer Markdown-Links
 *    von `/docs` ohne trailing slash) → `/docs/ARCHITECTURE.md`.
 * 2. `/docs?name=architecture` (alte Ops-/API-Links) → `/docs/ARCHITECTURE.md`.
 *
 * Die eigentliche HTML-Rendition liegt in `src/app/docs/[...slug]/page.tsx`.
 */
import { NextResponse, type NextRequest } from "next/server";
import { docsHrefFromNameParam, rewriteDocsHref } from "@/lib/docsLinks";

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (pathname === "/docs" || pathname === "/docs/") {
    const dest = docsHrefFromNameParam(req.nextUrl.searchParams.get("name"));
    if (dest) {
      const url = req.nextUrl.clone();
      url.pathname = dest;
      url.search = "";
      return NextResponse.redirect(url);
    }
    return NextResponse.next();
  }

  if (pathname.endsWith(".md") && !pathname.startsWith("/docs/") && !pathname.startsWith("/api/")) {
    const rewritten = rewriteDocsHref(pathname);
    if (rewritten.startsWith("/docs/")) {
      const url = req.nextUrl.clone();
      url.pathname = rewritten;
      return NextResponse.redirect(url);
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/docs", "/docs/", "/:file.md", "/audit-remediation/:file.md"],
};
