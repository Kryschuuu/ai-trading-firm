"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/apiClient";
import type { AgentRow, MissionRow } from "@/lib/types";
import { describeAuditEntry, firstSentence } from "@/lib/auditView";
import { missionScopeLabel } from "@/lib/missionTemplates";
import WorkshopTab from "./workshop/WorkshopTab";
import BrokersPanel from "./control-plane/BrokersPanel";
import OperationsCenterPanel from "./ops/OperationsCenterPanel";
import ThemeSwitcher from "./ThemeSwitcher";
import AuditTrailPanel from "./common/AuditTrailPanel";
import ProtocolPanel from "./common/ProtocolPanel";

type ConfigEntry = {
  key: string;
  label: string;
  unit: "%" | "x" | "count" | "bool" | "rr" | "idx";
  description: string;
  value: number | boolean;
  min: number;
  max: number;
  locked: boolean;
  defaultValue: number | boolean;
};

/** Zustand des adaptiven Risk-Limit-Systems (GET /api/firm/risk/volatility). */
type AdaptiveRiskStatus = {
  regime: "NORMAL" | "ELEVATED" | "EXTREME";
  enabled: boolean;
  factor: number;
  baseMaxRiskPerTrade: number;
  effectiveMaxRiskPerTrade: number;
  lastUpdate: string | null;
  lastChange: string | null;
  lastError: string | null;
  stale: boolean;
  reason: string;
  indicators: {
    name: string;
    label: string;
    value: number | null;
    threshold: number;
    available: boolean;
    triggered: boolean;
  }[];
  events: {
    at: string;
    prevRegime: string;
    regime: string;
    factor: number;
    baseMaxRiskPerTrade: number;
    effectiveMaxRiskPerTrade: number;
    triggered: string[];
    reason: string;
  }[];
  config: Record<string, number | boolean>;
  bounds: Record<string, [number, number]>;
};

type FirmData = {
  agents: AgentRow[];
  missions: MissionRow[];
  positions: any[];
  proposals: any[];
  /**
   * Letzten Audit-Zeilen aus GET /api/firm. Die Übersicht rendert inzwischen
   * den gepagten Audit-Trail über GET /api/firm/log (AuditTrailPanel) — das
   * Feld bleibt Teil des API-Vertrags für andere Clients.
   */
  auditLog: any[];
  riskLimits: Record<string, any>;
  riskDefaults: Record<string, any>;
  riskCeilings: Record<string, [number, number]>;
  riskConfig: ConfigEntry[];
  volatilityConfig: ConfigEntry[];
  adaptiveRisk: AdaptiveRiskStatus | null;
  killSwitchArmed: boolean;
  killSwitches: any[];
  messages: any[];
  ollama: { available: boolean; baseUrl: string; models: string[]; error?: string };
  scheduler: { enabled: boolean; lastTickAt: string | null };
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
  auditLog: [], riskLimits: {}, riskDefaults: {}, riskCeilings: {}, riskConfig: [],
  volatilityConfig: [], adaptiveRisk: null,
  killSwitchArmed: false,
  killSwitches: [], messages: [], ollama: { available: false, baseUrl: "", models: [] },
  scheduler: { enabled: false, lastTickAt: null },
  account: {
    equity: 0, startingEquity: 0, freeCash: 0, drawdownPct: 0,
    openPositions: 0, broker: "PAPER", paperMode: true, livePositions: [],
  },
  brokers: {},
  requireHumanApproval: false,
  timestamp: "",
};

type Tab = "overview" | "reports" | "protocol" | "agents" | "workshop" | "ops" | "brokers" | "risk" | "architecture";


export default function FirmDashboard() {
  const [data, setData] = useState<FirmData>(defaultData);
  const [tab, setTab] = useState<Tab>("overview");
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [firmError, setFirmError] = useState("");
  const [needToken, setNeedToken] = useState(false);
  const [tokenDraft, setTokenDraft] = useState("");
  /** Pipeline-Statusleiste: läuft / fertig / fehlgeschlagen (optisch hervorgehoben). */
  const [pipeline, setPipeline] = useState<{
    phase: "running" | "done" | "failed";
    detail?: string;
  } | null>(null);

  /** Zeigt nach einer 401 die Token-Eingabe und bricht die Aktion ab. */
  async function ensureAuth(res: Response): Promise<boolean> {
    if (res.status === 401) {
      setNeedToken(true);
      setNotice("🔒 Diese Aktion braucht den API-Token (FIRM_API_TOKEN).");
      return false;
    }
    return true;
  }

  function saveToken() {
    window.localStorage.setItem("firmToken", tokenDraft.trim());
    setTokenDraft("");
    setNeedToken(false);
    setNotice("Token gespeichert — Aktion bitte erneut ausführen.");
  }

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/firm");
      const json = await res.json();
      // FIX (v1.23.0): Ein 503 (z. B. PostgreSQL nicht erreichbar) liefert
      // einen Fehlerkörper statt des Firm-Zustands. Der wurde früher ungeprüft
      // in den State geschrieben und hat das Dashboard beim nächsten Rendern
      // zerschossen (`data.positions.filter` auf undefined). Jetzt bleibt der
      // letzte gültige Zustand stehen und die Meldung erscheint als Hinweis —
      // die modulbasierten Tabs (Operations Center, Brokers) bleiben nutzbar.
      if (!json || json.ok === false || !Array.isArray(json.positions) || !Array.isArray(json.missions)) {
        setFirmError(
          typeof json?.error === "string" && json.error
            ? json.error
            : `Unerwartete Antwort von GET /api/firm (HTTP ${res.status}).`
        );
        return;
      }
      setFirmError("");
      setData(json);
    } catch {
      setFirmError("Netzwerkfehler — /api/firm nicht erreichbar.");
    } finally {
      setLoading(false);
    }
  }, []);

  // Kein synchrones setState im Effekt (react-hooks/set-state-in-effect):
  // Das initiale Laden wird um einen Tick verschoben, der Effekt selbst ruft
  // keine Setter auf.
  useEffect(() => {
    const id = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(id);
  }, [load]);

  // auto-refresh every 8s while running, else 15s
  useEffect(() => {
    const id = setInterval(load, data.missions.some((m) => m.status === "ACTIVE") ? 8000 : 15000);
    return () => clearInterval(id);
  }, [load, data.missions]);

  // „Pipeline fertig“ löst sich nach 20 s von selbst — „fehlgeschlagen“
  // bleibt sichtbar, bis die nächste Aktion kommt (Fehler nicht übersehen).
  useEffect(() => {
    if (pipeline?.phase !== "done") return;
    const id = window.setTimeout(() => setPipeline(null), 20_000);
    return () => window.clearTimeout(id);
  }, [pipeline]);

  async function seed() {
    await apiFetch("/api/seed", { method: "POST" });
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
    const res = await apiFetch("/api/firm/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId, missionId: mission.id }),
    });
    if (!(await ensureAuth(res))) { setRunning(null); return; }
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
    setNotice("");
    // Statusleiste: „Pipeline gestartet“ — pulsierend hervorgehoben,
    // auch bei Neustart (setzt den Zustand zurück auf running).
    setPipeline({ phase: "running" });
    const res = await apiFetch("/api/firm/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ missionId: mission.id, pipeline: true }),
    });
    if (!(await ensureAuth(res))) { setRunning(null); setPipeline(null); return; }
    const json = await res.json();
    setRunning(null);
    if (json.ok) {
      const steps = (json.pipeline ?? [])
        .map((s: any) => `${s.role}:${s.result.status}`)
        .join(" → ");
      setPipeline({ phase: "done", detail: steps || "keine Schritte" });
    } else {
      setPipeline({ phase: "failed", detail: json.error ?? "unbekannt" });
    }
    load();
  }

  async function kill(arm: boolean) {
    const res = await apiFetch("/api/firm/kill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ arm, reason: "OPERATOR_DASHBOARD", flatten: arm }),
    });
    if (!(await ensureAuth(res))) return;
    setNotice(
      arm
        ? "🔴 NOT-HALT AKTIV — alle Orders blockiert, offene Positionen glattgestellt."
        : "Kill-Switch entschärft. Missionen stehen wieder auf PENDING."
    );
    load();
  }

  async function runTick() {
    setRunning("tick");
    const res = await apiFetch("/api/firm/tick", { method: "POST" });
    if (!(await ensureAuth(res))) { setRunning(null); return; }
    const json = await res.json();
    setRunning(null);
    if (json.ok) {
      const stops = json.stopsTriggered?.length ?? 0;
      setNotice(
        `Tick fertig — ${json.quotesRefreshed} Kurse aktualisiert, ${stops} SL/TP-Auslösungen${json.marketScan ? ", Marktscan geschrieben" : ""}${json.dailyLossKill ? ", ⚠️ Tagesverlust-Limit → Kill-Switch!" : ""}`
      );
    } else {
      setNotice(`Tick fehlgeschlagen: ${json.error ?? "unbekannt"}`);
    }
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
          <ThemeSwitcher />
          <a
            href="/docs"
            className="rounded-lg border border-emerald-600/50 bg-emerald-500/10 px-3 py-2 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/20"
          >
            📖 Doku &amp; Installation
          </a>
          <button
            onClick={() => runTick()}
            disabled={running !== null}
            className="rounded-lg border border-sky-700/50 bg-sky-500/10 px-3 py-2 text-xs font-semibold text-sky-300 hover:bg-sky-500/20 disabled:opacity-50"
          >
            {running === "tick" ? "Tick läuft…" : "⟳ Markt-Tick"}
          </button>
          <button
            onClick={() => runPipeline()}
            disabled={running !== null}
            className={`rounded-lg border px-3 py-2 text-xs font-semibold disabled:opacity-60 ${
              running === "pipeline"
                ? "animate-pulse border-emerald-500/80 bg-emerald-500/20 text-emerald-300"
                : "border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700"
            }`}
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

      {/* Pipeline-Statusleiste — bei laufender/neu gestarteter Pipeline
          pulsierender Emerald-Block mit Glow; nach Abschluss grün (20 s),
          bei Fehler rot und bleibend. */}
      {pipeline && (
        <div
          role="status"
          aria-live="polite"
          className={`mb-6 flex items-center gap-3 rounded-xl border-2 px-4 py-3 ${
            pipeline.phase === "failed"
              ? "border-red-500/70 bg-red-500/15 shadow-[0_0_20px_-6px_var(--color-red-500)]"
              : pipeline.phase === "running"
                ? "pipeline-glow border-emerald-500/70 bg-emerald-500/10"
                : "border-emerald-500/70 bg-emerald-500/15 shadow-[0_0_20px_-6px_var(--color-emerald-500)]"
          }`}
        >
          {pipeline.phase === "running" ? (
            <span className="inline-block h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-emerald-400 border-t-transparent" />
          ) : pipeline.phase === "done" ? (
            <span className="shrink-0 text-lg leading-none text-emerald-400">✓</span>
          ) : (
            <span className="shrink-0 text-lg leading-none text-red-400">✗</span>
          )}
          <div className="min-w-0">
            <p
              className={`text-sm font-bold tracking-wide ${
                pipeline.phase === "failed" ? "text-red-300" : "text-emerald-300"
              }`}
            >
              {pipeline.phase === "running" && "⚡ Pipeline gestartet — läuft"}
              {pipeline.phase === "done" && "Pipeline fertig"}
              {pipeline.phase === "failed" && "Pipeline fehlgeschlagen"}
            </p>
            <p
              className={`mt-0.5 truncate text-xs ${
                pipeline.phase === "failed" ? "text-red-200/80" : "text-emerald-200/70"
              }`}
            >
              {pipeline.phase === "running"
                ? "CEO → Research → Backtest → Risk → Approver → Executor …"
                : pipeline.detail}
            </p>
          </div>
        </div>
      )}

      {notice && (
        <div className="mb-6 rounded-lg border border-slate-700 bg-slate-800/60 px-4 py-2 text-sm text-slate-200">
          {notice}
          {needToken && (
            <div className="mt-2 flex items-center gap-2">
              <input
                type="password"
                placeholder="API-Token (FIRM_API_TOKEN)"
                value={tokenDraft}
                onChange={(e) => setTokenDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && saveToken()}
                className="w-72 rounded border border-slate-600 bg-slate-900 px-2 py-1 text-xs text-slate-100"
              />
              <button
                onClick={saveToken}
                className="rounded bg-emerald-600 px-3 py-1 text-xs font-bold text-white hover:bg-emerald-500"
              >
                Speichern
              </button>
            </div>
          )}
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
          label="Monitor"
          value={
            !data.scheduler.enabled
              ? "aus"
              : data.scheduler.lastTickAt
                ? `Tick ${new Date(data.scheduler.lastTickAt).toLocaleTimeString("de-DE")}`
                : "wartet"
          }
          danger={!data.scheduler.enabled}
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

      {firmError && (
        <div className="mb-4 rounded-xl border border-amber-800/60 bg-amber-950/30 px-4 py-3 text-xs leading-relaxed text-amber-200">
          <p className="font-bold text-amber-100">Firm-Status nicht verfügbar (Datenbank).</p>
          <p className="mt-1">
            {firmError} Die Modul-Tabs (Operations Center, Brokers & Venues) funktionieren weiter —
            ihre Quellen sind lokal.
          </p>
          {data.positions.length === 0 && (
            <p className="mt-1 text-amber-300/80">
              Prüfen: PostgreSQL gestartet? `DATABASE_URL` gesetzt? `npx drizzle-kit push` ausgeführt?
            </p>
          )}
        </div>
      )}

      {loading ? (
        <p className="py-16 text-center text-slate-400">Loading firm state…</p>
      ) : (
        <>
          {tab === "overview" && (
            <OverviewTab data={data} openPositions={openPositions} />
          )}
          {tab === "reports" && <ReportsTab />}
          {tab === "protocol" && <ProtocolTab />}
          {tab === "agents" && <AgentsTab data={data} running={running} onRun={runAgent} />}
          {tab === "ops" && (
            <OperationsCenterPanel onOpenTab={(target) => setTab(target as Tab)} />
          )}
          {tab === "workshop" && (
            <WorkshopTab
              agents={data.agents}
              missions={data.missions}
              onChanged={load}
              onUnauthorized={() => {
                setNeedToken(true);
                setNotice("🔒 Diese Aktion braucht den API-Token (FIRM_API_TOKEN).");
              }}
              onOpenProtocol={() => setTab("protocol")}
            />
          )}
          {tab === "brokers" && (
            <BrokersPanel
              onUnauthorized={() => {
                setNeedToken(true);
                setNotice("🔒 Diese Aktion braucht den API-Token (FIRM_API_TOKEN/FIRM_ADMIN_TOKEN).");
              }}
            />
          )}
          {tab === "risk" && <RiskTab data={data} onChanged={load} />}
          {tab === "architecture" && <ArchitectureTab />}
        </>
      )}
    </div>
  );
}

const tabs: { id: Tab; label: string }[] = [
  { id: "overview", label: "Firm Overview" },
  { id: "reports", label: "📊 Reports" },
  { id: "protocol", label: "📋 Protokoll" },
  { id: "agents", label: "Agents ↗ Orchestrator" },
  { id: "workshop", label: "🛠 Workshop" },
  { id: "ops", label: "🧭 Operations Center" },
  { id: "brokers", label: "🌐 Brokers & Venues" },
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

function Table({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) {
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
          head={["Titel", "Ziel", "Symbol / Segment", "Risikobudget", "Status"]}
          rows={data.missions.map((m) => [
            <span key={m.id} className="font-semibold text-slate-200">{m.title}</span>,
            // Auf Wortgrenze gekürzt, vollständiger Text im Tooltip — kein harter Schnitt mitten im Wort.
            <span key={`${m.id}-objective`} title={m.objective} className="block max-w-xl">
              {firstSentence(m.objective, 120)}
            </span>,
            // Missions-Typ (v1.35.0): Einzel-Symbol oder „Markt-Scan: <Segment>“.
            <span key={`${m.id}-scope`} title={m.symbol ?? missionScopeLabel(m)}>
              {missionScopeLabel(m)}
            </span>,
            `${(Number(m.riskBudget) * 100).toFixed(0)} %`,
            m.status,
          ])}
        />
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-slate-400">Positionen</h2>
        {data.positions.length === 0 ? (
          <p className="rounded-xl border border-slate-800 bg-slate-900/50 px-4 py-6 text-sm text-slate-400">
            Keine Positionen. Pipeline oder Executor gegen eine aktive Mission laufen lassen.
          </p>
        ) : (
          <Table
            head={["Status", "Symbol", "Side", "Qty", "Entry", "SL", "TP", "Kurs", "PnL", "Exit-Grund"]}
            rows={data.positions.slice(0, 15).map((p) => [
              p.status,
              p.symbol,
              p.side,
              p.qty,
              p.entryPrice,
              p.stopLoss ?? "—",
              p.takeProfit ?? "—",
              p.lastPrice ?? "—",
              <span
                key={p.id}
                className={(Number(p.unrealizedPnl) >= 0 ? "text-emerald-400" : "text-red-400") + " font-semibold"}
              >
                {(Number(p.unrealizedPnl) >= 0 ? "+" : "") + Number(p.unrealizedPnl).toFixed(2)}
              </span>,
              p.exitReason ?? "—",
            ])}
          />
        )}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-slate-400">Approval Queue</h2>
        <Table
          head={["Aktion", "Vorgeschlagene Order", "Risiko-Score", "Status"]}
          rows={data.proposals.map((p) => {
            const detail = p.proposedDetail ?? {};
            const summary = [
              detail.symbol ? String(detail.symbol) : null,
              detail.side ? String(detail.side).toUpperCase() : null,
              detail.reason ? String(detail.reason) : null,
            ]
              .filter((part): part is string => Boolean(part))
              .join(" · ");
            return [
              p.action,
              <details key={p.id} className="max-w-xl">
                <summary className="cursor-pointer text-slate-300">
                  {summary || "Details anzeigen"}
                </summary>
                <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-950/60 p-2 font-mono text-[11px] text-slate-300">
                  {JSON.stringify(detail, null, 2)}
                </pre>
              </details>,
              p.riskScore,
              p.status,
            ];
          })}
        />
      </section>

      {/* Audit-Trail: aufklappbar, vollständig geparst, mit Paging (20/50/100/200). */}
      <AuditTrailPanel
        title="Audit Trail"
        hint="Alle revisionssicheren Ereignisse — aufklappbar mit lesbaren Details, logischer Bewertung und Rohdaten."
      />
    </div>
  );
}

// ───────────────────────── Reports (Boss-Sicht) ─────────────────────────────

type EquityPoint = { ts: string; equity: number; trigger?: string };
type ReportData = {
  ok: boolean;
  period: string;
  since: string;
  kpis: {
    trades: number;
    realizedPnl: number;
    winRate: number | null;
    profitFactor: number | null;
    bestTrade: { symbol: string; pnl: number } | null;
    worstTrade: { symbol: string; pnl: number } | null;
    maxDrawdownPct: number;
    stopLossHits: number;
    takeProfitHits: number;
  };
  symbols: { symbol: string; trades: number; wins: number; pnl: number }[];
  turnsByRole: Record<string, number>;
  decisionsByType: Record<string, number>;
  blocks: { reason: string; count: number; explanation: string | null }[];
  notableEvents: { at: string; event: string; level: string; detail: any }[];
  recommendations: {
    at: string; role: string; symbol: string; side: string;
    horizon?: string; thesis?: string; confidence?: number;
    entryZone?: string; stopLoss?: string; target?: string; riskFlags?: string[];
    fresh?: boolean;
  }[];
  summary: string[];
};

/** Handgeschriebene SVG-Equity-Kurve — keine Chart-Dependency. */
function EquityChart({
  series,
  height = 220,
}: {
  series: EquityPoint[];
  height?: number;
}) {
  if (series.length < 2) {
    return (
      <p className="rounded-xl border border-slate-800 bg-slate-900/50 px-4 py-8 text-center text-sm text-slate-400">
        Noch zu wenig Historie für die Kurve — der Monitor schreibt bei jedem Tick einen Punkt.
      </p>
    );
  }
  const W = 1000;
  const PAD_Y = 18;
  const values = series.map((p) => p.equity);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const x = (i: number) => (i / (series.length - 1)) * W;
  const y = (v: number) => PAD_Y + (1 - (v - min) / span) * (height - 2 * PAD_Y);
  const points = series.map((p, i) => `${x(i).toFixed(1)},${y(p.equity).toFixed(1)}`).join(" ");
  const areaPoints = `0,${height} ${points} ${W},${height}`;
  const up = values[values.length - 1] >= values[0];
  const stroke = up ? "#34d399" : "#f87171";
  const last = values[values.length - 1];

  return (
    <div className="relative rounded-xl border border-slate-800 bg-slate-900/50 p-2">
      <svg viewBox={`0 0 ${W} ${height}`} className="w-full" preserveAspectRatio="none">
        <defs>
          <linearGradient id="eqfill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity="0.25" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {/* Startwert-Baseline */}
        <line
          x1="0" x2={W}
          y1={y(values[0])} y2={y(values[0])}
          stroke="#64748b" strokeDasharray="4 4" strokeWidth="1"
        />
        <polygon points={areaPoints} fill="url(#eqfill)" />
        <polyline points={points} fill="none" stroke={stroke} strokeWidth="2" />
      </svg>
      <div className="pointer-events-none absolute inset-x-3 top-1 flex justify-between text-[11px] text-slate-500">
        <span>{new Date(series[0].ts).toLocaleDateString("de-DE")} · Start {values[0].toFixed(0)}</span>
        <span style={{ color: stroke }} className="font-bold">
          {last.toFixed(2)} ({last >= values[0] ? "+" : ""}{(last - values[0]).toFixed(2)})
        </span>
        <span>{new Date(series[series.length - 1].ts).toLocaleTimeString("de-DE")}</span>
      </div>
    </div>
  );
}

function KpiTile({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 px-4 py-3">
      <p className="text-[11px] uppercase tracking-wider text-slate-400">{label}</p>
      <p className={`mt-1 text-lg font-bold ${
        tone === "good" ? "text-emerald-400" : tone === "bad" ? "text-red-400" : "text-slate-100"
      }`}>
        {value}
      </p>
    </div>
  );
}

function ReportsTab() {
  const [period, setPeriod] = useState<"day" | "week" | "month">("day");
  const [report, setReport] = useState<ReportData | null>(null);
  const [equitySeries, setEquitySeries] = useState<EquityPoint[]>([]);
  const [loadingRep, setLoadingRep] = useState(true);

  useEffect(() => {
    let alive = true;
    // async booten (kein synchrones setState im Effect)
    const t = setTimeout(async () => {
      try {
        const [r1, r2] = await Promise.all([
          fetch(`/api/firm/report?period=${period}`),
          fetch(`/api/firm/equity?range=${period === "day" ? "day" : period}`),
        ]);
        const j1 = await r1.json();
        const j2 = await r2.json();
        if (!alive) return;
        setReport(j1);
        setEquitySeries(j2.series ?? []);
      } catch {
        /* ignore */
      } finally {
        if (alive) setLoadingRep(false);
      }
    }, 0);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [period, setLoadingRep]);

  const k = report?.kpis;
  // "fresh" kommt serverseitig aus der Report-API (kein Date.now() im Render).

  return (
    <div className="space-y-6">
      <div className="flex gap-2">
        {(["day", "week", "month"] as const).map((p) => (
          <button
            key={p}
            onClick={() => setPeriod(p)}
            className={`rounded-lg px-4 py-1.5 text-sm font-semibold transition ${
              period === p ? "bg-emerald-500 text-slate-950" : "bg-slate-800 text-slate-300 hover:bg-slate-700"
            }`}
          >
            {p === "day" ? "Heute" : p === "week" ? "Diese Woche" : "Dieser Monat"}
          </button>
        ))}
        {report && (
          <span className="ml-auto self-center text-xs text-slate-500">
            ab {new Date(report.since).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" })}
          </span>
        )}
      </div>

      {/* Boss-Zusammenfassung */}
      {report && report.summary.length > 0 && (
        <section className="rounded-xl border border-emerald-700/40 bg-emerald-950/20 p-5">
          <h2 className="mb-2 text-sm font-bold uppercase tracking-wider text-emerald-300">📌 Lagebild für die Führung</h2>
          <ul className="ml-4 list-disc space-y-1 text-sm text-emerald-50/90">
            {report.summary.map((s, i) => <li key={i}>{s}</li>)}
          </ul>
        </section>
      )}

      {/* KPI-Kacheln */}
      {k && (
        <section className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
          <KpiTile label="Trades" value={String(k.trades)} />
          <KpiTile
            label="Realisiertes P&L"
            value={`${k.realizedPnl >= 0 ? "+" : ""}${k.realizedPnl.toFixed(2)}`}
            tone={k.realizedPnl > 0 ? "good" : k.realizedPnl < 0 ? "bad" : undefined}
          />
          <KpiTile label="Win-Rate" value={k.winRate != null ? `${k.winRate} %` : "—"} />
          <KpiTile
            label="Profit-Faktor"
            value={k.profitFactor != null ? (k.profitFactor === Infinity ? "∞" : k.profitFactor.toFixed(2)) : "—"}
          />
          <KpiTile
            label="Max Drawdown"
            value={`${k.maxDrawdownPct.toFixed(1)} %`}
            tone={k.maxDrawdownPct > 10 ? "bad" : undefined}
          />
          <KpiTile label="Stops ausgelöst" value={String(k.stopLossHits)} tone={k.stopLossHits > 0 ? "bad" : undefined} />
          <KpiTile label="TPs erreicht" value={String(k.takeProfitHits)} tone={k.takeProfitHits > 0 ? "good" : undefined} />
        </section>
      )}

      {/* Equity-Kurve */}
      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-slate-400">📈 Equity-Kurve</h2>
        {loadingRep ? (
          <p className="text-sm text-slate-400">Lade Kurve…</p>
        ) : (
          <EquityChart series={equitySeries} />
        )}
      </section>

      {/* Empfehlungen des Hauses */}
      {report && report.recommendations.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-slate-400">
            💡 Empfehlungen des Hauses
          </h2>
          <div className="grid gap-3 md:grid-cols-2">
            {(report?.recommendations ?? []).map((r, i) => {
              return (
                <div key={i} className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-slate-100">{r.symbol}</span>
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                      r.side === "LONG" ? "bg-emerald-500/20 text-emerald-300" : "bg-red-500/20 text-red-300"
                    }`}>
                      {r.side}
                    </span>
                    {r.horizon && <span className="rounded bg-sky-500/20 px-1.5 py-0.5 text-[10px] text-sky-300">{r.horizon}</span>}
                    {!r.fresh && <span className="text-[10px] text-amber-400">⚠️ älter als 24 h</span>}
                    <span className="ml-auto text-[11px] text-slate-500">{r.role}</span>
                  </div>
                  {r.thesis && <p className="mt-1 text-xs text-slate-300">{r.thesis}</p>}
                  <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-slate-400">
                    {r.entryZone && <span>Einstieg: <b className="text-slate-200">{r.entryZone}</b></span>}
                    {r.stopLoss && <span>Stop: <b className="text-red-300">{r.stopLoss}</b></span>}
                    {r.target && <span>Ziel: <b className="text-emerald-300">{r.target}</b></span>}
                    {typeof r.confidence === "number" && <span>Konfidenz: {(r.confidence * 100).toFixed(0)} %</span>}
                  </div>
                  {r.riskFlags && r.riskFlags.length > 0 && (
                    <p className="mt-1 text-[11px] text-amber-400">⚠️ Risiken: {r.riskFlags.join(", ")}</p>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Symbol-Breakdown + Blocks */}
      {report && (
        <section className="grid gap-6 lg:grid-cols-2">
          <div>
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-slate-400">Pro Symbol</h2>
            <Table
              head={["Symbol", "Trades", "Gewinner", "P&L"]}
              rows={report.symbols.map((s) => [
                s.symbol,
                s.trades,
                `${s.wins}/${s.trades}`,
                <span key={s.symbol} className={(s.pnl >= 0 ? "text-emerald-400" : "text-red-400") + " font-semibold"}>
                  {(s.pnl >= 0 ? "+" : "") + s.pnl.toFixed(2)}
                </span>,
              ])}
            />
            {report.symbols.length === 0 && (
              <p className="rounded-xl border border-slate-800 bg-slate-900/50 px-4 py-4 text-xs text-slate-500">
                Keine geschlossenen Trades im Zeitraum.
              </p>
            )}
          </div>
          <div>
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-slate-400">Blöcke & Gründe</h2>
            <Table
              head={["Grund", "Anzahl", "Bedeutung"]}
              rows={report.blocks.map((b) => [
                <code key={b.reason} className="font-mono text-[11px] text-amber-300">{b.reason}</code>,
                b.count,
                b.explanation ?? "—",
              ])}
            />
            {report.blocks.length === 0 && (
              <p className="rounded-xl border border-slate-800 bg-slate-900/50 px-4 py-4 text-xs text-slate-500">
                Keine blockierten Orders im Zeitraum.
              </p>
            )}
          </div>
        </section>
      )}

      {/* Bemerkenswerte Ereignisse */}
      {report && report.notableEvents.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-slate-400">
            Wichtige Ereignisse (SL/TP, Kill-Switch, Konfiguration)
          </h2>
          <Table
            head={["Zeit", "Ereignis", "Stufe", "Was ist passiert?"]}
            rows={report.notableEvents.map((e) => {
              // Derselbe Aufbereiter wie im Audit-Trail — keine abgeschnittene JSON.
              const view = describeAuditEntry({
                id: `${e.event}-${e.at}`,
                createdAt: e.at,
                event: e.event,
                level: e.level,
                detail: e.detail,
              });
              return [
                <span key={`${e.event}-${e.at}-at`} className="whitespace-nowrap tabular-nums">
                  {view.atLabel}
                </span>,
                <span key={`${e.event}-${e.at}-event`}>
                  <span className="block font-semibold text-slate-200">{view.eventLabel}</span>
                  <code className="text-[11px] text-slate-500">{e.event}</code>
                </span>,
                <span
                  key={`${e.event}-${e.at}-level`}
                  className={
                    view.tone === "critical"
                      ? "font-bold text-red-400"
                      : view.tone === "warn"
                        ? "text-amber-300"
                        : "text-emerald-300"
                  }
                >
                  {view.levelLabel}
                </span>,
                <details key={`${e.event}-${e.at}-detail`} className="max-w-xl">
                  <summary className="cursor-pointer text-slate-300">{view.headline}</summary>
                  <p className="mt-1 text-[11px] text-slate-400">{view.explanation}</p>
                  <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-950/60 p-2 font-mono text-[11px] text-slate-300">
                    {view.raw}
                  </pre>
                </details>,
              ];
            })}
          />
        </section>
      )}
    </div>
  );
}

/**
 * Protokoll-Tab: Zwei unabhängige, aber identisch aufgebaute Bereiche.
 *
 * Beide nutzen dasselbe Paging-System (20/50/100/200 pro Seite, Default 20),
 * dieselbe aufklappbare Kartenstruktur und denselben „Rohdaten"-Reiter.
 * Die komplette Aufbereitung (deutsche Titel, Feldlabels, Plausibilitätsprüfung)
 * liegt in src/lib/auditView.ts — server- und clientseitig identisch.
 */
function ProtocolTab() {
  return (
    <div className="space-y-8">
      <ProtocolPanel />
      <AuditTrailPanel
        title="Audit-Trail"
        hint="Revisionssichere Ereignisse: jede Order, jede Entscheidung, jede Risiko- und Regeländerung."
      />
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

function AdaptiveRiskPanel({ data }: { data: FirmData }) {
  const a = data.adaptiveRisk;
  const regimeStyle: Record<string, string> = {
    NORMAL: "bg-emerald-500/20 text-emerald-300 border-emerald-700/50",
    ELEVATED: "bg-amber-500/20 text-amber-300 border-amber-700/50",
    EXTREME: "bg-red-500/20 text-red-300 border-red-700/50",
  };
  const regimeLabel: Record<string, string> = {
    NORMAL: "Normal",
    ELEVATED: "Erhöhte Volatilität",
    EXTREME: "Extreme Volatilität",
  };

  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-slate-400">
        Adaptives Risiko — volatilitätsgetriebene Limit-Anpassung
      </h2>
      {!a ? (
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
          <p className="text-sm text-slate-400">
            Noch keine Bewertung. Der nächste Monitor-Tick (≈60 s) startet das adaptive
            System automatisch — oder löse manuell aus via{" "}
            <code className="rounded bg-slate-800 px-1 py-0.5 text-xs text-slate-200">
              POST /api/firm/risk/volatility
            </code>
            .
          </p>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-3">
          {/* Regime + wirksames Limit */}
          <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
            <div className="mb-3 flex items-center justify-between">
              <span className={`rounded-full border px-3 py-1 text-xs font-bold uppercase tracking-wide ${regimeStyle[a.regime] ?? regimeStyle.NORMAL}`}>
                {regimeLabel[a.regime] ?? a.regime}
              </span>
              {a.stale && (
                <span className="rounded bg-slate-800 px-2 py-0.5 text-[10px] text-slate-400">stale</span>
              )}
            </div>
            <div className="space-y-1 text-sm">
              <p className="text-slate-400">
                maxRiskPerTrade:{" "}
                <span className="font-mono text-slate-500 line-through">
                  {(a.baseMaxRiskPerTrade * 100).toFixed(2)} %
                </span>{" "}
                → <span className="font-mono font-bold text-emerald-300">{(a.effectiveMaxRiskPerTrade * 100).toFixed(2)} %</span>
              </p>
              <p className="text-xs text-slate-500">Faktor {a.factor} · Basis {a.baseMaxRiskPerTrade}</p>
              <p className="text-xs text-slate-400">{a.reason}</p>
              {a.lastUpdate && (
                <p className="pt-1 text-[11px] text-slate-500">
                  Aktualisiert {new Date(a.lastUpdate).toLocaleTimeString()}
                  {a.lastChange && a.lastChange !== a.lastUpdate ? ` · letzte Änderung ${new Date(a.lastChange).toLocaleTimeString()}` : ""}
                </p>
              )}
              {a.lastError && <p className="text-[11px] text-amber-400">Quelle: {a.lastError}</p>}
            </div>
          </div>

          {/* Indikatoren */}
          <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">Indikatoren</h3>
            <table className="w-full text-left text-xs">
              <tbody>
                {a.indicators.map((ind) => (
                  <tr key={ind.name} className="border-b border-slate-800/60 last:border-0">
                    <td className="py-1.5 pr-2 font-medium text-slate-300">{ind.name}</td>
                    <td className="py-1.5 pr-2 font-mono text-slate-400">
                      {ind.value != null
                        ? ind.name === "VIX" ? ind.value.toFixed(1) : `${(ind.value * 100).toFixed(2)} %`
                        : "n/v"}
                    </td>
                    <td className="py-1.5 pr-2 font-mono text-slate-600">
                      {ind.name === "VIX" ? ind.threshold : `${(ind.threshold * 100).toFixed(2)} %`}
                    </td>
                    <td className="py-1.5 text-right">
                      {!ind.available ? (
                        <span className="text-slate-600">—</span>
                      ) : ind.triggered ? (
                        <span className="font-bold text-amber-300">⚠ triggered</span>
                      ) : (
                        <span className="text-emerald-400">✓</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Letztes Event */}
          <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">Letztes Trigger-Event</h3>
            {a.events.length === 0 ? (
              <p className="text-xs text-slate-500">Keine Ereignisse seit Prozessstart.</p>
            ) : (
              (() => {
                const e = a.events[0];
                return (
                  <div className="space-y-1 text-xs text-slate-400">
                    <p>
                      <span className="font-mono text-slate-500">{e.prevRegime}</span> →{" "}
                      <span className="font-bold text-slate-200">{e.regime}</span>{" "}
                      <span className="font-mono">
                        ({(e.baseMaxRiskPerTrade * 100).toFixed(2)} % → {(e.effectiveMaxRiskPerTrade * 100).toFixed(2)} %)
                      </span>
                    </p>
                    <p className="text-slate-300">{e.reason}</p>
                    <p className="text-slate-600">
                      {new Date(e.at).toLocaleString()}
                      {e.triggered.length > 0 && ` · Trigger: ${e.triggered.join(", ")}`}
                    </p>
                  </div>
                );
              })()
            )}
            <p className="mt-3 text-[11px] text-slate-600">
              Vollständige Historie: <code className="text-slate-500">GET /api/firm/risk/volatility</code> und
              Audit-Log <code className="text-slate-500">RISK_ADAPTIVE</code>.
            </p>
          </div>
        </div>
      )}
    </section>
  );
}

type VolSectionProps = {
  data: FirmData;
  drafts: Record<string, string>;
  setDrafts: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  saving: string | null;
  save: (key: string, raw: string) => void;
};

function VolatilityConfigSection(props: VolSectionProps) {
  const { data, drafts, setDrafts, saving, save } = props;
  const rows = data.volatilityConfig ?? [];
  if (rows.length === 0) return null;
  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-slate-400">
        Volatilitäts-Schwellwerte &amp; Faktoren — zur Laufzeit änderbar
      </h2>
      <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900/50">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-800 text-[11px] uppercase tracking-wider text-slate-400">
              <th className="px-4 py-2 font-semibold">Parameter</th>
              <th className="px-4 py-2 font-semibold">Wirksam</th>
              <th className="px-4 py-2 font-semibold">Fenster</th>
              <th className="px-4 py-2 font-semibold">Ändern</th>
              <th className="px-4 py-2 font-semibold">Bedeutung</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const isPct = c.unit === "%";
              const isBool = c.unit === "bool";
              const fmtVal = isBool
                ? (c.value ? "an" : "aus")
                : isPct
                  ? `${(Number(c.value) * 100).toFixed(2)} %`
                  : String(c.value);
              const fmtBound = (v: number) => (isPct ? `${v * 100}%` : String(v));
              const draft = drafts[c.key] ?? "";
              return (
                <tr key={c.key} className="border-b border-slate-800/60 last:border-0">
                  <td className="px-4 py-2 font-medium text-slate-200">{c.label}</td>
                  <td className="px-4 py-2 font-bold text-emerald-300">{fmtVal}</td>
                  <td className="px-4 py-2 text-xs text-slate-500">
                    {fmtBound(c.min)} – {fmtBound(c.max)}
                  </td>
                  <td className="px-4 py-2">
                    {isBool ? (
                      <select
                        value={String(Number(c.value) >= 0.5)}
                        onChange={(e) => save(c.key, e.target.value)}
                        disabled={saving === c.key}
                        className="w-20 rounded border border-slate-700 bg-slate-800 px-1.5 py-1 text-xs text-slate-200"
                      >
                        <option value="1">an</option>
                        <option value="0">aus</option>
                      </select>
                    ) : (
                      <div className="flex items-center gap-1">
                        <input
                          type="number"
                          step="any"
                          placeholder={String(isPct ? (Number(c.value) * 100).toFixed(2) : c.value)}
                          value={draft}
                          onChange={(e) => setDrafts((d) => ({ ...d, [c.key]: e.target.value }))}
                          onKeyDown={(e) => e.key === "Enter" && draft !== "" && save(c.key, draft)}
                          className="w-24 rounded border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-slate-200"
                        />
                        {isPct && <span className="text-xs text-slate-500">%</span>}
                        <button
                          onClick={() => draft !== "" && save(c.key, draft)}
                          disabled={saving === c.key || draft === ""}
                          className="rounded bg-emerald-600/80 px-2 py-1 text-[11px] font-bold text-white hover:bg-emerald-500 disabled:opacity-40"
                        >
                          ✓
                        </button>
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2 text-xs text-slate-400">{c.description}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-3 rounded-lg border border-sky-700/50 bg-sky-950/30 px-4 py-3 text-xs text-sky-300">
        Diese Parameter steuern das adaptive Risiko (Regime NORMAL/ELEVATED/EXTREME) und wirken ab dem
        nächsten Tick (≈60 s) bzw. sofort bei Neubewertung — ohne Neustart. Jede Änderung wird im
        Audit-Log als <code className="font-mono">CONFIG_CHANGED</code> (Namespace{" "}
        <code className="font-mono">volatility</code>) protokolliert. Prozentwerte als Zahl eingeben
        (z. B. 1 = 1 %).
      </p>
    </section>
  );
}

function RiskTab({ data, onChanged }: { data: FirmData; onChanged: () => void }) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const allConfig = [...data.riskConfig, ...(data.volatilityConfig ?? [])];

  async function save(key: string, rawValue: string) {
    setSaving(key);
    setMsg("");
    const entry = allConfig.find((c) => c.key === key);
    const num =
      entry?.unit === "bool" ? (rawValue === "true" || rawValue === "1" ? 1 : 0) : Number(rawValue.replace(",", "."));
    const res = await apiFetch("/api/firm/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, value: num }),
    });
    if (res.status === 401) {
      setMsg("🔒 Aktion blockiert: FIRM_API_TOKEN ist aktiv und der Browser hat keinen gültigen Token (erst im Haupt-Tab oben hinterlegen).");
      setSaving(null);
      return;
    }
    const json = await res.json();
    setSaving(null);
    if (json.ok) {
      setMsg(`${key} gesetzt auf ${json.effective}${json.effective !== num ? ` (Eingabe ${num} wurde vom Code-Fenster geklemmt)` : ""}`);
      setDrafts((d) => ({ ...d, [key]: "" }));
      onChanged();
    } else {
      setMsg(`Fehler bei ${key}: ${json.error}`);
    }
  }

  return (
    <div className="space-y-6">
      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-slate-400">
          Risikokonfiguration — zur Laufzeit änderbar, im Code begrenzt
        </h2>
        <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900/50">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-800 text-[11px] uppercase tracking-wider text-slate-400">
                <th className="px-4 py-2 font-semibold">Limit</th>
                <th className="px-4 py-2 font-semibold">Wirksam</th>
                <th className="px-4 py-2 font-semibold">Erlaubtes Fenster</th>
                <th className="px-4 py-2 font-semibold">Ändern</th>
                <th className="px-4 py-2 font-semibold">Bedeutung</th>
              </tr>
            </thead>
            <tbody>
              {data.riskConfig.map((c) => {
                const isPct = c.unit === "%";
                const fmtVal = typeof c.value === "boolean"
                  ? (c.value ? "ja" : "nein")
                  : isPct
                    ? `${(Number(c.value) * 100).toFixed(1)} %`
                    : String(c.value);
                const fmtBound = (v: number) => (isPct ? `${v * 100}%` : v);
                const draft = drafts[c.key] ?? "";
                return (
                  <tr key={c.key} className="border-b border-slate-800/60 last:border-0">
                    <td className="px-4 py-2 font-medium text-slate-200">{c.label}</td>
                    <td className="px-4 py-2 font-bold text-emerald-300">{fmtVal}</td>
                    <td className="px-4 py-2 text-xs text-slate-500">
                      {fmtBound(c.min)} – {fmtBound(c.max)}
                    </td>
                    <td className="px-4 py-2">
                      {c.locked ? (
                        <span className="text-xs text-slate-500">🔒 gesperrt</span>
                      ) : (
                        <div className="flex items-center gap-1">
                          {c.unit === "bool" ? (
                            <select
                              value={String(c.value)}
                              onChange={(e) => save(c.key, e.target.value)}
                              disabled={saving === c.key}
                              className="w-24 rounded border border-slate-700 bg-slate-800 px-1.5 py-1 text-xs text-slate-200"
                            >
                              <option value={typeof c.value === "boolean" ? String(c.value) : String(Number(c.value) >= 0.5)}>
                                aktuell
                              </option>
                              <option value="1">an</option>
                              <option value="0">aus</option>
                            </select>
                          ) : (
                            <>
                              <input
                                type="number"
                                step="any"
                                placeholder={String(typeof c.value === "number" && isPct ? (Number(c.value) * 100).toFixed(1) : c.value)}
                                value={draft}
                                onChange={(e) => setDrafts((d) => ({ ...d, [c.key]: e.target.value }))}
                                onKeyDown={(e) => e.key === "Enter" && draft !== "" && save(c.key, draft)}
                                className={`w-28 rounded border bg-slate-800 px-2 py-1 text-xs text-slate-200 ${
                                  draft !== "" && Number(draft.replace(",", ".")) > (isPct ? c.max * 100 : c.max)
                                    ? "border-red-600"
                                    : "border-slate-700"
                                }`}
                              />
                              {isPct && <span className="text-xs text-slate-500">%</span>}
                              <button
                                onClick={() => draft !== "" && save(c.key, draft)}
                                disabled={saving === c.key || draft === ""}
                                className="rounded bg-emerald-600/80 px-2 py-1 text-[11px] font-bold text-white hover:bg-emerald-500 disabled:opacity-40"
                              >
                                ✓
                              </button>
                            </>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-2 text-xs text-slate-400">{c.description}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {msg && (
          <p className="mt-2 rounded-lg border border-sky-700/50 bg-sky-950/30 px-3 py-2 text-xs text-sky-300">{msg}</p>
        )}
        <p className="mt-3 rounded-lg border border-amber-700/50 bg-amber-950/30 px-4 py-3 text-xs text-amber-300">
          Werte wirken ab dem nächsten Turn/Tick ohne Neustart. Jede Änderung landet revisionssicher
          im Audit-Log (<code className="font-mono">CONFIG_CHANGED</code>). Die absoluten Grenzen
          (<code className="font-mono">LIMIT_CEILINGS</code> in <code className="font-mono">riskGuard.ts</code>)
          bleiben im kompilierten Code — auch eine kompromittierte Datenbank kann sie nicht aufweichen.
          Prozentwerte werden als Zahl eingegeben (z. B. 30 für 30 %).
        </p>
      </section>

      <AdaptiveRiskPanel data={data} />

      <VolatilityConfigSection data={data} drafts={drafts} setDrafts={setDrafts} saving={saving} save={save} />

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
      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
        <h2 className="mb-1 text-lg font-bold text-slate-50">1 · Grundprinzip (Ist-Stand)</h2>
        <p className="mb-3 text-sm text-slate-400">
          Die KI schlägt vor — der Code entscheidet. Orchestrierung ist ein
          eigener Engine-Layer (`src/lib/engine.ts`, `src/cycle/`) mit harten
          Grenzen in kompiliertem TypeScript — keine fremde Agenten-Runtime.
        </p>
        <ul className="ml-5 list-disc space-y-2 text-sm">
          <li><b className="text-emerald-400">Makro-Zyklus</b> — CEO + Research, LLM im Hintergrund, erzeugt versionierte Regeln (`trade_rules`).</li>
          <li><b className="text-emerald-400">Mikro-Zyklus</b> — eigener Prozess (`npm run micro`), kein LLM, WebSocket-Tick → kompilierte Regel → Paper-Fill.</li>
          <li><b className="text-emerald-400">Workshop-Pipeline</b> — sequenziell CEO → Research → Backtest → Risk → Approver → Executor; Race-Conditions an der Brokerschicht werden so vermieden.</li>
          <li><b className="text-emerald-400">MODEL_ROUTER</b> — kein Agent wählt sein Modell selbst (Task 09). Eskalationen nur als Antrag.</li>
        </ul>
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
        <h2 className="mb-1 text-lg font-bold text-slate-50">2 · 12-Aufgaben-Programm</h2>
        <p className="mb-3 text-sm text-slate-400">Was bereits im Code liegt — nicht was irgendwann geplant war:</p>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-700 text-[11px] uppercase text-slate-400">
                <th className="py-1 pr-3">Task</th>
                <th className="py-1 pr-3">Thema</th>
                <th className="py-1">Status</th>
              </tr>
            </thead>
            <tbody className="text-slate-300">
              <tr className="border-b border-slate-800"><td className="py-1 pr-3">01–06</td><td className="py-1 pr-3">Universum, Broker-Contract, Paper-Market-Data, Scanner, Portfolio, Zyklus</td><td className="py-1">geliefert</td></tr>
              <tr className="border-b border-slate-800"><td className="py-1 pr-3">07–09</td><td className="py-1 pr-3">Bitunix, Control Plane, MODEL_ROUTER</td><td className="py-1">geliefert</td></tr>
              <tr className="border-b border-slate-800"><td className="py-1 pr-3">10</td><td className="py-1 pr-3">Operations Center + RBAC (dieser Stand: Kern + leerer Tab)</td><td className="py-1">in Arbeit</td></tr>
              <tr><td className="py-1 pr-3">11</td><td className="py-1 pr-3">Live-Trading-Gate</td><td className="py-1">gesperrt — `LiveTradingGateError`</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
        <h2 className="mb-1 text-lg font-bold text-slate-50">3 · Sicherheit &amp; Risikokontrolle</h2>
        <p className="mb-3 text-sm text-slate-400">Defense-in-Depth — mehrschichtig, in Code verankert:</p>
        <ol className="ml-5 list-decimal space-y-2 text-sm">
          <li><b>Guardrails:</b> Engine validiert, dann <code className="font-mono">riskGuard.ts</code> (hart), dann Broker-Schleuse nochmal. Ein Agent-Output kann keine Schicht ändern.</li>
          <li><b>RBAC (Task 10):</b> Rollen viewer / operator / admin. Credentials und Routing-Modi nur Admin. Permission <code className="font-mono">live.gate</code> hat niemand.</li>
          <li><b>Kill-Switch:</b> Circuit-Breaker, DB-persistent. Jede Order in <code className="font-mono">submit</code> wird abgelehnt, sobald er scharf ist.</li>
          <li><b>Secrets:</b> Control Plane AES-256-GCM (AAD = Venue-ID). Das Frontend sieht nur Status, nie Keys.</li>
        </ol>
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
        <h2 className="mb-1 text-lg font-bold text-slate-50">4 · Paper-Trading (Ist)</h2>
        <ul className="ml-5 list-disc space-y-2 text-sm">
          <li><b>Default-Modus B</b> (<code className="font-mono">broker-market-data</code>): echte Kurse (Broker-Feed → Binance/Yahoo), Fills lokal im Simulator. Kein statisches Kursbuch — das ist nur noch <code className="font-mono">PAPER_STATIC_FALLBACK=true</code>.</li>
          <li><b>Modus A</b> (<code className="font-mono">synthetic</code>): seeded, deterministisch, für Tests.</li>
          <li><b>Modus C</b> (Broker-Paper-API): nur mit Venue-Capability + Flag; heute nicht wählbar (klarer Fehler, kein stiller Fallback).</li>
          <li><b>Live</b> bleibt unabhängig von Flags <code className="font-mono">LiveTradingGateError</code> (Task 11).</li>
        </ul>
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
        <h2 className="mb-1 text-lg font-bold text-slate-50">5 · Hardware (Variante A / B)</h2>
        <ul className="ml-5 list-disc space-y-2 text-sm">
          <li><b>Variante A — Solo-Node:</b> N150, 16 GB, alles lokal. 3B-Q4, Pipeline 2–6 min. Empfohlener Start.</li>
          <li><b>Variante B — Split-Node:</b> N150 24/7 + Desktop als Inferenz. 7B–14B, Pipeline 20–60 s.</li>
          <li><b>Quantisierung:</b> Q4_K_M ist der Standard — die Agenten füllen JSON, die Rechenarbeit liegt im Code. Q5 nur für den CEO, wenn Latenz es hergibt.</li>
          <li>Messen: <code className="font-mono">ollama ps</code> (RAM, tok/s). Zwei Modelle gleichzeitig auf 16 GB sind die harte Grenze — deshalb bleibt die Pipeline sequenziell.</li>
        </ul>
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
        <h2 className="mb-1 text-lg font-bold text-slate-50">6 · Broker (Ist)</h2>
        <ul className="ml-5 list-disc space-y-2 text-sm">
          <li><b>7 Venues registriert</b> hinter <code className="font-mono">BrokerAdapter</code>: PAPER (interner Simulator, vollständig), BITUNIX (Public REST/WS + Paper-Modus B), ALPACA/IBKR/BINANCE/KRAKEN/DYDX als ehrliche Stubs. <b>Registriert ≠ abgedeckt:</b> das Operations Center trennt registrierte Venues von tatsächlicher Discovery-/Market-Data-/Paper-/Testnet-/Live-Coverage (<code className="font-mono">GET /api/brokers/coverage</code>).</li>
          <li><b>Coverage (extern):</b> 1 Venue mit vollständiger Discovery, 1 Venue mit Paper-Market-Data, 0 Venues mit aktiviertem Live-Trading — differenziert im Coverage-Dashboard des Brokers-Tabs.</li>
          <li><b>Control Plane:</b> Credentials einmal Form → AES-256-GCM-Store. Frontend erhält nur Status (configured / connected / permissions / liveEnabled:false).</li>
          <li><b>Factory:</b> <code className="font-mono">getBroker(venue, &quot;live&quot;)</code> wirft immer <code className="font-mono">LiveTradingGateError</code>. Kein stiller Fallback auf Paper.</li>
          <li><b>Paper vereinheitlicht:</b> Der Bitunix-Paper-Ledger nutzt denselben zentralen <code className="font-mono">FillSimulator</code> wie die generische Paper-Execution (Spread, Slippage, Gebühren, Latenz, Partial Fills) — keine separate Simulationslogik mehr.</li>
        </ul>
      </section>

      {/* Questions to ask */}
      <section className="rounded-2xl border border-emerald-700/40 bg-emerald-950/20 p-6">
        <h2 className="mb-2 text-lg font-bold text-emerald-300">Fragen, die du dir vor dem Start stellen solltest</h2>
        <ul className="ml-5 list-disc space-y-2 text-sm text-emerald-100/90">
          <li>Welche maximale Drawdown-Toleranz hast du, bevor der Kill-Switch automatisch zieht? (Wert in % setzen)</li>
          <li>Wie viel Zeit kannst du realistisch pro Woche für Prompt-/Template-Wartung aufwenden? (beeinflusst Komplexität des Orchestrators)</li>
          <li>Welche Genauigkeit brauchst du bei Backtests, bevor du einem Setup vertraust? (das hier ist bewusst nur minimal)</li>
          <li>Stimmst du dem &quot;small round-trips, no shorts, no leverage&quot;-Start zu, oder willst du schon early Trades mit Margin?</li>
          <li>Welche Assets willst du wirklich handeln — Equities (→ Alpaca) oder Crypto (→ ccxt/Binance)?</li>
          <li>Hältst du einen hybriden Fallback sicher genug, um in Produktion je eine Cloud-API zu erlauben? (für Paper-Trading unnötig)</li>
        </ul>
      </section>
    </div>
  );
}
