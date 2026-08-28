"use client";

/**
 * Settings-Panel einer Broker-Karte (Task 08): read-only Flag-Anzeige.
 *
 * Zeigt Capabilities (Single Source of Truth = Adapter), Execution-Modi,
 * den Credential-Status und `liveEnabled` mit DEUTLICHEM "gesperrt"-Zustand.
 * Nichts hier ist editierbar — der einzige mutierende Pfad ist das
 * Loeschen (Bestaetigungsdialog, ConfirmDialog.tsx).
 */
import { useState } from "react";
import {
  deleteVenueCredentials,
  type BrokerListEntry,
  type BrokerStatusDto,
} from "@/lib/controlPlane";
import ConfirmDialog from "./ConfirmDialog";

function Flag({ ok, label, hint }: { ok: boolean; label: string; hint?: string }) {
  return (
    <span
      title={hint ?? label}
      className={`rounded-md border px-2 py-0.5 text-[11px] font-semibold ${
        ok
          ? "border-emerald-800/60 bg-emerald-500/10 text-emerald-300"
          : "border-slate-800 bg-slate-900/60 text-slate-600"
      }`}
    >
      {ok ? "✓" : "—"} {label}
    </span>
  );
}

const MODE_LABELS: Record<string, string> = {
  backtest: "Backtest",
  paper: "Paper",
  testnet: "Testnet",
  live: "Live",
};

export default function SettingsPanel({
  entry,
  status,
  onChanged,
  onUnauthorized,
}: {
  entry: BrokerListEntry;
  status: BrokerStatusDto | null;
  onChanged: () => void;
  onUnauthorized: () => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function confirmDelete() {
    setBusy(true);
    setError("");
    try {
      const result = await deleteVenueCredentials(entry.id);
      if (result.unauthorized) {
        onUnauthorized();
        setError("Nicht berechtigt (Admin-Token erforderlich).");
        return;
      }
      if (result.error) {
        setError(result.error);
        return;
      }
      setConfirmOpen(false);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 rounded-xl border border-slate-800 bg-slate-900/70 p-4">
      <p className="text-xs font-semibold text-slate-300">Einstellungen (read-only)</p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <section>
          <p className="text-[11px] uppercase tracking-wider text-slate-500">
            Capabilities (Adapter-SSoT)
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <Flag ok={entry.capabilities.discovery} label="Discovery" />
            <Flag ok={entry.capabilities.marketData} label="Marktdaten" />
            <Flag ok={entry.capabilities.trading} label="Trading" />
            <Flag ok={entry.capabilities.paper} label="Paper" />
            <Flag ok={entry.capabilities.testnet} label="Testnet" />
            <Flag ok={entry.capabilities.live} label="Live-Faehigkeit" />
            <Flag ok={entry.capabilities.stopAtVenue} label="Stops am Venue" />
          </div>
        </section>

        <section>
          <p className="text-[11px] uppercase tracking-wider text-slate-500">
            Markttypen
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <Flag ok={entry.capabilities.instrumentTypes.spot} label="Spot" />
            <Flag ok={entry.capabilities.instrumentTypes.future} label="Futures" />
            <Flag ok={entry.capabilities.instrumentTypes.perpetual} label="Perpetuals" />
            <Flag ok={entry.capabilities.instrumentTypes.option} label="Optionen" />
          </div>
        </section>
      </div>

      <section className="mt-3">
        <p className="text-[11px] uppercase tracking-wider text-slate-500">
          Execution-Modi
        </p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {Object.entries(entry.executionModes ?? {}).map(([mode, info]) => (
            <span
              key={mode}
              title={info.reason ?? MODE_LABELS[mode]}
              className={`rounded-md border px-2 py-0.5 text-[11px] font-semibold ${
                info.available
                  ? "border-emerald-800/60 bg-emerald-500/10 text-emerald-300"
                  : "border-slate-800 bg-slate-900/60 text-slate-600"
              }`}
            >
              {MODE_LABELS[mode] ?? mode}: {info.available ? "verfuegbar" : "gesperrt"}
            </span>
          ))}
        </div>
      </section>

      <section className="mt-3">
        <p className="text-[11px] uppercase tracking-wider text-slate-500">
          Credentials
        </p>
        <p className="mt-1 text-xs text-slate-300">
          {status?.configured
            ? "Hinterlegt (verschluesselt, nicht anzeigbar — nur Loeschen moeglich)."
            : "Keine Zugangsdaten hinterlegt."}
        </p>
        {error && (
          <p className="mt-2 rounded-lg border border-red-800/60 bg-red-950/40 px-3 py-2 text-xs text-red-300">
            {error}
          </p>
        )}
        <button
          onClick={() => setConfirmOpen(true)}
          disabled={!status?.configured || busy}
          className="mt-2 rounded-lg border border-red-800/60 bg-red-950/30 px-3 py-1.5 text-xs font-semibold text-red-300 transition hover:bg-red-950/60 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Zugangsdaten loeschen
        </button>
      </section>

      <section className="mt-3 rounded-lg border border-red-900/50 bg-red-950/30 p-3">
        <p className="flex items-center gap-2 text-xs font-bold text-red-300">
          <span aria-hidden="true">🔒</span> Live-Trading gesperrt
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-red-200/80">
          liveEnabled: {String(status?.liveEnabled ?? false)} — dieser Wert wird
          ausschliesslich aus der Gate-Service-Meldung uebernommen und ist in
          diesem Stadium immer false. Es gibt keine Moeglichkeit, Live hier
          freizuschalten (erst Task 11: Live-Trading-Gate).
        </p>
        <p className="mt-1 font-mono text-[10px] text-red-300/60">
          {status?.liveReason ?? "LIVE_GATE_LOCKED"}
        </p>
      </section>

      <ConfirmDialog
        open={confirmOpen}
        title="Zugangsdaten wirklich loeschen?"
        message={`Die verschluesselten Zugangsdaten fuer ${entry.id} werden unwiderruflich entfernt und die Verbindung getrennt. Das Ereignis wird im Audit-Log protokolliert.`}
        confirmLabel="Ja, loeschen"
        busy={busy}
        onConfirm={confirmDelete}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}
