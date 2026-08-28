"use client";

/**
 * "Brokers & Venues" — Control-Plane-UI (Task 08).
 *
 * Laedt GET /api/brokers (Karten-Basis: Capabilities, Flags, Health) und
 * parallel GET /api/brokers/{venue}/status (Control-Plane-Status mit den
 * 6 Zustands-Ebenen). Alle Mutationen laufen ueber die Karten/Komponenten
 * und loesen einen Refresh aus.
 *
 * Zustaende: Loading (Skeleton), Error (Banner + Retry), Empty (keine
 * Broker), Daten (Karten-Grid). XSS-sicher: kein innerHTML, alles JSX-Text.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchBrokerList,
  fetchVenueStatus,
  type BrokerListEntry,
  type BrokerStatusDto,
} from "@/lib/controlPlane";
import BrokerCard from "./BrokerCard";
import LiveGatePanel from "./LiveGatePanel";

type StatusMap = Record<string, { status: BrokerStatusDto | null; error: string }>;

export default function BrokersPanel({
  onUnauthorized,
}: {
  onUnauthorized?: () => void;
}) {
  const [entries, setEntries] = useState<BrokerListEntry[] | null>(null);
  const [statuses, setStatuses] = useState<StatusMap>({});
  const [listError, setListError] = useState("");
  const [loading, setLoading] = useState(true);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setListError("");
    try {
      const list = await fetchBrokerList();
      if (!mounted.current) return;
      if (list.error) {
        setListError(list.error);
        setEntries([]);
        setStatuses({});
        return;
      }
      const brokers = list.data?.brokers ?? [];
      setEntries(brokers);

      const results = await Promise.all(
        brokers.map(async (broker) => {
          const res = await fetchVenueStatus(broker.id);
          return [
            broker.id,
            {
              status: res.error ? null : res.data,
              error: res.error,
            },
          ] as const;
        })
      );
      if (!mounted.current) return;
      setStatuses(Object.fromEntries(results) as StatusMap);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  // Kein synchrones setState im Effekt (react-hooks/set-state-in-effect):
  // das initiale Laden wird um einen Tick verschoben (Repo-Muster).
  useEffect(() => {
    const id = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(id);
  }, [load]);

  return (
    <section className="space-y-4">
      <div className="rounded-xl border border-sky-800/50 bg-sky-500/5 px-4 py-3">
        <h2 className="text-sm font-bold text-sky-300">
          🌐 Brokers &amp; Venues — Control Plane
        </h2>
        <p className="mt-1 text-xs leading-relaxed text-slate-400">
          Verbindungsstatus, Berechtigungen und Modus-Ebenen je Venue. Zugangsdaten
          werden genau einmal entgegengenommen, im Backend mit AES-256-GCM
          verschluesselt (AAD = Venue-ID) und danach nie wieder angezeigt.
          Live-Trading bleibt <strong className="text-red-300">gesperrt</strong>, bis
          die Live-Gate-State-Machine (Task 11) vollstaendig durchlaufen ist —
          die Anzeige kommt ausschliesslich aus der Enforcer-Projektion.
        </p>
        <div className="mt-2 flex items-center gap-2">
          <button
            onClick={() => void load()}
            disabled={loading}
            className="rounded-lg border border-slate-700 px-3 py-1.5 text-[11px] font-semibold text-slate-300 transition hover:bg-slate-800 disabled:opacity-40"
          >
            {loading ? "Lade …" : "↻ Aktualisieren"}
          </button>
          <p className="text-[11px] text-slate-600">
            Statuswerte: GET /api/brokers + GET /api/brokers/{"{venue}"}/status
          </p>
        </div>
      </div>

      <LiveGatePanel onUnauthorized={onUnauthorized} />

      {loading && entries === null && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <div
              key={index}
              className="h-56 animate-pulse rounded-2xl border border-slate-800 bg-slate-900/40"
            />
          ))}
        </div>
      )}

      {!loading && listError && (
        <div className="rounded-xl border border-red-800/60 bg-red-950/40 p-4 text-sm text-red-300">
          <p className="font-bold">Broker-Liste konnte nicht geladen werden.</p>
          <p className="mt-1 text-xs">{listError}</p>
        </div>
      )}

      {!loading && !listError && entries !== null && entries.length === 0 && (
        <p className="py-10 text-center text-sm text-slate-500">
          Keine Broker gefunden (leere Antwort von GET /api/brokers).
        </p>
      )}

      {!loading && !listError && entries !== null && entries.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {entries.map((entry) => (
            <BrokerCard
              key={entry.id}
              entry={entry}
              status={statuses[entry.id]?.status ?? null}
              statusError={statuses[entry.id]?.error ?? ""}
              onChanged={() => void load()}
              onUnauthorized={onUnauthorized ?? (() => undefined)}
            />
          ))}
        </div>
      )}
    </section>
  );
}
