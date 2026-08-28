"use client";

/**
 * Operations Center — Phase-1-Hülle (Task 10).
 *
 * Zeigt Rolle, Live-Sperre und Modul-Karten ohne Widgets.
 * XSS-sicher: kein innerHTML, alles JSX-Text. Loading / Error / Empty.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch, readJson } from "@/lib/apiClient";

type PublicActor = {
  role: string;
  effectiveRole: string;
  source: string;
  elevated: boolean;
  permissions: string[];
};

type OpsModule = {
  id: string;
  title: string;
  summary: string;
  status: "ready" | "stub" | "locked";
  tab?: string;
  href?: string;
};

type OpsPayload = {
  ok: true;
  version: string;
  liveEnabled: boolean;
  liveLockedReason: string;
  actor: PublicActor | null;
  modules: OpsModule[];
};

const ROLE_LABEL: Record<string, string> = {
  admin: "Admin",
  operator: "Operator",
  viewer: "Viewer",
};

const SOURCE_LABEL: Record<string, string> = {
  "local-open": "lokaler Offen-Betrieb",
  "admin-token": "Admin-Token",
  "api-token": "API-Token",
  "viewer-token": "Viewer-Token",
};

export default function OperationsCenterPanel({
  onOpenBrokers,
}: {
  onOpenBrokers?: () => void;
}) {
  const [data, setData] = useState<OpsPayload | null>(null);
  const [error, setError] = useState("");
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
    setError("");
    try {
      const res = await apiFetch("/api/ops");
      const { data: json, error: readError } = await readJson<OpsPayload & { ok?: boolean; error?: string }>(
        res,
        "Operations Center konnte nicht geladen werden."
      );
      if (!mounted.current) return;
      if (readError || !json.ok) {
        setError(readError || json.error || "Unbekannter Fehler");
        setData(null);
        return;
      }
      setData(json as OpsPayload);
    } catch {
      if (!mounted.current) return;
      setError("Netzwerkfehler — /api/ops nicht erreichbar.");
      setData(null);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const id = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(id);
  }, [load]);

  const actor = data?.actor ?? null;
  const modules = data?.modules ?? [];

  return (
    <section className="space-y-4">
      <div className="rounded-xl border border-emerald-800/50 bg-emerald-500/5 px-4 py-3">
        <h2 className="text-sm font-bold text-emerald-300">Operations Center</h2>
        <p className="mt-1 text-xs leading-relaxed text-slate-400">
          Zentrale Lage: Rolle, Gate-Status und die Module der Firma. Die Kacheln
          (Universum, Scanner, Portfolio, Zyklus, Routing) kommen in den nächsten
          Phasen — dieser Tab ist bewusst die leere Hülle, analog zu den
          früheren Aufgaben 03–08.
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            onClick={() => void load()}
            disabled={loading}
            className="rounded-lg border border-slate-700 px-3 py-1.5 text-[11px] font-semibold text-slate-300 transition hover:bg-slate-800 disabled:opacity-40"
          >
            {loading ? "Lade …" : "↻ Aktualisieren"}
          </button>
          {actor ? (
            <span className="rounded-full border border-emerald-700/50 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-semibold text-emerald-300">
              Rolle: {ROLE_LABEL[actor.effectiveRole] ?? actor.effectiveRole}
              {actor.elevated ? " (Single-Admin)" : ""}
              {actor.source ? ` · ${SOURCE_LABEL[actor.source] ?? actor.source}` : ""}
            </span>
          ) : (
            !loading && (
              <span className="rounded-full border border-slate-700 px-2.5 py-1 text-[11px] text-slate-500">
                nicht angemeldet
              </span>
            )
          )}
          <span
            className="rounded-full border border-red-700/50 bg-red-500/10 px-2.5 py-1 text-[11px] font-semibold text-red-300"
            title={data?.liveLockedReason}
          >
            Live: gesperrt
          </span>
        </div>
      </div>

      {loading && data === null && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <div
              key={index}
              className="h-36 animate-pulse rounded-2xl border border-slate-800 bg-slate-900/40"
            />
          ))}
        </div>
      )}

      {!loading && error && (
        <div className="rounded-xl border border-red-800/60 bg-red-950/40 p-4 text-sm text-red-300">
          <p className="font-bold">Operations Center nicht verfügbar.</p>
          <p className="mt-1 text-xs">{error}</p>
        </div>
      )}

      {!loading && !error && modules.length === 0 && (
        <p className="py-10 text-center text-sm text-slate-500">
          Keine Module gemeldet (leere Antwort von GET /api/ops).
        </p>
      )}

      {!loading && !error && modules.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {modules.map((mod) => (
            <article
              key={mod.id}
              className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4"
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <h3 className="text-sm font-bold text-slate-100">{mod.title}</h3>
                <StatusChip status={mod.status} />
              </div>
              <p className="text-xs leading-relaxed text-slate-400">{mod.summary}</p>
              {mod.tab === "brokers" && onOpenBrokers && (
                <button
                  onClick={onOpenBrokers}
                  className="mt-3 rounded-lg border border-sky-700/50 bg-sky-500/10 px-3 py-1.5 text-[11px] font-semibold text-sky-300 hover:bg-sky-500/20"
                >
                  Zum Broker-Tab
                </button>
              )}
              {mod.href && (
                <a
                  href={mod.href}
                  className="mt-3 inline-block text-[11px] font-semibold text-emerald-400 hover:text-emerald-300"
                >
                  Dokumentation
                </a>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function StatusChip({ status }: { status: OpsModule["status"] }) {
  if (status === "ready") {
    return (
      <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-bold uppercase text-emerald-300">
        bereit
      </span>
    );
  }
  if (status === "locked") {
    return (
      <span className="rounded-full bg-red-500/20 px-2 py-0.5 text-[10px] font-bold uppercase text-red-300">
        gesperrt
      </span>
    );
  }
  return (
    <span className="rounded-full bg-slate-700/60 px-2 py-0.5 text-[10px] font-bold uppercase text-slate-400">
      Phase 3
    </span>
  );
}
