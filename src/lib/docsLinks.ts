/**
 * Link-Auflösung für gerendertes Markdown — doc-bewusst, ohne fs-Zugriff.
 *
 * ── Warum dieses Modul existiert ───────────────────────────────────────────
 * Die Doku ist für **GitHub** geschrieben. Dort löst ein relativer Link
 * gegenüber dem Verzeichnis der Quelldatei auf:
 *
 *   docs/BETA_STATUS.md  →  `audits/…/ROADMAP.md`  ⇒  docs/audits/…/ROADMAP.md
 *
 * Der alte Renderer hat daraus `/docs/ROADMAP.md` gemacht — nur der Dateiname
 * überlebte. Bei ~31 `README.md` im Baum kam dabei lautlos das falsche
 * Dokument heraus (Befund B5), und Ziele außerhalb von `docs/` wurden zu
 * kaputten URLs (Befund B1).
 *
 * Dieses Modul ist die **gemeinsame Auflösungslogik** für App und Validator
 * (`scripts/docs-validate.ts`, Check `App-Link-Check`). Beide benutzen
 * dieselbe Funktion — sonst prüft der Validator wieder eine andere Realität
 * als der Browser zeigt.
 *
 * ── Aufteilung ─────────────────────────────────────────────────────────────
 * * Alles hier ist **rein** (kein `node:fs`, kein `node:path`), damit auch die
 *   Client-Komponente `DocsMarkdown` dieses Modul importieren kann.
 * * Der Dateisystem-Zugriff wird über {@link FsProbe} hereingereicht und liegt
 *   serverseitig in `src/app/api/docs/route.ts` bzw. im Validator.
 *
 * ── URL-Schema ─────────────────────────────────────────────────────────────
 *   docs/README.md                       → /docs/README.md
 *   docs/audits/2026-09-18-feature-gap/README.md
 *                                        → /docs/audits/2026-09-18-feature-gap/README.md
 *   CHANGELOG.md (Repo-Root)             → /docs/root/CHANGELOG.md
 *
 * Ziele außerhalb von `docs/` und der Root-Markdown-Dateien werden **nicht**
 * in eine URL übersetzt (`kind: "unsupported"`) und im Viewer als Code-Text
 * dargestellt — der Viewer ist kein Repo-File-Reader (Befund B7).
 */

/** Reserviertes URL-Segment für Markdown-Dateien im Repo-Root. */
export const ROOT_DOC_SEGMENT = "root";

/** Letztes Pfadsegment (`audits/ARCHITECTURE.md` → `ARCHITECTURE.md`). */
export function basename(file: string): string {
  return file.split("/").pop() ?? file;
}

/** Pfadform normalisieren: `\` → `/`, führende `/` und `./` entfernen. */
export function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\/+/, "").replace(/^\.\//, "");
}

/** Enthält der Pfad ein `..`-Segment? */
export function hasParentRef(p: string): boolean {
  return normalizeSlashes(p).split("/").includes("..");
}

/**
 * Liegt der Pfad im Bereich, den der Viewer überhaupt anfasst?
 *
 * Das sind `docs/**` (Dateien **und** Verzeichnisse — ein Verzeichnis wird auf
 * sein `README.md` abgebildet) sowie die Ebene direkt im Repo-Root.
 * Ausgeschlossen: absolute Pfade, `..`-Segmente und alles unter `src/`,
 * `tests/`, `drizzle/`, `scripts/`.
 */
export function isWithinDocScope(file: string): boolean {
  if (!file) return false;
  const p = normalizeSlashes(file);
  if (p.startsWith("/") || /^[a-zA-Z]:/.test(p)) return false; // absolut
  if (hasParentRef(p)) return false;
  if (p === "docs" || p.startsWith("docs/")) return p.length > 5;
  return !p.includes("/"); // Repo-Root: nur die Dateiebene
}

/**
 * Traversal-Schranke: darf diese Datei vom Viewer ausgeliefert werden?
 *
 * Erlaubt sind ausschließlich **Markdown** unter `docs/**` und
 * Markdown-Dateien direkt im Repo-Root. Alles andere (`src/`, `tests/`,
 * `drizzle/`, absolute Pfade, `..`-Segmente, aber auch PDFs/CSV/JSON unter
 * `docs/`) ist ausgeschlossen — der Viewer bleibt damit kein File-Reader für
 * das Repository und liefert nie Binärdateien als `utf8`-Text aus.
 */
export function isServableDocFile(file: string): boolean {
  const p = normalizeSlashes(file);
  if (p.length <= 3 || !p.endsWith(".md")) return false;
  return isWithinDocScope(p);
}

/**
 * Kanonische Browser-URL einer Doku-Datei.
 *
 *   `docs/security/README.md` → `/docs/security/README.md`
 *   `CHANGELOG.md`            → `/docs/root/CHANGELOG.md`
 *   `src/db/schema.ts`        → `null` (nicht auslieferbar)
 */
export function canonicalPathForFile(file: string): string | null {
  if (!isServableDocFile(file)) return null;
  const p = normalizeSlashes(file);
  if (p.startsWith("docs/")) return `/docs/${encodePath(p.slice("docs/".length))}`;
  return `/docs/${ROOT_DOC_SEGMENT}/${encodePath(p)}`;
}

/**
 * Umkehrung von {@link canonicalPathForFile}: URL-Pfad (ohne führendes
 * `/docs/`) zurück in eine Datei. `null`, wenn der Pfad nicht auf eine
 * auslieferbare Datei zeigt.
 */
export function fileFromCanonicalPath(urlPath: string): string | null {
  if (!urlPath) return null;
  const rel = normalizeSlashes(urlPath).replace(/^docs\//, "");
  const file = rel.startsWith(`${ROOT_DOC_SEGMENT}/`)
    ? rel.slice(ROOT_DOC_SEGMENT.length + 1)
    : `docs/${rel}`;
  return isServableDocFile(file) ? file : null;
}

/**
 * Dekodiert ein einzelnes Pfadsegment (`Security%20Review.md` →
 * `Security Review.md`). Bei kaputten Escapes bleibt der Rohwert stehen.
 *
 * Pro Segment dekodiert — nicht über den ganzen Pfad —, damit ein kodiertes
 * `%2F` kein zusätzliches Segment erzeugen kann.
 */
export function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Pfadsegmente einzeln kodieren (`/` bleibt Trenner). */
function encodePath(p: string): string {
  return p.split("/").map((s) => encodeURIComponent(s)).join("/");
}

// ---------------------------------------------------------------------------
// Link-Auflösung
// ---------------------------------------------------------------------------

/** Minimaler Dateisystem-Blick, den die Auflösung braucht. */
export type FsProbe = {
  /** Existiert `file` und ist eine reguläre Datei? */
  isFile(file: string): boolean;
  /** Existiert `dir` und ist ein Verzeichnis? */
  isDir(dir: string): boolean;
};

export type DocLinkResolution =
  /** Externe URL, Protokoll-Link — unverändert durchreichen. */
  | { kind: "external"; href: string }
  /** Reiner In-Page-Anker (`#kapitel`) — unverändert durchreichen. */
  | { kind: "anchor"; href: string }
  /** Zeigt auf ein Dokument, das der Viewer ausliefert. */
  | { kind: "doc"; href: string; file: string }
  /** Liegt außerhalb der Doku (Code, Migrationen, Verzeichnis ohne README). */
  | { kind: "unsupported"; href: string };

/** Trennt `pfad#anker` in Pfad und Anker (sicher gegen mehrere `#`). */
export function splitAnchor(href: string): [string, string] {
  const idx = href.indexOf("#");
  if (idx === -1) return [href, ""];
  return [href.slice(0, idx), href.slice(idx + 1)];
}

/** Verzeichnissegments einer Datei (`docs/a/b.md` → `["docs","a"]`). */
function dirSegments(file: string): string[] {
  const parts = normalizeSlashes(file).split("/");
  parts.pop();
  return parts.filter(Boolean);
}

/**
 * Löst ein relatives Ziel gegenüber der Quelldatei auf — mit `.`/`..`-Logik
 * wie `path.resolve`, aber ohne `node:path` (Client-Bundle).
 *
 * @returns Segmente relativ zum Projektstamm, oder `null`, wenn das Ziel über
 *          den Projektstamm hinauszeigt.
 */
export function resolveRelativeTo(currentFile: string, target: string): string[] | null {
  const segs = dirSegments(currentFile);
  for (const raw of normalizeSlashes(target).split("/")) {
    if (!raw || raw === ".") continue;
    if (raw === "..") {
      if (segs.length === 0) return null;
      segs.pop();
      continue;
    }
    segs.push(raw);
  }
  return segs;
}

/**
 * Übersetzt einen Markdown-Link in die URL des Viewers.
 *
 * @param href        Rohziel aus dem Markdown (z. B. `audits/x/README.md#kapitel`).
 * @param currentFile Datei, in der der Link steht (`docs/BETA_STATUS.md`).
 * @param fs          Dateisystem-Blick (serverseitig); ohne ihn bleibt die
 *                    Prüfung aus und nur die Pfadform entscheidet.
 */
export function resolveDocLink(
  href: string,
  currentFile: string,
  fs?: FsProbe,
): DocLinkResolution {
  if (!href) return { kind: "external", href };

  // Externe Links, Protokolle, Protokoll-relative und schon absolute Pfade
  // bleiben unangetastet (`/api/...`, `/docs/...`, `//host`).
  if (/^(https?:|mailto:|tel:|data:)/i.test(href) || href.startsWith("//") || href.startsWith("/")) {
    return { kind: "external", href };
  }

  const [p, anchor] = splitAnchor(href);
  const withAnchor = anchor ? `#${anchor}` : "";

  // Reiner Anker: bleibt, solange Überschriften IDs haben (rehype-slug).
  if (!p) return { kind: "anchor", href: `#${anchor}` };

  const decoded = safeDecode(p);
  const segs = resolveRelativeTo(currentFile, decoded);
  if (!segs) return { kind: "unsupported", href };

  const file = segs.join("/");
  // Containment zuerst: Verzeichnisse unter docs/ sind erlaubt (sie werden
  // auf ihr README abgebildet), alles außerhalb docs/ bzw. der Root-Ebene nicht.
  if (!isWithinDocScope(file)) return { kind: "unsupported", href };

  // Nur Markdown ist renderbar — `.sql`, `.ts`, `.json`, `.csv` nicht.
  if (file.endsWith(".md")) {
    if (!fs || fs.isFile(file)) {
      const canonical = canonicalPathForFile(file);
      if (canonical) return { kind: "doc", href: `${canonical}${withAnchor}`, file };
    }
    return { kind: "unsupported", href };
  }

  // Verzeichnis-Ziel (`audits/2026-09-03-peer-review/`) → README.md darin.
  if (fs?.isDir(file)) {
    const index = `${file}/README.md`;
    if (fs.isFile(index)) {
      const canonical = canonicalPathForFile(index);
      if (canonical) return { kind: "doc", href: `${canonical}${withAnchor}`, file: index };
    }
  }

  return { kind: "unsupported", href };
}

/** `decodeURIComponent`, das bei kaputten Escapes den Rohwert zurückgibt. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// ---------------------------------------------------------------------------
// Link-Extraktion (gemeinsam mit dem Validator genutzt)
// ---------------------------------------------------------------------------

/**
 * Alle Link-Ziele eines Markdown-Dokuments in Lesereihenfolge.
 *
 * Code-Blöcke (``` und ~~~) und Inline-Code werden entfernt — Beispiele sind
 * keine echten Links. Externe URLs und Platzhalter (`...`) entfallen, damit
 * App und Validator exakt dieselbe Menge betrachten.
 */
export function extractMarkdownLinks(markdown: string): string[] {
  const out: string[] = [];
  let inFence = false;
  let filtered = "";
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) filtered += line.replace(/`[^`]*`/g, "") + "\n";
  }
  const re = /\]\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(filtered)) !== null) {
    const target = m[1].trim();
    if (!target) continue;
    if (/^(https?:|mailto:|tel:|data:)/i.test(target)) continue;
    if (target.includes("...")) continue;
    if (!out.includes(target)) out.push(target);
  }
  return out;
}
