/**
 * Docs-Viewer (v1.36.22): relative Markdown-Links dürfen im Browser nicht als
 * `http://host:3369/ARCHITECTURE.md` landen. Der Renderer schreibt sie auf
 * `/docs/<Datei>.md`; die Quellen unter `docs/` bleiben GitHub-relativ.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { DOCS_CATALOG, docsHrefForFile, lookupCatalog } from "../src/lib/docsCatalog";
import { resolveRenderableDoc } from "../src/lib/docsContent";
import { docsHrefFromNameParam, rewriteDocsHref } from "../src/lib/docsLinks";

const ROOT = process.cwd();

test("rewriteDocsHref: ARCHITECTURE.md und Root-404-URL landen unter /docs/", () => {
  assert.equal(rewriteDocsHref("ARCHITECTURE.md"), "/docs/ARCHITECTURE.md");
  assert.equal(rewriteDocsHref("./ARCHITECTURE.md"), "/docs/ARCHITECTURE.md");
  assert.equal(rewriteDocsHref("/ARCHITECTURE.md"), "/docs/ARCHITECTURE.md");
  assert.equal(rewriteDocsHref("docs/ARCHITECTURE.md"), "/docs/ARCHITECTURE.md");
  assert.equal(rewriteDocsHref("architecture"), "/docs/ARCHITECTURE.md");
  assert.equal(rewriteDocsHref("ARCHITECTURE.md#2-architektur"), "/docs/ARCHITECTURE.md#2-architektur");
});

test("rewriteDocsHref: lässt externe, Anker- und App-Routen unverändert", () => {
  assert.equal(rewriteDocsHref("https://example.com/x.md"), "https://example.com/x.md");
  assert.equal(rewriteDocsHref("mailto:ops@example.com"), "mailto:ops@example.com");
  assert.equal(rewriteDocsHref("#abschnitt"), "#abschnitt");
  assert.equal(rewriteDocsHref("/api/health"), "/api/health");
  assert.equal(rewriteDocsHref("/docs/ARCHITECTURE.md"), "/docs/ARCHITECTURE.md");
});

test("rewriteDocsHref: audit-remediation-Relativpfade bleiben im Docs-Namespace", () => {
  assert.equal(
    rewriteDocsHref("../audit-remediation/H10-adaptive-failopen.md"),
    "/docs/audit-remediation/H10-adaptive-failopen.md",
  );
});

test("docsHrefFromNameParam: alte Ops-Query ?name= wird kanonisch", () => {
  assert.equal(docsHrefFromNameParam("architecture"), "/docs/ARCHITECTURE.md");
  assert.equal(docsHrefFromNameParam("ARCHITECTURE.md"), "/docs/ARCHITECTURE.md");
  assert.equal(docsHrefFromNameParam("handbuch"), "/docs/HANDBUCH.md");
  assert.equal(docsHrefFromNameParam(null), null);
});

test("lookupCatalog trifft Slug, Dateiname und docs/-Pfad", () => {
  assert.equal(lookupCatalog("architecture")?.entry.file, "docs/ARCHITECTURE.md");
  assert.equal(lookupCatalog("ARCHITECTURE.md")?.entry.file, "docs/ARCHITECTURE.md");
  assert.equal(lookupCatalog("docs/ARCHITECTURE.md")?.entry.file, "docs/ARCHITECTURE.md");
  assert.equal(lookupCatalog("alpaca")?.entry.file, "docs/ALPACA.md");
});

test("alle Katalogdateien existieren und haben eine /docs/-URL", () => {
  for (const [slug, entry] of Object.entries(DOCS_CATALOG)) {
    const abs = path.join(ROOT, entry.file);
    assert.ok(existsSync(abs), `Katalog '${slug}' zeigt auf fehlende Datei ${entry.file}`);
    assert.equal(docsHrefForFile(entry.file).startsWith("/docs/"), true);
    assert.ok(docsHrefForFile(entry.file).endsWith(".md"), `${slug} muss als .md-URL erreichbar sein`);
  }
});

test("docs/README.md: jeder relative *.md-Link zeigt auf /docs/… und existiert", () => {
  const src = readFileSync(path.join(ROOT, "docs/README.md"), "utf8");
  const re = /\]\(([^)]+)\)/g;
  const missing: string[] = [];
  const badRewrite: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(src)) !== null) {
    const href = match[1].trim();
    if (/^(https?:|mailto:|#)/i.test(href)) continue;
    const pathPart = href.split("#")[0].split("?")[0];
    if (!/\.md$/i.test(pathPart)) continue;
    const rewritten = rewriteDocsHref(href);
    if (!rewritten.startsWith("/docs/")) {
      badRewrite.push(`${href} → ${rewritten}`);
      continue;
    }
    const resolved = resolveRenderableDoc(pathPart);
    if (!resolved || !existsSync(path.join(ROOT, resolved.file))) {
      missing.push(href);
    }
  }
  assert.deepEqual(badRewrite, [], "README-Links müssen auf /docs/… umgeschrieben werden");
  assert.deepEqual(missing, [], "README-Link-Ziele müssen auf Disk existieren");
});

test("resolveRenderableDoc: Path-Traversal ausserhalb docs/ und audit-remediation ist tot", () => {
  assert.equal(resolveRenderableDoc("../../package.json"), null);
  assert.equal(resolveRenderableDoc("../package.json"), null);
  assert.equal(resolveRenderableDoc("/etc/passwd.md"), null);
  assert.equal(resolveRenderableDoc("src/lib/version.ts"), null);
  const arch = resolveRenderableDoc("ARCHITECTURE.md");
  assert.ok(arch);
  assert.equal(arch.file, "docs/ARCHITECTURE.md");
  assert.equal(arch.href, "/docs/ARCHITECTURE.md");
});

test("Docs-App: Catch-All-Route und Middleware existieren (kein Client-only-Viewer mehr)", () => {
  const page = readFileSync(path.join(ROOT, "src/app/docs/[...slug]/page.tsx"), "utf8");
  assert.match(page, /params: Promise/);
  assert.match(page, /await params/);
  assert.match(page, /DocsShell/);
  const index = readFileSync(path.join(ROOT, "src/app/docs/page.tsx"), "utf8");
  assert.doesNotMatch(index, /["']use client["']/);
  const mw = readFileSync(path.join(ROOT, "src/middleware.ts"), "utf8");
  assert.match(mw, /docsHrefFromNameParam/);
  assert.match(mw, /rewriteDocsHref/);
});
