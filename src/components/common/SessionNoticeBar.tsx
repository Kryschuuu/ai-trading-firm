"use client";

/**
 * Hinweisbalken mit An-/Abmeldung (v1.36.41 aus `FirmDashboard` ausgelagert).
 *
 * Reine Darstellung: Der Zustand (Meldung, Token-Entwurf) bleibt im
 * Dashboard, hier wird nur gerendert und zurückgerufen. Das Token-Feld ist
 * sichtbar, sobald `showTokenField` gilt — also auch direkt nach einem
 * `401` beim initialen Laden, ohne dass erst eine Aktion nötig ist.
 */
export function SessionNoticeBar({
  notice,
  showTokenField,
  tokenDraft,
  onTokenDraftChange,
  onSubmit,
  onLogout,
}: {
  notice: string;
  showTokenField: boolean;
  tokenDraft: string;
  onTokenDraftChange: (value: string) => void;
  onSubmit: () => void;
  onLogout: () => void;
}) {
  return (
    <div className="mb-6 rounded-lg border border-slate-700 bg-slate-800/60 px-4 py-2 text-sm text-slate-200">
      <div className="flex items-center justify-between gap-4">
        <span>{notice}</span>
        {!showTokenField && (
          <button
            onClick={onLogout}
            className="rounded border border-slate-600 bg-slate-800 px-2.5 py-1 text-xs font-semibold text-slate-300 hover:bg-slate-700"
          >
            Abmelden
          </button>
        )}
      </div>
      {showTokenField && (
        <div className="mt-2 flex items-center gap-2">
          <input
            type="password"
            aria-label="API-Token (FIRM_API_TOKEN)"
            placeholder="API-Token (FIRM_API_TOKEN)"
            autoComplete="off"
            value={tokenDraft}
            onChange={(e) => onTokenDraftChange(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onSubmit()}
            className="w-72 rounded border border-slate-600 bg-slate-900 px-2 py-1 text-xs text-slate-100"
          />
          <button
            onClick={onSubmit}
            className="rounded bg-emerald-600 px-3 py-1 text-xs font-bold text-white hover:bg-emerald-500"
          >
            Anmelden
          </button>
        </div>
      )}
    </div>
  );
}
