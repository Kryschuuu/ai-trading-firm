"use client";

import { useState } from "react";
import type { AuditFact, AuditSection, AuditTrailSummary, AuditView, IssueSeverity } from "@/lib/auditView";

/**
 * Audit-Trail als lesbare Liste: jeder Eintrag ist ein aufklappbarer Container
 * mit Kurzfassung (zugeklappt) bzw. vollständiger, beschrifteter Darstellung
 * plus Rohdaten-Reiter (aufgeklappt).
 *
 * Die gesamte Aufbereitung (deutsche Titel, Feldlabels, Plausibilitätsprüfung)
 * kommt aus `src/lib/auditView.ts` — die Komponente rendert nur.
 */

const TONE_BADGE: Record<AuditView["tone"], string> = {
  info: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  warn: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  critical: "bg-red-500/15 text-red-300 border-red-500/40",
};

const TONE_BAR: Record<AuditView["tone"], string> = {
  info: "border-l-emerald-500/70",
  warn: "border-l-amber-500/70",
  critical: "border-l-red-500/80",
};

const ISSUE_STYLE: Record<IssueSeverity, { box: string; icon: string; label: string }> = {
  error: { box: "border-red-700/60 bg-red-950/40 text-red-200", icon: "⛔", label: "Widerspruch" },
  warn: { box: "border-amber-700/60 bg-amber-950/30 text-amber-200", icon: "⚠️", label: "Hinweis" },
  info: { box: "border-sky-700/50 bg-sky-950/30 text-sky-200", icon: "ℹ️", label: "Einordnung" },
};

const FACT_TONE: Record<NonNullable<AuditFact["tone"]>, string> = {
  neutral: "text-slate-200",
  good: "text-emerald-300",
  warn: "text-amber-300",
  bad: "text-red-300",
};

function FactRow({ fact }: { fact: AuditFact }) {
  return (
    <div className="grid grid-cols-1 gap-1 border-b border-slate-800/60 py-1.5 last:border-0 sm:grid-cols-[minmax(9rem,14rem)_1fr] sm:gap-3">
      <dt className="text-[11px] uppercase tracking-wide text-slate-400">{fact.label}</dt>
      <dd className="min-w-0">
        <span className={`block break-words text-slate-200 ${fact.mono ? "font-mono text-[11px]" : ""} ${FACT_TONE[fact.tone ?? "neutral"]}`}>
          {fact.value}
        </span>
        {fact.hint && <span className="mt-0.5 block text-[11px] leading-snug text-slate-500">{fact.hint}</span>}
      </dd>
    </div>
  );
}

function Section({ section }: { section: AuditSection }) {
  return (
    <section className="rounded-lg border border-slate-800 bg-slate-950/30 px-3 py-2">
      <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">{section.title}</h4>
      {section.note && <p className="mb-1 text-[11px] text-amber-300">{section.note}</p>}
      <dl>
        {section.facts.map((fact, index) => (
          <FactRow key={`${section.title}-${fact.label}-${index}`} fact={fact} />
        ))}
      </dl>
    </section>
  );
}

function IssueList({ issues }: { issues: AuditView["issues"] }) {
  if (issues.length === 0) return null;
  return (
    <ul className="space-y-1.5">
      {issues.map((issue, index) => {
        const style = ISSUE_STYLE[issue.severity];
        return (
          <li key={`${issue.title}-${index}`} className={`rounded-lg border px-3 py-2 ${style.box}`}>
            <p className="text-[11px] font-bold uppercase tracking-wide">
              <span aria-hidden="true" className="mr-1">{style.icon}</span>
              {style.label}: {issue.title}
            </p>
            <p className="mt-1 text-xs leading-relaxed">{issue.detail}</p>
          </li>
        );
      })}
    </ul>
  );
}

function AuditTrailRow({
  view,
  isOpen,
  onToggle,
}: {
  view: AuditView;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const [tab, setTab] = useState<"details" | "raw">("details");
  const hasErrors = view.issues.some((issue) => issue.severity === "error");
  const hasWarnings = view.issues.some((issue) => issue.severity === "warn");

  return (
    <li className={`overflow-hidden rounded-xl border border-slate-800 border-l-4 bg-slate-900/50 ${TONE_BAR[view.tone]}`}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isOpen}
        className="flex w-full items-start gap-3 px-3 py-2 text-left transition hover:bg-slate-800/40"
      >
        <span className={`mt-0.5 shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase ${TONE_BADGE[view.tone]}`}>
          {view.levelLabel}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-xs font-semibold text-slate-100">{view.eventLabel}</span>
            <code className="text-[10px] text-slate-500">{view.event}</code>
            {hasErrors && <span className="text-[10px] font-bold uppercase text-red-400">⛔ Widerspruch</span>}
            {!hasErrors && hasWarnings && <span className="text-[10px] font-bold uppercase text-amber-400">⚠ Hinweis</span>}
          </span>
          <span className="mt-0.5 block break-words text-xs text-slate-300">{view.headline}</span>
        </span>
        <span className="shrink-0 text-right">
          <span className="block whitespace-nowrap text-[11px] tabular-nums text-slate-300">{view.atLabel}</span>
          <span className="block whitespace-nowrap text-[10px] text-slate-500">{view.relative}</span>
        </span>
        <span aria-hidden="true" className="mt-1 shrink-0 text-slate-500">
          {isOpen ? "▾" : "▸"}
        </span>
      </button>

      {isOpen && (
        <div className="space-y-3 border-t border-slate-800 px-3 py-3">
          <div className="rounded-lg border border-slate-800 bg-slate-950/30 px-3 py-2">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Was ist passiert?</p>
            <p className="mt-1 text-xs leading-relaxed text-slate-300">{view.eventDescription}</p>
            <p className="mt-2 text-xs leading-relaxed text-emerald-200/90">{view.explanation}</p>
          </div>

          <IssueList issues={view.issues} />

          <div className="flex gap-2 border-b border-slate-800">
            {(
              [
                ["details", "Lesbare Details"],
                ["raw", "Rohdaten (DB-Eintrag)"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={`rounded-t-lg border border-b-0 px-3 py-1 text-[11px] font-semibold transition ${
                  tab === id
                    ? "border-slate-700 bg-slate-800 text-slate-100"
                    : "border-transparent text-slate-500 hover:text-slate-300"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {tab === "details" ? (
            <div className="space-y-2">
              {view.sections.length > 0 ? (
                view.sections.map((section, index) => <Section key={`${section.title}-${index}`} section={section} />)
              ) : (
                <p className="text-xs text-slate-500">Zu diesem Eintrag wurden keine Detailfelder protokolliert.</p>
              )}
            </div>
          ) : (
            <div>
              <p className="mb-1 text-[11px] text-slate-500">
                Vollständiger Datenbank-Eintrag aus <code>audit_log</code> — ungekürzt und unverändert.
              </p>
              <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-slate-800 bg-slate-950/60 p-3 font-mono text-[11px] leading-relaxed text-slate-300">
                {view.raw}
              </pre>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

export function AuditTrailList({
  views,
  summary,
  loading,
  emptyText = "Noch keine Audit-Einträge. Sobald die Firma läuft, erscheinen hier alle Ereignisse.",
  initialOpen,
}: {
  views: AuditView[];
  summary?: AuditTrailSummary;
  loading?: boolean;
  emptyText?: string;
  /** Beim ersten Rendern geöffnete Einträge (Deep-Link/Tests). */
  initialOpen?: string[];
}) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(initialOpen ?? []));

  function toggle(id: string) {
    setOpen((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const allOpen = views.length > 0 && views.every((view) => open.has(view.id));

  return (
    <div className="space-y-2">
      {summary && views.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <span className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-emerald-300">
            {summary.info} Information
          </span>
          <span className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-amber-300">
            {summary.warn} Warnung
          </span>
          <span className="rounded-md border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-red-300">
            {summary.critical} Kritisch
          </span>
          {summary.contradictions > 0 && (
            <span className="rounded-md border border-red-700/60 bg-red-950/40 px-2 py-0.5 font-semibold text-red-300">
              ⛔ {summary.contradictions} Widerspruch/Widersprüche
            </span>
          )}
          {summary.issues > 0 && (
            <span className="rounded-md border border-slate-700 bg-slate-800 px-2 py-0.5 text-slate-300">
              {summary.issues} Befund/Befunde insgesamt
            </span>
          )}
          <button
            type="button"
            onClick={() => setOpen(allOpen ? new Set() : new Set(views.map((view) => view.id)))}
            className="ml-auto rounded-md border border-slate-700 bg-slate-800 px-2 py-0.5 font-semibold text-slate-200 transition hover:bg-slate-700"
          >
            {allOpen ? "Alle zuklappen" : "Alle aufklappen"}
          </button>
        </div>
      )}

      {loading && views.length === 0 ? (
        <p className="rounded-xl border border-slate-800 bg-slate-900/50 px-4 py-6 text-sm text-slate-400">Lade Audit-Trail…</p>
      ) : views.length === 0 ? (
        <p className="rounded-xl border border-slate-800 bg-slate-900/50 px-4 py-6 text-sm text-slate-400">{emptyText}</p>
      ) : (
        <ul className="space-y-2">
          {views.map((view) => (
            <AuditTrailRow key={view.id} view={view} isOpen={open.has(view.id)} onToggle={() => toggle(view.id)} />
          ))}
        </ul>
      )}
    </div>
  );
}

export default AuditTrailList;
