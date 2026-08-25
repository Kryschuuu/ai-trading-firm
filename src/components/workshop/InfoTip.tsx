"use client";

/**
 * Info-Icon mit Hover-/Focus-Erklärung für Formular- und Fachbegriffe.
 *
 * Barrierefreiheit: echtes <button> (per Tab erreichbar), Tooltip erscheint
 * bei Hover UND Tastatur-Focus (group-focus-within), zusätzlich natives
 * `title` als Fallback und aria-label für Screen Reader. Der Tooltip-Text
 * hängt zusätzlich als visuell versteckter Text im DOM (Screen Reader lesen
 * ihn unabhängig vom Focus-Zustand).
 */
export default function InfoTip({
  text,
  label,
  id,
}: {
  /** Kurz, sachlich, 1–2 Sätze (Vorgabe Handbuch-UI). */
  text: string;
  /** Name des Begriffs fürs aria-label, z. B. „Risikobudget“. */
  label: string;
  /** Optionale DOM-id, damit Eingaben via aria-describedby verlinkt sind. */
  id?: string;
}) {
  const tipId = id ? `${id}-tip` : undefined;
  return (
    <span className="group relative inline-flex align-middle">
      <span id={tipId} className="sr-only">{text}</span>
      <button
        type="button"
        aria-label={`Hilfe: ${label}`}
        title={text}
        className="ml-1 flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-sky-600/60 bg-sky-500/10 text-[10px] font-bold text-sky-300 hover:bg-sky-500/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
      >
        i
      </button>
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-30 mb-1.5 hidden w-60 max-w-[75vw] -translate-x-1/2 rounded-lg border border-sky-700/60 bg-slate-950 px-3 py-2 text-left text-[11px] font-normal leading-snug text-slate-200 shadow-xl group-hover:block group-focus-within:block"
      >
        {text}
      </span>
    </span>
  );
}
