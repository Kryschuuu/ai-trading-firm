/**
 * Doku-Viewer-Auflösung (`resolveDoc`) — Suchpfade `docs/architecture/` und
 * `docs/roadmap/` (STX-08-02, Altlast 3 aus OP-6) sowie die
 * **pfadbewusste** Auflösung (Doku-Rendering-Fix 2026-10-03).
 *
 * Anlass: `STRATEGY_STACK.md`, `PIPELINE_MAP.md`, `DB_SCHEMA.md`,
 * `INTEGRATION_POINTS.md` und der ADR-Log `DECISIONS.md` sind die
 * Single-Source-of-Truth für die Template-/Screening-Arbeit (ADR-008…010),
 * waren im Browser-Viewer aber nicht lesbar: `resolveDoc()` suchte nur in
 * `docs/`, `docs/audits/`, `docs/peer-reviews/`, `docs/security/` und
 * `docs/archive/`.
 *
 * Dieser Test ist rein statisch/deterministisch (keine DB, kein Netz, keine
 * Uhr) und sichert vier Dinge ab:
 *   1. Die Dateien unter `docs/architecture/` und `docs/roadmap/` lösen auf;
 *      die Suchpfade stehen nach `docs/security/` und vor `docs/archive/`.
 *   2. Die Path-Traversal-Abwehr bleibt: Parent-Referenzen (`..`) werden
 *      abgewiesen, und nur `docs/**` sowie Root-`*.md` sind auslieferbar.
 *   3. Die kanonische URL trägt den **Pfad innerhalb von `docs/`** — damit
 *      kollidieren die ~31 `README.md` des Baums nicht mehr auf eine URL.
 *   4. Katalog-Slugs und ihre kanonischen Pfade bleiben stabil.
 *
 * Geändertes Verhalten seit dem Doku-Rendering-Fix: `audits/README.md` löst
 * nicht mehr nach `docs/README.md` auf (das war der Befund „127 falsche
 * Treffer“), sondern nach `docs/audits/README.md`. Genau das wird hier
 * festgeschrieben, damit die Altlast nicht zurückkommt.
 *
 * Bewusste Entscheidung (Begründung im Modulkopf von
 * `src/lib/docsCatalog.ts`): Die fünf SSoT-Dokumente bekommen **keine**
 * Katalogeinträge. Ein Eintrag würde Schritt 2 (Dateiname-Matching) öffnen;
 * dann löste auch die pfadförmige Eingabe
 * `../architecture/STRATEGY_STACK.md` auf — genau das schließt die Abnahme
 * aus. Der Existenz-Fallback reicht für die Anzeige im Viewer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  DOCS_CATALOG,
  docCanonicalPath,
  isServableDocFile,
  listDocs,
  resolveDoc,
  resolveDocRequest,
} from "@/lib/docsCatalog";

const ROOT = process.cwd();

/** Der Auftrag nennt vier Architektur-Dateien und den ADR-Log; `STATUS.md`
 *  fällt unter denselben Suchpfad (historischer TASK-Tracker). */
const NEW_FALLBACK_DOCS: Array<{ name: string; file: string }> = [
  { name: "STRATEGY_STACK.md", file: "docs/architecture/STRATEGY_STACK.md" },
  { name: "PIPELINE_MAP.md", file: "docs/architecture/PIPELINE_MAP.md" },
  { name: "DB_SCHEMA.md", file: "docs/architecture/DB_SCHEMA.md" },
  { name: "INTEGRATION_POINTS.md", file: "docs/architecture/INTEGRATION_POINTS.md" },
  { name: "DECISIONS.md", file: "docs/roadmap/DECISIONS.md" },
  { name: "STATUS.md", file: "docs/roadmap/STATUS.md" },
];

const REJECTED = [
  "../architecture/STRATEGY_STACK.md",
  "..\\architecture\\STRATEGY_STACK.md",
  "architecture/../architecture/STRATEGY_STACK.md",
  "../../etc/passwd.md",
  "docs/../docs/roadmap/DECISIONS.md",
  "..",
];

// ── 1) Neue Suchpfade ───────────────────────────────────────────────────────
test("docs/architecture/ und docs/roadmap/ sind über resolveDoc() auffindbar", () => {
  for (const { name, file } of NEW_FALLBACK_DOCS) {
    const resolved = resolveDoc(name);
    assert.ok(resolved, `resolveDoc(${JSON.stringify(name)}) muss auflösen`);
    assert.equal(resolved.file, file, `${name}: Datei muss im neuen Suchpfad liegen`);
    // Kanonische URL = Pfad innerhalb von docs/ (nur der Dateiname wäre
    // mehrdeutig — es gibt 31 README.md im Baum).
    assert.equal(resolved.canonicalPath, `/docs/${file.slice("docs/".length)}`, `${name}: kanonische Browser-URL`);
    assert.equal(
      resolved.slug,
      file
        .slice("docs/".length)
        .replace(/\.md$/, "")
        .replace(/\//g, "-")
        .toLowerCase(),
      `${name}: Slug des Existenz-Fallbacks = Pfad unter docs/, kleingeschrieben`,
    );
    assert.ok(existsSync(path.join(ROOT, resolved.file)), `${file}: Datei muss existieren`);
  }
});

test("Suchpfad-Reihenfolge: architecture/ + roadmap/ nach security/, vor archive/", () => {
  // Die Liste ist statisch und explizit; der Test liest sie aus dem Modulkopf
  // (wie andere Repo-Tests) und hält die geforderte Reihenfolge fest, damit die
  // bestehenden Prioritäten nicht versehentlich verschoben werden.
  const source = readFileSync(path.join(ROOT, "src/lib/docsCatalog.ts"), "utf8");
  const block = source.match(/const searchPaths = \[([\s\S]*?)\];/);
  assert.ok(block, "searchPaths-Liste muss im Quelltext stehen");

  const entries = [...block[1].matchAll(/`docs\/([a-z-]*)\/\$\{safeBase\}`/g)].map((m) => m[1]);
  assert.deepEqual(
    entries,
    ["audits", "peer-reviews", "security", "architecture", "roadmap", "archive"],
    "Reihenfolge der Unterordner: architecture/ und roadmap/ zwischen security/ und archive/",
  );
  assert.match(block[1], /`docs\/\$\{safeBase\}`/, "docs/ bleibt erster Suchpfad");
  assert.match(block[1], /safeBase, \/\/ Root-Dateien/, "Root-Dateien bleiben letzter Suchpfad");
});

// ── 2) Traversal-/Pfadabwehr ────────────────────────────────────────────────
test("Parent-Referenzen erreichen den Existenz-Fallback nicht", () => {
  for (const name of REJECTED) {
    assert.equal(
      resolveDoc(name),
      null,
      `resolveDoc(${JSON.stringify(name)}) muss abweisen (Parent-Referenz)`,
    );
  }
});

test("Ohne .md (oder mit bloßem Basename) lernt der Viewer die neuen Ordner nicht", () => {
  for (const name of ["architecture/STRATEGY_STACK", "roadmap/DECISIONS", "STRATEGY_STACK", "DECISIONS"]) {
    assert.equal(resolveDoc(name), null, `resolveDoc(${JSON.stringify(name)}) darf nicht auflösen`);
  }
});

test("Der aufgelöste Pfad verlässt nie den Projektstamm (docs/ oder Root)", () => {
  const names = [
    ...NEW_FALLBACK_DOCS.map((d) => d.name),
    ...REJECTED.filter((n) => n.endsWith(".md")),
    "audits/README.md",
    "security/README.md",
    "CHANGELOG.md",
    "audits/2026-09-03-peer-review/README.md",
  ];
  for (const name of names) {
    const resolved = resolveDoc(name);
    if (!resolved) continue;
    assert.ok(!resolved.file.split(/[/\\]+/).includes(".."), `${name}: kein ..-Segment`);
    assert.ok(!path.isAbsolute(resolved.file), `${name}: kein absoluter Pfad`);
    assert.ok(
      resolved.file.startsWith("docs/") || !resolved.file.includes("/"),
      `${name}: nur docs/** oder bekannte Root-Dateien`,
    );
  }
});

test("Die SSoT-Dokumente bleiben bewusst außerhalb des Katalogs (Fallback reicht)", () => {
  const catalogFiles = new Set(Object.values(DOCS_CATALOG).map((entry) => entry.file));
  for (const { file } of NEW_FALLBACK_DOCS) {
    assert.ok(!catalogFiles.has(file), `${file}: kein Katalogeintrag (sonst löste die Pfadform auf)`);
  }
});

// ── 3) Regression: bestehende Auflösungen ───────────────────────────────────
test("Katalog-Slugs und ihre kanonischen Pfade bleiben stabil", () => {
  // Der nackte Dateiname ohne Verzeichnis bleibt die `docs/`-Datei.
  const readme = resolveDoc("README.md");
  assert.ok(readme, "README.md muss weiterhin auflösen");
  assert.equal(readme.slug, "readme");
  assert.equal(readme.file, "docs/README.md");
  assert.equal(readme.canonicalPath, "/docs/README.md");

  // Slug-Auflösung (Schritt 1) bleibt unverändert.
  assert.equal(resolveDoc("security")?.file, "docs/security/SECURITY_AUDIT.md");
  assert.equal(resolveDoc("strategyValidation")?.file, "docs/STRATEGY_VALIDATION.md");
  assert.equal(resolveDoc("security")?.canonicalPath, "/docs/security/SECURITY_AUDIT.md");

  // Repo-Root-Dateien stehen unter dem reservierten Segment `root/`, weil
  // sonst `CHANGELOG.md` (Root) und `docs/CHANGELOG.md` (Stub) kollidieren.
  const changelog = resolveDoc("root/CHANGELOG.md");
  assert.ok(changelog, "root/CHANGELOG.md muss auflösen");
  assert.equal(changelog.slug, "changelog");
  assert.equal(changelog.file, "CHANGELOG.md");
  assert.equal(changelog.canonicalPath, "/docs/root/CHANGELOG.md");
  assert.equal(docCanonicalPath("changelog"), "/docs/root/CHANGELOG.md");

  // Der gleichnamige Stub unter docs/ bleibt unter seiner eigenen URL
  // erreichbar und verlinkt von dort auf die Root-Datei.
  const stub = resolveDoc("CHANGELOG.md");
  assert.ok(stub, "CHANGELOG.md muss auflösen");
  assert.equal(stub.file, "docs/CHANGELOG.md");
  assert.equal(stub.canonicalPath, "/docs/CHANGELOG.md");
  assert.notEqual(stub.slug, changelog.slug, "Stub und Root-Datei brauchen verschiedene Slugs");

  // Einfache Trenner werden weiterhin normalisiert: die Pfadform gewinnt.
  assert.equal(resolveDoc("roadmap/STATUS.md")?.file, "docs/roadmap/STATUS.md");
  assert.equal(resolveDoc("roadmap/STATUS.md")?.canonicalPath, "/docs/roadmap/STATUS.md");
});

test("Namenskollisionen lösen nicht mehr auf dasselbe Dokument auf (Befund B5)", () => {
  // Vor dem Fix landeten alle drei auf `docs/README.md` — der Viewer zeigte
  // lautlos das falsche Dokument.
  const cases: Array<[string, string, string]> = [
    ["README.md", "docs/README.md", "/docs/README.md"],
    ["audits/README.md", "docs/audits/README.md", "/docs/audits/README.md"],
    ["security/README.md", "docs/security/README.md", "/docs/security/README.md"],
    [
      "audits/2026-09-03-peer-review/README.md",
      "docs/audits/2026-09-03-peer-review/README.md",
      "/docs/audits/2026-09-03-peer-review/README.md",
    ],
    [
      "audits/2026-09-18-feature-gap/remediation/TRACKING.md",
      "docs/audits/2026-09-18-feature-gap/remediation/TRACKING.md",
      "/docs/audits/2026-09-18-feature-gap/remediation/TRACKING.md",
    ],
  ];

  const seen = new Set<string>();
  for (const [name, file, canonicalPath] of cases) {
    const resolved = resolveDoc(name);
    assert.ok(resolved, `${name}: muss auflösen`);
    assert.equal(resolved.file, file, `${name}: Datei`);
    assert.equal(resolved.canonicalPath, canonicalPath, `${name}: kanonische URL`);
    assert.ok(existsSync(path.join(ROOT, resolved.file)), `${file}: muss existieren`);
    seen.add(resolved.file);
  }
  assert.equal(seen.size, cases.length, "jeder Name trifft ein eigenes Dokument");
});

test("Nur docs/** und Root-*.md sind auslieferbar (Traversal-Schranke)", () => {
  for (const name of [
    "src/db/schema.ts",
    "tests/fixtures/golden/README.md",
    "drizzle/2026-09-22_cross_sectional_ranking.sql",
    "src/executionQuality/README.md",
    "/etc/passwd.md",
    "docs/../../etc/passwd.md",
  ]) {
    assert.equal(resolveDoc(name), null, `resolveDoc(${JSON.stringify(name)}) muss abweisen`);
  }
  assert.equal(isServableDocFile("docs/a/b.md"), true);
  assert.equal(isServableDocFile("CHANGELOG.md"), true);
  assert.equal(isServableDocFile("src/db/schema.ts"), false);
  assert.equal(isServableDocFile("docs/../src/db/schema.ts"), false);
});

test("resolveDocRequest akzeptiert Slug, Pfad und kanonische URL", () => {
  assert.equal(resolveDocRequest("/docs/security/README.md")?.file, "docs/security/README.md");
  assert.equal(resolveDocRequest("/docs/root/CONFIGURATION.md")?.file, "CONFIGURATION.md");
  assert.equal(resolveDocRequest("docs/HANDBUCH.md")?.file, "docs/HANDBUCH.md");
  assert.equal(resolveDocRequest("handbuch")?.file, "docs/HANDBUCH.md");
  assert.equal(resolveDocRequest("/docs/../../etc/passwd.md"), null);
});

test("Jeder Katalogeintrag bleibt über Slug und canonicalPath stabil", () => {
  const slugs = Object.keys(DOCS_CATALOG);
  for (const slug of slugs) {
    const resolved = resolveDoc(slug);
    assert.ok(resolved, `${slug}: Slug muss auflösen`);
    assert.equal(resolved.file, DOCS_CATALOG[slug].file, `${slug}: Datei unverändert`);
    assert.equal(resolved.canonicalPath, docCanonicalPath(slug), `${slug}: canonicalPath unverändert`);
    assert.ok(resolved.canonicalPath.startsWith("/docs/"), `${slug}: kanonischer URL-Pfad`);
  }
  assert.equal(listDocs().length, slugs.length, "listDocs() = Katalogeinträge (unverändert)");
});
