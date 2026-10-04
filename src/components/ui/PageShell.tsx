/**
 * Seitenhülle für alle Top-Level-Seiten (v0.15.0).
 *
 * Nutzt die volle Bildschirmbreite: Das Dashboard war vorher auf
 * `max-w-7xl` (1280 px) zentriert, während der Doku-Viewer schon
 * randlos arbeitete. Auf einem 27"- oder Ultrawide-Monitor blieben so
 * mehrere hundert Pixel ungenutzt, obwohl die Tabellen (Positionen,
 * Risikofelder, Coverage) genau daraus ihren Nutzen ziehen.
 *
 * `title`/`subtitle`/`eyebrow` erzeugen einen einheitlichen Seitenkopf; ohne
 * diese Props rendert die Hülle nur das Raster (z. B. für den Doku-Hub).
 */

import type { ReactNode } from "react";

import { PAGE_GUTTER } from "./layout";
import { cx } from "./cx";

export function PageShell({
  children,
  className,
  /** Kopfzeile: kleine Überzeile über dem Titel (z. B. „Open-Source · Local-First“). */
  eyebrow,
  title,
  subtitle,
  /** Aktionen rechts neben dem Titel (Theme-Wahl, Primäraktionen). */
  actions,
  /** Kopfbereich zusätzlich unterhalb des Titels (z. B. Reiterleiste). */
  toolbar,
}: {
  children: ReactNode;
  className?: string;
  eyebrow?: ReactNode;
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  toolbar?: ReactNode;
}) {
  const hasHeader = Boolean(eyebrow || title || subtitle || actions);
  return (
    <div className={cx("w-full", PAGE_GUTTER, "py-4 sm:py-6", className)}>
      {hasHeader && (
        <header className="mb-5 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div className="min-w-0">
            {eyebrow && (
              <p className="text-xs uppercase tracking-[0.15em] text-emerald-400">{eyebrow}</p>
            )}
            {title && (
              <h1 className="mt-1 text-2xl font-bold text-slate-50 sm:text-3xl">{title}</h1>
            )}
            {subtitle && <p className="mt-1 text-sm text-slate-400">{subtitle}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      {toolbar}
      {children}
    </div>
  );
}
