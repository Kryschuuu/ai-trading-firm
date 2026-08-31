"use client";

import { useRef, useState } from "react";
import InfoTip from "./InfoTip";
import { apiFetch, readJson } from "@/lib/apiClient";
import { missionScopeLabel } from "@/lib/missionTemplates";
import type { AgentRow, MissionRow, RunTurnResponse, TurnResultDto } from "@/lib/types";
import {
  aggregateOutcomes,
  classifyTurnOutcome,
  JSON_DEBUG_TIPS,
  OUTCOME_CATEGORIES,
  type OutcomeCategory,
} from "@/lib/workshop";

/**
 * Schritt 4 (Handbuch 6.4): Testschleife — ersetzt die for/i-Schleife mit
 * curl | jq. Läuft sequenziell (ein Agent, ein Turn nach dem anderen),
 * klassifiziert jedes Ergebnis mit derselben Logik wie die Tests
 * (classifyTurnOutcome) und zeigt die Verteilung live als Balken.
 */

const MAX_RUNS = 20;
const DEFAULT_RUNS = 10;

type SingleRun = {
  index: number;
  category: OutcomeCategory;
  status: string;
  reason: string;
  latencyMs: number | null;
  result: TurnResultDto | null;
  error: string;
};

const CATEGORY_STYLE: Record<OutcomeCategory, { label: string; bar: string; text: string; help: string }> = {
  TRADE: { label: "TRADE", bar: "bg-emerald-500", text: "text-emerald-300", help: "Der Agent hat einen konkreten Ordervorschlag geliefert (type=TRADE)." },
  HOLD: { label: "HOLD", bar: "bg-slate-500", text: "text-slate-300", help: "Bewusste Entscheidung gegen den Trade — gewolltes Verhalten bei unklarer Lage." },
  INVALID_JSON: { label: "HOLD · kaputtes JSON", bar: "bg-amber-500", text: "text-amber-300", help: "HOLD, weil die Modellantwort kein gültiges JSON war. Häuft sich das, liefert das Modell Müll — Debugging-Tipps beachten." },
  ERROR: { label: "ERROR", bar: "bg-red-500", text: "text-red-300", help: "API- oder Laufzeitfehler (z. B. Rate-Limit, Modellserver nicht erreichbar). Kein Trading-Ergebnis." },
  OTHER: { label: "ANDERE (REPORT/KILL/…)", bar: "bg-sky-500", text: "text-sky-300", help: "Prozessstimmen wie REPORT, APPROVE, REJECT oder KILL — normal für CEO/Risk/Approver." },
};

export default function HitRatePanel({
  agents,
  missions,
  onUnauthorized,
  onOpenProtocol,
}: {
  agents: AgentRow[];
  missions: MissionRow[];
  onUnauthorized: () => void;
  onOpenProtocol: () => void;
}) {
  const runnable = missions.filter((m) => m.status !== "KILLED");
  // Explizite Auswahl + abgeleitete Vorauswahl (siehe AgentRunPanel).
  const [agentId, setAgentId] = useState("");
  const [missionId, setMissionId] = useState("");
  const effAgentId = agentId || agents[0]?.id || "";
  const effMissionId = missionId || runnable[0]?.id || "";
  const [runsPlanned, setRunsPlanned] = useState(DEFAULT_RUNS);
  const [runs, setRuns] = useState<SingleRun[]>([]);
  const [phase, setPhase] = useState<"idle" | "running" | "done">("idle");
  const [loopError, setLoopError] = useState("");
  const stopRef = useRef(false);
  const failuresRef = useRef<HTMLDivElement | null>(null);

  const stats = aggregateOutcomes(runs.map((r) => r.category));
  const failures = runs.filter((r) => r.category === "ERROR" || r.category === "INVALID_JSON");

  function stop() {
    stopRef.current = true;
  }

  async function startLoop() {
    if (!effAgentId || !effMissionId) {
      setLoopError("Bitte Agent und Mission auswählen.");
      return;
    }
    stopRef.current = false;
    setRuns([]);
    setLoopError("");
    setPhase("running");
    const collected: SingleRun[] = [];

    for (let i = 1; i <= runsPlanned; i++) {
      if (stopRef.current) break;
      const { res, data, error: err } = await readJson<RunTurnResponse>(
        await apiFetch("/api/firm/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agentId: effAgentId, missionId: effMissionId }),
        }),
        `Lauf ${i} fehlgeschlagen`
      );
      if (res.status === 401) {
        onUnauthorized();
        setPhase("idle");
        return;
      }
      if (res.status === 429) {
        setLoopError("Schreib-Rate-Limit erreicht (FIRM_RATE_LIMIT, Standard 60/60 s) — Schleife angehalten. Kurz warten, dann mit weniger Läufen fortsetzen.");
        break;
      }
      const category = classifyTurnOutcome({ ok: !err, error: err, result: data.result });
      collected.push({
        index: i,
        category,
        status: data.result?.status ?? "—",
        reason: data.result?.decision?.reason ?? err ?? "",
        latencyMs: data.result?.latencyMs ?? null,
        result: data.result ?? null,
        error: err,
      });
      setRuns([...collected]);
    }

    setPhase("done");
    if (failuresRef.current && collected.some((r) => r.category === "ERROR" || r.category === "INVALID_JSON")) {
      failuresRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }

  return (
    <div className="space-y-4">
      {/* ── Steuerung ────────────────────────────────────────────── */}
      <section aria-labelledby="hitrate-title" className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
        <div className="mb-1 flex items-center">
          <h3 id="hitrate-title" className="text-sm font-bold text-slate-100">Testschleife starten</h3>
          <InfoTip
            id="hitrate-title"
            label="Testschleife"
            text="Lässt EINEN Agenten mehrfach hintereinander gegen EINE Mission laufen und zählt die Entscheidungen — die Trefferquote aus Handbuch 6.4."
          />
        </div>
        <p className="mb-4 text-xs text-slate-500">
          Sequenziell, ein Turn nach dem anderen. Faustregel aus 6.1: pro Iteration genau eine Prompt-Änderung, dann erneut messen.
        </p>

        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <label htmlFor="hitrate-agent" className="mb-1 block text-xs font-semibold text-slate-300">
              Agent
              <InfoTip id="hitrate-agent" label="Agent" text="Ein Agent pro Test (Handbuch 6.1) — sonst weißt du nicht, welche Änderung welchen Effekt hatte." />
            </label>
            <select
              id="hitrate-agent"
              value={effAgentId}
              onChange={(e) => setAgentId(e.target.value)}
              disabled={phase === "running"}
              aria-describedby="hitrate-agent-tip"
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 disabled:opacity-50"
            >
              {agents.map((a) => (
                <option key={a.id} value={a.id}>{a.name} ({a.role})</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="hitrate-mission" className="mb-1 block text-xs font-semibold text-slate-300">
              Mission
              <InfoTip id="hitrate-mission" label="Mission" text="Der Auftrag für jeden Durchlauf. Gleiche Mission über alle Messungen, damit die Werte vergleichbar bleiben." />
            </label>
            <select
              id="hitrate-mission"
              value={effMissionId}
              onChange={(e) => setMissionId(e.target.value)}
              disabled={phase === "running"}
              aria-describedby="hitrate-mission-tip"
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 disabled:opacity-50"
            >
              {runnable.length === 0 && <option value="">— keine lauffähige Mission —</option>}
              {runnable.map((m) => (
                <option key={m.id} value={m.id}>{m.title} ({missionScopeLabel(m)})</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="hitrate-runs" className="mb-1 block text-xs font-semibold text-slate-300">
              Durchläufe
              <InfoTip id="hitrate-runs" label="Durchläufe" text="Standard 10 (Handbuch 6.4). Maximal 20, damit das Schreib-Rate-Limit (Standard 60/60 s) nicht zuschlägt." />
            </label>
            <input
              id="hitrate-runs"
              type="number"
              min={1}
              max={MAX_RUNS}
              value={runsPlanned}
              onChange={(e) => {
                const v = Number(e.target.value);
                setRunsPlanned(Math.max(1, Math.min(MAX_RUNS, Number.isFinite(v) ? Math.trunc(v) : DEFAULT_RUNS)));
              }}
              disabled={phase === "running"}
              aria-describedby="hitrate-runs-tip"
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 disabled:opacity-50"
            />
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          {phase !== "running" ? (
            <button
              onClick={() => void startLoop()}
              disabled={!effAgentId || !effMissionId}
              className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-bold text-white hover:bg-sky-500 disabled:opacity-50"
            >
              ▶ {runsPlanned}× messen
            </button>
          ) : (
            <button
              onClick={stop}
              className="rounded-lg border border-amber-600 bg-amber-500/10 px-4 py-2 text-sm font-bold text-amber-300 hover:bg-amber-500/20"
            >
              ⏹ Nach aktuellem Lauf stoppen
            </button>
          )}
          {runs.length > 0 && (
            <p aria-live="polite" className="text-xs text-slate-400">
              {phase === "running" ? "Läuft… " : "Fertig — "}
              {runs.length}/{runsPlanned} Durchläufen · live: {stats.counts.TRADE} TRADE · {stats.counts.HOLD} HOLD · {stats.counts.INVALID_JSON} kaputtes JSON · {stats.counts.ERROR} ERROR
            </p>
          )}
        </div>

        {loopError && (
          <p role="alert" className="mt-3 rounded-lg border border-red-800 bg-red-950/50 px-3 py-2 text-xs text-red-300">
            ✖ {loopError}
          </p>
        )}
      </section>

      {/* ── Balkendiagramm ───────────────────────────────────────── */}
      <section aria-labelledby="hitrate-chart-title" className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
        <div className="mb-1 flex items-center">
          <h3 id="hitrate-chart-title" className="text-sm font-bold text-slate-100">
            Verteilung {phase === "running" ? "(live)" : runs.length > 0 ? "(Endergebnis)" : ""}
          </h3>
          <InfoTip
            id="hitrate-chart-title"
            label="Verteilung"
            text="Anteil der Entscheidungen über alle Durchläufe. TRADE vs. HOLD ist die Kernfrage; „kaputtes JSON“ und ERROR sind Qualitätsprobleme, keine Entscheidungen."
          />
        </div>
        {runs.length === 0 ? (
          <p className="text-xs text-slate-500">Noch keine Messung — oben starten.</p>
        ) : (
          <>
            <p className="mb-3 text-xs text-slate-400">
              {runs.length} Durchläufe · TRADE-Anteil <strong className="text-emerald-300">{stats.pct.TRADE} %</strong> · HOLD-Anteil {stats.pct.HOLD} %
            </p>
            <div className="space-y-2" role="img" aria-label={`Balkendiagramm: ${OUTCOME_CATEGORIES.map((c) => `${CATEGORY_STYLE[c].label} ${stats.counts[c]} von ${runs.length} (${stats.pct[c]} Prozent)`).join(", ")}`}>
              {OUTCOME_CATEGORIES.map((cat) => {
                const style = CATEGORY_STYLE[cat];
                return (
                  <div key={cat} className="flex items-center gap-2">
                    <span className="flex w-36 shrink-0 items-center text-[11px] font-semibold text-slate-400" title={style.help}>
                      {style.label}
                      <InfoTip id={`bar-${cat}`} label={style.label} text={style.help} />
                    </span>
                    <div className="h-5 flex-1 overflow-hidden rounded bg-slate-950" aria-hidden="true">
                      <div
                        className={`h-full ${style.bar} transition-all duration-500`}
                        style={{ width: `${Math.max(stats.pct[cat], stats.counts[cat] > 0 ? 2 : 0)}%` }}
                      />
                    </div>
                    <span className={`w-24 shrink-0 text-right text-[11px] font-bold ${style.text}`}>
                      {stats.counts[cat]} · {stats.pct[cat]} %
                    </span>
                  </div>
                );
              })}
            </div>
          </>
        )}

        {stats.showJsonTips && (
          <div className="mt-4 rounded-lg border border-amber-700 bg-amber-950/30 p-3">
            <p className="text-xs font-bold text-amber-300">
              ⚠ „HOLD · kaputtes JSON“ häuft sich ({stats.counts.INVALID_JSON} von {stats.total} = {stats.pct.INVALID_JSON} %) — dein Modell liefert unlesbares JSON. Dann:
            </p>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-[11px] leading-relaxed text-amber-200">
              {JSON_DEBUG_TIPS.map((tip) => (
                <li key={tip}>{tip}</li>
              ))}
            </ol>
          </div>
        )}
      </section>

      {/* ── Läufe + Fehlschläge ──────────────────────────────────── */}
      <section ref={failuresRef} aria-labelledby="hitrate-runs-title" className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <h3 id="hitrate-runs-title" className="text-sm font-bold text-slate-100">Einzelne Läufe</h3>
          <InfoTip
            id="hitrate-runs-title"
            label="Einzelne Läufe"
            text="Jeder Durchlauf mit Status, Begründung und Latenz. Aufklappen für die vollständige Entscheidungskette."
          />
          {failures.length > 0 && (
            <button
              onClick={onOpenProtocol}
              className="ml-auto rounded border border-red-700 px-2.5 py-1 text-[11px] font-semibold text-red-300 hover:bg-red-500/10"
              aria-label="Fehlgeschlagene Läufe im Protokoll-Tab nachschlagen"
            >
              ↗ {failures.length} Fehlschläge im Protokoll nachschlagen
            </button>
          )}
        </div>
        {runs.length === 0 ? (
          <p className="text-xs text-slate-500">Die Läufe erscheinen hier während der Messung.</p>
        ) : (
          <ul className="space-y-2">
            {runs.map((r) => {
              const style = CATEGORY_STYLE[r.category];
              return (
                <li
                  key={r.index}
                  className={`rounded-lg border px-3 py-2 ${
                    r.category === "ERROR" || r.category === "INVALID_JSON"
                      ? "border-red-900/60 bg-red-950/20"
                      : "border-slate-800 bg-slate-950/40"
                  }`}
                >
                  <details>
                    <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-xs">
                      <span className="font-mono text-slate-500">#{r.index}</span>
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${style.text}`}>{style.label}</span>
                      <span className="text-slate-400">{r.status}</span>
                      {r.latencyMs != null && (
                        <span className="text-[11px] text-slate-500">{(r.latencyMs / 1000).toFixed(1)} s</span>
                      )}
                      <span className="ml-auto max-w-full truncate text-[11px] text-slate-500">{r.reason}</span>
                    </summary>
                    <div className="mt-2 space-y-2">
                      {r.error && (
                        <p className="rounded border border-red-800 bg-red-950/40 px-2 py-1.5 text-[11px] text-red-300">Fehler: {r.error}</p>
                      )}
                      {r.result && (
                        <>
                          <pre className="overflow-x-auto rounded bg-slate-950 p-2 font-mono text-[11px] text-emerald-300">
                            {JSON.stringify(r.result.decision, null, 2)}
                          </pre>
                          {r.result.trace && r.result.trace.length > 0 && (
                            <ul className="space-y-0.5">
                              {r.result.trace.map((t, i) => (
                                <li key={i} className={`text-[11px] ${t.ok ? "text-emerald-300" : "text-red-300"}`}>
                                  {t.ok ? "✔" : "✖"} {t.layer}: {t.detail}
                                </li>
                              ))}
                            </ul>
                          )}
                        </>
                      )}
                    </div>
                  </details>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
