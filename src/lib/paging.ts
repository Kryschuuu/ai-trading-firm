/**
 * Paging-Kern für alle Listen im Dashboard (Audit-Trail + Protokoll).
 *
 * Bewusst DB- und React-frei: dieselben Funktionen laufen im API-Handler
 * (Server-Paging über `limit`/`offset`) und in den Komponenten
 * (Client-Paging über bereits geladene Arrays). Damit ist garantiert, dass
 * "Seite 3 von 5" auf beiden Seiten dieselbe Bedeutung hat.
 *
 * Regel (Produktanforderung): Default 20 Einträge pro Seite, wählbar
 * 20 / 50 / 100 / 200.
 */

/** Erlaubte Seitengrößen — UI und API prüfen gegen dieselbe Liste. */
export const PAGE_SIZE_OPTIONS = [20, 50, 100, 200] as const;

export type PageSize = (typeof PAGE_SIZE_OPTIONS)[number];

export const DEFAULT_PAGE_SIZE: PageSize = 20;

/** Maximale Seitengröße — deckelt Payload-Größe und DB-Last. */
export const MAX_PAGE_SIZE: number = Math.max(...PAGE_SIZE_OPTIONS);

/**
 * Klemmt eine Seitengröße auf die erlaubten Werte.
 * Unbekannte Werte (z. B. `limit=37`, `NaN`, `"abc"`) fallen auf den Default.
 */
export function normalizePageSize(value: unknown): PageSize {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return DEFAULT_PAGE_SIZE;
  const match = PAGE_SIZE_OPTIONS.find((option) => option === Math.trunc(num));
  return match ?? DEFAULT_PAGE_SIZE;
}

/** Anzahl Seiten für `total` Einträge; leere Liste ergibt 1 (Seite "1 von 1"). */
export function pageCount(total: number, pageSize: number): number {
  const size = Number.isFinite(pageSize) && pageSize > 0 ? pageSize : DEFAULT_PAGE_SIZE;
  const rows = Number.isFinite(total) && total > 0 ? total : 0;
  return Math.max(1, Math.ceil(rows / size));
}

/**
 * Klemmt eine 1-basierte Seitenzahl in den gültigen Bereich.
 * Wird beim Filtern kleiner (weniger Treffer), springt die UI nicht ins Leere.
 */
export function normalizePage(page: unknown, pages: number): number {
  const num = typeof page === "number" ? page : Number(page);
  const max = Number.isFinite(pages) && pages > 0 ? Math.trunc(pages) : 1;
  if (!Number.isFinite(num)) return 1;
  return Math.min(Math.max(1, Math.trunc(num)), Math.max(1, max));
}

/** Schneidet die aktuelle Seite aus einem Array (1-basiert, defensive Klemmung). */
export function slicePage<T>(items: readonly T[], page: number, pageSize: number): T[] {
  const list = Array.isArray(items) ? items : [];
  const size = Number.isFinite(pageSize) && pageSize > 0 ? pageSize : DEFAULT_PAGE_SIZE;
  const current = normalizePage(page, pageCount(list.length, size));
  return list.slice((current - 1) * size, current * size);
}

/** 1-basiertes Anzeigefenster ("Einträge 21–40 von 137"); leere Liste → null. */
export function pageWindow(
  total: number,
  page: number,
  pageSize: number
): { from: number; to: number; total: number } | null {
  const rows = Number.isFinite(total) && total > 0 ? Math.trunc(total) : 0;
  if (rows === 0) return null;
  const size = Number.isFinite(pageSize) && pageSize > 0 ? pageSize : DEFAULT_PAGE_SIZE;
  const current = normalizePage(page, pageCount(rows, size));
  const from = (current - 1) * size + 1;
  return { from, to: Math.min(rows, current * size), total: rows };
}

/** Server-seitiger Offset aus `page` + `pageSize` (nie negativ). */
export function pageOffset(page: number, pageSize: number): number {
  const size = Number.isFinite(pageSize) && pageSize > 0 ? pageSize : DEFAULT_PAGE_SIZE;
  const current = Math.max(1, Number.isFinite(page) ? Math.trunc(page) : 1);
  return (current - 1) * size;
}
