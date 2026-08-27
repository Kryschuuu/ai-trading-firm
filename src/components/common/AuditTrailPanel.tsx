"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  describeAuditTrail,
  knownAuditEvents,
  summarizeAuditTrail,
  type AuditEntryDto,
} from "@/lib/auditView";
import { AuditTrailList } from "./AuditTrailList";
import { Pager, usePagination } from "./Pager";

/**
 * Audit-Trail mit Server-Paging (20/50/100/200 pro Seite), Level-/Event-Filter
 * und vollständiger, lesbarer Darstellung pro Eintrag.
 *
 * Wird an zwei Stellen verwendet — „Firm Overview" und „Protokoll" — damit
 * beide exakt dasselbe Verhalten zeigen.
 */
export function AuditTrailPanel({
  title = "Audit-Trail",
  hint = "Revisionssichere Ereignisse der Firma: Entscheidungen, Orders, Risiko- und Regeländerungen.",
  refreshMs = 15000,
}: {
  title?: string;
  hint?: string;
  refreshMs?: number;
}) {
  const [rows, setRows] = useState<AuditEntryDto[]>([]);
  const [level, setLevel] = useState("");
  const [event, setEvent] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [observedEvents, setObservedEvents] = useState<string[]>([]);
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
    if (level) params.set("level", level);
    if (event) params.set("event", event);
    try {
      const res = await fetch(`/api/firm/log?${params.toString()}`, { cache: "no-store" });
      const json = (await res.json()) as {
        audit?: AuditEntryDto[];
        meta?: { auditTotal?: number };
      };
      if (!alive.current) return;
      const audit = Array.isArray(json.audit) ? json.audit : [];
      setRows(audit);
      setTotal(Number(json.meta?.auditTotal ?? audit.length));
      setObservedEvents((previous) => {
        const merged = new Set([...previous, ...audit.map((row) => row.event)]);
        return [...merged].sort();
      });
      setError(null);
    } catch {
      if (alive.current) setError("Audit-Trail nicht erreichbar — die letzten geladenen Einträge bleiben sichtbar.");
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [page, pageSize, level, event, setTotal]);

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

  const views = useMemo(() => describeAuditTrail(rows), [rows]);
  const summary = useMemo(() => summarizeAuditTrail(views), [views]);
  const eventOptions = useMemo(() => {
    const merged = new Set([...knownAuditEvents(), ...observedEvents]);
    return [...merged].sort();
  }, [observedEvents]);

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">{title}</h2>
          <p className="mt-1 text-xs text-slate-500">{hint}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="audit-level-filter" className="text-[11px] text-slate-500">
            Stufe
          </label>
          <select
            id="audit-level-filter"
            value={level}
            onChange={(change) => {
              setLevel(change.target.value);
              pagination.goTo(1);
            }}
            className="cursor-pointer rounded-lg border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-slate-200"
          >
            <option value="">Alle</option>
            <option value="INFO">INFO — Information</option>
            <option value="WARN">WARN — Warnung</option>
            <option value="CRITICAL">CRITICAL — Kritisch</option>
          </select>

          <label htmlFor="audit-event-filter" className="text-[11px] text-slate-500">
            Ereignis
          </label>
          <select
            id="audit-event-filter"
            value={event}
            onChange={(change) => {
              setEvent(change.target.value);
              pagination.goTo(1);
            }}
            className="cursor-pointer rounded-lg border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-slate-200"
          >
            <option value="">Alle Ereignisse</option>
            {eventOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && (
        <p className="rounded-lg border border-amber-700/50 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">{error}</p>
      )}

      <Pager pagination={pagination} label="Ereignisse" />
      <AuditTrailList views={views} summary={summary} loading={loading} />
    </section>
  );
}

export default AuditTrailPanel;
