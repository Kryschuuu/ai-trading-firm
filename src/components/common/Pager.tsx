"use client";

import { useCallback, useState } from "react";
import {
  DEFAULT_PAGE_SIZE,
  PAGE_SIZE_OPTIONS,
  normalizePage,
  normalizePageSize,
  pageCount,
  pageWindow,
  type PageSize,
} from "@/lib/paging";

/**
 * Gemeinsamer Paging-Zustand für Audit-Trail und Protokoll.
 *
 * Produktanforderung: Default 20 Einträge, wählbar 20/50/100/200.
 * Der Zustand lebt in der UI, die Seite wird serverseitig geschnitten
 * (`/api/firm/log?page=…&limit=…`), damit auch Historie jenseits der ersten
 * 200 Zeilen erreichbar bleibt.
 */
export function usePagination(initialTotal = 0) {
  const [pageSize, setPageSize] = useState<PageSize>(DEFAULT_PAGE_SIZE);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(initialTotal);

  const pages = pageCount(total, pageSize);
  const current = normalizePage(page, pages);
  const window = pageWindow(total, current, pageSize);

  const changePageSize = useCallback((next: unknown) => {
    setPageSize(normalizePageSize(next));
    setPage(1);
  }, []);

  const goTo = useCallback(
    (next: number) => {
      const requested = Number(next);
      const num = Number.isFinite(requested) ? Math.trunc(requested) : 1;
      // Klemmen auf den gültigen Bereich — sonst liefert die API leere Seiten.
      setPage(Math.min(Math.max(1, num), pages));
    },
    [pages]
  );

  return { pageSize, page: current, pages, total, setTotal, window, changePageSize, goTo };
}

export type Pagination = ReturnType<typeof usePagination>;

/**
 * Paging-Leiste: Seitengröße (20/50/100/200), Seitenstand und Vor/Zurück.
 * Identisch in Audit-Trail und Protokoll — ein Verhalten, zwei Listen.
 */
export function Pager({ pagination, label = "Einträge" }: { pagination: Pagination; label?: string }) {
  const { pageSize, page, pages, window: win } = pagination;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900/50 px-3 py-2 text-xs">
      <div className="flex items-center gap-2">
        <label htmlFor={`page-size-${label}`} className="text-slate-400">
          {label} pro Seite
        </label>
        <select
          id={`page-size-${label}`}
          value={pageSize}
          onChange={(event) => pagination.changePageSize(event.target.value)}
          className="cursor-pointer rounded-lg border border-slate-700 bg-slate-800 px-2 py-1 text-slate-200"
        >
          {PAGE_SIZE_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </div>

      <div className="flex items-center gap-2 text-slate-400">
        <button
          type="button"
          onClick={() => pagination.goTo(page - 1)}
          disabled={page <= 1}
          className="rounded-lg border border-slate-700 bg-slate-800 px-2 py-1 font-semibold text-slate-200 transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          ← Zurück
        </button>
        <span className="tabular-nums text-slate-300">
          Seite {page} von {pages}
        </span>
        <button
          type="button"
          onClick={() => pagination.goTo(page + 1)}
          disabled={page >= pages}
          className="rounded-lg border border-slate-700 bg-slate-800 px-2 py-1 font-semibold text-slate-200 transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Weiter →
        </button>
      </div>

      <span className="text-slate-500 tabular-nums">
        {win ? `${label} ${win.from}–${win.to} von ${win.total}` : `Keine ${label.toLowerCase()}`}
      </span>
    </div>
  );
}
