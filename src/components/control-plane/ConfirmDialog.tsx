"use client";

/**
 * Bestaetigungsdialog (Task 08) — Pflicht vor dem Loeschen von Credentials.
 *
 * XSS-sicher: alle Inhalte als React-Text (kein innerHTML). Das Overlay
 * faengt Klicks ausserhalb ab (Abbrechen), Escape schliesst.
 */
import { useEffect } from "react";

export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  busy,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div className="w-full max-w-md rounded-2xl border border-red-800/60 bg-slate-900 p-5 shadow-2xl">
        <h3 className="text-sm font-bold text-red-300">{title}</h3>
        <p className="mt-2 text-xs leading-relaxed text-slate-300">{message}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={busy}
            className="rounded-lg border border-slate-700 px-4 py-2 text-xs font-semibold text-slate-300 transition hover:bg-slate-800 disabled:opacity-40"
          >
            Abbrechen
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className="rounded-lg bg-red-600 px-4 py-2 text-xs font-bold text-white transition hover:bg-red-500 disabled:opacity-40"
          >
            {busy ? "Loesche …" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
