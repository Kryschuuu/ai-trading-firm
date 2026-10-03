/**
 * Doku-Viewer-Auflösung (`resolveDoc`) — Suchpfade `docs/architecture/` und
 * `docs/roadmap/` (STX-08-02, Altlast 3 aus OP-6).
 *
 * Anlass: `STRATEGY_STACK.md`, `PIPELINE_MAP.md`, `DB_SCHEMA.md`,
 * `INTEGRATION_POINTS.md` und der ADR-Log `DECISIONS.md` sind die
 * Single-Source-of-Truth für die Template-/Screening-Arbeit (ADR-008…010),
 * waren im Browser-Viewer aber nicht lesbar: `resolveDoc()` suchte nur in
 * `docs/`, `docs/audits/`, `docs/peer-reviews/`, `docs/security/` und
 * `docs/archive/`.
 *
 * Dieser Test ist rein statisch/deterministisch (keine DB, kein Netz, keine
 * Uhr) und sichert drei Dinge ab:
 *   1. Die Dateien unter `docs/architecture/` und `docs/roadmap/` lösen über
 *      ihr Basename auf; die Suchpfade stehen nach `docs/security/` und vor
 *      `docs/archive/`.
 *   2. Die Path-Traversal-Abwehr bleibt: Parent-Referenzen (`..`) werden
 *      abgewiesen, und der aufgelöste Pfad entsteht weiterhin ausschließlich
 *      aus `basename()` + fester Ordnerliste.
 *   3. Bestehende Auflösungen (Katalog-Slugs, `audits/README.md`,
 *      `security/README.md`, `CHANGELOG.md`) sind unverändert.
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

import { DOCS_CATALOG, docCanonicalPath, listDocs, resolveDoc } from "@/lib/docsCatalog";

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
    assert.equal(resolved.canonicalPath, `/docs/${name}`, `${name}: kanonische Browser-URL`);
    assert.equal(
      resolved.slug,
      name.replace(/\.md$/, "").toLowerCase(),
      `${name}: Slug des Existenz-Fallbacks = kleingeschriebenes Basename`,
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
test("Bestehende Auflösungen sind unverändert (audits/, security/, CHANGELOG.md)", () => {
  // Vor und nach der Änderung: `README.md` ist ein früher Katalogeintrag,
  // `audits/README.md` und `security/README.md` matchen in Schritt 2 dorthin.
  for (const name of ["audits/README.md", "security/README.md", "README.md"]) {
    const resolved = resolveDoc(name);
    assert.ok(resolved, `${name}: muss weiterhin auflösen`);
    assert.equal(resolved.slug, "readme", `${name}: Slug bleibt readme`);
    assert.equal(resolved.file, "docs/README.md", `${name}: Datei bleibt docs/README.md`);
    assert.equal(resolved.canonicalPath, "/docs/README.md", `${name}: canonicalPath unverändert`);
  }

  const changelog = resolveDoc("CHANGELOG.md");
  assert.ok(changelog, "CHANGELOG.md muss weiterhin auflösen");
  assert.equal(changelog.slug, "changelog");
  assert.equal(changelog.file, "CHANGELOG.md");
  assert.equal(changelog.canonicalPath, "/docs/CHANGELOG.md");

  // Slug-Auflösung (Schritt 1) bleibt unverändert.
  assert.equal(resolveDoc("security")?.file, "docs/security/SECURITY_AUDIT.md");
  assert.equal(resolveDoc("strategyValidation")?.file, "docs/STRATEGY_VALIDATION.md");

  // Einfache Trenner werden weiterhin über `basename()` normalisiert (kein
  // Parent-Bezug): das Verhalten der Ordner-Suche bleibt stabil.
  assert.equal(resolveDoc("roadmap/STATUS.md")?.file, "docs/roadmap/STATUS.md");
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
