"use client";

import { useCallback, useEffect, useState } from "react";
import InfoTip from "./InfoTip";
import { apiFetch, readJson } from "@/lib/apiClient";
import { missionScopeLabel } from "@/lib/missionTemplates";
import type {
  AgentDecisionDto,
  AgentRow,
  LogResponse,
  MissionRow,
  RunTurnResponse,
  TurnResultDto,
} from "@/lib/types";

/**
 * Schritt 2 (Handbuch 6.2): EINEN Agenten gegen EINE Mission laufen lassen
 * und die Antwort prüfen — ersetzt das psql-SELECT auf agent_messages.
 * Zeigt das geparste Decision-JSON formatiert plus die letzten 3 echten
 * Agenten-Turns mit Quelle und Latenz. Analysten- und Systemmeldungen stehen
 * bewusst separat und lesbar im Protokoll-Tab.
 */

const SOURCE_LABEL: Record<string, string> = {
  ollama: "Modell (ollama-kompatibel)",
  fallback: "Regel-Engine (Fallback)",
};

/** API normalisiert Latenzen auf Zahl|null; defensiv bleibt die UI trotzdem NaN-frei. */
function formatLatency(latencyMs: number | null | undefined): string {
  return typeof latencyMs === "number" && Number.isFinite(latencyMs) && latencyMs >= 0
    ? `${(latencyMs / 1000).toFixed(1)} s`
    : "—";
}

function DecisionField({
  name,
  value,
  help,
}: {
  name: string;
  value: string;
  help: string;
}) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2">
      <div className="flex items-center">
        <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{name}</span>
        <InfoTip id={`dec-${name}`} label={name} text={help} />
      </div>
      <p className="mt-0.5 font-mono text-sm text-slate-100">{value}</p>
    </div>
  );
}

export default function AgentRunPanel({
  agents,
  missions,
  onUnauthorized,
}: {
  agents: AgentRow[];
  missions: MissionRow[];
  onUnauthorized: () => void;
}) {
  const runnable = missions.filter((m) => m.status !== "KILLED");
  // Explizite Auswahl (leer = noch nichts gewählt) …
  const [agentId, setAgentId] = useState("");
  const [missionId, setMissionId] = useState("");
  // … Vorauswahl als abgeleitete Werte (keine setState-Effekte nötig):
  // explizite Auswahl sonst erster Agent / erste lauffähige Mission.
  const effAgentId = agentId || agents[0]?.id || "";
  const effMissionId = missionId || runnable[0]?.id || "";
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<TurnResultDto | null>(null);
  const [error, setError] = useState("");
  const [lastMessages, setLastMessages] = useState<LogResponse["turns"]>([]);
  const [showRaw, setShowRaw] = useState(false);

  const loadLastMessages = useCallback(async () => {
    try {
      const res = await fetch("/api/firm/log?limit=3");
      const json = (await res.json()) as LogResponse;
      if (res.ok && json.ok) setLastMessages(json.turns.slice(0, 3));
    } catch {
      /* Protokoll ist optionaler Kontext */
    }
  }, []);

  // Initial-Laden um einen Tick versetzt (Konvention siehe FirmDashboard) —
  // kein synchrones setState im Effekt.
  useEffect(() => {
    const id = window.setTimeout(() => void loadLastMessages(), 0);
    return () => window.clearTimeout(id);
  }, [loadLastMessages]);

  async function runTurn() {
    if (!effAgentId || !effMissionId) {
      setError("Bitte Agent und Mission auswählen.");
      return;
    }
    setRunning(true);
    setError("");
    setResult(null);
    setShowRaw(false);
    const { res, data, error: err } = await readJson<RunTurnResponse>(
      await apiFetch("/api/firm/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: effAgentId, missionId: effMissionId }),
      }),
      "Agenten-Turn fehlgeschlagen"
    );
    setRunning(false);
    if (res.status === 401) {
      onUnauthorized();
      return;
    }
    if (err) {
      setError(err);
      return;
    }
    if (data.result) setResult(data.result);
    void loadLastMessages();
  }

  const decision: AgentDecisionDto | null = result?.decision ?? null;
  const agent = agents.find((a) => a.id === effAgentId);
  const mission = missions.find((m) => m.id === effMissionId);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {/* ── Steuerung + Ergebnis ─────────────────────────────────── */}
      <section aria-labelledby="run-title" className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
        <div className="mb-1 flex items-center">
          <h3 id="run-title" className="text-sm font-bold text-slate-100">Agent einzeln ausführen</h3>
          <InfoTip
            id="run-title"
            label="Agent einzeln ausführen"
            text="Genau ein Agent, ein Turn — der Weg zum Prompt-Debuggen (Handbuch 6.1). Niemals die ganze Pipeline zum Debuggen starten."
          />
        </div>
        <p className="mb-4 text-xs text-slate-500">POST <code className="font-mono">/api/firm/run</code> mit <code className="font-mono">{`{agentId, missionId}`}</code></p>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="run-agent" className="mb-1 block text-xs font-semibold text-slate-300">
              Agent
              <InfoTip
                id="run-agent"
                label="Agent"
                text="Die Rolle bestimmt das Mandat: Nur RESEARCH und EXECUTOR dürfen handeln — im Code erzwungen, nicht im Prompt."
              />
            </label>
            <select
              id="run-agent"
              value={effAgentId}
              onChange={(e) => setAgentId(e.target.value)}
              aria-describedby="run-agent-tip"
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
            >
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.role})
                </option>
              ))}
            </select>
            {agent && <p className="mt-1 text-[11px] text-slate-500">Modell: <code className="font-mono">{agent.model}</code> · Status: {agent.status}</p>}
          </div>
          <div>
            <label htmlFor="run-mission" className="mb-1 block text-xs font-semibold text-slate-300">
              Mission
              <InfoTip
                id="run-mission"
                label="Mission"
                text="Der Auftrag, dessen Ziel und Universum dem Agenten als Kontext in den Prompt wandern: Einzel-Symbol oder Markt-Scan (Segment-Kandidaten). Gestoppte (KILLED) Missionen laufen nicht."
              />
            </label>
            <select
              id="run-mission"
              value={effMissionId}
              onChange={(e) => setMissionId(e.target.value)}
              aria-describedby="run-mission-tip"
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
            >
              {runnable.length === 0 && <option value="">— keine lauffähige Mission —</option>}
              {runnable.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.title} ({missionScopeLabel(m)})
                </option>
              ))}
            </select>
            {mission && <p className="mt-1 text-[11px] text-slate-500">Ziel: {mission.objective.slice(0, 60)}{mission.objective.length > 60 ? "…" : ""}</p>}
          </div>
        </div>

        <button
          onClick={() => void runTurn()}
          disabled={running || !effAgentId || !effMissionId}
          className="mt-4 rounded-lg bg-sky-600 px-4 py-2 text-sm font-bold text-white hover:bg-sky-500 disabled:opacity-50"
        >
          {running ? "Agent denkt… (Dauer modellabhängig)" : "▶ Turn starten"}
        </button>

        <div aria-live="polite" className="mt-4 space-y-3">
          {error && (
            <p role="alert" className="rounded-lg border border-red-800 bg-red-950/50 px-3 py-2 text-xs text-red-300">
              ✖ {error}
            </p>
          )}
          {running && (
            <p className="rounded-lg border border-sky-800 bg-sky-950/40 px-3 py-2 text-xs text-sky-300">
              ⏳ Turn läuft — lokale Modelle brauchen oft 20–60 s pro Antwort.
            </p>
          )}
          {result && (
            <div className="space-y-3 rounded-lg border border-slate-700 bg-slate-950/40 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`rounded px-2 py-0.5 text-[11px] font-bold ${
                    result.status === "EXECUTED" ? "bg-emerald-500/20 text-emerald-300"
                    : result.status === "BLOCKED" ? "bg-red-500/20 text-red-300"
                    : "bg-slate-600/40 text-slate-200"
                  }`}
                >
                  {result.status}
                </span>
                <span className="text-[11px] text-slate-500">
                  {SOURCE_LABEL[result.source] ?? result.source} · Modell <code className="font-mono">{result.model}</code> · {formatLatency(result.latencyMs)}
                </span>
                {result.guardrail && (
                  <span className="rounded bg-amber-500/15 px-2 py-0.5 text-[11px] font-semibold text-amber-300">
                    Guardrail: {result.guardrail}
                  </span>
                )}
              </div>

              {decision && (
                <div className="grid gap-2 sm:grid-cols-2">
                  <DecisionField
                    name="type"
                    value={decision.type}
                    help="Entscheidungstyp: TRADE (Ordervorschlag), HOLD (nicht handeln), REPORT/APPROVE/REJECT (Prozessstimme), KILL (Not-Halt-Anforderung)."
                  />
                  <DecisionField
                    name="symbol"
                    value={decision.symbol ?? "—"}
                    help="Zu handelndes Instrument. Muss der Broker-Whitelist entsprechen, sonst wird die Order abgelehnt (INVALID_SYMBOL)."
                  />
                  <DecisionField
                    name="side"
                    value={decision.side ?? "—"}
                    help="Richtung der Position. LONG = Kauf (Wertsteigerung). SHORT wäre Leerverkauf — standardmäßig gesperrt."
                  />
                  <DecisionField
                    name="stopLossPct"
                    value={decision.stopLossPct != null ? `${decision.stopLossPct} %` : "—"}
                    help="Stop-Abstand in Prozent vom Einstieg. Pflichtfeld für TRADE; die Engine klemmt Modellwerte in einen sicheren Bereich und berechnet die Stückzahl daraus."
                  />
                  <DecisionField
                    name="riskScore"
                    value={decision.riskScore != null ? decision.riskScore.toFixed(2) : "—"}
                    help="Selbst eingeschätzte Unsicherheit des Modells von 0 (sicher) bis 1 (sehr unsicher). Fließt in Freigaben und Protokoll ein."
                  />
                  <DecisionField
                    name="reason"
                    value={decision.reason ?? "—"}
                    help="Kurzbegründung (max. ~20 Wörter empfohlen). Steht agent_messages.content — genau das, was du im Protokoll nachlesen kannst."
                  />
                </div>
              )}

              {result.trace && result.trace.length > 0 && (
                <details>
                  <summary className="cursor-pointer text-xs font-semibold text-slate-400">
                    Entscheidungskette ({result.trace.length} Schichten)
                  </summary>
                  <ul className="mt-2 space-y-1">
                    {result.trace.map((t, i) => (
                      <li key={i} className={`text-[11px] ${t.ok ? "text-emerald-300" : "text-red-300"}`}>
                        {t.ok ? "✔" : "✖"} {t.layer}: {t.detail}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
        </div>
      </section>

      {/* ── Letzte 3 echte Agenten-Turns ─────────────────────────── */}
      <section aria-labelledby="run-msgs-title" className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
        <div className="mb-1 flex items-center">
          <h3 id="run-msgs-title" className="text-sm font-bold text-slate-100">Letzte 3 Agenten-Turns</h3>
          <InfoTip
            id="run-msgs-title"
            label="Letzte Agenten-Turns"
            text="Die drei neuesten echten Entscheidungen aus agent_messages (Handbuch 6.2) — Name, Inhalt, Quelle und Latenz, automatisch formatiert. Analystenberichte stehen im Protokoll als eigene Kategorie."
          />
        </div>
        <p className="mb-4 text-xs text-slate-500">Quelle „Regel-Engine“ heißt: Es antwortet gerade kein Modell — du testest die Pipeline, nicht die KI.</p>

        {showRaw && result && (
          <pre className="mb-4 max-h-48 overflow-auto rounded-lg border border-slate-800 bg-slate-950 p-3 font-mono text-[11px] text-slate-400">
            {JSON.stringify(result, null, 2)}
          </pre>
        )}
        {result && (
          <button
            onClick={() => setShowRaw((v) => !v)}
            className="mb-4 rounded border border-slate-600 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800"
            aria-expanded={showRaw}
          >
            {showRaw ? "Rohdaten ausblenden" : "Rohdaten des Turns anzeigen (JSON)"}
          </button>
        )}

        {lastMessages.length === 0 ? (
          <p className="text-xs text-slate-500">Noch keine Nachrichten — links einen Turn starten.</p>
        ) : (
          <ol className="space-y-3">
            {lastMessages.map((t, i) => (
              <li key={t.id} className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-bold text-sky-300">#{i + 1}</span>
                  <span className="text-xs font-semibold text-slate-200">{t.agent}</span>
                  <span className="text-[11px] text-slate-500">{t.role}</span>
                  <span className="ml-auto text-[11px] text-slate-500">
                    {new Date(t.at).toLocaleTimeString("de-DE")} · {SOURCE_LABEL[t.source ?? ""] ?? t.source ?? "—"} · {formatLatency(t.latencyMs)}
                  </span>
                </div>
                <p className="mt-1.5 text-xs text-slate-300">{t.content ?? t.decision?.reason ?? "(leere Nachricht)"}</p>
                {t.decision && (
                  <details className="mt-1.5">
                    <summary className="cursor-pointer text-[11px] font-semibold text-slate-500">
                      Geparste Entscheidung: {t.decision.type}
                      {t.decision.symbol ? ` · ${t.decision.symbol}` : ""}
                      {t.decision.side ? ` · ${t.decision.side}` : ""}
                    </summary>
                    <pre className="mt-1 overflow-x-auto rounded bg-slate-950 p-2 font-mono text-[11px] text-emerald-300">
                      {JSON.stringify(t.decision, null, 2)}
                    </pre>
                    {t.rawResponse && (
                      <>
                        <p className="mt-1.5 text-[11px] font-semibold text-slate-500">Rohergebnis des Modells ({t.model ?? "Modell nicht protokolliert"}):</p>
                        <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-slate-950 p-2 font-mono text-[11px] text-slate-400">
                          {t.rawResponse}
                        </pre>
                      </>
                    )}
                  </details>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
