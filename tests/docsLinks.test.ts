/**
 * Link-Auflösung für den Doku-Viewer (`src/lib/docsLinks.ts`).
 *
 * Sichert den Kern des Doku-Rendering-Fixes ab (Befunde A3, B1, B2, B5, B7):
 *
 *   1. Relative `.md`-Links lösen **gegenüber dem Verzeichnis der Quelldatei**
 *      auf — nicht über den nackten Dateinamen.
 *   2. Ziele außerhalb von `docs/` (und der Root-`*.md`) werden nicht in eine
 *      URL übersetzt, sondern als `unsupported` markiert (kein Repo-File-Reader).
 *   3. Anker bleiben erhalten und sind `github-slugger`-kompatibel.
 *   4. End-to-end: **jeder** `.md`-Link der Doku landet im Browser beim
 *      richtigen Dokument. Genau diese Prüfung hätte die 903 toten und 127
 *      falschen Treffer des Ausgangsbefunds gefunden.
 *
 * Rein deterministisch: kein Netz, keine DB, nur das lokale Dateisystem.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import GithubSlugger from "github-slugger";
import {
  canonicalPathForFile,
  extractMarkdownLinks,
  fileFromCanonicalPath,
  isServableDocFile,
  resolveDocLink,
  splitAnchor,
  type FsProbe,
} from "@/lib/docsLinks";

const ROOT = process.cwd();

const fsProbe: FsProbe = {
  isFile: (file: string) => {
    try {
      return statSync(path.join(ROOT, file)).isFile();
    } catch {
      return false;
    }
  },
  isDir: (dir: string) => {
    try {
      return statSync(path.join(ROOT, dir)).isDirectory();
    } catch {
      return false;
    }
  },
};

/** Repo-Root-Markdown, das von der Doku verlinkt wird. */
const ROOT_MD = ["CHANGELOG.md", "CONFIGURATION.md", "CONTRIBUTING.md", "INSTALL.md", "README.md", "VERSION.md"];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of require("node:fs").readdirSync(dir) as string[]) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

// ── 1) Relative Auflösung gegenüber der Quelldatei ─────────────────────────
test("Relativer .md-Link löst gegenüber dem Verzeichnis der Quelldatei auf", () => {
  const cases: Array<[string, string, string]> = [
    // [Quelldatei, Ziel, erwartete Datei]
    ["docs/BETA_STATUS.md", "audits/2026-09-29-strategy-template-ausbau/ROADMAP.md",
      "docs/audits/2026-09-29-strategy-template-ausbau/ROADMAP.md"],
    ["docs/BETA_STATUS.md", "audits/2026-09-20-roadmap-audit/findings/RMA-P5-04-drawdown-scaling.md",
      "docs/audits/2026-09-20-roadmap-audit/findings/RMA-P5-04-drawdown-scaling.md"],
    ["docs/HANDBUCH.md", "security/README.md", "docs/security/README.md"],
    ["docs/README.md", "../README.md", "README.md"],
    ["docs/README.md", "../CONFIGURATION.md", "CONFIGURATION.md"],
    ["docs/audits/2026-09-20-roadmap-audit/findings/RMA-P1-05-lifecycle-drift.md", "../../../STRATEGY_LIFECYCLE.md",
      "docs/STRATEGY_LIFECYCLE.md"],
    ["docs/audits/2026-09-18-feature-gap/remediation/TRACKING.md", "../README.md",
      "docs/audits/2026-09-18-feature-gap/README.md"],
  ];

  for (const [source, target, expected] of cases) {
    const res = resolveDocLink(target, source, fsProbe);
    assert.equal(res.kind, "doc", `${source} -> ${target}: muss ein Dokument sein`);
    assert.equal(res.kind === "doc" && res.file, expected, `${source} -> ${target}: Datei`);
    assert.equal(res.kind === "doc" && res.href, canonicalPathForFile(expected), `${source} -> ${target}: URL`);
  }
});

// ── 2) Namenskollisionen (Befund B5) ───────────────────────────────────────
test("Gleichnamige Dateien in verschiedenen Ordnern bekommen verschiedene URLs", () => {
  const seen = new Map<string, string>();
  for (const source of [
    "docs/README.md",
    "docs/security/README.md",
    "docs/audits/README.md",
    "docs/audits/2026-09-03-peer-review/README.md",
    "docs/peer-reviews/README.md",
  ]) {
    const res = resolveDocLink("README.md", source, fsProbe);
    assert.equal(res.kind, "doc", `${source}: README.md muss auflösen`);
    if (res.kind !== "doc") continue;
    seen.set(source, res.file);
  }
  // Jede Quelldatei trifft "ihr" README — nicht alle dasselbe.
  assert.equal(seen.get("docs/README.md"), "docs/README.md");
  assert.equal(seen.get("docs/security/README.md"), "docs/security/README.md");
  assert.equal(seen.get("docs/audits/README.md"), "docs/audits/README.md");
  assert.equal(new Set(seen.values()).size, seen.size, "keine zwei Quellen zeigen auf dieselbe Datei");
});

// ── 3) Ziele außerhalb der Doku (Befund B7) ────────────────────────────────
test("Ziele außerhalb von docs/ werden nicht in eine URL übersetzt", () => {
  const cases: Array<[string, string]> = [
    ["docs/COPY_TRADING.md", "../src/brokers/reconciliation.ts"],
    ["docs/COPY_TRADING.md", "../drizzle/2026-10-03_copy_subscriptions.sql"],
    ["docs/COPY_TRADING.md", "../src/executionQuality/README.md"],
    ["docs/LLM_ROUTING.md", "../tests/fixtures/golden/README.md"],
    ["docs/HISTORY.md", "../scripts/import-history-csv.ts"],
    ["docs/README.md", "../../../../etc/passwd.md"], // verlässt den Projektstamm
  ];
  for (const [source, target] of cases) {
    const res = resolveDocLink(target, source, fsProbe);
    assert.equal(res.kind, "unsupported", `${source} -> ${target}: darf keine URL werden`);
  }
});

test("Verzeichnis-Ziele zeigen auf README.md darin", () => {
  const res = resolveDocLink("audits/2026-09-03-peer-review/", "docs/AUDIT_REMEDIATION_2026-09.md", fsProbe);
  assert.equal(res.kind, "doc");
  assert.equal(res.kind === "doc" && res.file, "docs/audits/2026-09-03-peer-review/README.md");
});

test("Externe URLs, Protokolle und reine Anker bleiben unverändert", () => {
  assert.equal(resolveDocLink("https://example.com/x", "docs/README.md", fsProbe).kind, "external");
  assert.equal(resolveDocLink("mailto:a@b.c", "docs/README.md", fsProbe).kind, "external");
  assert.deepEqual(
    resolveDocLink("#4-steuerung-über-die-api", "docs/HANDBUCH.md", fsProbe),
    { kind: "anchor", href: "#4-steuerung-über-die-api" },
  );
});

test("Der Anker bleibt beim Umschreiben erhalten", () => {
  const res = resolveDocLink("security/README.md#rule-governance-sec-06", "docs/HANDBUCH.md", fsProbe);
  assert.equal(res.kind, "doc");
  assert.equal(res.kind === "doc" && res.href, "/docs/security/README.md#rule-governance-sec-06");
});

// ── 4) URL-Schema ──────────────────────────────────────────────────────────
test("Kanonische URL und Datei sind Umkehrungen voneinander", () => {
  const pairs: Array<[string, string]> = [
    ["docs/README.md", "/docs/README.md"],
    ["docs/security/README.md", "/docs/security/README.md"],
    ["docs/audits/2026-09-18-feature-gap/remediation/TRACKING.md",
      "/docs/audits/2026-09-18-feature-gap/remediation/TRACKING.md"],
    ["CHANGELOG.md", "/docs/root/CHANGELOG.md"],
    ["CONFIGURATION.md", "/docs/root/CONFIGURATION.md"],
  ];
  for (const [file, url] of pairs) {
    assert.equal(canonicalPathForFile(file), url, `${file} -> ${url}`);
    assert.equal(fileFromCanonicalPath(url.slice("/docs/".length)), file, `${url} -> ${file}`);
  }
  assert.equal(canonicalPathForFile("src/db/schema.ts"), null);
  assert.equal(isServableDocFile("docs/../src/db/schema.ts"), false);
});

// ── 5) Extraktion ──────────────────────────────────────────────────────────
test("Links in Code-Blöcken und Inline-Code werden nicht extrahiert", () => {
  const md = [
    "Text mit [echtem Link](README.md).",
    "",
    "```md",
    "[im Code](nicht-echt.md)",
    "```",
    "",
    "Inline: `[a](b.md)` und [noch einer](INSTALL.md).",
    "Platzhalter: [x](foo/.../bar.md)",
  ].join("\n");
  assert.deepEqual(extractMarkdownLinks(md), ["README.md", "INSTALL.md"]);
  assert.deepEqual(splitAnchor("a/b.md#c#d"), ["a/b.md", "c#d"]);
});

// ── 6) End-to-end: jeder .md-Link der Doku ─────────────────────────────────
test("Jeder .md-Link der Doku landet im Viewer beim richtigen Dokument", () => {
  const files = [
    ...walk(path.join(ROOT, "docs")).filter((f) => f.endsWith(".md")),
    ...ROOT_MD.map((f) => path.join(ROOT, f)).filter((f) => statSync(f).isFile()),
  ];

  const broken: string[] = [];
  const wrong: string[] = [];
  let checked = 0;

  for (const file of files) {
    const rel = path.relative(ROOT, file);
    for (const target of extractMarkdownLinks(readFileSync(file, "utf8"))) {
      const [p] = splitAnchor(target);
      if (!p || !p.endsWith(".md")) continue;

      let expected: string;
      try {
        expected = path.relative(ROOT, path.resolve(path.dirname(file), decodeURIComponent(p)));
      } catch {
        continue;
      }
      const insideDocs = expected.startsWith("docs/");
      const isRootMd = !expected.includes("/") && expected.endsWith(".md");
      if (!insideDocs && !isRootMd) continue; // absichtlich Code-Text (B7)
      if (!fsProbe.isFile(expected)) continue; // toter Link -> docs:validate

      checked++;
      const res = resolveDocLink(target, rel, fsProbe);
      if (res.kind !== "doc") broken.push(`${rel}: ${target}`);
      else if (res.file !== expected) wrong.push(`${rel}: ${target} -> ${res.file} statt ${expected}`);
    }
  }

  assert.ok(checked > 1000, `Plausibilität: ${checked} geprüfte Links`);
  assert.deepEqual(broken.slice(0, 10), [], "Links, die im Viewer nicht ankommen");
  assert.deepEqual(wrong.slice(0, 10), [], "Links, die auf das falsche Dokument zeigen");
});

// ── 7) Anker: github-slugger-Kompatibilität (Befund A3) ────────────────────
test("Alle Kapitel-Anker der Doku sind github-slugger-kompatibel", () => {
  const files = [
    ...walk(path.join(ROOT, "docs")).filter((f) => f.endsWith(".md")),
    // Root-Dateien sind Sprungziele der Doku (`../CONFIGURATION.md#…`).
    ...ROOT_MD.map((f) => path.join(ROOT, f)).filter((f) => statSync(f).isFile()),
  ];
  const slugsOf = new Map<string, string[]>();
  const slugCache = new Map<string, string[]>();

  const headings = (file: string): string[] => {
    const cached = slugCache.get(file);
    if (cached) return cached;
    const slugger = new GithubSlugger();
    const out: string[] = [];
    let inFence = false;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      const m = line.match(/^#{1,6}\s+(.+?)\s*$/);
      if (m) {
        out.push(
          slugger.slug(
            m[1]
              .replace(/\s+#+\s*$/, "")
              .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
              .replace(/\*\*|__/g, "")
              .replace(/\*/g, "")
              .replace(/`/g, "")
              .trim(),
          ),
        );
      }
    }
    slugCache.set(file, out);
    return out;
  };

  const dead: string[] = [];
  let checked = 0;
  for (const file of files) {
    slugsOf.set(file, headings(file));
  }
  for (const file of files) {
    const rel = path.relative(ROOT, file);
    for (const target of extractMarkdownLinks(readFileSync(file, "utf8"))) {
      const [p, anchor] = splitAnchor(target);
      if (!anchor) continue;
      const resolved = p ? path.resolve(path.dirname(file), decodeURIComponent(p)) : file;
      checked++;
      if (!(slugsOf.get(resolved) ?? []).includes(decodeURIComponent(anchor))) {
        dead.push(`${rel}: toter Anker -> ${target}`);
      }
    }
  }

  assert.ok(checked > 100, `Plausibilität: ${checked} Anker geprüft`);
  assert.deepEqual(dead.slice(0, 10), [], "Anker, die im Browser ins Leere springen");
});
