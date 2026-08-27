"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProtocolEntryDto } from "@/lib/types";
import { summarizeProtocolEntry, type ProtocolEntryLike } from "@/lib/auditView";
import { ProtocolList } from "./ProtocolList";
import { Pager, usePagination } from "./Pager";

/**
 * Protokoll-Bereich (agent_messages) mit demselben Paging-System wie der
 * Audit-Trail: 20/50/100/200 Einträge pro Seite, Default 20.
 *
 * Die Liste zeigt Turns, Analystenberichte und Systemmeldungen — jeweils mit
 * Kurzfassung, vollständigen lesbaren Details und einem Rohdaten-Reiter.
 */
export function ProtocolPanel({
  title = "Protokoll — Entscheidungen, Analysen und Systemmeldungen",
  hint = "Jeder Eintrag ist aufklappbar: Kurzfassung, vollständige Details und der originale Datenbank-Eintrag.",
  refreshMs = 12000,
}: {
  title?: string;
  hint?: string;
  refreshMs?: number;
}) {
  const [entries, setEntries] = useState<ProtocolEntryDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const pagination = usePagination();
  const { page, pageSize, setTotal } = pagination;
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ limit: String(pageSize), page: String(page) });
    try {
      const res = await fetch(`/api/firm/log?${params.toString()}`, { cache: "no-store" });
      const json = (await res.json()) as { entries?: ProtocolEntryDto[]; meta?: { entryTotal?: number } };
      if (!alive.current) return;
      const next = Array.isArray(json.entries) ? json.entries : [];
      setEntries(next);
      setTotal(Number(json.meta?.entryTotal ?? next.length));
      setError(null);
    } catch {
      if (alive.current) setError("Protokoll nicht erreichbar — die letzten geladenen Einträge bleiben sichtbar.");
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [page, pageSize, setTotal]);

  useEffect(() => {
    const boot = window.setTimeout(() => {
      void load();
    }, 0);
    const id = window.setInterval(() => void load(), refreshMs);
    return () => {
      window.clearTimeout(boot);
      window.clearInterval(id);
    };
  }, [load, refreshMs]);

  /** Clientseitige Suche über die geladene Seite (Text, Rolle, Event-Typ). */
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return entries as ProtocolEntryLike[];
    return (entries as ProtocolEntryLike[]).filter((entry) =>
      [
        entry.actor?.name,
        entry.actor?.role,
        entry.messageType,
        entry.decision?.type,
        entry.decision?.symbol,
        entry.analysis?.view,
        entry.content,
        summarizeProtocolEntry(entry),
      ]
        .filter((part): part is string => typeof part === "string")
        .some((part) => part.toLowerCase().includes(needle))
    );
  }, [entries, query]);

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">{title}</h2>
          <p className="mt-1 text-xs text-slate-500">{hint}</p>
        </div>
        <label className="flex items-center gap-2 text-[11px] text-slate-500">
          Suche in dieser Seite
          <input
            value={query}
            onChange={(change) => setQuery(change.target.value)}
            placeholder="z. B. BTC, HOLD, Cassini"
            className="w-56 rounded-lg border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-slate-200 placeholder:text-slate-600"
          />
        </label>
      </div>

      {error && (
        <p className="rounded-lg border border-amber-700/50 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">{error}</p>
      )}

      <Pager pagination={pagination} label="Protokolleinträge" />
      <ProtocolList
        entries={visible}
        loading={loading}
        emptyText={
          query.trim().length > 0
            ? "Keine Protokolleinträge auf dieser Seite passen zur Suche."
            : "Noch keine Protokolleinträge. Pipeline, Markt-Tick oder Analystenzyklus starten."
        }
      />
    </section>
  );
}

export default ProtocolPanel;
