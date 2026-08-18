"use client";

import { useCallback, useEffect, useState } from "react";

type FirmData = {
  agents: any[];
  missions: any[];
  positions: any[];
  proposals: any[];
  auditLog: any[];
  riskLimits: Record<string, any>;
  riskConfig: Record<string, string>;
  killSwitchArmed: boolean;
  killSwitches: any[];
  ollama: { available: boolean; baseUrl: string; models: string[]; error?: string };
  account: {
    equity: number;
    startingEquity: number;
    freeCash: number;
    drawdownPct: number;
    openPositions: number;
    broker: string;
    paperMode: boolean;
    livePositions: any[];
  };
  brokers: Record<string, { label: string; assets: string; paperApi: boolean; openSource: boolean; note: string }>;
  requireHumanApproval: boolean;
  timestamp: string;
};

const defaultData: FirmData = {
  agents: [], missions: [], positions: [], proposals: [],
  auditLog: [], riskLimits: {}, riskConfig: {}, killSwitchArmed: false,
  killSwitches: [], ollama: { available: false, baseUrl: "", models: [] },
  account: {
    equity: 0, startingEquity: 0, freeCash: 0, drawdownPct: 0,
    openPositions: 0, broker: "PAPER", paperMode: true, livePositions: [],
  },
  brokers: {},
  requireHumanApproval: false,
  timestamp: "",
};

type Tab = "overview" | "agents" | "risk" | "architecture";

export default function FirmDashboard() {
  const [data, setData] = useState<FirmData>(defaultData);
  const [tab, setTab] = useState<Tab>("overview");
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/firm");
      const json = await res.json();
      setData(json);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // auto-refresh every 8s while running, else 15s
  useEffect(() => {
    const id = setInterval(load, data.missions.some((m) => m.status === "ACTIVE") ? 8000 : 15000);
    return () => clearInterval(id);
  }, [load, data.missions]);

  async function seed() {
    await fetch("/api/seed", { method: "POST" });
    setNotice("Firm seeded with default team + mission.");
    load();
  }

  async function runAgent(agentId: string) {
    const mission = data.missions.find((m) => m.status === "ACTIVE" || m.status === "PENDING");
    if (!mission) {
      setNotice("Create/activate a mission first.");
      return;
    }
    setRunning(agentId);
    setNotice("");
    const res = await fetch("/api/firm/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId, missionId: mission.id }),
    });
    const json = await res.json();
    setRunning(null);
    if (json.ok) {
      setNotice(`Agent executed → ${json.result.status}.`);
    } else {
      setNotice(`Run failed: ${json.error ?? "unknown"}`);
    }
    load();
  }

  async function runPipeline() {
    const mission = data.missions.find((m) => m.status === "ACTIVE" || m.status === "PENDING");
    if (!mission) {
      setNotice("Keine aktive Mission. Zuerst „Seed / Reset“ klicken.");
      return;
    }
    setRunning("pipeline");
    setNotice("Pipeline läuft: CEO → Research → Backtest → Risk → Approver → Executor …");
    const res = await fetch("/api/firm/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ missionId: mission.id, pipeline: true }),
    });
    const json = await res.json();
    setRunning(null);
    if (json.ok) {
      const steps = (json.pipeline ?? [])
        .map((s: any) => `${s.role}:${s.result.status}`)
        .join(" → ");
      setNotice(`Pipeline fertig — ${steps || "keine Schritte"}`);
    } else {
      setNotice(`Pipeline fehlgeschlagen: ${json.error ?? "unbekannt"}`);
    }
    load();
  }

  async function kill(arm: boolean) {
    await fetch("/api/firm/kill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ arm, reason: "OPERATOR_DASHBOARD", flatten: arm }),
    });
    setNotice(
      arm
        ? "🔴 NOT-HALT AKTIV — alle Orders blockiert, offene Positionen glattgestellt."
        : "Kill-Switch entschärft. Missionen stehen wieder auf PENDING."
    );
    load();
  }

  const badAgents = data.agents;
  const openPositions = data.positions.filter((p) => p.status === "OPEN");

  return (
    <div className="mx-auto max-w-7xl px-4 py-8">
      {/* Header */}
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.15em] text-emerald-400">
            Open-Source · Local-First · No Cloud
          </p>
          <h1 className="mt-1 text-3xl font-bold text-slate-50">
            Autonomous AI Trading Firm
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Reference implementation for Ollama · PostgreSQL · Drizzle on your own hardware
          </p>
        </div>
        <div className="flex items-center gap-2">
          <a
            href="/docs"
            className="rounded-lg border border-emerald-600/50 bg-emerald-500/10 px-3 py-2 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/20"
          >
            📖 Doku &amp; Installation
          </a>
          <button
            onClick={() => runPipeline()}
            disabled={running !== null}
            className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-700 disabled:opacity-50"
          >
            {running === "pipeline" ? "Pipeline läuft…" : "▶▶ Ganze Pipeline"}
          </button>
          <button
            onClick={() => seed()}
            className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-700"
          >
            Seed / Reset
          </button>
          {data.killSwitchArmed ? (
            <button
              onClick={() => kill(false)}
              className="rounded-lg bg-slate-700 px-3 py-2 text-xs font-bold text-slate-100 hover:bg-slate-600"
            >
              Disarm Kill Switch
            </button>
          ) : (
            <button
              onClick={() => kill(true)}
              className="rounded-lg bg-red-600 px-4 py-2 text-xs font-bold text-white shadow-lg hover:bg-red-500"
            >
              🛑 Pull Kill Switch
            </button>
          )}
        </div>
      </header>

      {notice && (
        <div className="mb-6 rounded-lg border border-slate-700 bg-slate-800/60 px-4 py-2 text-sm text-slate-200">
          {notice}
        </div>
      )}

      {/* Status strip */}
      <section className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Paper-Equity" value={`$${data.account.equity.toLocaleString()}`} />
        <Stat label="Freies Cash" value={`$${data.account.freeCash.toLocaleString()}`} />
        <Stat
          label="Drawdown"
          value={`${data.account.drawdownPct.toFixed(2)} %`}
          danger={data.account.drawdownPct >= Number(data.riskLimits.maxEquityDrawdownPct ?? 0.15) * 100}
        />
        <Stat label="Offene Positionen" value={`${data.account.openPositions}`} />
        <Stat
          label="Not-Halt"
          value={data.killSwitchArmed ? "AKTIV" : "sicher"}
          danger={data.killSwitchArmed}
        />
        <Stat
          label="Lokales LLM"
          value={data.ollama.available ? `Ollama (${data.ollama.models.length})` : "Regel-Engine"}
          danger={!data.ollama.available}
        />
      </section>

      {/* Tabs */}
      <nav className="mb-6 flex flex-wrap gap-2">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`rounded-lg px-4 py-2 text-sm font-semibold transition ${
              tab === t.id
                ? "bg-emerald-500 text-slate-950"
                : "bg-slate-800 text-slate-300 hover:bg-slate-700"
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {loading ? (
        <p className="py-16 text-center text-slate-400">Loading firm state…</p>
      ) : (
        <>
          {tab === "overview" && (
            <OverviewTab data={data} openPositions={openPositions} />
          )}
          {tab === "agents" && <AgentsTab data={data} running={running} onRun={runAgent} />}
          {tab === "risk" && <RiskTab data={data} />}
          {tab === "architecture" && <ArchitectureTab />}
        </>
      )}
    </div>
  );
}

const tabs: { id: Tab; label: string }[] = [
  { id: "overview", label: "Firm Overview" },
  { id: "agents", label: "Agents ↗ Orchestrator" },
  { id: "risk", label: "Risk & Guardrails" },
  { id: "architecture", label: "Design Decisions / Guide" },
];

function Stat({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className={`rounded-xl border px-4 py-3 ${danger ? "border-red-700 bg-red-950/40" : "border-slate-800 bg-slate-900/60"}`}>
      <p className="text-[11px] uppercase tracking-wider text-slate-400">{label}</p>
      <p className={`mt-1 text-lg font-bold ${danger ? "text-red-400" : "text-slate-100"}`}>{value}</p>
    </div>
  );
}

function Table({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900/50">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-slate-800 text-[11px] uppercase tracking-wider text-slate-400">
            {head.map((h) => (
              <th key={h} className="px-4 py-2 font-semibold">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-slate-800/60 last:border-0">
              {r.map((c, j) => (
                <td key={j} className="px-4 py-2 text-slate-300">{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OverviewTab({ data, openPositions }: { data: FirmData; openPositions: any[] }) {
  return (
    <div className="space-y-6">
      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-slate-400">Missions</h2>
        <Table
          head={["Title", "Objective", "Symbol", "Risk Budget", "Status"]}
          rows={data.missions.map((m) => [
            m.title,
            m.objective.slice(0, 60) + (m.objective.length > 60 ? "…" : ""),
            m.symbol ?? "—",
            `${(Number(m.riskBudget) * 100).toFixed(0)}%`,
            m.status,
          ])}
        />
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-slate-400">Open Positions (Paper)</h2>
        {openPositions.length === 0 ? (
          <p className="rounded-xl border border-slate-800 bg-slate-900/50 px-4 py-6 text-sm text-slate-400">
            No open positions. Run an Executor agent against an active mission.
          </p>
        ) : (
          <Table
            head={["Symbol", "Side", "Qty", "Entry", "Broker", "Status"]}
            rows={openPositions.map((p) => [
              p.symbol,
              p.side,
              p.qty,
              p.entryPrice,
              p.broker,
              p.status,
            ])}
          />
        )}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-slate-400">Approval Queue</h2>
        <Table
          head={["Action", "Detail", "Risk Score", "Status"]}
          rows={data.proposals.map((p) => [
            p.action,
            JSON.stringify(p.proposedDetail).slice(0, 60),
            p.riskScore,
            p.status,
          ])}
        />
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-slate-400">Audit Trail</h2>
        <Table
          head={["Event", "Level", "Detail"]}
          rows={data.auditLog.map((a) => [
            a.event,
            a.level,
            JSON.stringify(a.detail ?? {}).slice(0, 70),
          ])}
        />
      </section>
    </div>
  );
}

function AgentsTab({
  data,
  running,
  onRun,
}: {
  data: FirmData;
  running: string | null;
  onRun: (id: string) => void;
}) {
  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      {data.agents.map((a) => (
        <div key={a.id} className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-bold text-slate-100">{a.name}</h3>
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${
                a.status === "RUNNING"
                  ? "bg-amber-500/20 text-amber-300"
                  : a.status === "BLOCKED"
                  ? "bg-red-500/20 text-red-300"
                  : "bg-emerald-500/20 text-emerald-300"
              }`}
            >
              {a.status}
            </span>
          </div>
          <p className="mb-1 text-xs font-semibold text-emerald-400">{a.role}</p>
          <p className="mb-1 text-xs text-slate-500">Model: {a.model}</p>
          <p className="mb-3 line-clamp-3 text-xs text-slate-400">{a.systemPrompt}</p>
          <button
            onClick={() => onRun(a.id)}
            disabled={running === a.id}
            className="w-full rounded-lg bg-slate-700 px-3 py-2 text-xs font-semibold text-slate-100 hover:bg-slate-600 disabled:opacity-50"
          >
            {running === a.id ? "Thinking…" : "▶ Run one turn"}
          </button>
        </div>
      ))}
    </div>
  );
}

function RiskTab({ data }: { data: FirmData }) {
  const limits = data.riskLimits as Record<string, any>;
  const rows: [string, string][] = [];
  for (const k in limits) {
    if (typeof limits[k] === "boolean" || typeof limits[k] === "number") {
      rows.push([fancy(k), String(limits[k])]);
    }
  }
  return (
    <div className="space-y-6">
      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-slate-400">
          Hard-coded guardrails (code, not instructions)
        </h2>
        <Table head={["Limit", "Value"]} rows={rows} />
        <p className="mt-3 rounded-lg border border-amber-700/50 bg-amber-950/30 px-4 py-3 text-xs text-amber-300">
          These limits are enforced in <code className="font-mono">src/lib/riskGuard.ts</code> — outside
          the agent layer. No prompt, instruction, or agent output can change them at runtime.
        </p>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-slate-400">
          Ollama status
        </h2>
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
          <p className="text-sm text-slate-300">
            Available:{" "}
            <span className={data.ollama.available ? "text-emerald-400" : "text-red-400"}>
              {data.ollama.available ? "yes" : "no"}
            </span>
          </p>
          <p className="text-sm text-slate-300">Endpoint: {data.ollama.baseUrl || "http://127.0.0.1:11434"}</p>
          {data.ollama.error && <p className="text-sm text-red-400">Error: {data.ollama.error}</p>}
          {data.ollama.models.length > 0 && (
            <p className="mt-2 text-sm text-slate-400">Models: {data.ollama.models.join(", ")}</p>
          )}
          <p className="mt-2 text-xs text-slate-500">
            When Ollama is unreachable the firm falls back to a deterministic rules engine so the
            full orchestration + guardrail pipeline stays demonstrable.
          </p>
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-slate-400">
          Kill-switch history
        </h2>
        <Table
          head={["Triggered By", "Reason", "Armed"]}
          rows={data.killSwitches.map((k) => [k.triggeredBy, k.reason, k.armed ? "yes" : "no"])}
        />
      </section>
    </div>
  );
}

function fancy(k: string) {
  return k
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (s) => s.toUpperCase())
    .replace(/pct/g, "%")
    .replace(/max/g, "Max");
}

function ArchitectureTab() {
  return (
    <div className="prose prose-invert max-w-none">
      <Guide />
    </div>
  );
}

function Guide() {
  return (
    <div className="space-y-8 text-slate-300">
      {/* Framework & orchestration */}
      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
        <h2 className="mb-1 text-lg font-bold text-slate-50">1 · Framework & Orchestration</h2>
        <p className="mb-3 text-sm text-slate-400">Paperclip-Ersatz für autonome Trading-Agenten auf eigener Hardware:</p>
        <ul className="ml-5 list-disc space-y-2 text-sm">
          <li><b className="text-emerald-400">LangGraph</b> — bester Kandidat für Trading. Zustandsmaschine mit expliziten Übergängen (research → risk → approve → execute), Checkpointing/Context-Persistenz zwischen Läufen reaktiv, feinkörnige Kontrolle über jeden Schritt. Steilere Lernkurve, aber genau das, was als "institutionelles Wissen" über Sessions hinweg gefordert wird.</li>
          <li><b className="text-emerald-400">AutoGen (Microsoft)</b> — conversation-driven, aber das freie Agenten-Gespräch ist riskant für Geld-Operationen; State-Management über alles hinweg schwieriger. Gut für Exploration, nicht als harte Pipeline.</li>
          <li><b className="text-emerald-400">CrewAI</b> — niedrige Einstiegshürde, schöne Rollen ("crew = CEO + workers"), aber die magische Orchestrierung macht Kontrolle über Schritte und Reproduzierbarkeit schwerer.</li>
          <li><b className="text-emerald-400">Pickleball nebenbei</b> — dieser Code hier liefert einen minimalen, selbstgeschriebenen Orchestrator (Engine-Layer) extra. Eine Agenten-Schleife reicht für Paper-Trading völlig.</li>
        </ul>
        <p className="mt-3 text-sm">
          <b>Parallel oder sequenziell?</b> Deine N150 (16 GB) lädt höchstens <b>2 kleine Modelle gleichzeitig</b> in den RAM. Für NLP-Aufgaben pro Turn mit &lt;4k tokens dominiert ohnehin die Einzellatenz. Starte <b>sequenziell geordnet</b> (jeder Agent, wenn der vorherige fertig ist) — für Paper-Trading ist das instant genug und nutzt die Knappheit als Feature: weniger Race-Conditions an der Brokerschicht.
        </p>
      </section>

      {/* Model selection */}
      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
        <h2 className="mb-1 text-lg font-bold text-slate-50">2 · Modellauswahl & Kompromisse</h2>
        <p className="mb-3 text-sm text-slate-400">Empfehlungen basierend auf N150 / 48GB-RAM-Desktop / RX-480 (8GB):</p>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead><tr className="border-b border-slate-700 text-slate-400 text-[11px] uppercase"><th className="py-1 pr-3">Rolle</th><th className="py-1 pr-3">Modell (Ollama-Tag)</th><th className="py-1">Warum</th></tr></thead>
            <tbody className="text-slate-300">
              <tr className="border-b border-slate-800"><td className="py-1 pr-3">CEO / Orchestrator</td><td className="py-1 pr-3">qwen2.5:14b-instruct-q4</td><td className="py-1">gutes Instruktionsfolgen, grosse Community</td></tr>
              <tr className="border-b border-slate-800"><td className="py-1 pr-3">Research</td><td className="py-1 pr-3">llama3.1:8b-instruct-q4</td><td className="py-1">schnell, zusammenfasst Analysen</td></tr>
              <tr className="border-b border-slate-800"><td className="py-1 pr-3">Backtest-Assistenz</td><td className="py-1 pr-3">deepseek-coder:6.7b / qwen2.5-coder</td><td className="py-1">Code-Skelette für Tests, nicht für Disposition</td></tr>
              <tr><td className="py-1 pr-3">Risk / Approver</td><td className="py-1 pr-3">qwen2.5:7b-instruct-q4</td><td className="py-1">schauen kritisch & deterministisch gegen Härtelogik</td></tr>
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-sm">
          <b>DeepSeek Coder?</b> Für <b>Code-Generierung</b> (Backtest-Skripte, Adapter) ja. Als <b>Orchestrator</b> nein — es ist auf Fülltext/Code trainiert, nicht auf strukturierte Instruktionsausführung wie Qwen/Llama. Nutze Coder für Toolings, Qwen für Koordination.
        </p>
        <p className="mt-2 text-sm">
          <b>Kompromisse vs. Claude:</b> lokale Modelle (a) brauchen <b>strikteres Prompt-Design</b> (JSON-Only, weniger Prosa), (b) haben <b>kleinere effektive Kontext-Fenster</b> (~8–32k), (c) hallucinieren öfter. Dafür: 0 Kosten, volle Datenkontrolle, CPU+GPU offline.
        </p>
        <p className="mt-2 text-sm">
          <b>Hybrid-Empfehlung:</b> lokal abwickeln (Research, Routinen, Approver-Vorprüfung, strukturierte Daten). <b>Nur für schwerwiegende, seltene, komplexe Entscheidungen</b> (z. B. missionales Strategic-Review) optional ein größeres Modell per API nutzen — aber primär menschlicher Review, nicht Cloud-LLM. Für Paper-Trading kannst du in reiner Lokalität bleiben.
        </p>
      </section>

      {/* Security & risk */}
      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
        <h2 className="mb-1 text-lg font-bold text-slate-50">3 · Sicherheit & Risikokontrolle</h2>
        <p className="mb-3 text-sm text-slate-400">Defense-in-Depth — mehrschichtige, in Code verankerte Kontrolle:</p>
        <ol className="ml-5 list-decimal space-y-2 text-sm">
          <li><b>Mehrschichtig statt nur Instruktionen:</b> diesem Repo liegt die Pipeline bei — Engine validiert, dann <code className="font-mono">riskGuard.ts</code> (hart), dann Broker nochmal (hart). Ein Agent-Output kann keine der harten Schichten ändern.</li>
          <li><b>Approver-Workflow:</b> Executor erzeugt nur einen <b>Vorschlag</b>; der Approver (Vega) prüft und setzt im Prod-Fall einen Status auf APPROVED, ehe der Order die Brokerschicht erreicht. Im Demo ist der Status zur Vereinfachung vorbeifüllt.</li>
          <li><b>Kill-Switch:</b> oberster Schalter wirkt als Circuit-Breaker in-memory; sobald aktiv, wird <em>jeder</em> ordre in der Broker.execute abgelehnt — auch wenn ein Agent (oder ein injizierter Prompt) ihn umgehen will.</li>
        </ol>
      </section>

      {/* MVP & scaling */}
      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
        <h2 className="mb-1 text-lg font-bold text-slate-50">4 · Minimales Setup & Skalierung</h2>
        <ul className="ml-5 list-disc space-y-2 text-sm">
          <li><b>Start mit 2 Agenten:</b> Research + Executor in einer Engpass-Pipeline, ein Approver-Prozess als Gegenleser. Das ist dein MVP — iteriere auf Instruktionen/Templates, nicht auf Agentenzahl.</li>
          <li><b>Iteration:</b> ändere je Lauf <em>ein</em> Prompt-Attribut (z. B. Format-JSON-Only, Symbol-Restriktion), logge das Audit-Trail, lest Entscheidungen am nächsten Tag. Das hier tut genau das.</li>
          <li><b>Wann wird Hardware Bottleneck?</b> wenn (a) Turn-Latenz &gt; dein Decision-Horizont wird, (b) Kontext &gt; effektives Fenster (über 8k tokens pro Turn), (c) zwei Modelle gleichzeitig laufen und RAM kollidiert, oder (d) viele parallele Läufe die Disk-IO von Ollama saturieren. Messen: Ollama zeigt tokens/s + native RAM-Nutzung in <code className="font-mono">ollama ps</code>.</li>
        </ul>
      </section>

      {/* Hardware limits */}
      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
        <h2 className="mb-1 text-lg font-bold text-slate-50">5 · Praktische Grenzen deiner Hardware</h2>
        <ul className="ml-5 list-disc space-y-2 text-sm">
          <li><b>8 GB VRAM (RX-480):</b> taugt für Modelle bis ~7–8B in 4-bit (ein Rechenkern). Zur RX-480 fehlen moderne Features (BF16/FP8/FlashAttention), viele Backends nutzen sie nicht voll. Für kontinuierliche Läufe empfohlen: <b>primary CPU+RAM</b> (dein 48GB-Desktop) mit CUDA-nahen offeneren Modellen via Ollama-CPU, oder die 8GB-GPU nur für die grösste Modellklasse verwenden.</li>
          <li><b>Quantisierung:</b> 4-bit vs 8-bit für strukturierte, klar vorgegebene Aufgaben (Risiko/Approver) ist fast egal — das sind im Kern Skript-Durchläufe + Matching. Qualität leidet erst bei freier, nuancenlastiger Kreativität (Strategie-Ideation). Nimm Q4 für die Pipeline, Q5–Q6 nur für den CEO, wenn Latenz es hergibt.</li>
          <li><b>Empfehlung als Start-Modell:</b> <code className="font-mono">qwen2.5:7b-instruct-q4_K_M</code> — klein genug für deine Hardware, gut genug für Instruktionen; es beweist den Stack ohne zu hohe Latenz. Danach skalieren auf 14B nur wenn du es stabil brauchst.</li>
        </ul>
      </section>

      {/* Brokers */}
      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
        <h2 className="mb-1 text-lg font-bold text-slate-50">6 · Broker für späteres Paper- & Live-Trading</h2>
        <ul className="ml-5 list-disc space-y-2 text-sm">
          <li><b>Alpaca</b> (API-First, US-Equities) — beste Paper-Trading-First-API, gebührenfrei Paper, elegante Orders, OAuth; ideal zum Start.</li>
          <li><b>Interactive Brokers</b> — vollwertiger Broker, globale Märkte, aber CLI + TWS-API ist sperrig und nutzt 32-Bit-Gateway — auf der N150 machbar, aber Bureaucratie.</li>
          <li><b>Binance/Kraken/KuCoin</b> — Crypto-Spot (und Futures), API einfach via <b>ccxt</b>; Paper-Feeds fehlen teils, daher Alpaca für Demo plausibler.</li>
          <li><b>dYdX</b> — dezentrale Perpetuals, komplett open-source, Self-Custody; für einen "open-source First"-Ansatz thematisch passend, aber Margin/Risiko zusätzlich.</li>
        </ul>
        <p className="mt-2 text-sm text-slate-400">Dieses Repo bringt die PAPER-Broker-Abstraktion mit; Alpaca/ccxt-Adapter sprechen dieselbe Schnittstelle an.</p>
      </section>

      {/* Questions to ask */}
      <section className="rounded-2xl border border-emerald-700/40 bg-emerald-950/20 p-6">
        <h2 className="mb-2 text-lg font-bold text-emerald-300">Fragen, die du dir vor dem Start stellen solltest</h2>
        <ul className="ml-5 list-disc space-y-2 text-sm text-emerald-100/90">
          <li>Welche maximale Drawdown-Toleranz hast du, bevor der Kill-Switch automatisch zieht? (Wert in % setzen)</li>
          <li>Wie viel Zeit kannst du realistisch pro Woche für Prompt-/Template-Wartung aufwenden? (beeinflusst Komplexität des Orchestrators)</li>
          <li>Welche Genauigkeit brauchst du bei Backtests, bevor du einem Setup vertraust? (das hier ist bewusst nur minimal)</li>
          <li>Stimmst du dem "small round-trips, no shorts, no leverage"-Start zu, oder willst du schon early Trades mit Margin?</li>
          <li>Welche Assets willst du wirklich handeln — Equities (→ Alpaca) oder Crypto (→ ccxt/Binance)?</li>
          <li>Hältst du einen hybriden Fallback sicher genug, um in Produktion je eine Cloud-API zu erlauben? (für Paper-Trading unnötig)</li>
        </ul>
      </section>
    </div>
  );
}
