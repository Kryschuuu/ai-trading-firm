/**
 * Daten-Tabelle (`DataTable`) — ein Baustein für alle Tabellen (v0.15.0).
 *
 * Probleme der Vorgänger-Version:
 *   1. Jede Tabelle brachte ihr eigenes Markup mit (`Table` im Dashboard,
 *      drei weitere Inline-Tabellen, Broker-Coverage, Report-Kennzahlen) —
 *      Sticky-Header, Zebra-Streifen und Fokusring waren dadurch pro Tabelle
 *      unterschiedlich oder fehlten ganz.
 *   2. Auf schmalen Bildschirmen liefen breite Tabellen aus dem Viewport.
 *      Ein reiner `overflow-x-auto`-Wrapper ist für Maus-Nutzer okay, für
 *      Touch und Tastatur aber unangenehm, wenn zusätzlich Spalten außerhalb
 *      des Sichtbereichs liegen.
 *
 * Lösung:
 *   - Wrapper `.fs-table-scroll`: `overflow-x: auto`, per Tastatur fokussierbar
 *     (`tabIndex=0`, `role="region"`, `aria-label`), sichtbarer Fokusring —
 *     dieselbe Mechanik wie `.docs-table-scroll` im Doku-Viewer.
 *   - `stack` (Default `true` für Tabellen bis ~8 Spalten): Unterhalb des
 *     `sm`-Breakpoints wird jede Zeile zur beschrifteten Karte (`data-label`
 *     + CSS in `globals.css`). Nichts liegt mehr außerhalb des Viewports.
 *   - `stickyHead` + `maxHeight`: lange Listen behalten die Spaltenköpfe.
 *
 * Die Komponente bleibt bewusst „dumm“ (Präsentation): Sortierung, Paging und
 * Filterung liegen in den Panels, die sie einsetzen.
 */

import type { ReactNode } from "react";

import { cx } from "./cx";
import { PANEL } from "./layout";

export default function DataTable({
  head,
  rows,
  /** Beschreibung für Screen Reader (`aria-label` des Scroll-Containers). */
  label,
  /** Zeilen als Karten stapeln, wenn der Viewport < `sm` ist (Default: an). */
  stack = true,
  /** Spaltenköpfe beim Scrollen stehen lassen (sinnvoll mit `maxHeight`). */
  stickyHead = false,
  /** Maximale Höhe des Scrollbereichs (z. B. `"70vh"`). */
  maxHeight,
  /** Text unter der Tabelle, wenn `rows` leer ist. */
  empty,
  /** Schlüssel je Zeile; Default ist der Index (Zeilen sind rein darstellend). */
  rowKey,
  /** Ausrichtung je Spalte (Default: links) — Zahlen gehören rechtsbündig. */
  align,
  className,
}: {
  head: string[];
  rows: ReactNode[][];
  label?: string;
  stack?: boolean;
  stickyHead?: boolean;
  maxHeight?: string;
  empty?: ReactNode;
  rowKey?: (index: number) => string;
  align?: Array<"left" | "center" | "right">;
  className?: string;
}) {
  const alignClass = (index: number) =>
    align?.[index] === "right"
      ? "text-right"
      : align?.[index] === "center"
        ? "text-center"
        : "text-left";

  if (rows.length === 0 && empty) {
    return (
      <p className={`${PANEL} px-4 py-4 text-xs text-slate-500`}>
        {empty}
      </p>
    );
  }

  return (
    <div
      className={cx("fs-table-scroll", className)}
      role="region"
      aria-label={label}
      tabIndex={0}
      style={maxHeight ? { maxHeight } : undefined}
    >
      <table className={cx("fs-table w-full text-left text-sm", stack && "fs-table-stack")}>
        <thead className={stickyHead ? "fs-table-sticky" : undefined}>
          <tr>
            {head.map((h, index) => (
              <th
                key={h}
                scope="col"
                className={cx("px-3 py-2 font-semibold sm:px-4", alignClass(index))}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((cells, i) => (
            <tr key={rowKey ? rowKey(i) : i}>
              {cells.map((cell, j) => (
                <td
                  key={j}
                  // `data-label` trägt den Spaltenkopf in die mobile Kartenansicht.
                  data-label={stack ? head[j] : undefined}
                  className={cx("px-3 py-2 align-top text-slate-300 sm:px-4", alignClass(j))}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
