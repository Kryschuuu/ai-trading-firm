"use client";

import { useMemo, useState } from "react";
import InfoTip from "./InfoTip";
import { apiFetch, readJson } from "@/lib/apiClient";
import type { AgentPromptResponse, AgentRow } from "@/lib/types";

/**
 * Schritt 3 (Handbuch 6.3): system_prompt eines Agenten in der UI ändern —
 * ersetzt das psql-UPDATE auf agents. Änderungen wirken sofort (Prompts
 * stehen in der DB); Guardrails bleiben unberührt, weil sie im Code leben.
 */

/** Das Antwortformat aus Handbuch 6.3 — unverändert. */
const JSON_FORMAT_SPEC =
  '{"type":"TRADE"|"HOLD","symbol":"<SYMBOL>","side":"LONG","stopLossPct":<2-10>,"reason":"<max 20 Wörter>","riskScore":<0.0-1.0>}';

const JSON_FORMAT_EXAMPLE =
  '{"type":"TRADE","symbol":"ETH","side":"LONG","stopLossPct":5,"reason":"Kurs über 20-Tage-Linie, RSI neutral, ATR stützt Stop","riskScore":0.35}';

const FORMAT_FIELDS: { name: string; help: string }[] = [
  { name: "type", help: "TRADE = konkreter Ordervorschlag, HOLD = bewusst nicht handeln. Andere Typen (REPORT, APPROVE, REJECT, KILL) nutzen CEO/Risk/Approver." },
  { name: "symbol", help: "Instrument aus der Paper-Broker-Liste (BTC, ETH, SOL, SPY, QQQ, NVDA, AAPL, MSFT). Ungültige Symbole werden abgelehnt." },
  { name: "side", help: "Richtung: LONG = Kauf. Shorts sind standardmäßig gesperrt — im Prompt „side ist immer LONG“ verankern." },
  { name: "stopLossPct", help: "Stop-Abstand in Prozent, erlaubt 2–10. Pflicht bei TRADE; kleinere Werte = größere Position bei gleichem Risiko." },
  { name: "reason", help: "Kurzbegründung mit harten Fakten (Indikator, Lage), max. ~20 Wörter. Erkenntlich in agent_messages und Audit-Log." },
  { name: "riskScore", help: "Eigene Unsicherheitseinschätzung 0.0 (sicher) bis 1.0 (sehr unsicher). Ein hoher Score ist kein Fehler — Raten ist der Fehler." },
];

export default function PromptPanel({
  agents,
  onChanged,
  onUnauthorized,
}: {
  agents: AgentRow[];
  onChanged: () => void;
  onUnauthorized: () => void;
}) {
  // Explizite Auswahl ("" = noch nichts gewählt) + abgeleitete Vorauswahl.
  const [agentId, setAgentId] = useState("");
  const effAgentId = agentId || agents[0]?.id || "";
  // draft === null → unverändert: der Prompt des gewählten Agenten aus dem
  // Firmzustand wird angezeigt. `agents` refresht alle paar Sekunden — ein
  // laufender Edit (draft !== null) wird absichtlich NICHT überschrieben.
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [okMsg, setOkMsg] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);

  const agent = useMemo(() => agents.find((a) => a.id === effAgentId) ?? null, [agents, effAgentId]);
  const prompt = draft ?? agent?.systemPrompt ?? "";
  const dirty = draft !== null && prompt !== (agent?.systemPrompt ?? "");

  function selectAgent(id: string) {
    setAgentId(id);
    setDraft(null);
    setError("");
    setOkMsg("");
    setWarnings([]);
  }

  async function save() {
    if (!agent || !effAgentId) return;
    setError("");
    setOkMsg("");
    setWarnings([]);
    const trimmed = prompt.trim();
    if (trimmed.length < 20) {
      setError("systemPrompt: mindestens 20 Zeichen — ein leerer Prompt liefert nur Rauschen.");
      return;
    }
    setSaving(true);
    const { res, data, error: err } = await readJson<AgentPromptResponse>(
      await apiFetch("/api/firm/agents", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: effAgentId, systemPrompt: trimmed }),
      }),
      "Prompt konnte nicht gespeichert werden"
    );
    setSaving(false);
    if (res.status === 401) {
      onUnauthorized();
      return;
    }
    if (err) {
      setError(err);
      return;
    }
    setDraft(data.agent?.systemPrompt ?? trimmed);
    setOkMsg(`✔ Gespeichert (Datenbank, ${new Date().toLocaleTimeString("de-DE")}) — wirkt ab dem nächsten Turn, kein Neubau nötig.`);
    setWarnings(data.warnings ?? []);
    onChanged();
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {/* ── Editor ───────────────────────────────────────────────── */}
      <section aria-labelledby="prompt-title" className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
        <div className="mb-1 flex items-center">
          <h3 id="prompt-title" className="text-sm font-bold text-slate-100">System-Prompt bearbeiten</h3>
          <InfoTip
            id="prompt-title"
            label="System-Prompt"
            text="Die standinge Anweisung einer Rolle. Steht in der Datenbank (agents.system_prompt) und geht jedem Turn voran — hier gehört das Antwortformat hinein."
          />
        </div>
        <p className="mb-4 text-xs text-slate-500">PUT <code className="font-mono">/api/firm/agents</code> mit <code className="font-mono">{`{agentId, systemPrompt}`}</code></p>

        <div className="mb-4">
          <label htmlFor="prompt-agent" className="mb-1 block text-xs font-semibold text-slate-300">
            Agent
            <InfoTip
              id="prompt-agent"
              label="Agentenauswahl"
              text="Eine Rolle pro Iteration (Handbuch 6.1): erst einen Agenten stabil bekommen, dann zum nächsten."
            />
          </label>
          <select
            id="prompt-agent"
            value={effAgentId}
            onChange={(e) => selectAgent(e.target.value)}
            aria-describedby="prompt-agent-tip"
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
          >
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.role})
              </option>
            ))}
          </select>
          {agent && (
            <p className="mt-1 text-[11px] text-slate-500">
              Modell: <code className="font-mono">{agent.model}</code> · geändert: {new Date(agent.updatedAt).toLocaleString("de-DE")}
            </p>
          )}
        </div>

        <div className="mb-2 flex items-center">
          <label htmlFor="prompt-text" className="block text-xs font-semibold text-slate-300">
            system_prompt
            <InfoTip
              id="prompt-text"
              label="Prompt-Editor"
              text="Änderungen wirken sofort — Prompts stehen in der Datenbank, kein Neubau nötig. Guardrails dagegen brauchen einen Neubau: weiche vs. harte Schicht."
            />
          </label>
          <span className="ml-auto text-[11px] text-slate-500">{prompt.trim().length}/8000</span>
        </div>
        <textarea
          id="prompt-text"
          value={prompt}
          onChange={(e) => {
            setDraft(e.target.value);
            setOkMsg("");
          }}
          rows={14}
          maxLength={8000}
          spellCheck={false}
          aria-describedby="prompt-text-tip"
          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs leading-relaxed text-slate-100 focus:border-sky-500 focus:outline-none"
        />

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            onClick={() => void save()}
            disabled={saving || !agent}
            className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-bold text-white hover:bg-sky-500 disabled:opacity-50"
          >
            {saving ? "Speichern…" : "Prompt speichern"}
          </button>
          <button
            onClick={() => {
              setDraft(null);
              setOkMsg("");
              setError("");
              setWarnings([]);
            }}
            disabled={!dirty}
            className="rounded-lg border border-slate-600 px-3 py-2 text-xs font-semibold text-slate-300 hover:bg-slate-800 disabled:opacity-40"
          >
            Zurücksetzen
          </button>
          {dirty && <span className="text-[11px] text-amber-300">ungespeicherte Änderungen</span>}
        </div>

        <div aria-live="polite" className="mt-3 space-y-2">
          {error && (
            <p role="alert" className="rounded-lg border border-red-800 bg-red-950/50 px-3 py-2 text-xs text-red-300">
              ✖ {error}
            </p>
          )}
          {okMsg && (
            <p role="status" className="rounded-lg border border-emerald-700 bg-emerald-950/60 px-3 py-2 text-xs font-semibold text-emerald-300">
              {okMsg}
            </p>
          )}
          {warnings.map((w) => (
            <p key={w} className="rounded-lg border border-amber-800 bg-amber-950/40 px-3 py-2 text-xs text-amber-300">
              ⚠ {w}
            </p>
          ))}
        </div>
      </section>

      {/* ── Format-Hilfe ─────────────────────────────────────────── */}
      <section aria-labelledby="prompt-format-title" className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
        <div className="mb-1 flex items-center">
          <h3 id="prompt-format-title" className="text-sm font-bold text-slate-100">Das Antwortformat (JSON)</h3>
          <InfoTip
            id="prompt-format-title"
            label="Antwortformat"
            text="Der Prompt muss das exakte JSON-Format vorgeben — kein Fließtext, keine Code-Fences. Unlesbare Antworten werden zu HOLD, nie zu einem Trade."
          />
        </div>
        <p className="mb-3 text-xs text-slate-400">
          Das Soll-Format für RESEARCH/EXECUTOR — vollständig und unverändert in den Prompt übernehmen:
        </p>
        <pre className="overflow-x-auto rounded-lg border border-slate-800 bg-slate-950 p-3 font-mono text-[11px] leading-relaxed text-emerald-300">
{JSON_FORMAT_SPEC}
        </pre>
        <p className="mb-2 mt-4 text-xs font-semibold text-slate-300">Vollständiges Beispiel:</p>
        <pre className="overflow-x-auto rounded-lg border border-emerald-900/60 bg-emerald-950/20 p-3 font-mono text-[11px] leading-relaxed text-emerald-200">
{JSON_FORMAT_EXAMPLE}
        </pre>
        <button
          onClick={() => {
            setDraft((p) =>
              (p ?? "").includes(JSON_FORMAT_EXAMPLE)
                ? p
                : `${(p ?? agent?.systemPrompt ?? "").trimEnd()}\n\nANTWORTFORMAT — ausschließlich dieses JSON, kein Fließtext, keine Code-Fences:\n${JSON_FORMAT_EXAMPLE}\n`
            );
            setOkMsg("");
          }}
          className="mt-2 rounded border border-emerald-700 px-2.5 py-1.5 text-[11px] font-semibold text-emerald-300 hover:bg-emerald-500/10"
          aria-label="Beispiel-JSON an den Prompt anhängen"
        >
          + Beispiel an Prompt anhängen
        </button>

        <dl className="mt-5 space-y-2">
          {FORMAT_FIELDS.map((f) => (
            <div key={f.name} className="rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2">
              <dt className="flex items-center text-xs font-bold text-slate-200">
                <code className="font-mono text-sky-300">{f.name}</code>
                <InfoTip id={`fmt-${f.name}`} label={f.name} text={f.help} />
              </dt>
              <dd className="mt-0.5 text-[11px] leading-snug text-slate-400">{f.help}</dd>
            </div>
          ))}
        </dl>

        <p className="mt-4 rounded-lg border border-sky-800/60 bg-sky-500/5 px-3 py-2 text-[11px] leading-relaxed text-sky-200">
          <strong>Regeln für gute Prompts:</strong> side ist immer „LONG“ (Shorts gesperrt) · stopLossPct zwischen 2 und 10 ·
          bei unklarer Lage <code className="font-mono">{"{\"type\":\"HOLD\"}"}</code> · niemals Kurse oder Kennzahlen erfinden ·
          keine Erklärung außerhalb des JSON.
        </p>
      </section>
    </div>
  );
}
