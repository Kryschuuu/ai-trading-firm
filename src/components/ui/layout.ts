/**
 * Gemeinsame Layout-Konstanten der Oberfläche (v0.15.0).
 *
 * Vorher hat jedes Panel seine Container-Klassen selbst getippt — mit der
 * Folge, dass das Dashboard bei `max-w-7xl` (1280 px) endete, während der
 * Doku-Viewer bereits die volle Breite nutzte, und dass Abstände, Karten- und
 * Tabellenstile zwischen den Tabs drifteten.
 *
 * Diese Datei ist die **einzige** Quelle für:
 *   - Seitenränder (`PAGE_GUTTER`): fluide von Mobile bis Ultrawide,
 *   - Karten-/Panel-Flächen (`PANEL`, `PANEL_PADDED`, `PANEL_HEADER`),
 *   - Abschnitts- und Feldtitel (`SECTION_TITLE`, `LABEL`),
 *   - Tabellen-Klassen (`.fs-table*`, siehe `globals.css`),
 *   - Raster, die sich an ihren Inhalt anpassen (`AUTO_FIT_*`).
 *
 * Warum Konstanten und keine Komponenten für alles: Tailwind erkennt die
 * vollständigen Klassennamen im Quelltext (auch in `.ts`) und generiert sie
 * korrekt. Für Struktur (Karte, Tabelle, Kennzahl, Reiter) gibt es daneben
 * echte Komponenten in `./*`; hier liegen nur die Textbausteine.
 */

/**
 * Horizontale Seitenränder — identisch in Dashboard, Broker-Seite und Doku.
 * Bewusst kein `max-w-*`: Die Nutzer lesen datendichte Tabellen und Kurven,
 * die von jeder zusätzlichen Bildschirmbreite profitieren. Lesetext wird
 * stattdessen dort begrenzt, wo er steht (z. B. „Guide“-Karten).
 */
export const PAGE_GUTTER = "px-3 sm:px-5 lg:px-8 2xl:px-10 3xl:px-12";

/** Äußere Seitenhülle: volle Breite + Seitenränder. */
export const PAGE_SHELL = `w-full ${PAGE_GUTTER}`;

/**
 * Gegenstück zu {@link PAGE_GUTTER} für Leisten, die **randlos** kleben
 * sollen (Reiterleiste, Sprungleiste): negativer Außenabstand hebt die
 * Polsterung der Seitenhülle auf, das Innenpolster stellt sie wieder her.
 * So bleibt der Inhalt an derselben Fluchtlinie, die Leiste reicht aber bis
 * zum Fensterrand und deckt beim Scrollen sauber ab.
 */
export const PAGE_GUTTER_BLEED =
  "-mx-3 px-3 sm:-mx-5 sm:px-5 lg:-mx-8 lg:px-8 2xl:-mx-10 2xl:px-10 3xl:-mx-12 3xl:px-12";

/** Kartenfläche ohne Polster (z. B. für Tabellen, die eigene Ränder bringen). */
export const PANEL = "rounded-xl border border-slate-800 bg-slate-900/50";

/** Kartenfläche mit Standardpolster. */
export const PANEL_PADDED = `${PANEL} p-4 sm:p-5`;

/**
 * Größere Kartenfläche für ganze Abschnitte (Guide-Spalten,
 * Architektur-Kapitel, Dateibaum): etwas weichere Rundung, mehr Innenabstand.
 */
export const PANEL_LARGE = "rounded-2xl border border-slate-800 bg-slate-900/40 p-5 sm:p-6";

/** Kopfzeile einer Karte (Titelzeile + optionale Aktionen). */
export const PANEL_HEADER = "flex flex-wrap items-center justify-between gap-3";

/** Abschnittsüberschrift (Kleinbuchstaben-Versalien, wie im restlichen UI). */
export const SECTION_TITLE =
  "flex items-center text-sm font-semibold uppercase tracking-wider text-slate-400";

/** Feld-/Spaltenbeschriftung. */
export const LABEL = "text-xs uppercase tracking-wider text-slate-500";

/** Fließtext-Maß: verhindert, dass Sätze auf Ultrawide auseinanderlaufen. */
export const PROSE_MEASURE = "max-w-[90ch]";

/** Sekundärer Text (Erklärungen unter Kennzahlen, Hinweiszeilen). */
export const MUTED_TEXT = "text-xs leading-relaxed text-slate-400";

/**
 * Raster, das sich an den Inhalt anpasst statt an feste Spaltenzahlen:
 * mobil eine Spalte, auf Ultrawide so viele wie sinnvoll Platz haben.
 * `minmax(min(100%, <min>), 1fr)` verhindert Überlauf, wenn der Container
 * schmaler ist als die Mindestbreite einer Karte.
 *
 * Wichtig: Die Klassennamen stehen hier als **vollständige Literale**. Der
 * Tailwind-Scanner liest den Quelltext und erkennt nur statische Kandidaten —
 * eine zur Laufzeit zusammengesetzte Klasse (`autoFit("22rem")`) landet nicht
 * im erzeugten CSS. Genau das hat der Build in v0.15.0 aufgedeckt.
 */
export const AUTO_FIT_CARDS =
  "grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,17rem),1fr))]";

/** Operations-Center-Sektionen, Broker-/Coverage-Karten. */
export const AUTO_FIT_PANELS =
  "grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,22rem),1fr))]";

/** Breite Auswertungen und Empfehlungskarten (Text + Zahlen). */
export const AUTO_FIT_WIDE =
  "grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,30rem),1fr))]";

/** Sekundäre Schaltfläche: neutral, mit konsistentem Fokusring. */
export const BUTTON_SUBTLE =
  "inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs font-semibold text-slate-200 transition hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950 disabled:opacity-40";

/** Primärschaltfläche: grün, für die Hauptaktion eines Bereichs. */
export const BUTTON_PRIMARY =
  "inline-flex items-center gap-1.5 rounded-lg border border-emerald-600/60 bg-emerald-500/15 px-3 py-2 text-xs font-semibold text-emerald-300 transition hover:bg-emerald-500/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950 disabled:opacity-40";

/** Gefahrenschaltfläche: Not-Halt und destruktive Aktionen. */
export const BUTTON_DANGER =
  "inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-2 text-xs font-bold text-white shadow-lg transition hover:bg-red-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950 disabled:opacity-40";

/** Informationsschaltfläche: Markt-Tick, Aktualisieren. */
export const BUTTON_INFO =
  "inline-flex items-center gap-1.5 rounded-lg border border-sky-700/60 bg-sky-500/10 px-3 py-2 text-xs font-semibold text-sky-300 transition hover:bg-sky-500/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950 disabled:opacity-40";

/** Textlink innerhalb von Hinweisboxen. */
export const LINK =
  "rounded underline decoration-dotted underline-offset-2 hover:text-emerald-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400";
