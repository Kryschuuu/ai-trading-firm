"use client";

/**
 * Broker-Karte "Brokers & Venues" (Task 08).
 *
 * Anzeige pro Broker: Status-LED, Markets-Anzahl, Futures/Spot-Flags,
 * Buttons [Verbinden] [Test] [Einstellungen], 6 Zustands-Chips
 * (Connection / Market Discovery / Permissions / Paper / Testnet / Live)
 * je off/pending/active/error.
 *
 * Connect-Flow = masked credential form (CredentialForm.tsx). PAPER ist der
 * interne Simulator ohne Credentials — Verbinden = reiner Verbindungstest.
 * Der Live-Chip zeigt immer "gesperrt/off" (liveEnabled nur aus
 * Gate-Meldung).
 */
import { useState } from "react";
import {
  testVenueConnection,
  type BrokerListEntry,
  type BrokerStatusDto,
} from "@/lib/controlPlane";
import StateChip from "./StateChip";
import CredentialForm from "./CredentialForm";
import SettingsPanel from "./SettingsPanel";

const LAYER_ORDER = [
  "connection",
  "marketDiscovery",
  "permissions",
  "paper",
  "testnet",
  "live",
] as const;

function ledInfo(status: BrokerStatusDto | null): {
  color: string;
  label: string;
} {
  if (!status) return { color: "bg-slate-600", label: "Status unbekannt" };
  if (status.connected) return { color: "bg-emerald-400", label: "Verbunden" };
  if (status.layers.connection?.state === "error")
    return { color: "bg-red-500", label: "Fehler (read-only Probe)" };
  if (status.layers.connection?.state === "pending")
    return { color: "bg-amber-400", label: "In Pruefung" };
  if (status.configured) return { color: "bg-amber-400", label: "Konfiguriert" };
  return { color: "bg-slate-600", label: "Offline / nicht verbunden" };
}

export default function BrokerCard({
  entry,
  status,
  statusError,
  onChanged,
  onUnauthorized,
}: {
  entry: BrokerListEntry;
  status: BrokerStatusDto | null;
  statusError: string;
  onChanged: () => void;
  onUnauthorized: () => void;
}) {
  const [panel, setPanel] = useState<"none" | "connect" | "settings">("none");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const led = ledInfo(status);
  const isPaper = entry.id === "PAPER";
  const canTest = isPaper || status?.configured;

  async function runTest() {
    setBusy(true);
    setFeedback(null);
    try {
      const result = await testVenueConnection(entry.id);
      if (result.unauthorized) {
        onUnauthorized();
        setFeedback({ tone: "error", text: "Nicht berechtigt (Admin-Token erforderlich)." });
        return;
      }
      if (result.error) {
        setFeedback({ tone: "error", text: result.error });
      } else {
        setFeedback({
          tone: "ok",
          text: `Verbindungstest ok — Berechtigungen: ${
            result.data?.permissions?.join(", ") || "keine"
          }.`,
        });
      }
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
      {/* Kopfzeile: LED + Name + Venue-ID */}
      <header className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <span
            title={led.label}
            aria-label={led.label}
            className={`h-3 w-3 shrink-0 rounded-full ${led.color} ring-2 ring-slate-950`}
          />
          <div>
            <h3 className="text-sm font-bold text-slate-100">{entry.label}</h3>
            <p className="font-mono text-[11px] text-slate-500">{entry.id}</p>
          </div>
        </div>
        <div className="flex gap-1.5">
          <button
            onClick={() => {
              setFeedback(null);
              setPanel("connect");
            }}
            disabled={busy || (isPaper && panel === "connect")}
            className="rounded-lg bg-sky-500 px-3 py-1.5 text-[11px] font-bold text-slate-950 transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Verbinden
          </button>
          <button
            onClick={runTest}
            disabled={busy || !canTest}
            title={
              canTest
                ? "Verbindungstest (read-only Probe)"
                : "Erst Zugangsdaten hinterlegen"
            }
            className="rounded-lg border border-slate-700 px-3 py-1.5 text-[11px] font-semibold text-slate-300 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy && panel === "none" ? "Teste …" : "Test"}
          </button>
          <button
            onClick={() => {
              setFeedback(null);
              setPanel(panel === "settings" ? "none" : "settings");
            }}
            className="rounded-lg border border-slate-700 px-3 py-1.5 text-[11px] font-semibold text-slate-300 transition hover:bg-slate-800"
          >
            Einstellungen
          </button>
        </div>
      </header>

      {/* Status-LED-Text */}
      <p className="mt-1.5 text-[11px] text-slate-500">{led.label}</p>

      {/* Kennzahlen: Maerkte + Markttypen + Permissions */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="rounded-lg border border-slate-800 bg-slate-950/60 px-2.5 py-1 text-[11px] font-semibold text-slate-300">
          Maerkte:{" "}
          {status && status.discovery.state === "active"
            ? status.discovery.count
            : "—"}
        </span>
        {entry.capabilities.instrumentTypes.spot && (
          <span className="rounded-lg border border-slate-800 bg-slate-950/60 px-2.5 py-1 text-[11px] font-semibold text-slate-300">
            Spot
          </span>
        )}
        {entry.capabilities.instrumentTypes.perpetual && (
          <span className="rounded-lg border border-slate-800 bg-slate-950/60 px-2.5 py-1 text-[11px] font-semibold text-slate-300">
            Perpetuals
          </span>
        )}
        {entry.capabilities.instrumentTypes.future && (
          <span className="rounded-lg border border-slate-800 bg-slate-950/60 px-2.5 py-1 text-[11px] font-semibold text-slate-300">
            Futures
          </span>
        )}
        {status?.permissions?.map((permission) => (
          <span
            key={permission}
            className="rounded-lg border border-emerald-800/60 bg-emerald-500/10 px-2.5 py-1 font-mono text-[11px] font-bold text-emerald-300"
          >
            {permission}
          </span>
        ))}
        <span className="ml-auto font-mono text-[10px] text-slate-600">
          {entry.health.status} · {entry.health.latencyMs} ms
        </span>
      </div>

      {/* 6 Zustands-Ebenen */}
      <div className="mt-3 flex flex-wrap gap-1.5">
        {LAYER_ORDER.map((layerId) => {
          const layer = status?.layers?.[layerId];
          return (
            <StateChip
              key={layerId}
              layerId={layerId}
              state={layer?.state ?? "off"}
              detail={layer?.detail}
            />
          );
        })}
      </div>

      {statusError && (
        <p className="mt-3 rounded-lg border border-red-800/60 bg-red-950/40 px-3 py-2 text-xs text-red-300">
          Status nicht ladbar: {statusError}
        </p>
      )}

      {feedback && (
        <p
          className={`mt-3 rounded-lg border px-3 py-2 text-xs ${
            feedback.tone === "ok"
              ? "border-emerald-800/60 bg-emerald-500/10 text-emerald-300"
              : "border-red-800/60 bg-red-950/40 text-red-300"
          }`}
        >
          {feedback.text}
        </p>
      )}

      {panel === "connect" && !isPaper && (
        <CredentialForm
          venue={entry.id}
          label={entry.label}
          onDone={(result, error) => {
            setPanel("none");
            setFeedback(
              error
                ? { tone: "error", text: error }
                : {
                    tone: "ok",
                    text: `Gespeichert & verbunden — Berechtigungen: ${
                      result?.permissions?.join(", ") || "keine"
                    }.`,
                  }
            );
            onChanged();
          }}
          onUnauthorized={onUnauthorized}
        />
      )}

      {panel === "connect" && isPaper && (
        <p className="mt-4 rounded-xl border border-slate-800 bg-slate-900/70 p-4 text-xs text-slate-400">
          PAPER ist der interne Simulator — er benoetigt keine Zugangsdaten.
          Die Verbindung wird ueber den Button <strong>Test</strong> geprueft.
        </p>
      )}

      {panel === "settings" && (
        <SettingsPanel
          entry={entry}
          status={status}
          onChanged={onChanged}
          onUnauthorized={onUnauthorized}
        />
      )}
    </article>
  );
}
