"use client";

/**
 * Operations Center (Task 10) — die Control Plane der Firma.
 *
 * Der Tab aggregiert zehn Sektionen aus bestehenden Modulen (Universum,
 * Scanner, Portfolio, Research, Broker, LLM, Agenten, Risiko, Audit, Hilfe)
 * und stellt Rolle sowie Live-Gate-Status davor. Er ist kein Platzhalter:
 * jede Sektion zeigt echte Werte ihrer Quelle oder einen begründeten Zustand
 * (`empty` / `degraded` / `locked` / `unavailable`).
 *
 * Aufbau:
 *   OperationsCenterPanel  — Datenbeschaffung (GET /api/ops), Refresh
 *   OperationsCenterView   — reine Darstellung (props rein, Markup raus)
 *
 * XSS-sicher: kein innerHTML, alles JSX-Text. Loading / Error / Empty sind
 * eigene Zustände, damit ein Teilausfall nie als „alles gut“ erscheint.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch, readJson } from "@/lib/apiClient";
import type { OpsItem, OpsMetric, OpsPayload, OpsSection, OpsSectionStatus, OpsTone } from "@/ops/types";

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

const STATUS_LABEL: Record<OpsSectionStatus, string> = {
  ready: "bereit",
  degraded: "eingeschränkt",
  empty: "leer",
  locked: "gesperrt",
  unavailable: "nicht verfügbar",
};

/** Zustände, die Aufmerksamkeit verlangen (Kopfzeile + Sortierung). */
const ATTENTION: readonly OpsSectionStatus[] = ["unavailable", "locked", "degraded"];

const TONE_CLASS: Record<OpsTone, string> = {
  neutral: "text-slate-200",
  good: "text-emerald-300",
  warn: "text-amber-300",
  bad: "text-red-300",
};

/** Uhrzeit aus ISO-8601 (UTC) — Vergleichbarkeit mit den Audit-Zeiten. */
function clockUtc(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "—";
  return `${date.toISOString().slice(11, 19)} UTC`;
}

export default function OperationsCenterPanel({
  onOpenTab,
}: {
  /** Öffnet einen Dashboard-Tab (brokers / risk / protocol) direkt. */
  onOpenTab?: (tab: string) => void;
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
        return;
      }
      setData(json as OpsPayload);
    } catch {
      if (!mounted.current) return;
      setError("Netzwerkfehler — /api/ops nicht erreichbar.");
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const id = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(id);
  }, [load]);

  return (
    <OperationsCenterView payload={data} loading={loading} error={error} onReload={load} onOpenTab={onOpenTab} />
  );
}

export type OperationsCenterViewProps = {
  payload: OpsPayload | null;
  loading: boolean;
  error: string;
  onReload?: () => void;
  onOpenTab?: (tab: string) => void;
};

/** Reine Darstellung: testbar ohne Netz, ohne Datenbank. */
export function OperationsCenterView({
  payload,
  loading,
  error,
  onReload,
  onOpenTab,
}: OperationsCenterViewProps) {
  const actor = payload?.actor ?? null;
  const sections = payload?.sections ?? [];
  const health = payload?.health ?? null;
  const liveEnabled = payload?.liveEnabled === true;

  // Sektionen, die Aufmerksamkeit verlangen, nach vorn — der Rest bleibt in
  // Katalogreihenfolge (stabile, wiedererkennbare Anordnung).
  const ordered = [...sections].sort((a, b) => rank(a.status) - rank(b.status));

  return (
    <section className="space-y-4" aria-label="Operations Center">
      <div className="rounded-xl border border-emerald-800/50 bg-emerald-500/5 px-4 py-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-bold text-emerald-300">Operations Center</h2>
          <span className="text-[11px] text-slate-500">
            {payload ? `v${payload.version} · Stand ${clockUtc(payload.generatedAt)}` : ""}
          </span>
        </div>
        <p className="mt-1 text-xs leading-relaxed text-slate-400">
          Control Plane der Firma: zehn Sektionen, jede aggregiert aus einem bestehenden Modul.
          Rolle und Live-Sperre stehen vorne — Schreibzugriffe gehören in die jeweiligen Tabs.
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            onClick={() => onReload?.()}
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
            title={payload?.liveLockedReason ?? ""}
          >
            Live: {liveEnabled ? "freigegeben" : "gesperrt"}
          </span>
          {health && (
            <span className="rounded-full border border-slate-700 px-2.5 py-1 text-[11px] text-slate-400">
              {health.ready}/{health.total} Sektionen bereit
              {health.unavailable > 0 ? ` · ${health.unavailable} nicht verfügbar` : ""}
              {health.locked > 0 ? ` · ${health.locked} gesperrt` : ""}
              {health.degraded > 0 ? ` · ${health.degraded} eingeschränkt` : ""}
              {health.empty > 0 ? ` · ${health.empty} leer` : ""}
            </span>
          )}
          <a
            href="/docs?name=handbuch"
            className="rounded-lg border border-slate-700 px-3 py-1.5 text-[11px] font-semibold text-slate-300 transition hover:bg-slate-800"
          >
            Handbuch
          </a>
        </div>
        {payload && !liveEnabled && (
          <p className="mt-2 rounded-lg border border-red-900/60 bg-red-950/30 px-3 py-2 text-[11px] leading-relaxed text-red-200">
            Live-Sperre aktiv — {payload.liveLockedReason}
          </p>
        )}
      </div>

      {loading && !payload && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <div key={index} className="h-44 animate-pulse rounded-2xl border border-slate-800 bg-slate-900/40" />
          ))}
        </div>
      )}

      {!loading && error && !payload && (
        <div className="rounded-xl border border-red-800/60 bg-red-950/40 p-4 text-sm text-red-300">
          <p className="font-bold">Operations Center nicht verfügbar.</p>
          <p className="mt-1 text-xs">{error}</p>
          {onReload && (
            <button
              onClick={() => onReload()}
              className="mt-3 rounded-lg border border-red-700/60 px-3 py-1.5 text-[11px] font-semibold text-red-200 hover:bg-red-900/40"
            >
              Erneut versuchen
            </button>
          )}
        </div>
      )}

      {payload && error && (
        <div className="rounded-xl border border-amber-800/60 bg-amber-950/30 p-3 text-xs text-amber-200">
          Letzte Aktualisierung fehlgeschlagen — angezeigt werden die Werte von {clockUtc(payload.generatedAt)}.
          <span className="ml-1 text-amber-300/80">({error})</span>
        </div>
      )}

      {!loading && !error && payload && sections.length === 0 && (
        <p className="py-10 text-center text-sm text-slate-500">
          Keine Sektionen gemeldet (leere Antwort von GET /api/ops).
        </p>
      )}

      {sections.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
          {ordered.map((section) => (
            <SectionCard key={section.id} section={section} onOpenTab={onOpenTab} />
          ))}
        </div>
      )}
    </section>
  );
}

function rank(status: OpsSectionStatus): number {
  const index = ATTENTION.indexOf(status);
  return index === -1 ? ATTENTION.length : index;
}

function SectionCard({
  section,
  onOpenTab,
}: {
  section: OpsSection;
  onOpenTab?: (tab: string) => void;
}) {
  const target = section.tab;
  return (
    <article className="flex flex-col rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
      <div className="mb-2 flex items-start justify-between gap-2">
        <h3 className="text-sm font-bold text-slate-100">{section.title}</h3>
        <StatusChip status={section.status} />
      </div>
      <p className="text-xs leading-relaxed text-slate-400">{section.summary}</p>

      {section.error && (
        <p className="mt-3 rounded-lg border border-red-900/60 bg-red-950/30 px-3 py-2 text-[11px] leading-relaxed text-red-200">
          {section.error}
        </p>
      )}
      {!section.error && section.note && (
        <p className="mt-3 rounded-lg border border-amber-900/50 bg-amber-950/20 px-3 py-2 text-[11px] leading-relaxed text-amber-200">
          {section.note}
        </p>
      )}

      {section.metrics.length > 0 && (
        <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5">
          {section.metrics.map((metric) => (
            <MetricRow key={metric.label} metric={metric} />
          ))}
        </dl>
      )}

      {section.items.length > 0 && (
        <details className="mt-3 rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2">
          <summary className="cursor-pointer text-[11px] font-semibold text-slate-400 hover:text-slate-200">
            {section.items.length} Einträge anzeigen
          </summary>
          <ul className="mt-2 space-y-1">
            {section.items.map((item, index) => (
              <ItemRow key={`${item.label}-${index}`} item={item} />
            ))}
          </ul>
        </details>
      )}

      <div className="mt-auto flex flex-wrap items-center gap-3 pt-3 text-[11px]">
        {target && onOpenTab && (
          <button
            onClick={() => onOpenTab(target)}
            className="rounded-lg border border-sky-700/50 bg-sky-500/10 px-3 py-1.5 font-semibold text-sky-300 hover:bg-sky-500/20"
          >
            Tab öffnen
          </button>
        )}
        {section.href && (
          <a href={section.href} className="font-semibold text-emerald-400 hover:text-emerald-300">
            Dokumentation
          </a>
        )}
        <details className="ml-auto">
          <summary className="cursor-pointer text-slate-500 hover:text-slate-300">Quellen</summary>
          <ul className="mt-1 max-w-xs space-y-0.5 text-[10px] text-slate-500">
            {section.sources.map((source) => (
              <li key={source}>{source}</li>
            ))}
          </ul>
        </details>
      </div>
    </article>
  );
}

function MetricRow({ metric }: { metric: OpsMetric }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-[10px] uppercase tracking-wider text-slate-500" title={metric.hint ?? metric.label}>
        {metric.label}
      </dt>
      <dd className={`truncate text-xs font-semibold ${TONE_CLASS[metric.tone ?? "neutral"]}`} title={metric.value}>
        {metric.value}
      </dd>
    </div>
  );
}

function ItemRow({ item }: { item: OpsItem }) {
  return (
    <li className="flex items-baseline justify-between gap-2 text-[11px]">
      <span className="min-w-0 truncate text-slate-300" title={item.label}>
        {item.label}
      </span>
      <span className="flex min-w-0 shrink-0 items-baseline gap-1.5">
        {item.value && (
          <span className={`font-semibold ${TONE_CLASS[item.tone ?? "neutral"]}`}>{item.value}</span>
        )}
        {item.meta && <span className="truncate text-slate-500">{item.meta}</span>}
      </span>
    </li>
  );
}

function StatusChip({ status }: { status: OpsSectionStatus }) {
  const className =
    status === "ready"
      ? "bg-emerald-500/20 text-emerald-300"
      : status === "degraded"
        ? "bg-amber-500/20 text-amber-300"
        : status === "empty"
          ? "bg-slate-700/60 text-slate-300"
          : "bg-red-500/20 text-red-300";
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${className}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}
