/**
 * Status-Chip (`Chip`) — kurze Zustände einheitlich dargestellt (v0.15.0).
 *
 * Vorher mischten sich in den Panels Formen und Farben: mal `rounded-full`,
 * mal `rounded-md`, mal `bg-emerald-500/20`, mal `bg-emerald-500/10`. Der
 * Chip bündelt das auf fünf Bedeutungen (neutral/gut/warnung/fehler/info).
 *
 * Reine Darstellung: Der Inhalt ist immer Text (kein `innerHTML`), ein
 * optionaler `title` liefert die Begründung für Hover und Screen Reader.
 */

import { cx } from "./cx";

export type ChipTone = "neutral" | "good" | "warn" | "bad" | "info";

const TONE_CLASS: Record<ChipTone, string> = {
  neutral: "border-slate-700 bg-slate-800/70 text-slate-300",
  good: "border-emerald-700/60 bg-emerald-500/15 text-emerald-300",
  warn: "border-amber-700/60 bg-amber-500/15 text-amber-300",
  bad: "border-red-700/60 bg-red-500/15 text-red-300",
  info: "border-sky-700/60 bg-sky-500/15 text-sky-300",
};

export default function Chip({
  children,
  tone = "neutral",
  className,
  title,
}: {
  children: React.ReactNode;
  tone?: ChipTone;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cx(
        "inline-flex max-w-full items-center gap-1 truncate rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide",
        TONE_CLASS[tone],
        className
      )}
    >
      {children}
    </span>
  );
}
