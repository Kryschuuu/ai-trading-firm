"use client";

/**
 * Live-Gate-Panel (Task 11) — Anzeige + Kill-Switch im „Brokers & Venues"-Tab.
 *
 * Reine Projektion von GET /api/live/state: Gate-Zustand je Venue (Live-Chip
 * kommt aus dem GATE-Zustand, nicht aus einem UI-Flag), Flags, Suite-Stamp,
 * Cooldown-Restzeit, Kill-Switch-Status + Audit-Kettenkopf.
 *
 * Einzige Mutation über die UI: der KILL-SWITCH (Admin + Confirm-Dialog mit
 * getippter Phrase „KILL" — serverseitig erzwungen). Transitions bewusst
 * NICHT per UI-Knopf: der ordnungsgemäße Weg ist das Runbook in
 * docs/LIVE_TRADING.md (API/CLI), damit kein Klick-Fehler Live öffnet.
 * XSS-sicher: nur JSX-Text, kein innerHTML.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchLiveGateState,
  postLiveGateKill,
  type LiveGateOverviewDto,
  type LiveGateVenueSnapshotDto,
} from "@/lib/liveGate";
import ConfirmDialog from "./ConfirmDialog";

const STATE_ORDER: LiveGateVenueSnapshotDto["state"][] = [
  "DISCONNECTED",
  "CONNECTED",
  "MARKET_DATA_OK",
  "ACCOUNT_READ_OK",
  "ORDER_TEST_OK",
  "PAPER_APPROVED",
  "LIVE_PENDING",
  "HUMAN_APPROVED",
  "LIVE_ENABLED",
];

function stateColor(state: LiveGateVenueSnapshotDto["state"]): string {
  if (state === "LIVE_ENABLED") return "border-red-600/60 bg-red-500/10 text-red-300";
  if (state === "HUMAN_APPROVED" || state === "LIVE_PENDING")
    return "border-amber-600/60 bg-amber-500/10 text-amber-300";
  if (state === "DISCONNECTED") return "border-slate-700 bg-slate-900/60 text-slate-400";
  return "border-sky-600/60 bg-sky-500/10 text-sky-300";
}

function fmtCooldown(ms: number): string {
  if (ms <= 0) return "abgelaufen";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

export default function LiveGatePanel({
  onUnauthorized,
}: {
  onUnauthorized?: () => void;
}) {
  const [overview, setOverview] = useState<LiveGateOverviewDto | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [killOpen, setKillOpen] = useState(false);
  const [killReason, setKillReason] = useState("");
  const [killPhrase, setKillPhrase] = useState("");
  const [killBusy, setKillBusy] = useState(false);
  const [killError, setKillError] = useState("");
  const [killNote, setKillNote] = useState("");
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const res = await fetchLiveGateState();
    if (!mounted.current) return;
    if (res.error) {
      setError(res.error);
      setOverview(null);
      if (res.status === 401 || res.status === 403) onUnauthorized?.();
    } else {
      setOverview(res.data);
    }
    setLoading(false);
  }, [onUnauthorized]);

  // Kein synchrones setState im Effekt (react-hooks/set-state-in-effect):
  // das initiale Laden wird um einen Tick verschoben (Repo-Muster).
  useEffect(() => {
    const id = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(id);
  }, [load]);

  const pullKill = useCallback(async () => {
    setKillBusy(true);
    setKillError("");
    setKillNote("");
    const res = await postLiveGateKill({
      scope: "all",
      reason: killReason,
      confirm: killPhrase,
    });
    setKillBusy(false);
    if (!res.error && res.data?.ok) {
      setKillOpen(false);
      setKillReason("");
      setKillPhrase("");
      setKillNote("Kill-Switch gezogen — Live systemweit gesperrt (Audit-Eintrag geschrieben).");
      void load();
    } else {
      setKillError(res.error || "Kill fehlgeschlagen.");
      if (res.status === 401 || res.status === 403) onUnauthorized?.();
    }
  }, [killPhrase, killReason, load, onUnauthorized]);

  const venues = overview?.venues.filter((v) => v.liveAvailable) ?? [];

  return (
    <section
      aria-label="Live-Trading-Gate"
      className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold text-slate-200">Live-Trading-Gate (Task 11)</h3>
          <p className="mt-1 text-xs text-slate-400">
            Auditierte State-Machine: 9 Zustände, 8 legale Übergänge, Human-Gate mit
            Cooldown{overview?.config.fourEyes ? " + 4-Augen" : ""}. Dieses Panel{" "}
            <span className="font-semibold">schaltet kein Live ein</span> — der einzige
            UI-Weg ist der Kill-Switch.
          </p>
        </div>
        <button
          onClick={() => {
            setKillOpen(true);
            setKillError("");
          }}
          className="rounded-lg border border-red-700/70 bg-red-950/50 px-4 py-2 text-xs font-bold text-red-300 transition hover:bg-red-900/60"
        >
          Kill-Switch ziehen
        </button>
      </div>

      {killNote && (
        <p className="mt-3 rounded-lg border border-red-800/60 bg-red-950/40 p-2 text-xs text-red-300">
          {killNote}
        </p>
      )}
      {loading && <p className="mt-4 text-xs text-slate-500">Lade Gate-Zustand …</p>}
      {!loading && error && (
        <p className="mt-4 rounded-lg border border-red-800/60 bg-red-950/40 p-2 text-xs text-red-300">
          {error}{" "}
          <button className="underline" onClick={() => void load()}>
            Erneut versuchen
          </button>
        </p>
      )}

      {overview && (
        <>
          <div className="mt-4 flex flex-wrap gap-2 text-[11px]">
            <span
              className={`rounded-md border px-2 py-0.5 font-semibold ${
                overview.killSwitch.active
                  ? "border-red-600/60 bg-red-500/10 text-red-300"
                  : "border-slate-700 bg-slate-900/60 text-slate-400"
              }`}
              title="Persistente Failsafe-Datei + Memory; wirkt aus jedem Zustand sofort."
            >
              Kill-Switch: {overview.killSwitch.active ? "AKTIV" : "frei"}
              {overview.killSwitch.scopes.length > 0 ? ` (${overview.killSwitch.scopes.join(", ")})` : ""}
            </span>
            <span
              className={`rounded-md border px-2 py-0.5 font-semibold ${
                overview.suite.valid
                  ? "border-emerald-600/60 bg-emerald-500/10 text-emerald-300"
                  : "border-slate-700 bg-slate-900/60 text-slate-400"
              }`}
              title={overview.suite.reason}
            >
              Security-Suite: {overview.suite.valid ? `bestanden (${overview.suite.runId})` : "kein gültiger Stamp"}
            </span>
            <span
              className={`rounded-md border px-2 py-0.5 font-semibold ${
                overview.audit.integrity.ok
                  ? "border-emerald-600/60 bg-emerald-500/10 text-emerald-300"
                  : "border-red-600/60 bg-red-500/10 text-red-300"
              }`}
              title="Hash-Kette über alle Audit-Einträge (Manipulation wird erkannt)."
            >
              Audit-Kette: {overview.audit.integrity.ok ? "intakt" : `BROCHEN (seq ${overview.audit.integrity.firstBrokenSeq})`}
            </span>
            <span className="rounded-md border border-slate-700 bg-slate-900/60 px-2 py-0.5 font-mono text-slate-400">
              {overview.policyVersion}
            </span>
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {venues.map((v) => {
              const rank = STATE_ORDER.indexOf(v.state);
              return (
                <div key={v.venue} className="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-bold text-slate-200">{v.venue}</span>
                    <span
                      className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-semibold ${stateColor(v.state)}`}
                      title={`Deny-Code: ${v.denyCodeIfAny ?? "—"}`}
                    >
                      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
                      {v.state}
                    </span>
                  </div>
                  <div className="mt-2 h-1.5 w-full rounded-full bg-slate-800" aria-hidden="true">
                    <div
                      className={`h-1.5 rounded-full ${v.state === "LIVE_ENABLED" ? "bg-red-500" : "bg-sky-500"}`}
                      style={{ width: `${((rank + 1) / STATE_ORDER.length) * 100}%` }}
                    />
                  </div>
                  <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-slate-400">
                    <div>
                      Flags: {v.flags.venueEnabled ? "venue✓" : "venue✗"} ·{" "}
                      {v.flags.platformLive ? "platform✓" : "platform✗"} ·{" "}
                      {v.flags.venueLiveFlag ? "live✓" : "live✗"}
                    </div>
                    <div>Suite: {v.suite.valid ? "✓" : "✗"}</div>
                    <div>
                      Cooldown:{" "}
                      {v.state === "LIVE_PENDING"
                        ? v.cooldownElapsed
                          ? "abgelaufen (Freigabe möglich)"
                          : fmtCooldown(v.cooldownRemainingMs)
                        : "—"}
                    </div>
                    <div>
                      Übergänge: {v.history.transitions} · Denys: {v.history.denials} · Kills:{" "}
                      {v.history.kills}
                    </div>
                  </dl>
                </div>
              );
            })}
          </div>
          <p className="mt-3 text-[11px] text-slate-500">
            Runbook für Freigaben: docs/LIVE_TRADING.md (API <code>POST /api/live/transition</code>{" "}
            bzw. CLI) — jedes Opening ist ein auditierter Admin-Akt mit Begründung.
          </p>
        </>
      )}

      <ConfirmDialog
        open={killOpen}
        title="LIVE-KILL-SWITCH ziehen?"
        message={`Das sperrt Live-Trading SYSTEMWEIT (alle Venues), sofort und aus jedem Zustand — auch bei DB-Ausfall (persistente Failsafe-Datei). Rückgängig nur via Kill-Clear + komplettem Neudurchlauf der State-Machine. Zur Bestätigung Tippe "KILL" und nenne einen Grund.`}
        confirmLabel="Kill ziehen"
        busy={killBusy}
        onConfirm={() => void pullKill()}
        onCancel={() => setKillOpen(false)}
      />
      {killOpen && (
        <div className="mt-3 grid gap-2">
          <input
            value={killReason}
            onChange={(e) => setKillReason(e.target.value)}
            placeholder="Grund (Pflicht, min. 8 Zeichen) — erscheint im Audit"
            className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-200"
          />
          <input
            value={killPhrase}
            onChange={(e) => setKillPhrase(e.target.value)}
            placeholder='Bestätigungs-Phrase "KILL"'
            className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-200"
          />
          {killError && <p className="text-xs text-red-300">{killError}</p>}
          <button
            onClick={() => void pullKill()}
            disabled={killBusy || killPhrase !== "KILL" || killReason.trim().length < 8}
            className="justify-self-start rounded-lg bg-red-600 px-4 py-2 text-xs font-bold text-white transition hover:bg-red-500 disabled:opacity-40"
          >
            {killBusy ? "Ziehe …" : "Kill-Switch ziehen (confirm)"}
          </button>
        </div>
      )}
    </section>
  );
}
