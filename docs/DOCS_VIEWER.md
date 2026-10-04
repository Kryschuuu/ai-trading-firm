# Doku-Viewer (`/docs`) — Aufbau, Pflege, Grenzen

**Stand:** 2026-10-04 · **Version:** `v0.14.0` (Beta) · **Status:** Implementiert
**Verwandt:** [REPOSITORY_STRUCTURE.md](REPOSITORY_STRUCTURE.md) · [DOCS_SYNC_AUDIT.md](DOCS_SYNC_AUDIT.md) · [INDICATORS.md](INDICATORS.md)

Der Viewer macht die Markdown-Doku **im laufenden System** lesbar — ohne
GitHub, ohne Editor, ohne Internet. Diese Datei beschreibt, wie er aufgebaut
ist, wie man ein neues Dokument ergänzt und wo seine Grenzen liegen. Sie ist
zugleich die Pflegeanleitung: Wer Doku hinzufügt, arbeitet mit genau drei
Dateien (§4).

> **Beta-Hinweis:** Reine Lese-Oberfläche. Der Viewer schreibt nichts, führt
> nichts aus und zeigt ausschließlich Dateien unter `docs/` sowie die
> Root-`*.md` — die Whitelist ist die Traversal-Schranke (§5).

---

## 1. Zwei Sichten auf dieselbe Doku

| Sicht | Was sie zeigt | Wo sie herkommt |
| --- | --- | --- |
| **Katalog** | Die **kuratierte** Navigation: 82 Dokumente in 9 Themenbereichen | `DOCS_CATALOG` (`src/lib/docsCatalog.ts`) + Abschnitts-Zuordnung (`src/lib/docsNav.ts`) |
| **Dateibaum** | **Alle** Markdown-Dateien unter `docs/` (342 Dateien inkl. der Root-`*.md`) | `buildDocsTree()` (`src/lib/docsTree.ts`), geladen über `?tree=1` |

Warum beides: Der Katalog beantwortet „Wo fange ich an?“ — der Baum „Wo steht
das Audit-Finding von letzter Woche?“. Die 260 Dateien, die nicht im Katalog
stehen — darunter allein 214 Detailseiten unterhalb von `audits/**` — würden
das Menü fluten, sind im Baum aber vollständig erreichbar und durchsuchbar.

---

## 2. Seiten und Komponenten

| Route | Datei | Inhalt |
| --- | --- | --- |
| `/docs` | `src/app/docs/page.tsx` → `DocsIndex.tsx` | Katalog-Hub: Suche, Schnellzugriff, Sprungleiste, Abschnitts-Raster, Dateibaum |
| `/docs/<Pfad>.md` | `src/app/docs/[...path]/page.tsx` → `DocsView.tsx` | Einzeldokument: Breadcrumb, Sidebar, Inhaltsverzeichnis, Vor/Zurück |
| `GET /api/docs` | `src/app/api/docs/route.ts` | Katalog + `sections` + `quickAccess`; mit `?tree=1` zusätzlich den Dateibaum |
| `GET /api/docs?name=…` | dieselbe Route | Ein Dokument als Markdown **plus** serverseitig berechnete Link-Map |

| Baustein | Aufgabe |
| --- | --- |
| `src/lib/docsCatalog.ts` | Slug → Datei/Titel/Untertitel; Auflösung von Slugs, Pfaden, kanonischen URLs; Traversal-Schranke |
| `src/lib/docsNav.ts` | Themenbereiche (`DOCS_SECTIONS`), Slug→Abschnitt (`SLUG_SECTION`), Schnellzugriff — **reines Modul**, damit auch der Client es nutzen kann |
| `src/lib/docsLinks.ts` | Kanonische URL ↔ Datei, Link-Extraktion, GitHub-relative Auflösung (ohne `node:fs`) |
| `src/lib/docsRenderServer.ts` | Datei lesen + Link-Map bauen — **eine** Implementierung für API und Seite |
| `src/lib/docsTree.ts` | Verzeichnisbaum unter `docs/` (server-only) |
| `src/components/docs/DocsNav.tsx` | Gruppen-Navigation mit Filter (Sidebar, Drawer, Hub) |
| `src/components/docs/DocsFileTree.tsx` | Aufklappbarer, durchsuchbarer Dateibaum |
| `src/components/docs/DocsMarkdown.tsx` | Markdown-Rendering, Link-Rewriting, Scroll-Container für Tabellen |
| `src/components/docs/DocsIcons.tsx` | Inline-SVG-Icons (keine Unicode-Glyphen) |

**Rendering-Modell:** Katalog **und** Dokumentinhalt werden **serverseitig**
gerendert und als Props übergeben. Der Client übernimmt danach nur noch
Interaktion (Suche, Auf-/Zuklappen, Drawer, Inhaltsverzeichnis). Deshalb:

* kein „Lade Dokument…“-Flackern beim ersten Aufruf,
* die Seite ist ohne JavaScript lesbar,
* Druck/PDF enthält den vollständigen Text,
* die Link-Map kommt aus derselben Quelle, die `npm run docs:validate` prüft
  (kein zweiter Auflösungspfad im Browser).

---

## 3. Aufbau der Oberfläche

### 3.1 Übersicht (`/docs`)

1. **Kopf** — Zähler („82 Dokumente in 9 Themenbereichen“, aus dem Katalog gezählt), Link zum Überblick, Dashboard-Rücksprung.
2. **Suche** — filtert live über **Titel, Untertitel, Pfad, Slug und Abschnitt**; mehrere Begriffe wirken als UND.
3. **Schnellzugriff** — Chips auf die häufigsten Dokumente (`DOCS_QUICK_ACCESS`).
4. **Sprungleiste** — sticky, horizontal scrollbar; ein Chip je Themenbereich mit Anzahl.
5. **Abschnitts-Raster** — 1 → 2 → 3 → 4 Spalten (`sm`/`lg`/`2xl`/`1900px`), je Abschnitt Titel und Kurzbeschreibung.
6. **Dateibaum** — erst beim Aufklappen geladen (`?tree=1`), mit eigener Suche.

### 3.2 Einzeldokument (`/docs/<Pfad>.md`)

* **Kopf (sticky):** Breadcrumb „Dokumentation / Thema / Titel“, Dateipfad,
  Buttons „Menü“ (< `lg`), „Inhalt“ (< `2xl`), „← Alle Dokumente“.
* **Sidebar (`lg`+):** dieselbe Gruppen-Navigation, sticky, mit Auto-Fokus im
  Filter. Unter `lg` liegt sie als **Drawer** vor (Overlay, Esc schließt,
  Hintergrund scrollt nicht mit).
* **Artikel:** volle Breite der Restfläche (`minmax(0,1fr)`), nie schmaler als
  nötig, nie breiter als der Viewport.
* **Inhaltsverzeichnis:** rechts ab `2xl` (sticky, IntersectionObserver
  markiert das aktive Kapitel), darunter als aufklappbare Liste im Kopf.
* **Fuß:** „Vorher/Weiter“ in Katalogreihenfolge.
* **Tab-Titel:** `generateMetadata` setzt `<title>` und Beschreibung je Dokument.

### 3.3 Tabellen, Code, Bilder — die Überlauf-Regel

Breite Tabellen (bis 11 Spalten, z. B. [DAILY_WEEKLY_RESEARCH.md §3](DAILY_WEEKLY_RESEARCH.md#3-faktor-katalog))
sind der klassische Bruchpunkt: `prose` setzt nur `width: 100%`, der
min-content-Bedarf langer Env-Namen/Pfade sprengt dann den Artikel.

Deshalb rendert `DocsMarkdown` **jede** Tabelle in `.docs-table-scroll`
(`src/app/globals.css`):

| Eigenschaft | Wirkung |
| --- | --- |
| `overflow-x: auto`, `max-width: 100%` | Tabelle nutzt die volle Breite, wenn sie passt — sonst scrollt sie horizontal, statt über die Nachbarspalte zu ragen |
| `tabIndex={0}`, `role="region"`, `aria-label` | mit der Tastatur scrollbar (A11y) |
| `overflow-wrap: break-word`, `code { overflow-wrap: anywhere }` | lange Tokens brechen in der Zelle um |
| `@media print { overflow: visible }` | Papier kennt kein horizontales Scrollen — die Tabelle wird vollständig gedruckt |

Zusätzlich gilt global: `img`/`svg`/`video` max. 100 % Breite, `.docs-content`
bricht lange Wörter um. Code-Blöcke scrollen (`prose-pre`), sie brechen nicht.

---

## 4. Ein neues Dokument ergänzen (Pflegeanleitung)

**Drei Dateien, drei Schritte — die Tests erzwingen jeden davon:**

1. **Datei anlegen:** `docs/<NAME>.md` mit Status-Header (Datum, Code-Version,
   Zweck) — Konvention siehe [REPOSITORY_STRUCTURE.md](REPOSITORY_STRUCTURE.md) §Regeln 2.
2. **Katalogisieren** (`src/lib/docsCatalog.ts`): Eintrag `{ file, title, subtitle }`
   mit sprechendem Slug. Ohne Eintrag ist das Dokument nur über den Dateibaum
   oder den Basename-Fallback erreichbar.
3. **Abschnitt zuordnen** (`src/lib/docsNav.ts` → `SLUG_SECTION`): Der
   Abschnitt bestimmt die Position im Menü. Fehlt die Zuordnung, wird das
   Dokument sichtbar ins **Archiv** einsortiert und
   `tests/docsNav.test.ts` wird **rot** („Slugs ohne Abschnitt“).

Danach:

```bash
npm run docs:validate      # Links, Anker, Env-Flags, API-Routen, Version-Konsistenz
node --import tsx --test tests/docsNav.test.ts tests/docsCatalog.test.ts
```

Und in `docs/README.md` eine Zeile in die passende Tabelle — das ist die
GitHub-Sicht, die der Viewer nicht ersetzt.

**Neuen Themenbereich anlegen:** Eintrag in `DOCS_SECTIONS`
(`id`, `label`, `short`, `description`) plus Zuordnungen in `SLUG_SECTION`.
Die Reihenfolge im Array ist die Reihenfolge in der Oberfläche; jeder Bereich
muss mindestens ein Dokument enthalten.

---

## 5. Sicherheit: die Whitelist ist die Schranke

Der Viewer ist **kein** Datei-Browser des Repositories. Auslieferbar sind nur:

* `docs/**/*.md`,
* die Root-Markdown-Dateien (`README.md`, `CHANGELOG.md`, `CONFIGURATION.md`,
  `VERSION.md`, `INSTALL.md`, `CONTRIBUTING.md`).

Alles andere (`src/**`, `drizzle/*.sql`, `tests/**`) wird von
`resolveDocRequest()` abgewiesen; Pfad-Segmente mit `..` werden grundsätzlich
verworfen — auch wenn sie rechnerisch wieder in `docs/` landen würden. Ziele
außerhalb der Doku werden im Fließtext als **nicht klickbarer Code-Text**
dargestellt (statt als toter Link). Die Pflicht-Regressionstests stehen in
`tests/docsCatalog.test.ts` (Traversal, Namenskollisionen) und
`tests/docsLinks.test.ts`.

**Root-Dateien** liegen unter dem reservierten URL-Segment `root/`
(`/docs/root/CHANGELOG.md`) — sonst kollidieren sie mit gleichnamigen Dateien
unter `docs/` (`docs/CHANGELOG.md` ist ein Weiterleitungs-Stub).

---

## 6. Grenzen (bewusst)

| Grenze | Grund |
| --- | --- |
| **Kein Markdown-Editor/Schreibpfad** | Doku ist Code: Änderungen gehören in einen PR und durch `docs:validate` |
| **Keine Volltextsuche über Inhalte** | Gesucht wird über Metadaten (Titel, Untertitel, Pfad, Abschnitt, Dateiname) — für die 342 Dateien reicht das; Volltextsuche würde einen Index brauchen |
| **Kein `mdx`/eingebetteter Code** | Anzeige, nicht Ausführung; `remark-gfm` + `rehype-slug` decken Tabellen, Aufgabenlisten, Anker ab |
| **Bilder nur aus dem Repo** | `img-src 'self' data:` in der CSP (Produktion) — externe Grafiken werden nicht geladen |
| **Katalog ist kuratiert** | Nicht jedes Dokument steht im Menü; der Dateibaum ist die vollständige Sicht |

---

## 7. Prüfpfad

| Frage | Befehl / Datei |
| --- | --- |
| Sind alle Links und Anker im Viewer gültig? | `npm run docs:validate` (App-Link-Check, 1400+ Links) |
| Ist jeder Katalog-Slug genau einem Abschnitt zugeordnet? | `tests/docsNav.test.ts` |
| Bleibt die Traversal-Schranke intakt? | `tests/docsCatalog.test.ts` |
| Funktionieren Anker-IDs und Link-Rewriting? | `tests/ui/DocsMarkdown.test.tsx` |
| Nennen alle Versionsstellen dieselbe Zahl? | `tests/docsVersioning.test.ts` + `docs:validate` (Check F) |
