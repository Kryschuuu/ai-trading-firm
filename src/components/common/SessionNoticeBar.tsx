"use client";


/**
 * Hinweisbalken mit An-, Ab- und Verlängerung der Browser-Session
 * (v1.36.41 aus `FirmDashboard` ausgelagert; Statuszeile seit v1.39.0).
 *
 * Reine Darstellung: Der Zustand (Meldung, Token-Entwurf, Session-Snapshot)
 * bleibt im Dashboard, hier wird nur gerendert und zurückgerufen. Das
 * Token-Feld ist sichtbar, sobald `showTokenField` gilt — also auch direkt
 * nach einem `401` beim initialen Laden, ohne dass erst eine Aktion nötig ist.
 *
 * Neu seit v1.39.0: der Balken ist **immer** sichtbar und beantwortet die zwei
 * Fragen, die vorher nirgends standen: „Ist die Firm-API überhaupt
 * eingetragen?“ (`firmApi.configured`) und „Läuft meine Sitzung?“
 * (`session.state` inkl. Restzeit). An-, Ab- und Verlängern sitzen direkt
 * daneben, statt sich hinter einer Fehlermeldung zu verstecken.
 */

import type { SessionSnapshot } from "@/lib/firmSession";
import {
  describeSession,
  formatSessionCountdown,
  sessionMaxLifeRemainingS,
  sessionRemainingS,
} from "@/lib/firmSession";

export function SessionNoticeBar({
  notice,
  showTokenField,
  tokenDraft,
  onTokenDraftChange,
  onSubmit,
  onLogout,
  onRenew,
  onShowLogin,
  session,
  statusUnavailable = false,
  busy = false,
  now,
}: {
  notice: string;
  showTokenField: boolean;
  tokenDraft: string;
  onTokenDraftChange: (value: string) => void;
  onSubmit: () => void;
  onLogout: () => void;
  onRenew: () => void;
  /** Blendet das Token-Feld ein — der Knopf oben *zeigt* die Anmeldung nur an. */
  onShowLogin: () => void;
  session: SessionSnapshot | null;
  /** `true` ⇒ der Statusabruf schlug fehl (nicht nur „noch nicht geladen“). */
  statusUnavailable?: boolean;
  busy?: boolean;
  /**
   * Ankerzeitpunkt für das Runterzählen — der Balken rechnet selbst nichts
   * (kein `Date.now()` im Render: Komponenten müssen rein bleiben), das
   * Dashboard schiebt die Uhr über einen 20-s-Ticker nach.
   */
  now: number;
}) {
  const status = describeSession(session, now, statusUnavailable);
  const signedIn = session?.session.state === "active" || session?.session.state === "expiring";
  const remaining = session ? sessionRemainingS(session, now) : 0;
  const maxLife = session ? sessionMaxLifeRemainingS(session, now) : 0;
  const open = session?.session.state === "open";
  const configured = session?.firmApi.configured ?? false;
  /**
   * Ein Anmeldeknopf wird nur gezeigt, wo er auch zu etwas fuehrt: ohne
   * konfiguriertes Credential und ohne Session-Signierung fuehrte er ins Leere
   * (der Server konnte gar keine Session ausstellen).
   */
  const canLogin = configured || Boolean(session?.firmApi.sessionsAvailable) || session === null;
  /**
   * „Verlaengern“ gehoert auch in den Nachfrist-Zustand: genau dort ist es der
   * eine Klick, der die Sitzung ohne Token-Eingabe zurueckholt.
   */
  const canRenew = signedIn || session?.session.state === "renewable";

  return (
    <div
      className={`mb-6 rounded-lg border px-4 py-2 text-sm text-slate-200 ${
        status.warning ? "border-amber-700/60 bg-amber-950/25" : "border-slate-700 bg-slate-800/60"
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <span className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden
            className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${
              open
                ? "bg-amber-400"
                : signedIn
                  ? "bg-emerald-400"
                  : status.warning
                    ? "bg-red-400"
                    : "bg-slate-500"
            }`}
          />
          <span className="min-w-0">{status.label}</span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {signedIn && (
            <span className="font-mono text-xs text-slate-400" title="Restzeit der Anmeldefrist · Restzeit bis zur absoluten Grenze">
              {formatSessionCountdown(remaining)} · max {formatSessionCountdown(maxLife)}
            </span>
          )}
          {canRenew && (
            <button
              onClick={onRenew}
              disabled={busy}
              className="rounded border border-slate-600 bg-slate-800 px-2.5 py-1 text-xs font-semibold text-slate-300 hover:bg-slate-700 disabled:opacity-50"
            >
              Verlängern
            </button>
          )}
          {(signedIn || !configured) && !open && (
            <button
              onClick={onLogout}
              className="rounded border border-slate-600 bg-slate-800 px-2.5 py-1 text-xs font-semibold text-slate-300 hover:bg-slate-700"
            >
              Abmelden
            </button>
          )}
          {!signedIn && !open && !showTokenField && canLogin && (
            <button
              onClick={onShowLogin}
              className="rounded bg-emerald-600 px-3 py-1 text-xs font-bold text-white hover:bg-emerald-500"
            >
              Anmelden
            </button>
          )}
        </span>
      </div>
      {notice !== "" && <p className="mt-1 text-xs text-slate-300/80">{notice}</p>}
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
            disabled={busy}
            className="rounded bg-emerald-600 px-3 py-1 text-xs font-bold text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            Anmelden
          </button>
          <span className="text-xs text-slate-400">
            Der Token wird nur geprüft — der Browser behält die HttpOnly-Sitzung, nicht den Token.
          </span>
        </div>
      )}
    </div>
  );
}
