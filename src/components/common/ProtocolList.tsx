"use client";

import { useState } from "react";
import {
  ROLE_LABELS,
  SOURCE_LABELS,
  describeModel,
  formatDuration,
  formatRelative,
  formatTimestampUtc,
  protocolKindLabel,
  protocolRawJson,
  summarizeProtocolEntry,
  type ProtocolEntryLike,
} from "@/lib/auditView";

/**
 * Protokoll-Liste (agent_messages) im selben Muster wie der Audit-Trail:
 * Kurzfassung zugeklappt, vollständige lesbare Darstellung + Rohdaten-Reiter
 * aufgeklappt. Kein Text wird abgeschnitten — lange Inhalte scrollen.
 */

function decisionBadgeClass(entry: ProtocolEntryLike): string {
  if (entry.kind === "turn") {
    const type = entry.decision?.type?.toUpperCase();
    if (type === "TRADE") return "bg-emerald-500/15 text-emerald-300 border-emerald-500/30";
    if (type === "APPROVE") return "bg-emerald-500/15 text-emerald-300 border-emerald-500/30";
    if (type === "KILL" || type === "REJECT") return "bg-red-500/15 text-red-300 border-red-500/40";
    if (type === "HOLD" || type === "REPORT") return "bg-slate-600/30 text-slate-300 border-slate-600/40";
    return "bg-sky-500/15 text-sky-300 border-sky-500/30";
  }
  if (entry.kind === "analysis") return "bg-violet-500/15 text-violet-300 border-violet-500/30";
  if (entry.kind === "system") return "bg-amber-500/15 text-amber-300 border-amber-500/30";
  return "bg-slate-600/30 text-slate-300 border-slate-600/40";
}

function decisionLabel(entry: ProtocolEntryLike): string {
  if (entry.kind === "turn") {
    const type = entry.decision?.type?.toUpperCase();
    return type ?? "ENTSCHEIDUNG";
  }
  return protocolKindLabel(entry.kind).toUpperCase();
}

function actorName(entry: ProtocolEntryLike): string {
  const name = entry.actor?.name?.trim();
  return name && name !== "?" ? name : "System";
}

function actorRole(entry: ProtocolEntryLike): string {
  const role = entry.actor?.role?.trim().toUpperCase();
  if (!role || role === "?") return "SYSTEM";
  return ROLE_LABELS[role] ? `${role} — ${ROLE_LABELS[role]}` : role;
}

function sourceLabel(entry: ProtocolEntryLike): string {
  const source = entry.trace?.source;
  return source ? (SOURCE_LABELS[source] ?? source) : "Quelle nicht protokolliert";
}

function DecisionFacts({ entry }: { entry: ProtocolEntryLike }) {
  const decision = entry.decision;
  if (!decision) return null;
  const rows: { label: string; value: string; hint?: string }[] = [
    { label: "Entscheidungstyp", value: decision.type?.toUpperCase() ?? "—" },
  ];
  if (decision.symbol) rows.push({ label: "Symbol", value: decision.symbol });
  if (decision.side) {
    rows.push({
      label: "Richtung",
      value: decision.side.toUpperCase() === "SHORT" ? "SHORT — Verkaufsposition" : "LONG — Kaufposition",
    });
  }
  if (decision.stopLossPct !== undefined && decision.stopLossPct !== null) {
    rows.push({
      label: "Stop-Loss",
      value: `${Number(decision.stopLossPct).toLocaleString("de-DE", { maximumFractionDigits: 1 })} %`,
      hint: "Abstand vom Einstieg; der Monitor schließt die Position, wenn der Kurs ihn erreicht.",
    });
  }
  if (decision.riskScore !== undefined && decision.riskScore !== null) {
    rows.push({
      label: "Risiko-Score",
      value: `${Number(decision.riskScore).toLocaleString("de-DE", { maximumFractionDigits: 2 })} von 1,00`,
      hint: "Selbsteinschätzung des Modells.",
    });
  }
  if (decision.reason) rows.push({ label: "Begründung des Modells", value: decision.reason });

  return (
    <dl className="rounded-lg border border-slate-800 bg-slate-950/30 px-3 py-2">
      <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Entscheidung (geparst)</h4>
      {rows.map((row) => (
        <div
          key={row.label}
          className="grid grid-cols-1 gap-1 border-b border-slate-800/60 py-1.5 last:border-0 sm:grid-cols-[minmax(9rem,14rem)_1fr] sm:gap-3"
        >
          <dt className="text-[11px] uppercase tracking-wide text-slate-400">{row.label}</dt>
          <dd className="min-w-0 break-words text-slate-200">
            {row.value}
            {row.hint && <span className="mt-0.5 block text-[11px] text-slate-500">{row.hint}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function AnalysisFacts({ entry }: { entry: ProtocolEntryLike }) {
  const analysis = entry.analysis;
  if (!analysis) return null;
  const view = analysis.view ?? null;
  const viewClass =
    view === "BULLISH" ? "text-emerald-300" : view === "BEARISH" ? "text-red-300" : "text-slate-300";
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/30 px-3 py-2 text-xs">
      <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Analystenbericht</h4>
      <p>
        <span className="text-slate-400">Einstufung: </span>
        <span className={`font-semibold ${viewClass}`}>{view ?? "ohne Einstufung"}</span>
      </p>
      <p className="mt-1">
        <span className="text-slate-400">Konfidenz: </span>
        <span className="text-slate-200">
          {analysis.confidence !== null && analysis.confidence !== undefined
            ? `${Math.round(analysis.confidence * 100)} %`
            : "nicht protokolliert"}
        </span>
      </p>
      {analysis.thesis && (
        <p className="mt-2 whitespace-pre-wrap rounded bg-slate-950/60 p-2 text-slate-200">{analysis.thesis}</p>
      )}
    </div>
  );
}

function TraceFacts({ entry }: { entry: ProtocolEntryLike }) {
  const trace = entry.trace;
  if (!trace) return null;
  const latency = formatDuration(trace.latencyMs ?? null);
  const modelHint = trace.model ? describeModel(trace.model) : null;
  const rows: { label: string; value: string; hint?: string }[] = [
    { label: "Quelle", value: sourceLabel(entry), hint: "ollama = lokales Modell, fallback = deterministische Regel-Engine." },
    { label: "KI-Modell", value: trace.model ?? "nicht protokolliert", hint: modelHint ?? undefined },
    { label: "Antwortzeit", value: latency ?? "nicht protokolliert" },
  ];
  if (trace.provider) rows.push({ label: "Provider", value: trace.provider });

  return (
    <dl className="rounded-lg border border-slate-800 bg-slate-950/30 px-3 py-2">
      <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Ausführung (Trace)</h4>
      {rows.map((row) => (
        <div
          key={row.label}
          className="grid grid-cols-1 gap-1 border-b border-slate-800/60 py-1.5 last:border-0 sm:grid-cols-[minmax(9rem,14rem)_1fr] sm:gap-3"
        >
          <dt className="text-[11px] uppercase tracking-wide text-slate-400">{row.label}</dt>
          <dd className="min-w-0 break-words text-slate-200">
            {row.value}
            {row.hint && <span className="mt-0.5 block text-[11px] text-slate-500">{row.hint}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function ProtocolRow({
  entry,
  isOpen,
  onToggle,
}: {
  entry: ProtocolEntryLike;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const [tab, setTab] = useState<"details" | "raw">("details");
  const content = entry.content?.trim() ?? "";

  return (
    <li className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/50">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isOpen}
        className="flex w-full items-start gap-3 px-3 py-2 text-left transition hover:bg-slate-800/40"
      >
        <span className={`mt-0.5 shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase ${decisionBadgeClass(entry)}`}>
          {decisionLabel(entry)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-xs font-semibold text-slate-100">{actorName(entry)}</span>
            <span className="text-[11px] text-slate-500">{actorRole(entry)}</span>
            <span className="text-[10px] text-slate-600">{protocolKindLabel(entry.kind)}</span>
          </span>
          <span className="mt-0.5 block break-words text-xs text-slate-300">{summarizeProtocolEntry(entry)}</span>
        </span>
        <span className="shrink-0 text-right">
          <span className="block whitespace-nowrap text-[11px] tabular-nums text-slate-300">
            {formatTimestampUtc(entry.at)}
          </span>
          <span className="block whitespace-nowrap text-[10px] text-slate-500">{formatRelative(entry.at)}</span>
        </span>
        <span aria-hidden="true" className="mt-1 shrink-0 text-slate-500">
          {isOpen ? "▾" : "▸"}
        </span>
      </button>

      {isOpen && (
        <div className="space-y-3 border-t border-slate-800 px-3 py-3">
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
              <DecisionFacts entry={entry} />
              <AnalysisFacts entry={entry} />
              <TraceFacts entry={entry} />

              <div className="rounded-lg border border-slate-800 bg-slate-950/30 px-3 py-2">
                <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  Vollständiger Inhalt ({entry.messageType})
                </h4>
                <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-slate-300">
                  {content || "Für diesen historischen Eintrag ist kein Text gespeichert."}
                </p>
                {content.length >= 500 && (
                  <p className="mt-1 text-[11px] text-slate-500">
                    Hinweis: Text ohne Entscheidungs-JSON wird von der Engine auf 500 Zeichen begrenzt
                    gespeichert (src/lib/engine.ts) — der Schluss kann deshalb fehlen.
                  </p>
                )}
              </div>

              {entry.trace?.rawResponse && (
                <details className="rounded-lg border border-slate-800 bg-slate-950/30 px-3 py-2">
                  <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                    Rohe Modellantwort
                  </summary>
                  <p className="mt-1 text-[11px] text-slate-500">
                    So hat das Modell geantwortet — ungeparst. Die Engine speichert maximal 2.000 Zeichen;
                    endet der Text mitten im Wort, wurde er beim Speichern gekürzt, nicht beim Parsen.
                  </p>
                  <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-950/60 p-2 font-mono text-[11px] leading-relaxed text-slate-300">
                    {entry.trace.rawResponse}
                  </pre>
                </details>
              )}

              {entry.trace?.prompt && (
                <details className="rounded-lg border border-slate-800 bg-slate-950/30 px-3 py-2">
                  <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                    Vollständiger Prompt
                  </summary>
                  <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-950/60 p-2 font-mono text-[11px] leading-relaxed text-slate-300">
                    {entry.trace.prompt}
                  </pre>
                </details>
              )}
            </div>
          ) : (
            <div>
              <p className="mb-1 text-[11px] text-slate-500">
                Vollständige Zeile aus <code>agent_messages</code> inklusive <code>meta</code> — ungekürzt.
              </p>
              <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-slate-800 bg-slate-950/60 p-3 font-mono text-[11px] leading-relaxed text-slate-300">
                {protocolRawJson(entry)}
              </pre>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

export function ProtocolList({
  entries,
  loading,
  emptyText = "Noch keine Protokolleinträge. Pipeline, Markt-Tick oder Analystenzyklus starten.",
  initialOpen,
}: {
  entries: ProtocolEntryLike[];
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

  const allOpen = entries.length > 0 && entries.every((entry) => open.has(entry.id));

  return (
    <div className="space-y-2">
      {entries.length > 0 && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => setOpen(allOpen ? new Set() : new Set(entries.map((entry) => entry.id)))}
            className="rounded-md border border-slate-700 bg-slate-800 px-2 py-0.5 text-[11px] font-semibold text-slate-200 transition hover:bg-slate-700"
          >
            {allOpen ? "Alle zuklappen" : "Alle aufklappen"}
          </button>
        </div>
      )}

      {loading && entries.length === 0 ? (
        <p className="rounded-xl border border-slate-800 bg-slate-900/50 px-4 py-6 text-sm text-slate-400">Lade Protokoll…</p>
      ) : entries.length === 0 ? (
        <p className="rounded-xl border border-slate-800 bg-slate-900/50 px-4 py-6 text-sm text-slate-400">{emptyText}</p>
      ) : (
        <ul className="space-y-2">
          {entries.map((entry) => (
            <ProtocolRow key={entry.id} entry={entry} isOpen={open.has(entry.id)} onToggle={() => toggle(entry.id)} />
          ))}
        </ul>
      )}
    </div>
  );
}

export default ProtocolList;
