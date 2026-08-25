"use client";

import { useEffect, useState } from "react";
import InfoTip from "./InfoTip";
import { apiFetch, readJson } from "@/lib/apiClient";
import type { MissionMutationResponse, MissionRow, MissionsIndexResponse } from "@/lib/types";

/**
 * Schritt 1 (Handbuch 5.1–5.3): Mission anlegen und bearbeiten — ersetzt das
 * psql-INSERT aus dem Handbuch. Budgets werden serverseitig gegen
 * LIMIT_CEILINGS geprüft, Symbole gegen die Paper-Broker-Liste.
 */

const FALLBACK_SYMBOLS = ["AAPL", "BTC", "ETH", "MSFT", "NVDA", "QQQ", "SOL", "SPY"];
const FALLBACK_LIMITS = { riskBudget: [0.002, 0.05] as [number, number], maxPositionPct: [0.01, 0.5] as [number, number] };

type FormState = {
  id: string | null;
  title: string;
  objective: string;
  symbol: string;
  riskBudgetPct: string;
  maxPositionPct: string;
  status: string;
};

const emptyForm: FormState = {
  id: null,
  title: "",
  objective: "",
  symbol: "BTC",
  riskBudgetPct: "2",
  maxPositionPct: "15",
  status: "PENDING",
};

/** Handbuch 5.2 — die Faustregel und die Beispiele als Nachschlagkasten. */
const QUALITY_EXAMPLES: { bad: string; why: string; good: string }[] = [
  { bad: "„Maximiere den Gewinn“", why: "kein Abbruchkriterium, lädt zum Zocken ein", good: "„Maximal ein Trade pro Tag, Stop 5 %“" },
  { bad: "„Handle clever“", why: "nicht überprüfbar", good: "„Nur Long, nur wenn Kurs über 20-Tage-Linie“" },
  { bad: "„Nutze alle Mittel“", why: "widerspricht den Guardrails", good: "„Maximal 15 % des Kapitals“" },
  { bad: "„Sei vorsichtig“", why: "Interpretationssache", good: "„Bei Unsicherheit HOLD antworten“" },
];

export default function MissionsPanel({
  missions,
  onChanged,
  onUnauthorized,
}: {
  missions: MissionRow[];
  onChanged: () => void;
  onUnauthorized: () => void;
}) {
  const [form, setForm] = useState<FormState>(emptyForm);
  const [symbols, setSymbols] = useState<string[]>(FALLBACK_SYMBOLS);
  const [limits, setLimits] = useState(FALLBACK_LIMITS);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [okMsg, setOkMsg] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const symbolFieldId = "mission-symbol";

  // Symbol-Liste + Grenzen einmalig vom Backend holen (Quelle: STATIC_PRICES
  // bzw. LIMIT_CEILINGS — die UI zeigt nie Grenzen, die der Server nicht kennt).
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/firm/missions");
        const json = (await res.json()) as MissionsIndexResponse;
        if (alive && res.ok && Array.isArray(json.symbols) && json.symbols.length > 0) {
          setSymbols(json.symbols);
          setLimits(json.limits ?? FALLBACK_LIMITS);
        }
      } catch {
        /* Fallback-Liste steht bereits */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  function editMission(m: MissionRow) {
    setForm({
      id: m.id,
      title: m.title,
      objective: m.objective,
      symbol: m.symbol ?? "",
      riskBudgetPct: String(Number(m.riskBudget) * 100),
      maxPositionPct: String(Number(m.maxPositionPct) * 100),
      status: m.status,
    });
    setError("");
    setOkMsg("");
    setWarnings([]);
  }

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  // Client-Validierung nur für unmittelbares Feedback; verbindlich ist der Server.
  function validateLocally(): string | null {
    if (form.title.trim().length < 3) return "Titel: mindestens 3 Zeichen.";
    if (form.objective.trim().length < 10) return "Ziel: mindestens 10 Zeichen — eine Mission braucht prüfbare Regeln.";
    if (!symbols.includes(form.symbol.trim().toUpperCase()))
      return `Symbol: nur Paper-Broker-Symbole sind erlaubt (${symbols.join(", ")}).`;
    const risk = Number(form.riskBudgetPct.replace(",", "."));
    if (!Number.isFinite(risk) || risk <= 0) return "Risikobudget: Zahl in Prozent erwartet, z. B. 2 für 2 %.";
    const pos = Number(form.maxPositionPct.replace(",", "."));
    if (!Number.isFinite(pos) || pos <= 0) return "Max. Positionsgröße: Zahl in Prozent erwartet, z. B. 15 für 15 %.";
    return null;
  }

  async function save() {
    setOkMsg("");
    setError("");
    setWarnings([]);
    const local = validateLocally();
    if (local) {
      setError(local);
      return;
    }
    setSaving(true);
    const payload = {
      id: form.id ?? undefined,
      title: form.title.trim(),
      objective: form.objective.trim(),
      symbol: form.symbol.trim().toUpperCase(),
      riskBudget: Number(form.riskBudgetPct.replace(",", ".")) / 100,
      maxPositionPct: Number(form.maxPositionPct.replace(",", ".")) / 100,
      status: form.status,
    };
    const { res, data, error: err } = await readJson<MissionMutationResponse>(
      await apiFetch("/api/firm/missions", {
        method: form.id ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }),
      "Mission konnte nicht gespeichert werden"
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
    setOkMsg(
      form.id
        ? `Mission „${data.mission?.title ?? form.title}“ aktualisiert.`
        : `Mission „${data.mission?.title ?? form.title}“ angelegt.`
    );
    setWarnings(data.warnings ?? []);
    setForm(emptyForm);
    onChanged();
  }

  const editing = form.id !== null;
  const fmtRange = (r: [number, number]) => `${(r[0] * 100).toFixed(1)} % – ${(r[1] * 100).toFixed(1)} %`;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {/* ── Formular ─────────────────────────────────────────────── */}
      <section aria-labelledby="mission-form-title" className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
        <div className="mb-1 flex items-center">
          <h3 id="mission-form-title" className="text-sm font-bold text-slate-100">
            {editing ? "Mission bearbeiten" : "Neue Mission anlegen"}
          </h3>
          <InfoTip
            id="mission-form-title"
            label="Mission"
            text="Eine Mission ist der Auftrag an die Firma — der wichtigste Hebel, noch vor der Modellwahl (Handbuch 5)."
          />
          {editing && (
            <button
              onClick={() => { setForm(emptyForm); setError(""); setOkMsg(""); setWarnings([]); }}
              className="ml-auto rounded border border-slate-600 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800"
              aria-label="Bearbeitung abbrechen und neues Formular leeren"
            >
              ✕ Neue anlegen
            </button>
          )}
        </div>
        <p className="mb-4 text-xs text-slate-500">Speichert über POST/PUT <code className="font-mono">/api/firm/missions</code> — direkt in die Datenbank, ohne Terminal.</p>

        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div>
            <label htmlFor="mission-title" className="mb-1 block text-xs font-semibold text-slate-300">
              Titel
              <InfoTip
                id="mission-title"
                label="Titel"
                text="Kurzname der Mission, z. B. „ETH Trendfolge, defensiv“. Wird in Listen und Auswahlmenüs angezeigt."
              />
            </label>
            <input
              id="mission-title"
              name="title"
              value={form.title}
              onChange={(e) => set("title", e.target.value)}
              maxLength={120}
              required
              placeholder="ETH Trendfolge, defensiv"
              aria-describedby="mission-title-tip"
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-sky-500 focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor="mission-objective" className="mb-1 block text-xs font-semibold text-slate-300">
              Ziel / Objective
              <InfoTip
                id="mission-objective"
                label="Ziel"
                text="Der vollständige Auftragstext an alle Agenten. Prüfbare Regeln statt Absichten: Richtung, Stop-Bereich, Häufigkeit, HOLD-Bedingung."
              />
            </label>
            <textarea
              id="mission-objective"
              name="objective"
              value={form.objective}
              onChange={(e) => set("objective", e.target.value)}
              rows={5}
              maxLength={2000}
              required
              placeholder={"Nur Long in ETH und nur bei klarem Aufwärtstrend. Stop-Loss zwischen 4 und 7 Prozent. Keine Nachkäufe. Bei unklarer Lage HOLD antworten statt zu handeln. Ziel ist Prozesstreue, nicht Rendite."}
              aria-describedby="mission-objective-tip"
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-sky-500 focus:outline-none"
            />
            <p className="mt-1 text-[11px] text-slate-500">{form.objective.trim().length}/2000 Zeichen</p>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label htmlFor={symbolFieldId} className="mb-1 block text-xs font-semibold text-slate-300">
                Symbol
                <InfoTip
                  id={symbolFieldId}
                  label="Symbol"
                  text="Das handelbare Instrument, das die Agenten analysieren. Der Paper-Broker kennt nur diese Liste (Handbuch 5.3)."
                />
              </label>
              <input
                id={symbolFieldId}
                name="symbol"
                list="mission-symbol-options"
                value={form.symbol}
                onChange={(e) => set("symbol", e.target.value.toUpperCase())}
                required
                placeholder="BTC"
                aria-describedby={`${symbolFieldId}-tip`}
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm uppercase text-slate-100 focus:border-sky-500 focus:outline-none"
              />
              <datalist id="mission-symbol-options">
                {symbols.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            </div>
            <div>
              <label htmlFor="mission-risk" className="mb-1 block text-xs font-semibold text-slate-300">
                Risikobudget
                <InfoTip
                  id="mission-risk"
                  label="Risikobudget"
                  text="Maximaler Verlust pro Trade als Anteil des Kapitals. Die Positionsgröße wird daraus berechnet — niemals vom Modell."
                />
              </label>
              <div className="flex items-center">
                <input
                  id="mission-risk"
                  name="riskBudgetPct"
                  type="number"
                  step="0.1"
                  min="0"
                  value={form.riskBudgetPct}
                  onChange={(e) => set("riskBudgetPct", e.target.value)}
                  required
                  aria-describedby="mission-risk-tip"
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-sky-500 focus:outline-none"
                />
                <span className="ml-2 text-sm text-slate-400">%</span>
              </div>
              <p className="mt-1 text-[11px] text-slate-500">erlaubt: {fmtRange(limits.riskBudget)}</p>
            </div>
            <div>
              <label htmlFor="mission-pos" className="mb-1 block text-xs font-semibold text-slate-300">
                Max. Position
                <InfoTip
                  id="mission-pos"
                  label="Maximale Positionsgröße"
                  text="Größter Anteil des Kapitals, der in eine einzelne Position darf. Code-Deckel liegt bei 50 % (LIMIT_CEILINGS.maxPositionPct)."
                />
              </label>
              <div className="flex items-center">
                <input
                  id="mission-pos"
                  name="maxPositionPct"
                  type="number"
                  step="1"
                  min="0"
                  value={form.maxPositionPct}
                  onChange={(e) => set("maxPositionPct", e.target.value)}
                  required
                  aria-describedby="mission-pos-tip"
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-sky-500 focus:outline-none"
                />
                <span className="ml-2 text-sm text-slate-400">%</span>
              </div>
              <p className="mt-1 text-[11px] text-slate-500">erlaubt: {(limits.maxPositionPct[0] * 100).toFixed(0)} % – {(limits.maxPositionPct[1] * 100).toFixed(0)} %</p>
            </div>
          </div>

          {editing && (
            <div>
              <label htmlFor="mission-status" className="mb-1 block text-xs font-semibold text-slate-300">
                Status
                <InfoTip
                  id="mission-status"
                  label="Status"
                  text="PENDING/ACTIVE: lauffähig. COMPLETED: abgeschlossen. KILLED: nach Not-Halt gestoppt — erst Kill-Switch entschärfen."
                />
              </label>
              <select
                id="mission-status"
                value={form.status}
                onChange={(e) => set("status", e.target.value)}
                aria-describedby="mission-status-tip"
                className="w-48 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
              >
                {["PENDING", "ACTIVE", "COMPLETED", "KILLED"].map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
          )}

          <button
            type="submit"
            disabled={saving}
            className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-bold text-white hover:bg-sky-500 disabled:opacity-50"
          >
            {saving ? "Speichern…" : editing ? "Änderungen speichern (PUT)" : "Mission anlegen (POST)"}
          </button>
        </form>

        <div aria-live="polite" className="mt-3 space-y-2">
          {error && (
            <p role="alert" className="rounded-lg border border-red-800 bg-red-950/50 px-3 py-2 text-xs text-red-300">
              ✖ {error}
            </p>
          )}
          {okMsg && (
            <p role="status" className="rounded-lg border border-emerald-800 bg-emerald-950/50 px-3 py-2 text-xs text-emerald-300">
              ✔ {okMsg}
            </p>
          )}
          {warnings.map((w) => (
            <p key={w} className="rounded-lg border border-amber-800 bg-amber-950/40 px-3 py-2 text-xs text-amber-300">
              ⚠ {w}
            </p>
          ))}
        </div>
      </section>

      {/* ── Qualität + Liste ─────────────────────────────────────── */}
      <div className="space-y-4">
        <section aria-labelledby="mission-quality-title" className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
          <div className="mb-2 flex items-center">
            <h3 id="mission-quality-title" className="text-sm font-bold text-slate-100">Was eine gute Mission ausmacht</h3>
            <InfoTip
              id="mission-quality-title"
              label="Anforderungen gute Mission"
              text="Faustregel: Wenn du nicht in einer SQL-Abfrage prüfen kannst, ob die Mission erfüllt wurde, ist sie zu vage formuliert."
            />
          </div>
          <p className="mb-3 rounded-lg border border-sky-800/60 bg-sky-500/5 px-3 py-2 text-xs text-sky-200">
            Faustregel: <strong>nicht in einer SQL-Abfrage prüfbar → zu vage.</strong>
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-800 text-[10px] uppercase tracking-wider text-slate-500">
                  <th className="py-1.5 pr-2 font-semibold">Schlecht</th>
                  <th className="py-1.5 pr-2 font-semibold">Warum</th>
                  <th className="py-1.5 font-semibold">Besser</th>
                </tr>
              </thead>
              <tbody>
                {QUALITY_EXAMPLES.map((q) => (
                  <tr key={q.bad} className="border-b border-slate-800/50 last:border-0">
                    <td className="py-1.5 pr-2 text-red-300">{q.bad}</td>
                    <td className="py-1.5 pr-2 text-slate-400">{q.why}</td>
                    <td className="py-1.5 text-emerald-300">{q.good}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section aria-labelledby="mission-list-title" className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
          <div className="mb-2 flex items-center">
            <h3 id="mission-list-title" className="text-sm font-bold text-slate-100">Bestehende Missionen</h3>
            <InfoTip
              id="mission-list-title"
              label="Missionsliste"
              text="Alle Missionen aus der Datenbank. Bearbeiten lädt den Eintrag ins Formular links; speichern überschreibt ihn."
            />
          </div>
          {missions.length === 0 ? (
            <p className="text-xs text-slate-500">
              Noch keine Missionen. Oben anlegen oder „Seed / Reset“ im Kopf der Seite klicken.
            </p>
          ) : (
            <ul className="space-y-2">
              {missions.map((m) => (
                <li
                  key={m.id}
                  className={`flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 ${
                    form.id === m.id ? "border-sky-600 bg-sky-500/10" : "border-slate-800 bg-slate-950/40"
                  }`}
                >
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                      m.status === "KILLED" ? "bg-red-500/20 text-red-300"
                      : m.status === "ACTIVE" ? "bg-emerald-500/20 text-emerald-300"
                      : "bg-slate-600/40 text-slate-300"
                    }`}
                  >
                    {m.status}
                  </span>
                  <span className="text-xs font-semibold text-slate-200">{m.title}</span>
                  <span className="text-[11px] text-slate-500">
                    {m.symbol ?? "—"} · Risiko {(Number(m.riskBudget) * 100).toFixed(1)} % · max. Pos. {(Number(m.maxPositionPct) * 100).toFixed(0)} %
                  </span>
                  <button
                    onClick={() => editMission(m)}
                    className="ml-auto rounded border border-slate-600 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800"
                    aria-label={`Mission ${m.title} bearbeiten`}
                  >
                    Bearbeiten
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
