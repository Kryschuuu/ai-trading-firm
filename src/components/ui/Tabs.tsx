"use client";

/**
 * Reiterleiste (`TabBar`) + Panel (`TabPanel`) — die eine Navigation für alle
 * Bereiche (v0.15.0).
 *
 * Vorher: lose `<button>`-Elemente in einem `flex flex-wrap`-Container ohne
 * Rollen, ohne Tastatursteuerung und ohne Bezug zwischen Reiter und Inhalt.
 * Auf schmalen Bildschirmen brachen die Reiter in zwei bis drei Zeilen um und
 * schoben den eigentlichen Inhalt nach unten.
 *
 * Jetzt:
 *   - `role="tablist"` / `aria-selected` / `aria-controls` (Panel: `TabPanel`),
 *   - Pfeiltasten, Home/End wechseln den Reiter (WAI-ARIA-Muster),
 *   - horizontal scrollbare Leiste auf Mobile (`overflow-x-auto`) statt Umbruch,
 *   - optional sticky unterhalb des Fensterrands, randlos mit Backdrop-Blur —
 *     beim Scrollen durch lange Reports bleibt der Bereichswechsel erreichbar.
 */

import { useCallback, useRef } from "react";

import { cx } from "./cx";
import { PAGE_GUTTER_BLEED } from "./layout";

export type TabDef<T extends string> = {
  id: T;
  label: string;
  /** Optionales Symbol vor dem Label (Emoji oder Zeichen). */
  icon?: string;
  /** Zahl/Text rechts am Reiter — z. B. Anzahl offener Positionen. */
  badge?: number | string;
  /** Tooltip/Zusatzinfo (z. B. Kurzbeschreibung des Bereichs). */
  title?: string;
};

export default function TabBar<T extends string>({
  tabs,
  active,
  onChange,
  /** Beschriftung der Reiterleiste für Screen Reader. */
  ariaLabel = "Bereiche",
  /** ID-Präfix; muss zu {@link TabPanel} passen. */
  idPrefix = "tab",
  sticky = true,
}: {
  tabs: readonly TabDef<T>[];
  active: T;
  onChange: (id: T) => void;
  ariaLabel?: string;
  idPrefix?: string;
  sticky?: boolean;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);

  /** Pfeiltasten wandern durch die Reiter; Aktivierung folgt dem Fokus. */
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const index = tabs.findIndex((t) => t.id === active);
      if (index < 0) return;
      let next = index;
      if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
      else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = tabs.length - 1;
      else return;
      event.preventDefault();
      const target = tabs[next];
      onChange(target.id);
      // Der fokussierte Reiter kann außerhalb des Sichtbereichs liegen.
      listRef.current
        ?.querySelector<HTMLButtonElement>(`#${CSS.escape(`${idPrefix}-${target.id}`)}`)
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
    },
    [active, idPrefix, onChange, tabs]
  );

  return (
    <div
      className={cx(
        "z-30 border-b border-slate-800 bg-slate-950/90 backdrop-blur",
        sticky && "sticky top-0"
      )}
    >
      <div
        ref={listRef}
        role="tablist"
        aria-label={ariaLabel}
        onKeyDown={onKeyDown}
        className={cx(
          "flex items-stretch gap-1 overflow-x-auto pb-1 pt-1",
          "[scrollbar-width:thin]",
          PAGE_GUTTER_BLEED
        )}
      >
        {tabs.map((t) => {
          const selected = t.id === active;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`${idPrefix}-${t.id}`}
              aria-selected={selected}
              aria-controls={`${idPrefix}-panel-${t.id}`}
              tabIndex={selected ? 0 : -1}
              title={t.title}
              onClick={() => onChange(t.id)}
              className={cx(
                "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-t-lg border-b-2 px-3 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400",
                selected
                  ? "border-emerald-400 bg-slate-800/60 text-emerald-300"
                  : "border-transparent text-slate-400 hover:bg-slate-800/40 hover:text-slate-200"
              )}
            >
              {t.icon && <span aria-hidden="true">{t.icon}</span>}
              {t.label}
              {t.badge !== undefined && (
                <span
                  className={cx(
                    "rounded-full px-1.5 py-0.5 text-[11px] font-bold tabular-nums",
                    selected ? "bg-emerald-500/20 text-emerald-200" : "bg-slate-800 text-slate-400"
                  )}
                >
                  {t.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Inhalt eines Reiters — verknüpft mit der zugehörigen Schaltfläche. */
export function TabPanel({
  id,
  idPrefix = "tab",
  children,
  className,
}: {
  id: string;
  idPrefix?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      id={`${idPrefix}-panel-${id}`}
      role="tabpanel"
      aria-labelledby={`${idPrefix}-${id}`}
      tabIndex={0}
      className={cx("mt-5 focus:outline-none", className)}
    >
      {children}
    </div>
  );
}
