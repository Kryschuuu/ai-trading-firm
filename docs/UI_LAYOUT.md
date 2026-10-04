# UI-Layout & Design-System (v0.15.0)

**Gilt für:** `src/app/**`, `src/components/**`, `src/components/ui/**`,
`src/app/globals.css`. · **Stand:** v0.15.0 (Beta).

Dieses Dokument beschreibt das Layout-System der Oberfläche: Seitenhüllen,
Breakpoints, Tabellen, Reiterleisten und die Testabsicherung. Es ist die
verbindliche Referenz für neue Seiten und Panels.

---

## 1. Warum ein eigenes Layout-System

Vor v0.15.0 war die Breite pro Bildschirm einzeln entschieden:

| Bereich | Vorher | Problem |
| --- | --- | --- |
| Dashboard (`/`) | `mx-auto max-w-7xl px-4` | 1280 px Deckel; auf 27"–34"-Monitoren blieben mehrere hundert Pixel ungenutzt, obwohl Positionstabelle (10 Spalten), Risikofelder und Coverage-Matrix genau davon profitieren |
| Broker-Seite (`/brokers`) | `mx-auto max-w-7xl px-4` | derselbe Deckel, zusätzlich ein zweiter Seitenkopf-Stil |
| Doku-Viewer (`/docs`) | bereits volle Breite | war die Ausnahme — Nutzer mussten zwischen „breit“ und „schmal“ springen |
| Tabellen | je Panel eigenes Markup | Sticky-Kopf, Zebra-Streifen und Fokusring fehlten teils; auf Mobile liefen breite Tabellen aus dem Viewport |
| Reiterleiste | `flex flex-wrap` ohne Rollen | kein `role="tablist"`, keine Pfeiltasten, Umbruch in mehrere Zeilen auf Mobile |

Seit v0.15.0 gibt es **eine** Quelle für Ränder, Karten, Tabellen und Reiter:
`src/components/ui/`.

---

## 2. Seitenhülle und Seitenränder

`src/components/ui/layout.ts` ist die einzige Quelle der Layout-Konstanten:

| Konstante | Bedeutung |
| --- | --- |
| `PAGE_GUTTER` | fluider Seitenrand: `px-3 sm:px-5 lg:px-8 2xl:px-10 3xl:px-12` |
| `PAGE_SHELL` | `w-full` + `PAGE_GUTTER` |
| `PAGE_GUTTER_BLEED` | Gegenstück für randlos klebende Leisten (Reiterleiste): negativer Außenabstand + gleiches Innenpolster |
| `PANEL`, `PANEL_PADDED`, `PANEL_LARGE`, `PANEL_HEADER` | Kartenfläche, Kartenfläche mit Polster, große Abschnittsfläche, Kartenkopf |
| `SECTION_TITLE`, `LABEL`, `MUTED_TEXT` | Abschnitts-, Feld- und Hinweistypografie |
| `BUTTON_*`, `LINK` | Schaltflächen- und Linkstile (siehe auch `Button`) |
| `AUTO_FIT_CARDS`, `AUTO_FIT_PANELS`, `AUTO_FIT_WIDE` | Raster, die sich an die Inhaltsbreite anpassen (17/22/30 rem Mindestbreite) |

Die Hülle selbst ist `PageShell` (`src/components/ui/PageShell.tsx`): volle
Breite, responsiver Rand, optionaler Seitenkopf mit Überzeile, Titel,
Untertitel und Aktionen.

Der Kartenrahmen steht **einmal** in `layout.ts`: Vorher trugen 20 Dateien
denselben String wörtlich (37 Vorkommen, dazu vier Opazitäts- und zwei
Radius-Varianten). Neue Flächen beziehen `PANEL*` von dort, statt den Rahmen
abzuschreiben — so bleiben Karten über alle Bereiche gleich und ein
Theme-/Kontrastwechsel ist eine Zeile.

**Regel:** Eine Seite beginnt mit `PageShell` (oder dem Doku-Layout) und bringt
**keinen** eigenen `max-w-*`-Rahmen mit. Textlesbarkeit wird dort begrenzt, wo
sie hingehört — z. B. `PROSE_MEASURE` (`max-w-[90ch]`) für lange Absätze oder
zwei Spalten (`3xl:columns-2`) im Guide.

---

## 3. Breakpoints (inkl. Ultrawide)

Tailwind liefert `sm`–`2xl`. In `src/app/globals.css` sind zwei zusätzliche
Breakpoints definiert:

```css
@theme {
  --breakpoint-3xl: 120rem; /* 1920 px */
  --breakpoint-4xl: 160rem; /* 2560 px */
}
```

Verwendung:

| Bereich | Wachstum |
| --- | --- |
| Kennzahlenleiste (Status) | 2 → 3 → 4 → 5 → **7** Spalten (`3xl`) |
| Report-KPI-Kacheln | 2 → 3 → 4 → 5 → **6** Spalten (`3xl`) |
| Agentenkarten | 1 → 2 → 3 → **4** Spalten (`3xl`) |
| Operations-Center-Sektionen | `AUTO_FIT_PANELS` (22 rem) — mobil 1, Ultrawide 4–5 Spalten |
| Broker-/Coverage-Karten | `AUTO_FIT_WIDE` (30 rem) |
| Planungs-Tabellen (Positionen, Risikofelder) | volle Breite, sticky Kopf bis `70vh` |
| Guide (Lesetext) | ab `3xl` zwei Spalten |

> **Fallstrick (im Build aufgefallen):** Tailwind v4 sammelt Klassennamen
> **statisch** aus dem Quelltext. Eine zur Laufzeit zusammengesetzte Klasse
> (`autoFit("22rem")`) landet nicht im CSS. Die Raster-Literale stehen deshalb
> vollständig in `layout.ts`; `tests/ui/Layout.test.tsx` erzwingt das.

---

## 4. Tabellen: `DataTable`

`src/components/ui/DataTable.tsx` ist der eine Baustein für Listen
(Positionen, Missionen, Approval-Queue, Report-Symboltabelle, Coverage,
Drawdown-Phasen, Kill-Switch-Historie).

* **Struktur statt Optik:** echte `<table>` mit `thead`/`tbody`, `scope="col"`.
* **Scrollbar per Tastatur:** Wrapper `.fs-table-scroll` mit `role="region"`,
  `aria-label` und `tabIndex=0`; sichtbarer Fokusring — dieselbe Mechanik wie
  `.docs-table-scroll` im Doku-Viewer (die CSS-Regeln sind zusammengeführt).
* **Mobile Kartenansicht:** bis 640 px stapelt `.fs-table-stack` jede Zeile zu
  einer beschrifteten Karte. Der Spaltenkopf wandert als `data-label` in jede
  Zelle (`td::before { content: attr(data-label) }`), die `<thead>` bleibt für
  Screen Reader im DOM.
* **Optionen:** `stack` (Default `true`), `stickyHead` + `maxHeight`,
  `align` (Zahlen rechtsbündig), `empty` (Leerzustand statt leerer Tabelle),
  `label` (Accessibility).
* **`stack={false}`** ist die richtige Wahl für breite Konfigurationsmatrizen
  mit Eingabefeldern (Risikolimits, Volatilitäts-Schwellen, Coverage-Matrix):
  dort ist horizontales Scrollen übersichtlicher als acht Zeilen pro Eintrag.
* **Druck:** `@media print` setzt Stapelung und Scrollbereich zurück — Papier
  kennt kein horizontales Scrollen.

---

## 5. Reiter (-leisten)

`src/components/ui/Tabs.tsx` liefert `TabBar` + `TabPanel`:

* `role="tablist"` / `role="tab"` / `role="tabpanel"`, `aria-selected`,
  `aria-controls`, `aria-labelledby` mit gemeinsamer `idPrefix`.
* Pfeiltasten, `Home`/`End` wechseln den Bereich (WAI-ARIA-Muster, Roving
  Tabindex); der fokussierte Reiter wird in den Sichtbereich gescrollt.
* Auf Mobile ist die Leiste **horizontal scrollbar** statt mehrzeilig
  (früher schoben umbrechende Reiter den Inhalt nach unten).
* `sticky` (Default) klebt die Leiste unter dem Fensterrand und nutzt
  `PAGE_GUTTER_BLEED`, damit sie randlos deckt.
* Zähler als `badge` beantworten „wo passiert etwas?“ ohne Klick (offene
  Positionen, Agenten, registrierte Venues).
* Der Workshop nutzt dieselbe Leiste mit `sticky={false}` — zwei klebende
  Leisten würden sich überlagern.

---

## 6. Weitere Bausteine

| Baustein | Zweck |
| --- | --- |
| `MetricTile` | Kennzahl-Kachel (ersetzt die früheren Duplikate `Stat` und `KpiTile`); `tone`, `sub`, `alarm`, InfoTip |
| `Chip` | Status-Chip mit fünf Bedeutungen (neutral/gut/Warnung/Fehler/Info) |
| `Button` | vier Rollen (primary/info/danger/subtle), `busy`, `active`, Fokusring |
| `InfoTip` | Info-Icon mit Hover-/Focus-Erklärung (liegt seit v0.15.0 im UI-Kit) |
| `cx` | minimaler Klassen-Joiner ohne Zusatzabhängigkeit |

---

## 7. Barrierefreiheit & Bedienung

* Alle interaktiven Elemente haben einen sichtbaren Fokusring
  (`focus-visible:ring-*`), nicht nur Browser-Defaults.
* Tabellenbereiche sind per Tastatur scrollbar und für Screen Reader benannt.
* Statusfarben sind **immer** zusätzlich textkodiert (z. B. „gesperrt“,
  „AKTIV“), nie nur rot/grün.
* Mobile Kartenansicht ersetzt horizontales Scrollen dort, wo Zeilen sonst
  unlesbar wären; `data-label` verhindert nackte Werte ohne Spaltenkopf.
* `prefers-reduced-motion` schaltet die Pipeline-Pulsanimation ab
  (`globals.css`).

---

## 8. Eine neue Seite anlegen

```tsx
import { PageShell } from "@/components/ui/PageShell";
import { AUTO_FIT_CARDS, PANEL_PADDED, SECTION_TITLE } from "@/components/ui/layout";

export default function ExamplePage() {
  return (
    <main className="min-h-screen bg-gradient-to-b from-slate-950 via-slate-950 to-slate-900">
      <PageShell eyebrow="Bereich" title="Titel" subtitle="Ein Satz Kontext">
        <section className={`${PANEL_PADDED} ${AUTO_FIT_CARDS}`}>…</section>
      </PageShell>
    </main>
  );
}
```

Checkliste:

1. `PageShell` statt eigenem Rahmen (kein `mx-auto max-w-*`).
2. Datenlisten als `DataTable` mit `label` — nicht als handgeschriebenes
   `<table>`; Konfigurationsmatrizen mit `stack={false}`.
3. Mehrere Bereiche einer Seite als `TabBar` + `TabPanel` (nicht als lose
   Knopfreihe).
4. Kartenraster über `AUTO_FIT_*` oder explizite Stufen bis `3xl`.
5. Themen: nur `slate-*`/Statusfarben verwenden — die Theme-Umschaltung
   (`data-theme`) faltet die `--color-*`-Variablen in `globals.css`.

---

## 9. Testabsicherung

`tests/ui/Layout.test.tsx` prüft den Vertrag ohne Browser
(`renderToStaticMarkup`, wie alle UI-Tests):

* Dashboard-Hülle: volle Breite, kein `max-w-7xl`; Statusleiste bis `3xl`
  siebenspaltig.
* Quelltext-Scan: keine Seite setzt einen zentrierten `max-w-*`-Rahmen.
* `TabBar`: Rollen, `aria-selected`/`aria-controls`, Roving Tabindex, Sticky.
* `DataTable`: `role="region"` + `tabIndex`, `data-label` je Zelle,
  `stack={false}`-Variante, Leerzustand.
* `MetricTile`/`Chip`/`Button`: Ton, Alarm, `aria-busy`, Fokusring.
* `globals.css`: Breakpoints, `.fs-table-*`, Mobile-Media-Query, Druck-Reset.
* `layout.ts`: Auto-fit-Raster als vollständige Klassennamen.

Zusätzlich prüfen die Layout-Änderungen die bestehenden Suiten
(`tests/ui/*.test.tsx`, u. a. Doku-Tabellen, Equity-Kurve, Session-Balken) und
der Build (`npx next build`) die CSS-Erzeugung.

---

## 10. API- und Doku-Oberflächen

Die Layout-Regeln betreffen auch die Stellen, an denen **API-Ergebnisse**
dargestellt werden — es gibt keine separaten „API-Seiten“:

* **Dashboard-Tabs** lesen `GET /api/firm` (Statusleiste, Risiko-Tab
  `PUT /api/firm/config`, Reports über `/api/report/*`, Venues/Control Plane
  über `/api/brokers*`). Antworten werden in `DataTable`/`MetricTile`
  gerendert; die Feldnamen der API sind die Spaltenlabels, damit Doku und
  Oberfläche dieselbe Sprache sprechen.
* **Doku-Viewer** (`/docs`, `/docs/<Pfad>.md`) rendert die Markdown-Quellen
  dieser Dateien (u. a. `docs/HANDBUCH.md` mit den API-Beispielen,
  `CONFIGURATION.md` für Env-Flags) serverseitig.
* **Fehlerantworten** (`{ ok: false, error, hint }`) landen in
  `FirmIssueBox`/`SessionNoticeBar`; sie nutzen dieselben `PANEL`-Flächen wie
  alle Karten.
* Ein neuer API-Endpunkt braucht deshalb **keine** neue Layout-Doku: die
  Darstellung folgt den Bausteinen aus diesem Dokument, die Route selbst wird
  in `docs/*.md` bzw. der jeweiligen Modul-Doku beschrieben (und
  `npm run docs:validate` prüft, dass jede in der Doku genannte Route
  existiert).

## 11. Verwandte Dokumente

* [DOCS_VIEWER.md](DOCS_VIEWER.md) — Aufbau des Doku-Viewers (Sidebar, Drawer,
  Inhaltsverzeichnis, Dateibaum).
* [FRONTEND_CONTROL_PLANE.md](FRONTEND_CONTROL_PLANE.md) — Datenfluss, API und
  Sicherheitskonzept der Broker-Control-Plane (Broker-Seite, Brokers-Tab).
* [REPOSITORY_STRUCTURE.md](REPOSITORY_STRUCTURE.md) — Ablage der Komponenten.
* [../CHANGELOG.md](../CHANGELOG.md) — Release-Historie (v0.15.0: diese
  Überarbeitung).
